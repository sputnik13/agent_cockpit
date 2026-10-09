//go:build libghostty

package daemon

import (
	"fmt"
	"sync"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/persistence/history"
	"github.com/vmihailenco/msgpack/v5"
)

// HistoryArchive batches rows Ghostty has evicted from finite live history.
// It has no VT parser: HistoryTracker supplies already-rendered terminal rows.
type HistoryArchive struct {
	mu      sync.Mutex
	store   *history.Store
	tracker *HistoryTracker
	session string
	pane    string
	enabled bool
	next    uint64
	pending []ScrollbackLine
	bytes   int
	last    time.Time
}

func NewHistoryArchive(store *history.Store, shadow *Shadow, sessionID, paneID string, enabled bool) (*HistoryArchive, error) {
	if store == nil || sessionID == "" || paneID == "" {
		return nil, fmt.Errorf("mux history archive requires store, session, and pane IDs")
	}
	next, err := store.NextLine(paneID)
	if err != nil {
		return nil, fmt.Errorf("read mux history archive boundary: %w", err)
	}
	archive := &HistoryArchive{store: store, tracker: NewHistoryTracker(shadow), session: sessionID, pane: paneID, next: next}
	if err := archive.SetEnabled(enabled); err != nil {
		archive.Close()
		return nil, err
	}
	return archive, nil
}

func (archive *HistoryArchive) LineCount() uint64 {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	return archive.next + uint64(len(archive.pending))
}

// Lines reads an inclusive archive range, including not-yet-flushed rows so a
// user can scroll immediately after native eviction.
func (archive *HistoryArchive) Lines(first, last uint64) ([]ScrollbackLine, error) {
	if last < first {
		return nil, fmt.Errorf("invalid mux archive line range")
	}
	archive.mu.Lock()
	defer archive.mu.Unlock()
	records, err := archive.store.Load(archive.pane, first, last)
	if err != nil {
		return nil, err
	}
	lines := make([]ScrollbackLine, 0)
	for _, record := range records {
		var decoded []ScrollbackLine
		if err := msgpack.Unmarshal(record.Data, &decoded); err != nil {
			return nil, fmt.Errorf("decode mux archive history rows: %w", err)
		}
		for _, line := range decoded {
			if uint64(line.Line) >= first && uint64(line.Line) <= last {
				lines = append(lines, line)
			}
		}
	}
	for index, line := range archive.pending {
		line.Line = uint(archive.next) + uint(index)
		if uint64(line.Line) >= first && uint64(line.Line) <= last {
			lines = append(lines, line)
		}
	}
	return lines, nil
}

// SetEnabled establishes a new privacy boundary. Enabling starts from rows that
// are resident now; it does not backfill any history produced while disabled.
func (archive *HistoryArchive) SetEnabled(enabled bool) error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if archive.enabled == enabled {
		return nil
	}
	archive.pending = nil
	archive.bytes = 0
	archive.tracker.Close()
	archive.tracker = NewHistoryTracker(archive.tracker.shadow)
	if enabled {
		if _, err := archive.tracker.Collect(); err != nil {
			return err
		}
	}
	archive.enabled = enabled
	return nil
}

// Record observes native eviction after the primary shadow accepted PTY output.
func (archive *HistoryArchive) Record() error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if !archive.enabled {
		return nil
	}
	lines, err := archive.tracker.Collect()
	if err != nil {
		return err
	}
	if len(lines) == 0 {
		return nil
	}
	archive.pending = append(archive.pending, lines...)
	archive.last = time.Now()
	for _, line := range lines {
		for _, run := range line.Runs {
			archive.bytes += len(run.Text) + len(run.SGR)
		}
	}
	if archive.bytes < history.TargetBatchBytes {
		return nil
	}
	return archive.flushLocked()
}

// FlushIdle commits a smaller batch only after output has been quiet for the
// supplied interval. Normal high-volume writes flush at TargetBatchBytes.
func (archive *HistoryArchive) FlushIdle(after time.Duration) error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	if len(archive.pending) == 0 || archive.last.IsZero() || time.Since(archive.last) < after {
		return nil
	}
	return archive.flushLocked()
}

func (archive *HistoryArchive) Flush() error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	return archive.flushLocked()
}

func (archive *HistoryArchive) flushLocked() error {
	if len(archive.pending) == 0 {
		return nil
	}
	lines := append([]ScrollbackLine(nil), archive.pending...)
	for index := range lines {
		lines[index].Line = uint(archive.next) + uint(index)
	}
	data, err := msgpack.Marshal(lines)
	if err != nil {
		return fmt.Errorf("encode mux history batch: %w", err)
	}
	last := archive.next + uint64(len(lines)) - 1
	if err := archive.store.Append(history.Record{SessionID: archive.session, PaneID: archive.pane, FirstLine: archive.next, LastLine: last, Data: data}); err != nil {
		return fmt.Errorf("append mux history batch: %w", err)
	}
	archive.next = last + 1
	archive.pending = nil
	archive.bytes = 0
	return nil
}

func (archive *HistoryArchive) Close() error {
	archive.mu.Lock()
	defer archive.mu.Unlock()
	err := archive.flushLocked()
	archive.tracker.Close()
	return err
}
