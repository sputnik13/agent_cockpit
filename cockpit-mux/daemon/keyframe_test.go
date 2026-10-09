//go:build libghostty

package daemon

import (
	"bytes"
	"path/filepath"
	"testing"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

func TestSnapshotRestoresAuthoritativeShadow(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("history\r\n\x1b[?1049halt\x1b[31m red"))
	snapshot, err := shadow.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreShadow(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	got, err := restored.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("restored shadow differs\n got: %q\nwant: %q", got, want)
	}
}

func TestSnapshotRestoresContinuation(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("\x1b]2;continued title"))
	snapshot, err := shadow.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreShadow(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	shadow.Feed([]byte("\a"))
	restored.Feed([]byte("\a"))
	got, err := restored.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("restored continuation differs\n got: %q\nwant: %q", got, want)
	}
}

func TestSnapshotCompressedStoreRoundTripPreservesAlternateScreenHistory(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("history one\r\nhistory two\r\nhistory three\r\n\x1b[?1049h\x1b[31mfull-screen editor\x1b[0m"))
	snapshot, err := shadow.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), persistence.DefaultTailCap)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveKeyframe(persistence.Keyframe{EngineVersion: version, Boundary: "grounded", Snapshot: snapshot}); err != nil {
		t.Fatal(err)
	}
	stored, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("fresh compressed snapshot unexpectedly retained tail: %q", tail)
	}
	restored, err := RestoreShadow(stored.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	got, err := restored.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("compressed Snapshot v1 round trip differs\n got: %q\nwant: %q", got, want)
	}
}
