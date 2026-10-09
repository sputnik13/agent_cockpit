// Package daemon owns the isolated local mux runtime.
package daemon

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
)

const socketName = "mux.sock"

// Unix-domain socket paths are short (104 bytes on Darwin). Keep the ordinary
// socket beside its private state, but move only an overlong endpoint into a
// per-user private runtime directory. The hash keeps independent mux homes
// separate without leaking the full home path into /tmp.
const maxHomeSocketPath = 90

// Home contains all mutable state for one standalone mux daemon. M1A intentionally
// owns no persistence beyond this runtime directory.
type Home struct {
	Path       string
	SocketPath string
}

// OpenHome creates a private mux home or verifies that an existing one is private.
func OpenHome(path string) (Home, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return Home{}, fmt.Errorf("resolve mux home: %w", err)
	}
	path = filepath.Clean(absPath)
	if err := os.MkdirAll(path, 0o700); err != nil {
		return Home{}, fmt.Errorf("create mux home: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return Home{}, fmt.Errorf("stat mux home: %w", err)
	}
	if !info.IsDir() {
		return Home{}, fmt.Errorf("mux home is not a directory: %s", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return Home{}, fmt.Errorf("mux home is accessible by other users: %s", path)
	}
	socketPath, runtimeDir := SocketPath(path)
	if runtimeDir != "" {
		if err := ensurePrivateRuntimeDir(runtimeDir); err != nil {
			return Home{}, err
		}
	}
	return Home{Path: path, SocketPath: socketPath}, nil
}

// SocketPath returns the daemon endpoint for home and, when it is separate from
// the mux home, the private runtime directory that must exist before listening.
// It is exported so the standalone CLI and Electron launcher use the same path.
func SocketPath(home string) (path string, runtimeDir string) {
	home = filepath.Clean(home)
	ordinary := filepath.Join(home, socketName)
	if len(ordinary) <= maxHomeSocketPath {
		return ordinary, ""
	}
	hash := sha256.Sum256([]byte(home))
	runtimeDir = filepath.Join("/tmp", fmt.Sprintf("acm-%d", os.Getuid()))
	return filepath.Join(runtimeDir, fmt.Sprintf("%x.sock", hash[:12])), runtimeDir
}

func ensurePrivateRuntimeDir(path string) error {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create private mux runtime directory: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect private mux runtime directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("private mux runtime path is not a directory: %s", path)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private mux runtime directory is accessible by other users: %s", path)
	}
	return nil
}
