//go:build darwin

package daemon

import "golang.org/x/sys/unix"

// Darwin's kernel process table uses SZOMB (5) for an exited child whose wait
// status has not yet been consumed. Keeping that zombie unreaped preserves its
// PID/SID while mux-owned descendants are terminated.
const darwinZombieState = 5

func observeOwnedChildExit(pid int) (bool, error) {
	process, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return false, err
	}
	if int(process.Proc.P_pid) != pid {
		return false, unix.ESRCH
	}
	return process.Proc.P_stat == darwinZombieState, nil
}
