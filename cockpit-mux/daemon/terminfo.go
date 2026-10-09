package daemon

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const terminalIdentity = "xterm-ghostty"

// ghosttyTerminfo is generated from the exact Ghostty revision pinned by the
// mux build. The same entry is installed under both ncurses directory shapes:
// macOS uses a hexadecimal first-byte directory (78), while Linux commonly
// uses the literal first character (x).
//
//go:embed assets/xterm-ghostty
var ghosttyTerminfo []byte

var childTerminfo = struct {
	sync.RWMutex
	directory string
}{}

// ConfigureTerminfo makes the bundled Ghostty entry available to every PTY
// started by this daemon. It deliberately lives inside the private mux home so
// neither a local nor remote host needs a system-wide terminfo installation.
func ConfigureTerminfo(home Home) (string, error) {
	directory := filepath.Join(home.Path, "terminfo")
	for _, relative := range []string{
		filepath.Join("78", terminalIdentity),
		filepath.Join("x", terminalIdentity),
		filepath.Join("67", "ghostty"),
		filepath.Join("g", "ghostty"),
	} {
		path := filepath.Join(directory, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return "", fmt.Errorf("create mux terminfo directory: %w", err)
		}
		existing, err := os.ReadFile(path)
		if err == nil && bytes.Equal(existing, ghosttyTerminfo) {
			continue
		}
		if err := os.WriteFile(path, ghosttyTerminfo, 0o600); err != nil {
			return "", fmt.Errorf("write mux Ghostty terminfo: %w", err)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", fmt.Errorf("protect mux Ghostty terminfo: %w", err)
		}
	}
	childTerminfo.Lock()
	childTerminfo.directory = directory
	childTerminfo.Unlock()
	return directory, nil
}

func paneTerminfoDirectory() string {
	childTerminfo.RLock()
	defer childTerminfo.RUnlock()
	return childTerminfo.directory
}
