//go:build libghostty

package daemon

import (
	"fmt"

	ghostty "go.mitchellh.com/libghostty"
)

// Snapshot captures the authoritative libghostty-vt Snapshot v1 payload.
func (shadow *Shadow) Snapshot() ([]byte, error) {
	shadow.mu.Lock()
	defer shadow.mu.Unlock()
	snapshot, err := shadow.terminal.Snapshot()
	if err != nil {
		return nil, fmt.Errorf("snapshot Ghostty shadow: %w", err)
	}
	return snapshot, nil
}

func EngineVersion() (string, error) {
	info, err := ghostty.GetBuildInfo()
	if err != nil {
		return "", fmt.Errorf("read Ghostty build info: %w", err)
	}
	return info.VersionString, nil
}

// RestoreShadow imports a validated Snapshot v1 into an independent shadow.
func RestoreShadow(snapshot []byte) (*Shadow, error) {
	decoder, err := ghostty.NewSnapshotDecoderBytesCopy(snapshot)
	if err != nil {
		return nil, fmt.Errorf("create Ghostty snapshot decoder: %w", err)
	}
	defer decoder.Close()
	if err := decoder.SetMaxContinuationBytes(continuationMaxBytes); err != nil {
		return nil, fmt.Errorf("set snapshot continuation limit: %w", err)
	}
	if err := decoder.SetRetainContinuation(true); err != nil {
		return nil, fmt.Errorf("retain snapshot continuation: %w", err)
	}
	terminal, err := decoder.Decode()
	if err != nil {
		return nil, fmt.Errorf("decode Ghostty snapshot: %w", err)
	}
	return &Shadow{terminal: terminal}, nil
}
