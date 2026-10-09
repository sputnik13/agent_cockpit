//go:build libghostty

package daemon

import (
	"bytes"
	"io"
	"testing"
)

func TestPipelineFeedsShadowAndAttachesAtNewSize(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf 'primary\\r\\n\\033[?1049halt-screen'")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	pipeline := Pipeline{Pane: pane, Shadow: shadow}

	buffer := make([]byte, 128)
	for {
		output, readErr := pipeline.Pump(buffer)
		if len(output.Data) > 0 && output.Sequence == 0 {
			t.Fatal("live chunk did not receive a sequence")
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			break
		}
	}

	seed, err := pipeline.Attach(100, 32, 0, 0)
	if err != nil {
		t.Fatalf("Attach() error = %v", err)
	}
	if seed.ResumeSequence == 0 {
		t.Fatal("Attach() did not provide a resume barrier")
	}
	if !bytes.Contains(seed.Data, []byte("alt-screen")) {
		t.Fatalf("seed %q does not contain shadow state", seed.Data)
	}
	if !bytes.HasPrefix(seed.Data, []byte("\x1b[?1049h")) {
		t.Fatalf("seed %q is missing the alternate-screen prefix", seed.Data)
	}
}

func TestPipelineAttachCapturesLiveGraphicsWithTextSeed(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf '\\033[2;3H\\033_Ga=T,f=32,s=1,v=1,i=91,q=2;/wAA/w==\\033\\\\'; sleep 1")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	pipeline := Pipeline{Pane: pane, Shadow: shadow}
	buffer := make([]byte, 512)
	for {
		_, readErr := pipeline.Pump(buffer)
		if readErr != nil {
			break
		}
	}
	seed, err := pipeline.Attach(80, 24, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(seed.Graphics, []byte("a=t,f=32,s=1,v=1,i=91,q=2")) {
		t.Fatalf("graphics attach seed = %q, want retained direct image", seed.Graphics)
	}
	if seed.ResumeSequence == 0 {
		t.Fatal("graphics attach did not retain the normal resume barrier")
	}
}

func TestPipelineRestoresCompleteSavedCursorState(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf '\\033[5;20r\\033[?6h\\033[1\\\"q\\033[1;1H\\033[31m\\0337\\033[?6l\\033[0\\\"q\\033[32m\\033[2;1H'")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	pipeline := Pipeline{Pane: pane, Shadow: shadow}
	buffer := make([]byte, 128)
	for {
		_, readErr := pipeline.Pump(buffer)
		if readErr != nil {
			break
		}
	}
	seed, err := pipeline.Attach(80, 24, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	consumer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(seed.Data)
	consumer.Feed([]byte("\x1b8\x1b[1;1HX"))
	shadow.Feed([]byte("\x1b8\x1b[1;1HX"))
	got, err := consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("DECRC after reattach differs from authoritative state\n got: %q\nwant: %q", got, want)
	}
}

func TestPipelineRestoresPrimarySavedCursorAfterAlternateExit(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf '\\033[1;1H\\033[31m\\0337\\033[?1049h\\033[2;1Halternate'")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	primary, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	pipeline := Pipeline{Pane: pane, Shadow: shadow, Primary: primary}
	buffer := make([]byte, 128)
	for {
		_, readErr := pipeline.Pump(buffer)
		if readErr != nil {
			break
		}
	}
	seed, err := pipeline.Attach(80, 24, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	consumer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(seed.Data)
	consumer.Feed([]byte("\x1b[?1049l\x1b8X"))
	shadow.Feed([]byte("\x1b[?1049l\x1b8X"))
	got, err := consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("primary DECRC after alternate exit differs from authoritative state\n got: %q\nwant: %q", got, want)
	}
}

func TestPipelineReattachesKittyKeyboardAndScrollRegion(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf '\\033[4;18r\\033[>1u\\033[?1049hkitty-reconnect'")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	pipeline := Pipeline{Pane: pane, Shadow: shadow}
	buffer := make([]byte, 128)
	for {
		_, readErr := pipeline.Pump(buffer)
		if readErr != nil {
			break
		}
	}
	seed, err := pipeline.Attach(100, 32, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range [][]byte{
		[]byte("\x1b[4;18r"),
		// libghostty normalizes the observed Kitty keyboard push sequence to
		// the active-mode form emitted in a fresh reattach seed.
		[]byte("\x1b[=1u"),
		[]byte("kitty-reconnect"),
	} {
		if !bytes.Contains(seed.Data, want) {
			t.Fatalf("reattach seed %q missing %q", seed.Data, want)
		}
	}
	consumer, err := NewShadow(100, 32)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(seed.Data)
	if _, err := consumer.Seed(); err != nil {
		t.Fatalf("fresh reattach consumer could not format state: %v", err)
	}
}

func TestRecordedTUIByteStreamRestoresGridAndTrackedModes(t *testing.T) {
	// This is a fixed recorded terminal transcript, deliberately split at VT
	// boundaries as a real PTY read can be. It exercises the mode state that
	// must be emitted before a fresh consumer receives the formatted grid.
	recorded := [][]byte{
		[]byte("build history\r\nline two\r\n\x1b[?1049h\x1b[?1h\x1b[?6h\x1b[?7l"),
		[]byte("\x1b[?25l\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[4h\x1b=\x1b[>1u"),
		[]byte("\x1b[3;20r\x1b[5 q\x1b]2;recorded-tui\a\x1b[2;4Hstatus: ready"),
	}
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	var modes ModeState
	for _, chunk := range recorded {
		shadow.Feed(chunk)
		modes.Observe(chunk)
	}
	grid, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(grid, []byte("status: ready")) {
		t.Fatalf("recorded grid seed %q is missing visible content", grid)
	}
	prefix := modes.Prefix()
	for _, want := range [][]byte{
		[]byte("\x1b[?1049h"), []byte("\x1b[?1h"), []byte("\x1b[?6h"),
		[]byte("\x1b[?7l"), []byte("\x1b[?25l"), []byte("\x1b[?1002h"),
		[]byte("\x1b[?1006h"), []byte("\x1b[?1004h"), []byte("\x1b[4h"),
		[]byte("\x1b="), []byte("\x1b[=1u"), []byte("\x1b[3;20r"),
		[]byte("\x1b[5 q"), []byte("\x1b]2;recorded-tui\a"),
	} {
		if !bytes.Contains(prefix, want) {
			t.Fatalf("reattach mode prefix %q missing %q", prefix, want)
		}
	}
	consumer, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(append(prefix, grid...))
	got, err := consumer.Seed()
	if err != nil {
		t.Fatal(err)
	}
	// Formatting a restored grid is allowed to normalize cursor/blank-line
	// controls. The acceptance contract is the visible grid plus the complete
	// restorable mode set above, not byte-identical formatter output.
	if !bytes.Contains(got, []byte("status: ready")) {
		t.Fatalf("fresh consumer lost recorded visible grid content: %q", got)
	}
}
