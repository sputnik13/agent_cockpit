//go:build !linux

package main

import "net"

// defaultPeerAllowed is the platform default peer check. Only Linux checks the
// peer's uid (SO_PEERCRED, see callback_peercred_linux.go); elsewhere the 0700
// socket directory is the only barrier, which the requirements state as the trust
// boundary rather than hiding it (docs/requirements/terminal-callback-socket.md,
// requirement 2).
func defaultPeerAllowed(*net.UnixConn) bool { return true }
