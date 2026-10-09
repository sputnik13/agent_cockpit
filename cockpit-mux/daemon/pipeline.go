//go:build libghostty

package daemon

import (
	"fmt"
	"sync"
)

// Pipeline is the M1A dual path: every PTY chunk is forwarded unchanged to the
// live stream and independently fed into the authoritative Ghostty shadow.
type Pipeline struct {
	mu            sync.Mutex
	Pane          *Pane
	Shadow        *Shadow
	Primary       *Shadow
	Stream        Stream
	Modes         ModeState
	OnPrimaryFeed func() error
	OnOutput      func(Output) error
	primaryMirror primaryMirror
	cols          uint16
	rows          uint16
	cellWidth     uint16
	cellHeight    uint16
}

func (pipeline *Pipeline) Pump(buffer []byte) (Output, error) {
	n, _, err := pipeline.Pane.ReadLive(buffer)
	if n > 0 {
		data := append([]byte(nil), buffer[:n]...)
		pipeline.mu.Lock()
		defer pipeline.mu.Unlock()
		pipeline.Shadow.Feed(data)
		if pipeline.Primary != nil {
			if err := pipeline.primaryMirror.FeedWithHook(pipeline.Primary, data, pipeline.OnPrimaryFeed); err != nil {
				return Output{}, err
			}
		}
		pipeline.Modes.Observe(data)
		outputs := pipeline.Stream.Append(data)
		if pipeline.OnOutput != nil {
			for _, output := range outputs {
				if recordErr := pipeline.OnOutput(output); recordErr != nil {
					return output, recordErr
				}
			}
		}
		return outputs[len(outputs)-1], err
	}
	return Output{}, err
}

// Attach resizes the authoritative shadow and PTY before producing a seed. The
// Stream lock makes ResumeSequence the first later raw-output chunk.
func (pipeline *Pipeline) Attach(cols, rows, cellWidth, cellHeight uint16) (Seed, error) {
	pipeline.mu.Lock()
	defer pipeline.mu.Unlock()
	if err := pipeline.resizeLocked(cols, rows, cellWidth, cellHeight); err != nil {
		return Seed{}, err
	}
	return pipeline.Stream.SnapshotWithGraphics(func() ([]byte, []byte, error) {
		altSeed, err := pipeline.Shadow.Seed()
		if err != nil {
			return nil, nil, err
		}
		prefix := pipeline.Modes.Prefix()
		seed := append(prefix, altSeed...)
		if pipeline.Primary != nil && pipeline.Modes.AlternateScreen {
			primary, err := pipeline.Primary.Seed()
			if err != nil {
				return nil, nil, err
			}
			if pipeline.primaryMirror.savedCursor {
				saved, err := pipeline.Primary.SavedCursorSeed()
				if err != nil {
					return nil, nil, err
				}
				primary = append(primary, saved...)
				primary = append(primary, "\x1b7"...)
				current, err := pipeline.Primary.Seed()
				if err != nil {
					return nil, nil, err
				}
				primary = append(primary, current...)
			}
			seed = append(primary, seed...)
		}
		if pipeline.Modes.HasSavedCursor() {
			saved, err := pipeline.Shadow.SavedCursorSeed()
			if err != nil {
				return nil, nil, err
			}
			seed = append(seed, saved...)
			seed = append(seed, "\x1b7"...)
			seed = append(seed, altSeed...)
		}
		graphics, err := pipeline.Shadow.GraphicsSeed()
		if err != nil {
			return nil, nil, err
		}
		return seed, graphics, nil
	})
}

// Resize keeps the PTY and authoritative shadow at the same geometry between
// attaches, so a later seed never reflows stale dimensions.
func (pipeline *Pipeline) Resize(cols, rows uint16) error {
	pipeline.mu.Lock()
	defer pipeline.mu.Unlock()
	return pipeline.resizeLocked(cols, rows, pipeline.cellWidth, pipeline.cellHeight)
}

// Scrollback always exposes primary-screen history. While an application owns
// the alternate screen, Shadow is intentionally that active screen; Primary is
// the separately maintained primary-only mirror and therefore the only source
// for shell history.
func (pipeline *Pipeline) Scrollback(before, count uint) ([]ScrollbackLine, error) {
	pipeline.mu.Lock()
	defer pipeline.mu.Unlock()
	shadow := pipeline.Shadow
	if pipeline.Modes.AlternateScreen && pipeline.Primary != nil {
		shadow = pipeline.Primary
	}
	return shadow.Scrollback(before, count)
}

func (pipeline *Pipeline) ScrollbackCount() (uint, error) {
	pipeline.mu.Lock()
	defer pipeline.mu.Unlock()
	shadow := pipeline.Shadow
	if pipeline.Primary != nil {
		shadow = pipeline.Primary
	}
	return shadow.ScrollbackCount()
}

func (pipeline *Pipeline) resizeLocked(cols, rows, cellWidth, cellHeight uint16) error {
	// A non-graphical client omits pixel dimensions. Preserve the last real
	// renderer geometry rather than erasing it during a text-only resize.
	if cellWidth == 0 || cellHeight == 0 {
		cellWidth, cellHeight = pipeline.cellWidth, pipeline.cellHeight
	}
	if err := pipeline.Shadow.ResizeWithPixels(cols, rows, cellWidth, cellHeight); err != nil {
		return err
	}
	if pipeline.Primary != nil {
		if err := pipeline.Primary.ResizeWithPixels(cols, rows, cellWidth, cellHeight); err != nil {
			return err
		}
	}
	if err := pipeline.Pane.Resize(cols, rows); err != nil {
		return fmt.Errorf("resize pane before seed: %w", err)
	}
	pipeline.cols = cols
	pipeline.rows = rows
	pipeline.cellWidth = cellWidth
	pipeline.cellHeight = cellHeight
	return nil
}
