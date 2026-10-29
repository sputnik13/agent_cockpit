package main

// Process-level tests. The test binary doubles as the helper/CLI binary: when
// REMOTE_HELPER_TEST_AS_MAIN=1 it runs main() instead of the tests, so a test can
// start it with any argv[0] ("cockpit", "helper-...") exactly as a pane or an ssh
// exec channel would, without building anything.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const asMainEnv = "REMOTE_HELPER_TEST_AS_MAIN"

func TestMain(m *testing.M) {
	if os.Getenv(asMainEnv) == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// childCmd prepares the test binary to run as argv0 with exactly the given
// environment (never the parent's: the tests may themselves run inside a cockpit
// pane whose COCKPIT_* variables must not leak into the child).
func childCmd(t *testing.T, argv0 string, args []string, env map[string]string, dir string) *exec.Cmd {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, args...)
	cmd.Args[0] = argv0
	cmd.Dir = dir
	cmd.Env = []string{asMainEnv + "=1", "PATH=/usr/bin:/bin"}
	for key, value := range env {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

// markerShell writes a $SHELL stub that records every invocation: bootstrapPath()
// runs `$SHELL -ilc …`, so a marker proves it ran.
func markerShell(t *testing.T) (shell, marker string) {
	t.Helper()
	dir := shortDir(t)
	marker = filepath.Join(dir, "marker")
	shell = filepath.Join(dir, "shell")
	script := "#!/bin/sh\necho ran >> '" + marker + "'\nprintf '__AC_PATH__%s__AC_PATH__' \"$PATH\"\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return shell, marker
}

func exitCode(t *testing.T, err error) int {
	t.Helper()
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	t.Fatalf("run: %v", err)
	return -1
}

func TestCockpitDispatchesBeforeBootstrapPath(t *testing.T) {
	shell, marker := markerShell(t)
	env := map[string]string{"SHELL": shell, "HOME": shortDir(t)}

	// Control: the helper path DOES run bootstrapPath (so the marker means something).
	helper := childCmd(t, "helper-0.1.0-test", nil, env, "")
	helper.Stdin = bytes.NewReader(nil) // immediate EOF: serve returns, the process exits 0
	if out, err := helper.CombinedOutput(); err != nil {
		t.Fatalf("the helper control run failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("control failed: the helper path did not run the stub shell, so this test proves nothing")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}

	// The CLI, in both spellings, must not.
	for name, invoke := range map[string]struct {
		argv0 string
		args  []string
	}{
		"program name cockpit":        {"cockpit", []string{"open"}},
		"helper binary + cockpit":     {"remote-helper", []string{"cockpit", "open"}},
		"cockpit through a full path": {"/some/dir/cockpit", []string{"help"}},
	} {
		t.Run(name, func(t *testing.T) {
			cmd := childCmd(t, invoke.argv0, invoke.args, env, "")
			cmd.Stdin = bytes.NewReader(nil)
			_ = cmd.Run() // exit 2 (usage) or 0 (help): not what is under test
			if _, err := os.Stat(marker); err == nil {
				t.Fatal("the cockpit CLI ran bootstrapPath(): dispatch must come BEFORE the login-shell PATH import")
			}
		})
	}
}

func TestCockpitNeverStartsTheRPCServer(t *testing.T) {
	cmd := childCmd(t, "cockpit", []string{"open", "/a/b.md"}, map[string]string{"HOME": shortDir(t)}, "")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		// Never reads stdin: it exits on its own with "not connected" (no socket set).
		if got := exitCode(t, err); got != exitNotConnected {
			t.Fatalf("exit = %d, want 3; stderr %q", got, stderr.String())
		}
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("the CLI did not exit: it must never serve RPC or wait on stdin")
	}
	_ = stdin.Close()
	if strings.Contains(stderr.String(), "remote-helper: starting") || stdout.Len() != 0 {
		t.Fatalf("the RPC server banner leaked into a CLI run: stdout %q stderr %q", stdout.String(), stderr.String())
	}
}

func TestCockpitIsDispatchedByAProgramNameSymlink(t *testing.T) {
	dir := shortDir(t)
	exe, _ := os.Executable()
	link := filepath.Join(dir, "cockpit")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(link, "help")
	cmd.Env = []string{asMainEnv + "=1"}
	out, err := cmd.Output()
	if err != nil || !strings.Contains(string(out), "usage: cockpit open <path>") {
		t.Fatalf("a symlink named cockpit must run the CLI: %v %q", err, out)
	}
}

func TestHelperVersionSubcommandIsUnchanged(t *testing.T) {
	cmd := childCmd(t, "helper-0.1.0-test", []string{"version"}, nil, "")
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != SourceHash {
		t.Fatalf("helper version = %q %v, want the source hash %q alone on stdout", out, err, SourceHash)
	}
}

func TestCockpitProcessUsesTheLogicalPWDAndTheCanonicalParent(t *testing.T) {
	root := shortDir(t)
	real := filepath.Join(root, "real")
	link := filepath.Join(root, "link")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	var captured []json.RawMessage
	_, sock := startTestListener(t, func(raw json.RawMessage) callbackReply {
		captured = append(captured, raw)
		return okReply(1, map[string]any{"status": "dispatched"})
	}, nil)

	// The shell is "in" the symlinked directory: PWD names the link, the kernel's
	// cwd is the real directory.
	cmd := childCmd(t, "cockpit", []string{"open", "notes.md"}, map[string]string{
		callbackSockEnv: sock,
		"PWD":           link,
		"TMUX_PANE":     "%9",
	}, link)
	if out, err := cmd.CombinedOutput(); err != nil || len(out) != 0 {
		t.Fatalf("cockpit open: %v, output %q (silent on success)", err, out)
	}
	if len(captured) != 1 {
		t.Fatalf("listener saw %d requests", len(captured))
	}
	var request struct {
		Pane *callbackPane `json:"pane"`
		Args openArgs      `json:"args"`
	}
	if err := json.Unmarshal(captured[0], &request); err != nil {
		t.Fatal(err)
	}
	realResolved, _ := filepath.EvalSymlinks(real)
	if request.Args.Path != filepath.Join(link, "notes.md") {
		t.Fatalf("path = %s, want the LOGICAL path through $PWD (%s)", request.Args.Path, filepath.Join(link, "notes.md"))
	}
	if request.Args.CanonicalPath != filepath.Join(realResolved, "notes.md") {
		t.Fatalf("canonicalPath = %s, want %s", request.Args.CanonicalPath, filepath.Join(realResolved, "notes.md"))
	}
	if request.Pane == nil || request.Pane.ID != "%9" {
		t.Fatalf("pane = %+v", request.Pane)
	}
}

// helperProcess is a real helper process with the test acting as main.
type helperProcess struct {
	t      *testing.T
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	frames chan map[string]any
	stderr *bytes.Buffer
	nextID int
}

func startHelperProcess(t *testing.T, env map[string]string) *helperProcess {
	t.Helper()
	shell, _ := markerShell(t)
	full := map[string]string{"SHELL": shell}
	for k, v := range env {
		full[k] = v
	}
	cmd := childCmd(t, "helper-0.1.0-test", nil, full, "")
	h := &helperProcess{t: t, cmd: cmd, frames: make(chan map[string]any, 64), stderr: &bytes.Buffer{}}
	var err error
	if h.stdin, err = cmd.StdinPipe(); err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = h.stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			body, err := readFrame(reader)
			if err != nil {
				close(h.frames)
				return
			}
			var msg map[string]any
			if json.Unmarshal(body, &msg) == nil {
				h.frames <- msg
			}
		}
	}()
	t.Cleanup(func() {
		_ = h.stdin.Close()
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	return h
}

func (h *helperProcess) send(method string, params any) int {
	h.t.Helper()
	h.nextID++
	raw, _ := json.Marshal(params)
	if err := writeFrame(h.stdin, Request{ID: h.nextID, Method: method, Params: raw}); err != nil {
		h.t.Fatalf("send %s: %v", method, err)
	}
	return h.nextID
}

// next returns the next frame from the helper, optionally skipping events.
func (h *helperProcess) next(wait time.Duration) map[string]any {
	h.t.Helper()
	select {
	case msg, ok := <-h.frames:
		if !ok {
			h.t.Fatalf("the helper closed its output; stderr:\n%s", h.stderr.String())
		}
		return msg
	case <-time.After(wait):
		h.t.Fatalf("no frame from the helper within %s; stderr:\n%s", wait, h.stderr.String())
		return nil
	}
}

func (h *helperProcess) response(id int) map[string]any {
	h.t.Helper()
	for {
		msg := h.next(5 * time.Second)
		if got, ok := msg["id"].(float64); ok && int(got) == id {
			return msg
		}
	}
}

// TestHelperProcessServesTheCLIEndToEnd is the Go-side integration test: a real
// helper process, a real `cockpit` invocation through the link the helper made, a
// real unix socket, and this test playing main (answering the `callback` event).
func TestHelperProcessServesTheCLIEndToEnd(t *testing.T) {
	home := shortDir(t)
	h := startHelperProcess(t, map[string]string{"HOME": home})

	id := h.send("handshake", map[string]any{"protocolVersion": ProtocolVersion, "projectId": "project-a"})
	resp := h.response(id)
	sock, cli := handshakeResult(t, resp)
	if sock == "" || cli == "" {
		t.Fatalf("handshake gave callbackSock=%q cliPath=%q; stderr:\n%s", sock, cli, h.stderr.String())
	}

	// The CLI link: per-os/arch, named cockpit, pointing at the very binary running.
	exe, _ := os.Executable()
	wantLink := filepath.Join(home, ".agent-cockpit", "bin", runtime.GOOS+"-"+runtime.GOARCH, "cockpit")
	if cli != wantLink {
		t.Fatalf("cliPath = %s, want %s", cli, wantLink)
	}
	if target, err := os.Readlink(cli); err != nil || target != exe {
		t.Fatalf("link target = %q %v, want the helper binary %s", target, err, exe)
	}
	if got := mode(t, filepath.Dir(cli)); got != 0o700 {
		t.Fatalf("link directory mode = %o, want 700", got)
	}
	if got := mode(t, filepath.Dir(sock)); got != 0o700 {
		t.Fatalf("socket directory mode = %o, want 700", got)
	}

	file := filepath.Join(home, "notes.md")
	run := func() (int, string) {
		cmd := exec.Command(cli, "open", file)
		cmd.Env = []string{asMainEnv + "=1", callbackSockEnv + "=" + sock, "TMUX_PANE=%4"}
		cmd.Dir = home
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		done := make(chan error, 1)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		go func() { done <- cmd.Wait() }()
		// Play main: wait for the forwarded event and answer it.
		ev := h.next(5 * time.Second)
		if ev["event"] != "callback" {
			t.Fatalf("expected a callback event, got %v", ev)
		}
		data := ev["data"].(map[string]any)
		request := data["request"].(map[string]any)
		h.send("callback.reply", map[string]any{
			"connId": data["connId"],
			"reply":  dispatchedFor(int64(request["id"].(float64))),
		})
		select {
		case err := <-done:
			return exitCode(t, err), stderr.String()
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
			t.Fatal("the CLI did not finish")
			return -1, ""
		}
	}
	if code, stderr := run(); code != 0 || stderr != "" {
		t.Fatalf("cockpit open exit %d, stderr %q; helper stderr:\n%s", code, stderr, h.stderr.String())
	}

	// The helper's callback.reply response is still delivered normally.
	for {
		msg := h.next(5 * time.Second)
		if _, isResponse := msg["id"]; isResponse {
			if msg["error"] != nil {
				t.Fatalf("callback.reply error: %v", msg["error"])
			}
			break
		}
	}

	// A stream that ends releases the path and the helper exits 0.
	_ = h.stdin.Close()
	done := make(chan error, 1)
	go func() { done <- h.cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("helper exit: %v\n%s", err, h.stderr.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the helper did not exit after EOF")
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("the socket must be unlinked when the helper exits: %v", err)
	}
	if _, err := os.Readlink(cli); err != nil {
		t.Fatalf("the CLI link must outlive the helper process: %v", err)
	}

	// With nothing listening, the same pane gets a fast, clear exit 3.
	cmd := exec.Command(cli, "open", file)
	cmd.Env = []string{asMainEnv + "=1", callbackSockEnv + "=" + sock}
	start := time.Now()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err := cmd.Run()
	if exitCode(t, err) != exitNotConnected || time.Since(start) > 2*time.Second ||
		!strings.Contains(stderr.String(), "not connected") {
		t.Fatalf("stale socket: exit %d after %s, stderr %q", exitCode(t, err), time.Since(start), stderr.String())
	}
}

func TestHelperProcessReportsNoCallbackWhenTheHomeIsUnusable(t *testing.T) {
	// HOME names a regular file: neither the CLI link nor the socket directory can
	// be created, and the handshake still succeeds (callback simply unavailable).
	file := filepath.Join(shortDir(t), "home")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	h := startHelperProcess(t, map[string]string{"HOME": file})
	id := h.send("handshake", map[string]any{"protocolVersion": ProtocolVersion, "projectId": "project-a"})
	sock, cli := handshakeResult(t, h.response(id))
	if sock != "" || cli != "" {
		t.Fatalf("callbackSock=%q cliPath=%q, want neither", sock, cli)
	}
}
