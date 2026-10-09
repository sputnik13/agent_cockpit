//go:build libghostty

package daemon

import "bytes"

// primaryMirror keeps a primary-only shadow. libghostty's formatter emits the
// active screen, so an alternate-screen attach needs a separately formatted
// primary seed before the alternate seed. The mirror removes only 1049 switches
// and ignores bytes while the application is on the alternate screen.
type primaryMirror struct {
	alternate   bool
	pending     []byte
	savedCursor bool
}

func (mirror *primaryMirror) Feed(shadow *Shadow, data []byte) {
	_ = mirror.FeedWithHook(shadow, data, nil)
}

// FeedWithHook emits each bounded primary-shadow update through hook. Splitting
// is safe because libghostty retains parser state; it gives optional history
// archival a chance to observe native page eviction within one large PTY read.
func (mirror *primaryMirror) FeedWithHook(shadow *Shadow, data []byte, hook func() error) error {
	data = append(append([]byte(nil), mirror.pending...), data...)
	mirror.pending = nil
	for len(data) > 0 {
		if mirror.alternate {
			index := bytes.Index(data, []byte("\x1b[?1049l"))
			if index < 0 {
				mirror.keep(data)
				return nil
			}
			mirror.alternate = false
			data = data[index+len("\x1b[?1049l"):]
			continue
		}

		index := bytes.Index(data, []byte("\x1b[?1049h"))
		if index < 0 {
			// Retain a possible split 1049 sequence but immediately feed the
			// confirmed primary bytes before it.
			keep := len(data)
			for suffix := len("\x1b[?1049h") - 1; suffix > 0; suffix-- {
				if len(data) >= suffix && bytes.Equal(data[len(data)-suffix:], []byte("\x1b[?1049h")[:suffix]) {
					keep = len(data) - suffix
					break
				}
			}
			if keep > 0 {
				if err := mirror.feed(shadow, data[:keep], hook); err != nil {
					return err
				}
			}
			mirror.keep(data[keep:])
			return nil
		}
		if index > 0 {
			if err := mirror.feed(shadow, data[:index], hook); err != nil {
				return err
			}
		}
		mirror.alternate = true
		data = data[index+len("\x1b[?1049h"):]
	}
	return nil
}

func (mirror *primaryMirror) feed(shadow *Shadow, data []byte, hook func() error) error {
	if bytes.Contains(data, []byte("\x1b7")) {
		mirror.savedCursor = true
	}
	if bytes.Contains(data, []byte("\x1bc")) {
		mirror.savedCursor = false
	}
	const archiveObservationChunk = 512
	for len(data) > 0 {
		end := archiveObservationChunk
		if end > len(data) {
			end = len(data)
		}
		shadow.Feed(data[:end])
		if hook != nil {
			if err := hook(); err != nil {
				return err
			}
		}
		data = data[end:]
	}
	return nil
}

func (mirror *primaryMirror) keep(data []byte) {
	const maxPending = len("\x1b[?1049l") - 1
	if len(data) > maxPending {
		data = data[len(data)-maxPending:]
	}
	mirror.pending = append(mirror.pending[:0], data...)
}
