//go:build !libghostty

package daemon

// newSessionAttachment keeps the pure-Go protocol/control-plane suite independent
// of a local Ghostty build. The runnable M1A daemon is built with libghostty.
func newSessionAttachment(*Pane, string, string, bool, bool, ...uint) (sessionAttachment, error) {
	return nil, nil
}
