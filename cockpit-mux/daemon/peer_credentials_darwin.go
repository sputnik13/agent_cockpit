//go:build darwin

package daemon

import (
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

func readPeerUID(connection *net.UnixConn) (uint32, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return 0, fmt.Errorf("obtain socket descriptor: %w", err)
	}

	var uid uint32
	var credentialErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, err := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if err != nil {
			credentialErr = err
			return
		}
		uid = credentials.Uid
	}); err != nil {
		return 0, fmt.Errorf("inspect socket descriptor: %w", err)
	}
	if credentialErr != nil {
		return 0, fmt.Errorf("get LOCAL_PEERCRED: %w", credentialErr)
	}
	return uid, nil
}
