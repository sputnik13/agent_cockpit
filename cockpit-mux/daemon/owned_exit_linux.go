//go:build linux

package daemon

import "golang.org/x/sys/unix"

func observeOwnedChildExit(pid int) (bool, error) {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return false, err
		}
		return info.Signo != 0, nil
	}
}
