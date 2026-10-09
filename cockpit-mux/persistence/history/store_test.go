package history

import (
	"bytes"
	"path/filepath"
	"testing"
)

func TestArchiveBatchesAreOrderedAndSessionReapRemovesThem(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	first := Record{SessionID: "session-a", PaneID: "pane-a", FirstLine: 0, LastLine: 2, Data: []byte("first batch")}
	second := Record{SessionID: "session-a", PaneID: "pane-a", FirstLine: 3, LastLine: 4, Data: []byte("second batch")}
	if err := store.Append(first); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(second); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(Record{SessionID: "session-a", PaneID: "pane-a", FirstLine: 6, LastLine: 6, Data: []byte("gap")}); err == nil {
		t.Fatal("archive accepted a non-contiguous line range")
	}
	records, err := store.Load("pane-a", 1, 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 || !bytes.Equal(records[0].Data, first.Data) || !bytes.Equal(records[1].Data, second.Data) {
		t.Fatalf("loaded archive records = %#v", records)
	}
	if err := store.ReapSession("session-a"); err != nil {
		t.Fatal(err)
	}
	records, err = store.Load("pane-a", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("reaped archive records = %#v, want none", records)
	}
}
