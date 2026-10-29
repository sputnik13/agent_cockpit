package main

// Where a project's callback socket lives on THIS host, and the directory checks
// that make that location the access-control boundary (requirements 2 and 4 of
// docs/requirements/terminal-callback-socket.md). The local counterpart is
// electron/main/callback/socketPath.ts; this file is the remote one.
//
// Primary: under $XDG_RUNTIME_DIR/agent-cockpit/callback/ when set, otherwise
// ~/.agent-cockpit/callback/, named <hosthash>-<h>.sock where <h> is the first 12
// hex characters of SHA-256(projectId) (the same value main derives) and
// <hosthash> is the first 8 of SHA-256(host name), because a remote home may be
// shared over NFS between hosts and a socket is only reachable on the host that
// bound it.
//
// A unix socket path is limited to 104 bytes on macOS (108 on Linux) and the
// takeover temp name needs a few more, so a path over the 90-byte guard (the same
// guard main uses) — or one that could not be injected into an environment — falls
// back to the literal /tmp/ac-cb-<uid>/<hosthash>-<h>.sock. Exceeding the guard
// never disables the feature: the helper returns the real path in the handshake,
// so the location of the socket never matters to the CLI.
//
// The directory is created 0700 and verified with lstat (a directory, not a
// symlink, owned by the current user, no group/other access) or the project's
// callback fails closed.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// callbackSocketPathGuardBytes is the longest socket path (bytes) the helper
// binds: below the OS limit, leaving room for the takeover temp name.
const callbackSocketPathGuardBytes = 90

type callbackPathErrorCode string

const (
	pathInvalidValue callbackPathErrorCode = "invalid-value"
	pathTooLong      callbackPathErrorCode = "too-long"
	pathUnsafeDir    callbackPathErrorCode = "unsafe-dir"
	pathDirError     callbackPathErrorCode = "dir-error"
)

// callbackPathError says why no usable, safe socket location exists.
type callbackPathError struct {
	code callbackPathErrorCode
	msg  string
}

func (e *callbackPathError) Error() string { return e.msg }

// callbackLocation is a derived socket location.
type callbackLocation struct {
	socketPath string
	// dir is the directory holding the socket (and nothing else of ours).
	dir string
	// fallback is true when the primary path was unusable and /tmp was chosen.
	fallback bool
}

type callbackLocationOptions struct {
	projectID string
	hostname  string
	// home is the user's home directory; "" when unknown.
	home string
	// xdgRuntimeDir is $XDG_RUNTIME_DIR; ignored unless absolute.
	xdgRuntimeDir string
	uid           int
	// tmpRoot is the parent of the fallback directory; "" means the literal /tmp.
	// Tests inject a private directory so they never touch the shared one.
	tmpRoot string
}

func sha256Hex(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

// callbackProjectHash is the first 12 hex characters of SHA-256(projectId): the
// stable per-project socket name (identical to projectHash in socketPath.ts).
func callbackProjectHash(projectID string) string { return sha256Hex(projectID)[:12] }

// callbackHostHash is the first 8 hex characters of SHA-256(host name).
func callbackHostHash(hostname string) string { return sha256Hex(hostname)[:8] }

// deriveCallbackLocation is the pure path derivation (no I/O). It falls back to
// /tmp when the primary path is unavailable, too long or not injectable, and
// fails only when no usable path exists even then.
func deriveCallbackLocation(opts callbackLocationOptions) (callbackLocation, error) {
	name := callbackHostHash(opts.hostname) + "-" + callbackProjectHash(opts.projectID) + ".sock"

	var primaryDir string
	switch {
	case opts.xdgRuntimeDir != "" && filepath.IsAbs(opts.xdgRuntimeDir):
		primaryDir = filepath.Join(opts.xdgRuntimeDir, "agent-cockpit", "callback")
	case opts.home != "":
		primaryDir = filepath.Join(opts.home, ".agent-cockpit", "callback")
	}

	var location callbackLocation
	if primaryDir != "" {
		primary := filepath.Join(primaryDir, name)
		if len(primary) <= callbackSocketPathGuardBytes && isInjectableEnvValue(primary) {
			location = callbackLocation{socketPath: primary, dir: primaryDir}
		}
	}
	if location.socketPath == "" {
		tmpRoot := opts.tmpRoot
		if tmpRoot == "" {
			tmpRoot = "/tmp"
		}
		dir := filepath.Join(tmpRoot, fmt.Sprintf("ac-cb-%d", opts.uid))
		location = callbackLocation{socketPath: filepath.Join(dir, name), dir: dir, fallback: true}
	}

	if !isInjectableEnvValue(location.socketPath) {
		return callbackLocation{}, &callbackPathError{pathInvalidValue, "socket path contains NUL or a line break"}
	}
	if n := len(location.socketPath); n > callbackSocketPathGuardBytes {
		return callbackLocation{}, &callbackPathError{
			pathTooLong,
			fmt.Sprintf("socket path is %d bytes even after the /tmp fallback (limit %d)", n, callbackSocketPathGuardBytes),
		}
	}
	return location, nil
}

// preparePrivateDir creates dir 0700 if absent, then verifies it by lstat and
// fails closed on anything unexpected: it must be a real directory (not a
// symlink), owned by uid, with no group/other access. Only the directory itself
// is verified: its pre-existing parents are not ours to judge.
func preparePrivateDir(dir string, uid int) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return &callbackPathError{pathDirError, fmt.Sprintf("cannot create %s: %v", dir, err)}
	}
	st, err := os.Lstat(dir)
	if err != nil {
		return &callbackPathError{pathDirError, fmt.Sprintf("cannot stat %s: %v", dir, err)}
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return &callbackPathError{pathUnsafeDir, dir + " is a symlink"}
	}
	if !st.IsDir() {
		return &callbackPathError{pathUnsafeDir, dir + " is not a directory"}
	}
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return &callbackPathError{pathDirError, "cannot determine the owner of " + dir}
	}
	if int(sys.Uid) != uid {
		return &callbackPathError{pathUnsafeDir, fmt.Sprintf("%s is owned by uid %d, not %d", dir, sys.Uid, uid)}
	}
	if st.Mode().Perm()&0o077 != 0 {
		return &callbackPathError{
			pathUnsafeDir,
			fmt.Sprintf("%s grants group/other access (mode %o); it must be 700", dir, st.Mode().Perm()),
		}
	}
	return nil
}
