//go:build linux

package main

import (
	"net"
	"os"
	"syscall"
)

// defaultPeerAllowed vets an accepted connection on Linux with SO_PEERCRED
// (requirement 2): the peer must be the helper's own user. The 0700 socket
// directory is the real barrier; this is the second line, and it fails CLOSED —
// a connection whose credentials cannot be read is refused.
func defaultPeerAllowed(conn *net.UnixConn) bool {
	uid, ok := peerUID(conn)
	return ok && int(uid) == os.Geteuid()
}

// peerUID reads the connected peer's uid with getsockopt(SO_PEERCRED).
func peerUID(conn *net.UnixConn) (uint32, bool) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, false
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || credErr != nil || cred == nil {
		return 0, false
	}
	return cred.Uid, true
}
