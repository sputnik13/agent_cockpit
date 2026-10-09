//go:build !libghostty

package daemon

import (
	"fmt"
	"os"
)

func NewHandoffOperations(Home, bool, ...uint) *Operations { return NewOperations() }

func (operations *Operations) AdoptHandoff(HandoffManifest, []*os.File) error {
	return fmt.Errorf("mux handoff adoption requires libghostty")
}
