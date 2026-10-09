//go:build !libghostty

package daemon

import "fmt"

// A non-native control-plane build never accepts a live handoff because it has
// no Ghostty engine with which to verify the received Snapshot v1 payload.
func VerifyHandoffManifest(HandoffManifest) error {
	return fmt.Errorf("mux handoff verification requires libghostty")
}
