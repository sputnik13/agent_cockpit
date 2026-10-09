//go:build libghostty

package daemon

import (
	"fmt"
	"sync"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
	"github.com/vmihailenco/msgpack/v5"
)

type recoveryMetadata struct {
	Modes              []byte `msgpack:"modes"`
	PrimarySavedCursor bool   `msgpack:"primary_saved_cursor"`
	Cols               uint16 `msgpack:"cols"`
	Rows               uint16 `msgpack:"rows"`
}

func marshalRecoveryMetadata(modes ModeState, primarySavedCursor bool, cols, rows uint16) ([]byte, error) {
	encodedModes, err := modes.MarshalPersistence()
	if err != nil {
		return nil, err
	}
	return msgpack.Marshal(recoveryMetadata{Modes: encodedModes, PrimarySavedCursor: primarySavedCursor, Cols: cols, Rows: rows})
}

// recoveredAttachment exposes an exited record for seed-only inspection. It has no
// Pane, so all write/resize-to-PTY paths are rejected by Operations.
type recoveredAttachment struct {
	mu            sync.Mutex
	shadow        *Shadow
	primary       *Shadow
	modes         ModeState
	primaryMirror primaryMirror
	recordedCols  uint16
	recordedRows  uint16
}

var recoveredAttachmentDone = func() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}()

func newRecoveredAttachment(keyframe persistence.Keyframe) (*recoveredAttachment, error) {
	if keyframe.Boundary == "forced" {
		return nil, fmt.Errorf("forced-boundary recovery record is diagnostic-only")
	}
	if len(keyframe.PrimarySnapshot) == 0 || len(keyframe.Metadata) == 0 {
		return nil, fmt.Errorf("incomplete mux recovery record")
	}
	shadow, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		return nil, err
	}
	primary, err := RestoreShadow(keyframe.PrimarySnapshot)
	if err != nil {
		shadow.Close()
		return nil, err
	}
	var metadata recoveryMetadata
	if err := msgpack.Unmarshal(keyframe.Metadata, &metadata); err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	modes, err := RestoreModeState(metadata.Modes)
	if err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	return &recoveredAttachment{
		shadow: shadow, primary: primary, modes: modes,
		primaryMirror: primaryMirror{alternate: modes.AlternateScreen, savedCursor: metadata.PrimarySavedCursor},
		recordedCols:  metadata.Cols, recordedRows: metadata.Rows,
	}, nil
}

func (attachment *recoveredAttachment) Attach(cols, rows, cellWidth, cellHeight uint16) (Seed, error) {
	attachment.mu.Lock()
	defer attachment.mu.Unlock()
	if err := attachment.shadow.ResizeWithPixels(cols, rows, cellWidth, cellHeight); err != nil {
		return Seed{}, err
	}
	if err := attachment.primary.ResizeWithPixels(cols, rows, cellWidth, cellHeight); err != nil {
		return Seed{}, err
	}
	active, err := attachment.shadow.Seed()
	if err != nil {
		return Seed{}, err
	}
	seed := append(attachment.modes.Prefix(), active...)
	if attachment.modes.AlternateScreen {
		primary, err := attachment.primary.Seed()
		if err != nil {
			return Seed{}, err
		}
		if attachment.primaryMirror.savedCursor {
			saved, err := attachment.primary.SavedCursorSeed()
			if err != nil {
				return Seed{}, err
			}
			primary = append(primary, saved...)
			primary = append(primary, "\x1b7"...)
			current, err := attachment.primary.Seed()
			if err != nil {
				return Seed{}, err
			}
			primary = append(primary, current...)
		}
		seed = append(primary, seed...)
	}
	if attachment.modes.HasSavedCursor() {
		saved, err := attachment.shadow.SavedCursorSeed()
		if err != nil {
			return Seed{}, err
		}
		seed = append(seed, saved...)
		seed = append(seed, "\x1b7"...)
		seed = append(seed, active...)
	}
	return Seed{Data: seed, ResumeSequence: 1}, nil
}

func (attachment *recoveredAttachment) Resize(uint16, uint16) error {
	return fmt.Errorf("recovered mux pane is read-only")
}
func (attachment *recoveredAttachment) OutputsFrom(uint64) []Output             { return nil }
func (attachment *recoveredAttachment) OutputsFromBounded(uint64, int) []Output { return nil }
func (attachment *recoveredAttachment) Scrollback(before, count uint) ([]ScrollbackLine, error) {
	attachment.mu.Lock()
	defer attachment.mu.Unlock()
	shadow := attachment.shadow
	if attachment.modes.AlternateScreen && attachment.primary != nil {
		shadow = attachment.primary
	}
	return shadow.Scrollback(before, count)
}
func (attachment *recoveredAttachment) SetPersistScrollback(bool) error { return nil }
func (attachment *recoveredAttachment) SetScrollbackLines(uint) error   { return nil }
func (attachment *recoveredAttachment) EnablePersistence(string, string, bool, bool) error {
	return nil
}
func (attachment *recoveredAttachment) Start() error          { return nil }
func (attachment *recoveredAttachment) Finalize() error       { return nil }
func (attachment *recoveredAttachment) Done() <-chan struct{} { return recoveredAttachmentDone }
func (attachment *recoveredAttachment) Close() error {
	attachment.shadow.Close()
	attachment.primary.Close()
	return nil
}
