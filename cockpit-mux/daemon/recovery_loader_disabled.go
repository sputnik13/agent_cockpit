//go:build !libghostty

package daemon

func loadRecoveredSession(string) (*managedSession, error) { return nil, nil }

func loadRecoveredCatalog(string) ([]*managedSession, error) { return nil, nil }
