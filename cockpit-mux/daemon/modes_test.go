package daemon

import (
	"bytes"
	"testing"
)

func TestModeStatePrefixesTrackedModes(t *testing.T) {
	var modes ModeState
	modes.Observe([]byte("\x1b[?1049h\x1b[?2004h"))
	if got, want := modes.Prefix(), []byte("\x1b[?1049h\x1b[?2004h\x1b[?2026l"); !bytes.Equal(got, want) {
		t.Fatalf("Prefix() = %q, want %q", got, want)
	}
	modes.Observe([]byte("\x1b[?1049l\x1b[?2004l"))
	if got, want := modes.Prefix(), []byte("\x1b[?2026l"); !bytes.Equal(got, want) {
		t.Fatalf("Prefix() after resets = %q, want %q", got, want)
	}
}

func TestModeStateTracksSequencesSplitAcrossPTYReads(t *testing.T) {
	var modes ModeState
	modes.Observe([]byte("\x1b[?10"))
	modes.Observe([]byte("49h\x1b[?20"))
	modes.Observe([]byte("04h\x1b[3;20"))
	modes.Observe([]byte("r\x1b[5 q\x1b]2;at"))
	modes.Observe([]byte("tach title\x1b\\"))
	prefix := modes.Prefix()
	for _, want := range [][]byte{
		[]byte("\x1b[?1049h"), []byte("\x1b[?2004h"), []byte("\x1b[3;20r"),
		[]byte("\x1b[5 q"), []byte("\x1b]2;attach title\a"), []byte("\x1b[?2026l"),
	} {
		if !bytes.Contains(prefix, want) {
			t.Fatalf("prefix %q missing %q", prefix, want)
		}
	}
}

func TestModeStateRestoresS2RestorableModes(t *testing.T) {
	var modes ModeState
	modes.Observe([]byte("\x1b[?1h\x1b[?6h\x1b[?7l\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[4h\x1b=\x1b[>1u"))
	prefix := modes.Prefix()
	for _, want := range [][]byte{
		[]byte("\x1b[?1h"), []byte("\x1b[?6h"), []byte("\x1b[?7l"), []byte("\x1b[?25l"),
		[]byte("\x1b[?1002h"), []byte("\x1b[?1006h"), []byte("\x1b[?1004h"),
		[]byte("\x1b[4h"), []byte("\x1b="), []byte("\x1b[=1u"), []byte("\x1b[?2026l"),
	} {
		if !bytes.Contains(prefix, want) {
			t.Fatalf("prefix %q missing %q", prefix, want)
		}
	}
}

func TestModeStateKittyKeyboardPopRestoresPriorFlags(t *testing.T) {
	var modes ModeState
	modes.Observe([]byte("\x1b[=3u\x1b[>7u\x1b[<1u"))
	if got, want := modes.kittyFlags, "3"; got != want {
		t.Fatalf("kitty flags = %q, want %q", got, want)
	}
}

func TestModeStatePersistenceRoundTripPreservesSeed(t *testing.T) {
	var modes ModeState
	modes.Observe([]byte("\x1b[?1049h\x1b[?2004h\x1b[?7l\x1b[4h\x1b]2;recovered\a\x1b7"))
	data, err := modes.MarshalPersistence()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreModeState(data)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := restored.Prefix(), modes.Prefix(); !bytes.Equal(got, want) {
		t.Fatalf("restored prefix = %q, want %q", got, want)
	}
	if !restored.HasSavedCursor() {
		t.Fatal("saved-cursor state was not restored")
	}
}
