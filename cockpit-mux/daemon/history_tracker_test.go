//go:build libghostty

package daemon

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/local-repo-explorer/cockpit-mux/persistence/history"
	"github.com/vmihailenco/msgpack/v5"
)

func TestHistoryTrackerEmitsNativeEvictionsInOrder(t *testing.T) {
	shadow, err := NewShadowWithScrollback(20, 2, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	tracker := NewHistoryTracker(shadow)
	defer tracker.Close()
	for index := 0; index < 20; index++ {
		shadow.Feed([]byte(fmt.Sprintf("early-%03d\r\n", index)))
	}
	if archived, err := tracker.Collect(); err != nil || len(archived) != 0 {
		t.Fatalf("initial tracker collect = %#v, %v", archived, err)
	}
	for index := 0; index < 10_000; index++ {
		shadow.Feed([]byte(fmt.Sprintf("late-%05d\r\n", index)))
	}
	archived, err := tracker.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) == 0 {
		t.Fatal("tracker did not emit rows evicted by native scrollback pruning")
	}
	var text strings.Builder
	for _, line := range archived {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !strings.Contains(text.String(), "early-000") || !strings.Contains(text.String(), "early-018") {
		t.Fatalf("archived native rows = %q, want early history", text.String())
	}
}

func TestHistoryArchiveWritesNativeEvictionsAsOneCleanCloseBatch(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	shadow, err := NewShadowWithScrollback(20, 2, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	archive, err := NewHistoryArchive(store, shadow, "logical-session", "pane-1", true)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 20; index++ {
		shadow.Feed([]byte(fmt.Sprintf("archive-early-%03d\r\n", index)))
	}
	if err := archive.Record(); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 10_000; index++ {
		shadow.Feed([]byte(fmt.Sprintf("archive-late-%05d\r\n", index)))
	}
	if err := archive.Record(); err != nil {
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	records, err := store.Load("pane-1", 0, 100_000)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("archive records = %d, want one clean-close batch", len(records))
	}
	var lines []ScrollbackLine
	if err := msgpack.Unmarshal(records[0].Data, &lines); err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, line := range lines {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !strings.Contains(text.String(), "archive-early-000") {
		t.Fatalf("archived rows = %q, want early history", text.String())
	}
}

func TestAttachmentScrollbackPagesFromArchiveBeforeFiniteLiveHistory(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	primary, err := NewShadowWithScrollback(20, 2, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	archive, err := NewHistoryArchive(store, primary, "session", "pane", true)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	attachment := &shadowAttachment{
		pipeline: &Pipeline{Shadow: primary, Primary: primary},
		archive:  archive,
	}
	for index := 0; index < 20; index++ {
		primary.Feed([]byte(fmt.Sprintf("page-early-%03d\r\n", index)))
	}
	if err := archive.Record(); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 10_000; index++ {
		primary.Feed([]byte(fmt.Sprintf("page-late-%05d\r\n", index)))
	}
	if err := archive.Record(); err != nil {
		t.Fatal(err)
	}
	lines, err := attachment.Scrollback(0, 20_000)
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, line := range lines {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !strings.Contains(text.String(), "page-early-000") || !strings.Contains(text.String(), "page-late-09998") {
		t.Fatalf("merged archive/live scrollback = %q", text.String())
	}
}

func TestHistoryArchiveObservesEveryLargePTYReadChunkBeforeNativePruning(t *testing.T) {
	store, err := history.Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	primary, err := NewShadowWithScrollback(20, 2, 100)
	if err != nil {
		t.Fatal(err)
	}
	defer primary.Close()
	archive, err := NewHistoryArchive(store, primary, "session", "pane", true)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var payload strings.Builder
	for index := 0; index < 12_000; index++ {
		fmt.Fprintf(&payload, "single-read-%05d\r\n", index)
	}
	var mirror primaryMirror
	if err := mirror.FeedWithHook(primary, []byte(payload.String()), archive.Record); err != nil {
		t.Fatal(err)
	}
	lines, err := archive.Lines(0, archive.LineCount())
	if err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	for _, line := range lines {
		for _, run := range line.Runs {
			text.WriteString(run.Text)
		}
	}
	if !strings.Contains(text.String(), "single-read-00000") {
		t.Fatalf("large PTY read lost earliest evicted history: %q", text.String())
	}
}
