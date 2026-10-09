//go:build libghostty

package daemon

import (
	"bytes"
	"path/filepath"
	"testing"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

func TestKeyframeTailRestoresUninterruptedShadow(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	shadow.Feed([]byte("before keyframe\r\n"))
	snapshot, err := shadow.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveKeyframe(persistence.Keyframe{EngineVersion: version, Boundary: "grounded", Snapshot: snapshot}); err != nil {
		t.Fatal(err)
	}
	for sequence, data := range [][]byte{[]byte("tail one\r\n"), []byte("\x1b[?1049halt tail")} {
		shadow.Feed(data)
		if err := store.Append(uint64(sequence+1), data); err != nil {
			t.Fatal(err)
		}
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	for _, data := range tail {
		restored.Feed(data)
	}
	got, err := restored.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("recovered shadow differs from uninterrupted control\n got: %q\nwant: %q", got, want)
	}
}
