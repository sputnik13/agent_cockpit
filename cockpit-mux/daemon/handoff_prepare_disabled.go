//go:build !libghostty

package daemon

import (
	"context"
	"fmt"
)

func (operations *Operations) PrepareHandoff(context.Context) (*PreparedHandoff, error) {
	return nil, fmt.Errorf("mux handoff preparation requires libghostty")
}
