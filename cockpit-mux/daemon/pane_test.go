package daemon

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestPaneTerminateStopsShellAndBackgroundHelpers(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "sleep 60 & echo $!; wait")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer pane.Close()

	output := make(chan string, 1)
	go func() {
		buffer := make([]byte, 128)
		for {
			n, _, readErr := pane.ReadLive(buffer)
			if n > 0 {
				output <- string(buffer[:n])
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	var childText string
	select {
	case childText = <-output:
	case <-time.After(2 * time.Second):
		t.Fatal("shell did not report background helper PID")
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(childText))
	if err != nil || childPID <= 0 {
		t.Fatalf("background helper PID output %q, parse error %v", childText, err)
	}

	if err := pane.Terminate(); err != nil {
		t.Fatalf("Terminate() error = %v", err)
	}
	if processGroupExists(pane.ProcessGroupID()) {
		t.Fatalf("pane process group %d survived termination", pane.ProcessGroupID())
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(childPID, 0); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("background helper process %d survived pane teardown", childPID)
}

func TestPaneTerminateStopsJobControlProcessGroups(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	pane, err := StartPane(bash, "--noprofile", "--norc", "-m", "-c", `sleep 60 & child=$!; printf 'CHILD:%s\n' "$child"; wait`)
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer pane.Close()

	output := make(chan string, 1)
	go func() {
		buffer := make([]byte, 256)
		for {
			n, _, readErr := pane.ReadLive(buffer)
			if n > 0 && bytes.Contains(buffer[:n], []byte("CHILD:")) {
				output <- string(buffer[:n])
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	var childPID int
	select {
	case line := <-output:
		if _, err := fmt.Sscanf(line[strings.Index(line, "CHILD:"):], "CHILD:%d", &childPID); err != nil {
			t.Fatalf("parse job-control child PID from %q: %v", line, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("interactive job-control shell did not report its child PID")
	}
	childGroup, err := syscall.Getpgid(childPID)
	if err != nil {
		t.Fatalf("read background job process group: %v", err)
	}
	if childGroup == pane.ProcessGroupID() {
		t.Fatalf("background job stayed in shell process group %d; test did not exercise job control", childGroup)
	}
	childSession, err := syscall.Getsid(childPID)
	if err != nil {
		t.Fatalf("read background job session: %v", err)
	}
	if childSession != pane.sid {
		t.Fatalf("background job session = %d, want PTY session %d", childSession, pane.sid)
	}

	if err := pane.Terminate(); err != nil {
		t.Fatalf("Terminate() error = %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-childGroup, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job-control process group %d survived pane teardown", childGroup)
}

func TestPaneTerminateReapsHelpersAfterShellLeaderExits(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	pane, err := StartPane(bash, "--noprofile", "--norc", "-m", "-c", `sleep 60 & child=$!; disown; printf 'CHILD:%s\n' "$child"; exit`)
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer pane.Close()

	output := make(chan string, 1)
	go func() {
		buffer := make([]byte, 256)
		for {
			n, _, readErr := pane.ReadLive(buffer)
			if n > 0 && bytes.Contains(buffer[:n], []byte("CHILD:")) {
				output <- string(buffer[:n])
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	var childPID int
	select {
	case line := <-output:
		if _, err := fmt.Sscanf(line[strings.Index(line, "CHILD:"):], "CHILD:%d", &childPID); err != nil {
			t.Fatalf("parse helper PID from %q: %v", line, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("shell did not report helper PID")
	}
	if err := pane.Wait(); err != nil {
		t.Fatalf("wait for shell leader: %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(childPID, 0); errors.Is(err, syscall.ESRCH) {
			break
		}
		state, stateErr := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(childPID)).Output()
		if stateErr == nil && strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := syscall.Kill(childPID, 0); err == nil {
		state, stateErr := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(childPID)).Output()
		if stateErr != nil || !strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
			t.Fatalf("helper process %d survived until after the shell leader was reaped", childPID)
		}
	}
	if err := pane.Terminate(); err != nil {
		t.Fatalf("Terminate() after leader exit: %v", err)
	}
}

func TestPaneExitObserverFailureNeverScansSIDAfterReap(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	observerErr := errors.New("injected process observer failure")
	pane, err := startPaneInDir(bash, "", func(int) (bool, error) {
		return false, observerErr
	}, "--noprofile", "--norc", "-m", "-c", `sleep 60 & child=$!; disown; printf 'CHILD:%s\n' "$child"; exit`)
	if err != nil {
		t.Fatalf("start test pane: %v", err)
	}
	defer pane.Close()

	var output strings.Builder
	var helperPID int
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		buffer := make([]byte, 256)
		n, _, readErr := pane.ReadLive(buffer)
		if n > 0 {
			output.Write(buffer[:n])
			if marker := strings.Index(output.String(), "CHILD:"); marker >= 0 {
				if _, scanErr := fmt.Sscanf(output.String()[marker:], "CHILD:%d", &helperPID); scanErr == nil {
					break
				}
			}
		}
		if readErr != nil {
			t.Fatalf("read helper pid from pane: %v", readErr)
		}
	}
	if helperPID <= 0 {
		t.Fatalf("shell did not report helper PID; output=%q", output.String())
	}
	helperStart, err := processStartToken(helperPID)
	if err != nil {
		t.Fatalf("identify test helper: %v", err)
	}
	helperSID, err := syscall.Getsid(helperPID)
	if err != nil || helperSID != pane.sid {
		t.Fatalf("helper SID = %d, err=%v; want pane SID %d", helperSID, err, pane.sid)
	}
	t.Cleanup(func() {
		// The observer-failure path deliberately leaves this isolated helper
		// alive. Still reap it if any assertion below fails, but only while its
		// captured process identity and session are unchanged.
		if currentStart, startErr := processStartToken(helperPID); startErr == nil && currentStart == helperStart {
			if currentSID, sidErr := syscall.Getsid(helperPID); sidErr == nil && currentSID == helperSID {
				_ = syscall.Kill(helperPID, syscall.SIGKILL)
			}
		}
	})

	if err := pane.Wait(); err == nil || !strings.Contains(err.Error(), observerErr.Error()) {
		t.Fatalf("Wait() error = %v, want injected observer failure", err)
	}
	if !strings.Contains(pane.terminateErr.Error(), "cleanup skipped") {
		t.Fatalf("cleanup state = %v, want fail-closed state", pane.terminateErr)
	}
	if err := pane.Terminate(); err == nil || !strings.Contains(err.Error(), "cleanup skipped") {
		t.Fatalf("Terminate() error = %v, want fail-closed cleanup diagnostic", err)
	}
	if currentStart, startErr := processStartToken(helperPID); startErr != nil || currentStart != helperStart {
		t.Fatalf("helper changed identity or exited unexpectedly: start=%q err=%v", currentStart, startErr)
	}
	if currentSID, sidErr := syscall.Getsid(helperPID); sidErr != nil || currentSID != helperSID {
		t.Fatalf("helper changed SID or exited unexpectedly: sid=%d err=%v", currentSID, sidErr)
	}

	// This is an isolated helper created by this test; clean it by its captured
	// PID/start identity and confirmed SID after proving the production path did
	// not signal it from an unverified numeric SID. Cleanup is also registered
	// above so failures in the assertions cannot leak it.
	if currentStart, startErr := processStartToken(helperPID); startErr == nil && currentStart == helperStart {
		if currentSID, sidErr := syscall.Getsid(helperPID); sidErr == nil && currentSID == helperSID {
			_ = syscall.Kill(helperPID, syscall.SIGKILL)
		}
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(helperPID, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		state, stateErr := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(helperPID)).Output()
		if stateErr == nil && strings.HasPrefix(strings.TrimSpace(string(state)), "Z") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("isolated test helper %d was not reaped after cleanup", helperPID)
}

func TestAdoptedPaneReapsObservedHelpersAfterNaturalShellExit(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	cmd := exec.Command(bash, "--noprofile", "--norc", "-m", "-c", `sleep 60 & child=$!; disown; printf 'CHILD:%s\n' "$child"; sleep 1; exit`)
	master, err := pty.Start(cmd)
	if err != nil {
		t.Fatalf("start adopted pane fixture: %v", err)
	}
	sessionID, err := syscall.Getsid(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = master.Close()
		t.Fatalf("read fixture session id: %v", err)
	}
	leaderStart, err := processStartToken(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = master.Close()
		t.Fatalf("identify fixture session leader: %v", err)
	}
	helperPID := 0
	helperStart := ""
	helperSID := 0
	fixtureWaited := false
	defer func() {
		if helperPID > 0 && helperStart != "" && helperSID > 0 {
			if currentStart, startErr := processStartToken(helperPID); startErr == nil && currentStart == helperStart {
				if currentSID, sidErr := syscall.Getsid(helperPID); sidErr == nil && currentSID == helperSID {
					_ = syscall.Kill(helperPID, syscall.SIGKILL)
				}
			}
		}
		if !fixtureWaited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
		_ = master.Close()
	}()

	fd, err := syscall.Dup(int(master.Fd()))
	if err != nil {
		t.Fatalf("duplicate pane master for simulated handoff: %v", err)
	}
	adopted, err := AdoptPane(os.NewFile(uintptr(fd), "adopted-pane-test"), sessionID, leaderStart)
	if err != nil {
		t.Fatalf("AdoptPane() error = %v", err)
	}
	defer adopted.Close()
	if adopted.LeaderStartToken() != leaderStart {
		t.Fatalf("adopted leader token = %q, want transferred token %q", adopted.LeaderStartToken(), leaderStart)
	}
	attachment := &hangingExitAttachment{done: make(chan struct{}), closed: make(chan struct{})}
	operations := NewOperations()
	session := &managedSession{
		id: "session-adopted-exit", paneID: "pane-adopted-exit", pane: adopted, attachment: attachment,
	}
	operations.sessions[session.id] = session
	operations.watchPaneExit(session)
	output := make(chan string, 1)
	go func() {
		buffer := make([]byte, 512)
		for {
			n, _, readErr := adopted.ReadLive(buffer)
			if n > 0 && bytes.Contains(buffer[:n], []byte("CHILD:")) {
				output <- string(buffer[:n])
				return
			}
			if readErr != nil {
				return
			}
		}
	}()
	var line string
	select {
	case line = <-output:
	case <-time.After(2 * time.Second):
		t.Fatal("shell did not report adopted-session helper PID")
	}
	var childPID int
	if _, err := fmt.Sscanf(line[strings.Index(line, "CHILD:"):], "CHILD:%d", &childPID); err != nil {
		t.Fatalf("parse helper PID from %q: %v", line, err)
	}
	helperPID = childPID
	helperStart, err = processStartToken(helperPID)
	if err != nil {
		t.Fatalf("identify adopted-session helper: %v", err)
	}
	helperSID, err = syscall.Getsid(helperPID)
	if err != nil || helperSID != sessionID {
		t.Fatalf("adopted helper SID = %d, err=%v; want pane SID %d", helperSID, err, sessionID)
	}

	if err := adopted.Wait(); err != nil {
		t.Fatalf("wait for naturally exited shell: %v", err)
	}
	select {
	case <-attachment.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("natural adopted-pane exit did not stop the blocked attachment")
	}
	operations.mu.Lock()
	paneWasCleared := session.pane == nil
	operations.mu.Unlock()
	if !paneWasCleared {
		t.Fatal("natural adopted-pane exit did not clear the dead pane")
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("reap adopted test fixture after cleanup: %v", err)
	}
	fixtureWaited = true
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(childPID, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("adopted PTY helper %d survived natural shell exit cleanup", childPID)
}

func TestPaneExitAndOperationsCloseSerializeAttachmentFinalization(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "sleep 0.1; exit")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	attachment := &serialExitAttachment{
		done: make(chan struct{}), finalizeStarted: make(chan struct{}), releaseFinalize: make(chan struct{}),
	}
	session := &managedSession{id: "serial-close", paneID: "serial-close-pane", pane: pane, attachment: attachment}
	operations := NewOperations()
	operations.sessions[session.id] = session
	operations.watchPaneExit(session)
	close(attachment.done)
	defer attachment.releaseOnce.Do(func() { close(attachment.releaseFinalize) })

	select {
	case <-attachment.finalizeStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("natural pane-exit watcher did not begin attachment finalization")
	}
	closeReturned := make(chan error, 1)
	go func() { closeReturned <- operations.Close() }()
	attachment.releaseOnce.Do(func() { close(attachment.releaseFinalize) })
	select {
	case closeErr := <-closeReturned:
		if closeErr != nil {
			t.Fatalf("Operations.Close() error = %v", closeErr)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Operations.Close() did not finish after attachment finalization")
	}

	attachment.mu.Lock()
	defer attachment.mu.Unlock()
	if attachment.overlap {
		t.Fatal("attachment Finalize() and Close() overlapped across pane exit and Operations.Close()")
	}
	if attachment.finalizeCount != 1 || attachment.closeCount != 1 {
		t.Fatalf("attachment lifecycle counts = finalize %d, close %d; want one each", attachment.finalizeCount, attachment.closeCount)
	}
}

func TestNormalizeProcessStartTokenCollapsesPaddedDateWhitespace(t *testing.T) {
	got := normalizeProcessStartToken("Tue Sep  9 12:34:56 2026")
	if got != "Tue Sep 9 12:34:56 2026" {
		t.Fatalf("normalizeProcessStartToken() = %q", got)
	}
}

func TestAdoptPaneRejectsChangedLeaderIdentity(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "sleep 60")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer pane.Terminate()

	fd, err := syscall.Dup(int(pane.master.Fd()))
	if err != nil {
		t.Fatalf("duplicate pane master: %v", err)
	}
	master := os.NewFile(uintptr(fd), "adopted-pane-mismatch-test")
	defer master.Close()
	if _, err := AdoptPane(master, pane.sid, pane.LeaderStartToken()+" stale"); err == nil {
		t.Fatal("AdoptPane() accepted a mismatched original leader identity")
	}
}

type hangingExitAttachment struct {
	sessionAttachment
	done   chan struct{}
	closed chan struct{}
	once   sync.Once
}

type serialExitAttachment struct {
	sessionAttachment
	done            chan struct{}
	finalizeStarted chan struct{}
	releaseFinalize chan struct{}
	releaseOnce     sync.Once
	mu              sync.Mutex
	finalizing      bool
	overlap         bool
	finalizeCount   int
	closeCount      int
}

func (attachment *serialExitAttachment) Done() <-chan struct{} { return attachment.done }

func (attachment *serialExitAttachment) Finalize() error {
	attachment.mu.Lock()
	if attachment.finalizing || attachment.closeCount > 0 {
		attachment.overlap = true
	}
	attachment.finalizing = true
	attachment.finalizeCount++
	attachment.mu.Unlock()
	close(attachment.finalizeStarted)
	<-attachment.releaseFinalize
	attachment.mu.Lock()
	attachment.finalizing = false
	attachment.mu.Unlock()
	return nil
}

func (attachment *serialExitAttachment) Close() error {
	attachment.mu.Lock()
	if attachment.finalizing {
		attachment.overlap = true
	}
	attachment.closeCount++
	attachment.mu.Unlock()
	return nil
}

func (attachment *hangingExitAttachment) Done() <-chan struct{} { return attachment.done }

func (attachment *hangingExitAttachment) Close() error {
	attachment.once.Do(func() {
		close(attachment.done)
		close(attachment.closed)
	})
	return nil
}

func TestPanePreservesRawOutputAndAssignsSequence(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf '\\000\\377A'")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer pane.Close()

	var got []byte
	buffer := make([]byte, 16)
	var sequence uint64
	for {
		n, current, readErr := pane.ReadLive(buffer)
		if n > 0 {
			got = append(got, buffer[:n]...)
			sequence = current
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			break
		}
	}
	if !bytes.Equal(got, []byte{0x00, 0xff, 'A'}) {
		t.Fatalf("raw PTY output = %x, want 00ff41", got)
	}
	if sequence == 0 {
		t.Fatal("output sequence was not assigned")
	}
}

func TestPaneResizeChangesOwnedPTYGeometry(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "sleep 30")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer func() {
		if pane.cmd != nil && pane.cmd.Process != nil {
			_ = pane.cmd.Process.Kill()
		}
		_ = pane.Close()
		_ = pane.Wait()
	}()
	if err := pane.Resize(54, 45); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	rows, cols, err := pty.Getsize(pane.master)
	if err != nil {
		t.Fatalf("Getsize() error = %v", err)
	}
	if cols != 54 || rows != 45 {
		t.Fatalf("PTY size = %dx%d, want 54x45", cols, rows)
	}
}

func TestPaneResizeDeliversSIGWINCHToForegroundProcess(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "trap 'stty size' WINCH; printf ready; while :; do sleep 1; done")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer func() {
		if pane.cmd != nil && pane.cmd.Process != nil {
			_ = pane.cmd.Process.Kill()
		}
		_ = pane.Close()
		_ = pane.Wait()
	}()
	output := make(chan []byte, 1)
	go func() {
		buf := make([]byte, 256)
		for {
			n, _, readErr := pane.ReadLive(buf)
			if n > 0 {
				output <- append([]byte(nil), buf[:n]...)
			}
			if readErr != nil {
				return
			}
		}
	}()
	select {
	case got := <-output:
		if !bytes.Contains(got, []byte("ready")) {
			t.Fatalf("initial output = %q, want ready", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("foreground process did not become ready")
	}
	if err := pane.Resize(54, 45); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case got := <-output:
			if bytes.Contains(got, []byte("45 54")) {
				return
			}
		case <-deadline:
			t.Fatal("foreground process did not report 45 54 after SIGWINCH")
		}
	}
}

func TestPaneResizeUpdatesNeovimInInteractiveDefaultShell(t *testing.T) {
	if _, err := exec.LookPath("nvim"); err != nil {
		t.Skip("Neovim is not installed")
	}
	pane, err := StartPane("/usr/bin/env", "BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`)
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer func() {
		if pane.cmd != nil && pane.cmd.Process != nil {
			_ = pane.cmd.Process.Kill()
		}
		_ = pane.Close()
		_ = pane.Wait()
	}()
	output := make(chan []byte, 32)
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, _, readErr := pane.ReadLive(buffer)
			if n > 0 {
				output <- append([]byte(nil), buffer[:n]...)
			}
			if readErr != nil {
				return
			}
		}
	}()
	if err := pane.Resize(110, 45); err != nil {
		t.Fatalf("set initial application geometry: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := pane.WriteInput([]byte("nvim --clean\r")); err != nil {
		t.Fatalf("start Neovim: %v", err)
	}
	awaitPaneOutput(t, output, []byte("Nvim"))
	if err := pane.Resize(54, 45); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	// SIGWINCH is delivered asynchronously; give Neovim's event loop one turn
	// before asking it to report the resulting grid.
	time.Sleep(200 * time.Millisecond)
	if _, err := pane.WriteInput([]byte("\x1b:echo 'COCKPIT-NVIM-PTY:' . &columns . 'x' . &lines\r")); err != nil {
		t.Fatalf("report Neovim geometry: %v", err)
	}
	awaitPaneOutput(t, output, []byte("COCKPIT-NVIM-PTY:54x45"))
}

func TestOperationsResizeUpdatesNeovimThroughShadowAttachment(t *testing.T) {
	if _, err := exec.LookPath("nvim"); err != nil {
		t.Skip("Neovim is not installed")
	}
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ConfigureTerminfo(home); err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/usr/bin/env", Args: []string{"BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`},
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "xterm-client", ClientKind: "cockpit", Cols: 110, Rows: 45,
	})
	requestOperation(t, operations, 3, methodSessionDetach, DetachSessionRequest{SessionID: created.SessionID, ClientID: "xterm-client"})
	requestOperation(t, operations, 4, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "wterm-client", ClientKind: "cockpit", Cols: 110, Rows: 45,
	})
	requestOperation(t, operations, 5, methodPaneWrite, WritePaneRequest{PaneID: created.PaneID, ClientID: "wterm-client", Data: []byte("nvim --clean\r")})
	readSessionUntil(t, operations, created.SessionID, []byte("Nvim"))
	requestOperation(t, operations, 6, methodPaneResize, ResizePaneRequest{PaneID: created.PaneID, ClientID: "wterm-client", Cols: 54, Rows: 45})
	time.Sleep(300 * time.Millisecond)
	requestOperation(t, operations, 7, methodPaneWrite, WritePaneRequest{
		PaneID: created.PaneID, ClientID: "wterm-client", Data: []byte("\x1b:echo 'COCKPIT-NVIM-OPERATIONS:' . &columns . 'x' . &lines\r"),
	})
	readSessionUntil(t, operations, created.SessionID, []byte("COCKPIT-NVIM-OPERATIONS:54x45"))
}

func awaitPaneOutput(t *testing.T, output <-chan []byte, needle []byte) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	var received []byte
	for {
		select {
		case chunk := <-output:
			received = append(received, chunk...)
			if bytes.Contains(received, needle) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %q in %q", needle, received)
		}
	}
}

func TestPaneCloseIsIdempotent(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "sleep 30")
	if err != nil {
		t.Fatalf("StartPane() error = %v", err)
	}
	defer func() {
		if pane.cmd != nil && pane.cmd.Process != nil {
			_ = pane.cmd.Process.Kill()
		}
		_ = pane.Wait()
	}()
	if err := pane.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}
	if err := pane.Close(); err != nil {
		t.Fatalf("second Close() error = %v, want nil", err)
	}
}
