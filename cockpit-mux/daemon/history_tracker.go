//go:build libghostty

package daemon

import (
	"fmt"
	"sort"

	ghostty "go.mitchellh.com/libghostty"
)

// HistoryTracker follows native scrollback rows until Ghostty discards them.
// The cached formatted rows are then safe to archive without replaying a raw
// VT stream. Trackers are deliberately owned by the daemon, never a renderer.
type HistoryTracker struct {
	shadow  *Shadow
	entries []trackedHistoryLine
}

type trackedHistoryLine struct {
	ref  *ghostty.TrackedGridRef
	line ScrollbackLine
}

func NewHistoryTracker(shadow *Shadow) *HistoryTracker {
	return &HistoryTracker{shadow: shadow}
}

// Collect returns rows that disappeared since the previous collection, then
// begins tracking every currently resident native history row. It must be
// called after each primary-screen terminal update while archive persistence is
// enabled. Ghostty owns all terminal parsing and eviction decisions.
func (tracker *HistoryTracker) Collect() ([]ScrollbackLine, error) {
	tracker.shadow.mu.Lock()
	defer tracker.shadow.mu.Unlock()

	archived := make([]ScrollbackLine, 0)
	retained := tracker.entries[:0]
	for _, entry := range tracker.entries {
		if !entry.ref.HasValue() {
			archived = append(archived, entry.line)
			entry.ref.Close()
			continue
		}
		retained = append(retained, entry)
	}
	tracker.entries = retained

	total, err := tracker.shadow.terminal.ScrollbackRows()
	if err != nil {
		return nil, fmt.Errorf("read Ghostty scrollback for archive: %w", err)
	}
	cols, err := tracker.shadow.terminal.Cols()
	if err != nil {
		return nil, fmt.Errorf("read Ghostty columns for archive: %w", err)
	}
	tracked := make(map[uint32]struct{}, len(tracker.entries))
	for _, entry := range tracker.entries {
		point, err := entry.ref.Point(ghostty.PointTagHistory)
		if err != nil {
			return nil, fmt.Errorf("locate tracked Ghostty history row: %w", err)
		}
		tracked[point.Y] = struct{}{}
	}
	for y := uint(0); y < total; y++ {
		if _, ok := tracked[uint32(y)]; ok {
			continue
		}
		line, err := tracker.shadow.historyLine(y, cols)
		if err != nil {
			return nil, err
		}
		ref, err := tracker.shadow.terminal.TrackGridRef(ghostty.Point{Tag: ghostty.PointTagHistory, X: 0, Y: uint32(y)})
		if err != nil {
			return nil, fmt.Errorf("track Ghostty history row: %w", err)
		}
		tracker.entries = append(tracker.entries, trackedHistoryLine{ref: ref, line: line})
	}
	// Existing tracked refs move as history grows, so sort by the current native
	// order before the next eviction pass. Entries with no value were already
	// emitted above and therefore never reach this comparator.
	sort.SliceStable(tracker.entries, func(left, right int) bool {
		leftPoint, _ := tracker.entries[left].ref.Point(ghostty.PointTagHistory)
		rightPoint, _ := tracker.entries[right].ref.Point(ghostty.PointTagHistory)
		return leftPoint.Y < rightPoint.Y
	})
	return archived, nil
}

func (tracker *HistoryTracker) Close() {
	for _, entry := range tracker.entries {
		entry.ref.Close()
	}
	tracker.entries = nil
}
