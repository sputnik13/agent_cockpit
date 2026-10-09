package daemon

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// Pane owns one local PTY process. Its raw output is always read before later shadow
// parsing layers, preserving byte-exact live delivery as an architectural boundary.
type Pane struct {
	master        *os.File
	cmd           *exec.Cmd
	pgid          int
	sid           int
	adopted       bool
	leaderStarted string

	mu             sync.Mutex
	terminateOnce  sync.Once
	terminateErr   error
	sequence       uint64
	waitDone       chan struct{}
	waitErr        error
	cleanupDone    chan struct{}
	observeExit    func(int) (bool, error)
	adoptedMembers map[int]string
}

// AdoptPane wraps a duplicated PTY master received during a live daemon
// handoff. The child process remains owned by the original session and is not
// reaped by the replacement daemon; its session leader is observed so natural
// exit can release any helpers that retain the PTY slave.
func AdoptPane(master *os.File, pgid int, leaderStarted string) (*Pane, error) {
	if master == nil {
		return nil, fmt.Errorf("adopt nil pane PTY")
	}
	if pgid <= 0 {
		return nil, fmt.Errorf("adopt pane PTY with invalid process group %d", pgid)
	}
	if leaderStarted == "" {
		return nil, fmt.Errorf("adopt pane PTY with no original leader identity")
	}
	started, err := processStartToken(pgid)
	if err != nil {
		return nil, fmt.Errorf("identify adopted pane session leader %d: %w", pgid, err)
	}
	if started != leaderStarted {
		return nil, fmt.Errorf("adopted pane session leader %d identity changed", pgid)
	}
	pane := &Pane{
		master: master, pgid: pgid, sid: pgid, adopted: true,
		leaderStarted: leaderStarted, adoptedMembers: make(map[int]string), waitDone: make(chan struct{}),
	}
	// Seed ownership before the replacement daemon can acknowledge handoff.
	// A process may exit immediately after the descriptor transfer commits, so
	// waiting for the periodic observer's first tick would leave an empty map.
	pane.captureAdoptedSessionMembers()
	go pane.waitAdoptedLeader()
	return pane, nil
}

// waitAdoptedLeader observes the original PTY session leader without owning or
// reaping it. Checking both the session ID and a process start token prevents a
// recycled PID from being mistaken for the transferred shell.
func (pane *Pane) waitAdoptedLeader() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		leaderAlive, ownershipVerified, definitive := pane.captureAdoptedSessionMembers()
		if ownershipVerified && !leaderAlive {
			close(pane.waitDone)
			return
		}
		if definitive && !ownershipVerified {
			close(pane.waitDone)
			return
		}
	}
}

// captureAdoptedSessionMembers snapshots identities only while the original
// session leader is still present with its original start token. Once that
// identity disappears, the numeric SID alone is ambiguous and must not be used
// to discover new signal targets; previously observed identities remain safe.
func (pane *Pane) captureAdoptedSessionMembers() (leaderAlive, ownershipVerified, definitive bool) {
	output, err := exec.Command("ps", "-axo", "pid=,stat=,lstart=").Output()
	if err != nil {
		return false, false, false
	}
	observed := make(map[int]string)
	leaderFound := false
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		pid, parseErr := strconv.Atoi(fields[0])
		if parseErr != nil || pid <= 0 {
			continue
		}
		started := normalizeProcessStartToken(strings.Join(fields[2:], " "))
		if pid == pane.sid {
			leaderFound = true
			if started != pane.leaderStarted {
				return false, false, true
			}
			leaderAlive = !strings.HasPrefix(fields[1], "Z")
		}
		if strings.HasPrefix(fields[1], "Z") {
			continue
		}
		sid, sidErr := unix.Getsid(pid)
		if sidErr == nil && sid == pane.sid {
			observed[pid] = started
		}
	}
	if !leaderFound {
		return false, false, true
	}
	pane.mu.Lock()
	for pid, started := range observed {
		pane.adoptedMembers[pid] = started
	}
	pane.mu.Unlock()
	return leaderAlive, true, true
}

func processStartToken(pid int) (string, error) {
	output, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return "", err
	}
	started := normalizeProcessStartToken(string(output))
	if started == "" {
		return "", fmt.Errorf("process %d is not present", pid)
	}
	return started, nil
}

func normalizeProcessStartToken(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

// StartPane launches command under a Ghostty-capable terminal environment.
func StartPane(command string, args ...string) (*Pane, error) {
	return StartPaneInDir(command, "", args...)
}

// StartPaneInDir launches a command under a PTY rooted at cwd. Keeping the
// original StartPane entrypoint preserves the small fixture/test surface while
// letting remote clients create project-rooted mux sessions without a shell
// interpolation step.
func StartPaneInDir(command, cwd string, args ...string) (*Pane, error) {
	return startPaneInDir(command, cwd, observeOwnedChildExit, args...)
}

func startPaneInDir(command, cwd string, observer func(int) (bool, error), args ...string) (*Pane, error) {
	cmd := exec.Command(command, args...)
	if cwd != "" {
		cmd.Dir = cwd
	}
	cmd.Env = append(os.Environ(), "TERM="+terminalIdentity, "COLORTERM=truecolor", "TERM_PROGRAM=agent-cockpit")
	if terminfo := paneTerminfoDirectory(); terminfo != "" {
		cmd.Env = append(cmd.Env, "TERMINFO="+terminfo)
	}
	master, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("start pane PTY: %w", err)
	}
	sid, err := unix.Getsid(cmd.Process.Pid)
	if err != nil {
		_ = master.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("read pane process session: %w", err)
	}
	leaderStarted, err := processStartToken(cmd.Process.Pid)
	if err != nil {
		_ = master.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, fmt.Errorf("identify pane session leader %d: %w", cmd.Process.Pid, err)
	}
	pane := &Pane{
		master: master, cmd: cmd, pgid: cmd.Process.Pid, sid: sid,
		leaderStarted: leaderStarted, waitDone: make(chan struct{}), cleanupDone: make(chan struct{}), observeExit: observer,
	}
	go pane.waitOwnedLeader()
	return pane, nil
}

// waitOwnedLeader keeps the child waitable until its private session has been
// cleaned up. The unreaped leader pins its PID/SID, so session enumeration can
// never target an unrelated process after numeric SID reuse.
func (pane *Pane) waitOwnedLeader() {
	defer close(pane.waitDone)
	cleanupRequested := false
	for {
		exited, err := pane.observeExit(pane.cmd.Process.Pid)
		if err != nil {
			// If the platform observer fails, wait for the owned process directly
			// and fail closed: do not enumerate or signal a SID we cannot verify.
			pane.terminateOnce.Do(func() {
				pane.terminateErr = fmt.Errorf("session cleanup skipped after pane exit observer failure: %w", err)
				if pane.cleanupDone != nil {
					close(pane.cleanupDone)
				}
			})
			pane.waitErr = errors.Join(
				pane.cmd.Wait(),
				fmt.Errorf("observe pane process %d exit; cleanup state is fail-closed to avoid an unverified SID: %w", pane.sid, err),
			)
			return
		}
		if exited {
			break
		}
		if cleanupRequested {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		select {
		case <-pane.cleanupDone:
			// Explicit Terminate already stopped every process in the session.
			// Continue observing until the child is waitable, then reap it once.
			cleanupRequested = true
		case <-time.After(10 * time.Millisecond):
		}
	}
	_ = pane.terminateSessionProcesses()
	pane.waitErr = pane.cmd.Wait()
}

// ReadLive reads raw PTY output and assigns the monotonic output sequence used by
// the later attach-seed barrier.
func (pane *Pane) ReadLive(buffer []byte) (int, uint64, error) {
	n, err := pane.master.Read(buffer)
	if n > 0 {
		pane.mu.Lock()
		pane.sequence++
		sequence := pane.sequence
		pane.mu.Unlock()
		return n, sequence, err
	}
	return n, 0, err
}

// WriteInput forwards bytes without text conversion.
func (pane *Pane) WriteInput(data []byte) (int, error) {
	n, err := pane.master.Write(data)
	if err != nil {
		return n, fmt.Errorf("write pane input: %w", err)
	}
	return n, nil
}

// Resize changes the PTY geometry before a future attach seed is emitted.
func (pane *Pane) Resize(cols, rows uint16) error {
	return pty.Setsize(pane.master, &pty.Winsize{Cols: cols, Rows: rows})
}

// Geometry reads the kernel-owned PTY window size. The daemon keeps a requested
// geometry for durable topology, but callers that need to diagnose a live TUI
// must be able to distinguish it from the size the kernel actually accepted.
func (pane *Pane) Geometry() (cols, rows uint16, err error) {
	rowsValue, colsValue, err := pty.Getsize(pane.master)
	if err != nil {
		return 0, 0, fmt.Errorf("read PTY geometry: %w", err)
	}
	if colsValue < 0 || rowsValue < 0 || colsValue > int(^uint16(0)) || rowsValue > int(^uint16(0)) {
		return 0, 0, fmt.Errorf("invalid PTY geometry %dx%d", colsValue, rowsValue)
	}
	return uint16(colsValue), uint16(rowsValue), nil
}

// ProcessGroupID identifies the shell and helper processes owned by this PTY.
func (pane *Pane) ProcessGroupID() int {
	if pane.cmd != nil && pane.cmd.Process != nil {
		if pgid, err := syscall.Getpgid(pane.cmd.Process.Pid); err == nil {
			return pgid
		}
	}
	return pane.pgid
}

// LeaderStartToken identifies the original PTY session leader across handoff.
func (pane *Pane) LeaderStartToken() string {
	return pane.leaderStarted
}

// Wait reports the owned child process exit.
func (pane *Pane) Wait() error {
	if pane.waitDone == nil {
		return nil
	}
	<-pane.waitDone
	return pane.waitErr
}

// Close tears down the PTY master. It is idempotent at the OS boundary.
func (pane *Pane) Close() error {
	if err := pane.master.Close(); err != nil && !errors.Is(err, os.ErrClosed) && err != io.EOF {
		return fmt.Errorf("close pane PTY: %w", err)
	}
	return nil
}

// Terminate stops every process in the PTY's private session, closes the master
// to deliver terminal hangup, then waits for the owned shell to be reaped.
// Interactive job control can put helpers in distinct process groups while
// keeping them in the same session. TERM gets a grace period before KILL.
func (pane *Pane) Terminate() error {
	terminateErr := pane.terminateSessionProcesses()
	closeErr := pane.Close()
	var waitErr error
	if pane.cmd != nil && pane.waitDone != nil {
		select {
		case <-pane.waitDone:
			waitErr = pane.Wait()
			var exitErr *exec.ExitError
			if errors.As(waitErr, &exitErr) {
				waitErr = nil
			}
		case <-time.After(2 * time.Second):
			waitErr = fmt.Errorf("pane process %d was not reaped after PTY teardown", pane.sid)
		}
	}
	return errors.Join(terminateErr, closeErr, waitErr)
}

// terminateSessionProcesses stops every process in the PTY's private session
// without closing the master. Natural shell exit uses this first so native
// attachments can drain their final bytes after a background helper releases
// the PTY slave. Interactive job control can put helpers in groups other than
// the shell's initial group, while keeping them in the same session.
func (pane *Pane) terminateSessionProcesses() error {
	pane.terminateOnce.Do(func() {
		pane.terminateErr = pane.terminateSessionProcessesOnce()
		if pane.cleanupDone != nil {
			close(pane.cleanupDone)
		}
	})
	return pane.terminateErr
}

func (pane *Pane) terminateSessionProcessesOnce() error {
	sessionID := pane.sid
	if sessionID <= 0 {
		return nil
	}
	if pane.adopted {
		return pane.terminateAdoptedSessionMembers()
	}

	var terminateErr error
	processes, err := processesInSession(sessionID)
	if err != nil {
		terminateErr = fmt.Errorf("enumerate mux pane process session: %w", err)
		processes = []int{sessionID}
	}
	for _, pid := range processes {
		if err := signalSessionProcess(pid, sessionID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			terminateErr = errors.Join(terminateErr, fmt.Errorf("signal mux pane process %d: %w", pid, err))
		}
	}

	graceDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(graceDeadline) {
		remaining, _ := processesInSession(sessionID)
		if len(remaining) == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	remaining, enumerateErr := processesInSession(sessionID)
	if enumerateErr != nil {
		terminateErr = errors.Join(terminateErr, fmt.Errorf("re-enumerate mux pane process session: %w", enumerateErr))
	}
	for _, pid := range remaining {
		if err := signalSessionProcess(pid, sessionID, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			terminateErr = errors.Join(terminateErr, fmt.Errorf("kill mux pane process %d: %w", pid, err))
		}
	}
	if pane.cmd != nil && pane.cmd.Process != nil {
		if err := pane.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			terminateErr = errors.Join(terminateErr, fmt.Errorf("kill mux pane process: %w", err))
		}
	}
	return terminateErr
}

func (pane *Pane) terminateAdoptedSessionMembers() error {
	// Refresh synchronously so termination immediately after descriptor handoff
	// does not depend on the observer's next timer tick.
	pane.captureAdoptedSessionMembers()
	pane.mu.Lock()
	members := make(map[int]string, len(pane.adoptedMembers))
	for pid, started := range pane.adoptedMembers {
		members[pid] = started
	}
	pane.mu.Unlock()
	if len(members) == 0 {
		return nil
	}

	var terminateErr error
	for pid, started := range members {
		if err := signalAdoptedSessionMember(pid, pane.sid, started, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			terminateErr = errors.Join(terminateErr, fmt.Errorf("signal adopted mux pane process %d: %w", pid, err))
		}
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !adoptedSessionMembersAlive(members, pane.sid) {
			return terminateErr
		}
		time.Sleep(20 * time.Millisecond)
	}
	for pid, started := range members {
		if err := signalAdoptedSessionMember(pid, pane.sid, started, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			terminateErr = errors.Join(terminateErr, fmt.Errorf("kill adopted mux pane process %d: %w", pid, err))
		}
	}
	return terminateErr
}

func adoptedSessionMembersAlive(members map[int]string, sessionID int) bool {
	for pid, started := range members {
		current, err := processStartToken(pid)
		if err != nil || current != started {
			continue
		}
		sid, err := unix.Getsid(pid)
		if err == nil && sid == sessionID {
			return true
		}
	}
	return false
}

func signalAdoptedSessionMember(pid, sessionID int, started string, signal syscall.Signal) error {
	current, err := processStartToken(pid)
	if err != nil || current != started {
		return syscall.ESRCH
	}
	currentSession, err := unix.Getsid(pid)
	if err != nil || currentSession != sessionID {
		return syscall.ESRCH
	}
	return syscall.Kill(pid, signal)
}

func processGroupExists(pid int) bool {
	err := syscall.Kill(-pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func signalSessionProcess(pid, sessionID int, signal syscall.Signal) error {
	currentSession, err := unix.Getsid(pid)
	if err != nil || currentSession != sessionID {
		return syscall.ESRCH
	}
	return syscall.Kill(pid, signal)
}

// processesInSession finds every live process in a PTY's session, including
// helpers reparented to PID 1 after the shell leader exits. Session IDs are
// read from the kernel for each PID; macOS `ps sess` is not a SID field.
func processesInSession(sessionID int) ([]int, error) {
	output, err := exec.Command("ps", "-axo", "pid=,stat=").Output()
	if err != nil {
		return nil, fmt.Errorf("list pane session processes: %w", err)
	}
	processes := make([]int, 0)
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || strings.HasPrefix(fields[1], "Z") {
			continue
		}
		pid, pidErr := strconv.Atoi(fields[0])
		if pidErr != nil || pid <= 0 {
			continue
		}
		processSession, sessionErr := unix.Getsid(pid)
		if sessionErr == nil && processSession == sessionID {
			processes = append(processes, pid)
		}
	}
	return processes, nil
}
