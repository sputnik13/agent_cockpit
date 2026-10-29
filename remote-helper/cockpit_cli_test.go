package main

// Scenarios 14 and 20 (CLI side): exit codes (0/2/3/4/1), logical-$PWD resolution
// plus the canonical parent-directory form, the 5 s deadline, silence on success,
// and a stale socket exiting fast. The CLI runs in-process against a REAL listener
// on a real unix socket in a short temporary directory.

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// cliFixture is a CLI run against a listener whose decision function the test
// controls.
type cliFixture struct {
	t        *testing.T
	sock     string
	env      map[string]string
	cwd      string
	stdout   bytes.Buffer
	stderr   bytes.Buffer
	mu       sync.Mutex
	requests []json.RawMessage
	reply    func(id int64) callbackReply
	eval     func(string) (string, error)
	deadline time.Duration
}

func newCLIFixture(t *testing.T) *cliFixture {
	t.Helper()
	f := &cliFixture{
		t:        t,
		env:      map[string]string{},
		cwd:      shortDir(t),
		eval:     filepath.EvalSymlinks,
		deadline: 2 * time.Second,
		reply:    func(id int64) callbackReply { return okReply(id, map[string]any{"status": "dispatched"}) },
	}
	_, f.sock = startTestListener(t, func(raw json.RawMessage) callbackReply {
		f.mu.Lock()
		f.requests = append(f.requests, raw)
		reply := f.reply
		f.mu.Unlock()
		return reply(1)
	}, nil)
	f.env[callbackSockEnv] = f.sock
	return f
}

func (f *cliFixture) run(args ...string) int {
	f.t.Helper()
	f.stdout.Reset()
	f.stderr.Reset()
	return runCockpitCLI(cockpitEnv{
		args:         args,
		getenv:       func(key string) string { return f.env[key] },
		getwd:        func() (string, error) { return f.cwd, nil },
		evalSymlinks: f.eval,
		dial: func(path string, timeout time.Duration) (net.Conn, error) {
			return net.DialTimeout("unix", path, timeout)
		},
		now:      time.Now,
		deadline: f.deadline,
		stdout:   &f.stdout,
		stderr:   &f.stderr,
	})
}

// lastRequest decodes the most recent request the listener received.
func (f *cliFixture) lastRequest() map[string]any {
	f.t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		f.t.Fatal("the listener received no request")
	}
	var request map[string]any
	if err := json.Unmarshal(f.requests[len(f.requests)-1], &request); err != nil {
		f.t.Fatal(err)
	}
	return request
}

func (f *cliFixture) requestCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests)
}

func argsOf(request map[string]any) map[string]any {
	args, _ := request["args"].(map[string]any)
	return args
}

func TestCLIIsSilentOnSuccess(t *testing.T) {
	f := newCLIFixture(t)
	if code := f.run("open", "/a/b.md"); code != exitOK {
		t.Fatalf("exit = %d, stderr %q", code, f.stderr.String())
	}
	if f.stdout.Len() != 0 || f.stderr.Len() != 0 {
		t.Fatalf("a successful open must print nothing; stdout=%q stderr=%q", f.stdout.String(), f.stderr.String())
	}
}

func TestCLIRequestCarriesTheEnvelopeAndPaneIdentity(t *testing.T) {
	f := newCLIFixture(t)
	f.env["TMUX_PANE"] = "%3"
	if code := f.run("open", "/a/b.md"); code != exitOK {
		t.Fatalf("exit = %d", code)
	}
	request := f.lastRequest()
	if request["v"] != float64(1) || request["id"] != float64(1) || request["op"] != "open" {
		t.Fatalf("envelope = %v", request)
	}
	if pane := request["pane"].(map[string]any); pane["kind"] != "tmux" || pane["id"] != "%3" {
		t.Fatalf("pane = %v", pane)
	}
	if _, named := request["projectId"]; named {
		t.Fatal("a request must never name a project; the socket decides that")
	}
}

func TestCLIPaneIdentityPrefersTheMuxKey(t *testing.T) {
	f := newCLIFixture(t)
	f.env["TMUX_PANE"] = "%0" // stale, inherited by the mux daemon from an outer tmux pane
	f.env[callbackMuxKeyEnv] = "term-2"
	f.run("open", "/a/b.md")
	pane := f.lastRequest()["pane"].(map[string]any)
	if pane["kind"] != "mux" || pane["id"] != "term-2" {
		t.Fatalf("pane = %v, want the mux key to win", pane)
	}
}

func TestCLISendsNoPaneWhenThereIsNoIdentity(t *testing.T) {
	f := newCLIFixture(t)
	f.run("open", "/a/b.md")
	if _, present := f.lastRequest()["pane"]; present {
		t.Fatal("a missing pane identity must be omitted, not sent as null")
	}
}

func TestCLIResolvesARelativePathFromTheWorkingDirectoryAndCleansItLexically(t *testing.T) {
	f := newCLIFixture(t)
	if err := os.MkdirAll(filepath.Join(f.cwd, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	f.run("open", "docs/../docs/./guide.md")
	args := argsOf(f.lastRequest())
	if want := filepath.Join(f.cwd, "docs", "guide.md"); args["path"] != want {
		t.Fatalf("path = %v, want %s", args["path"], want)
	}
	f.run("open", "/abs//dir/../file.md")
	if got := argsOf(f.lastRequest())["path"]; got != "/abs/file.md" {
		t.Fatalf("absolute path = %v, want it lexically cleaned", got)
	}
}

func TestCLICanonicalFormResolvesTheParentDirectoryOnly(t *testing.T) {
	f := newCLIFixture(t)
	root := shortDir(t)
	real := filepath.Join(root, "real")
	link := filepath.Join(root, "link")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	// A symlinked FILE inside the (symlinked) directory: its parent resolves, its
	// own name must not, so a symlinked file inside a worktree is not misclassified
	// as external.
	if err := os.WriteFile(filepath.Join(real, "target.md"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/hosts", filepath.Join(real, "alias.md")); err != nil {
		t.Fatal(err)
	}
	f.run("open", filepath.Join(link, "alias.md"))
	args := argsOf(f.lastRequest())
	realResolved, _ := filepath.EvalSymlinks(real)
	if args["path"] != filepath.Join(link, "alias.md") {
		t.Fatalf("path = %v, want the LOGICAL path through the symlinked directory", args["path"])
	}
	if args["canonicalPath"] != filepath.Join(realResolved, "alias.md") {
		t.Fatalf("canonicalPath = %v, want the resolved parent joined with the unresolved base name %s",
			args["canonicalPath"], filepath.Join(realResolved, "alias.md"))
	}
}

func TestCLIOmitsTheCanonicalFormWhenTheParentCannotBeResolved(t *testing.T) {
	f := newCLIFixture(t)
	f.run("open", filepath.Join(f.cwd, "does", "not", "exist.md"))
	args := argsOf(f.lastRequest())
	if _, present := args["canonicalPath"]; present {
		t.Fatalf("canonicalPath = %v; with an unresolvable parent only the logical path is sent", args["canonicalPath"])
	}
	if args["path"] == nil || args["path"] == "" {
		t.Fatal("the logical path must still be sent")
	}
}

func TestCLIUsesInjectedWorkingDirectoryForRelativePaths(t *testing.T) {
	f := newCLIFixture(t)
	f.cwd = "/work/proj"
	f.eval = func(string) (string, error) { return "", os.ErrNotExist }
	f.run("open", "README.md")
	if got := argsOf(f.lastRequest())["path"]; got != "/work/proj/README.md" {
		t.Fatalf("path = %v", got)
	}
}

// ---- Exit codes ----------------------------------------------------------------------

func TestCLIUsageErrorsExitTwoWithoutTouchingTheSocket(t *testing.T) {
	cases := map[string][]string{
		"no command":        {},
		"unknown command":   {"close", "/a"},
		"open without path": {"open"},
		"two paths":         {"open", "/a", "/b"},
		"unknown option":    {"open", "--wat", "/a"},
		"empty path":        {"open", ""},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			f := newCLIFixture(t)
			if code := f.run(args...); code != exitUsage {
				t.Fatalf("exit = %d, want 2; stderr %q", code, f.stderr.String())
			}
			if !strings.Contains(f.stderr.String(), "usage: cockpit open <path>") {
				t.Fatalf("stderr %q must show the usage", f.stderr.String())
			}
			if f.requestCount() != 0 {
				t.Fatal("a usage error must not send a request")
			}
		})
	}
}

func TestCLIUsageErrorWinsOverAMissingSocket(t *testing.T) {
	f := newCLIFixture(t)
	delete(f.env, callbackSockEnv)
	if code := f.run("open"); code != exitUsage {
		t.Fatalf("exit = %d, want 2 (usage) before any environment check", code)
	}
}

func TestCLIAcceptsADashDashTerminatorAndAPathStartingWithADash(t *testing.T) {
	f := newCLIFixture(t)
	if code := f.run("open", "--", "-odd.md"); code != exitOK {
		t.Fatalf("exit = %d, stderr %q", code, f.stderr.String())
	}
	if got := argsOf(f.lastRequest())["path"]; got != filepath.Join(f.cwd, "-odd.md") {
		t.Fatalf("path = %v", got)
	}
}

func TestCLIHelpPrintsUsageToStdoutAndExitsZero(t *testing.T) {
	f := newCLIFixture(t)
	for _, arg := range []string{"help", "--help", "-h"} {
		if code := f.run(arg); code != exitOK || !strings.Contains(f.stdout.String(), "usage: cockpit open <path>") {
			t.Fatalf("%s: exit %d stdout %q", arg, code, f.stdout.String())
		}
	}
}

func TestCLINotConnectedExitsThreeWithAClearMessage(t *testing.T) {
	t.Run("no socket in the environment", func(t *testing.T) {
		f := newCLIFixture(t)
		delete(f.env, callbackSockEnv)
		if code := f.run("open", "/a"); code != exitNotConnected {
			t.Fatalf("exit = %d, want 3", code)
		}
		if !strings.Contains(f.stderr.String(), "COCKPIT_CALLBACK_SOCK is not set") {
			t.Fatalf("stderr %q", f.stderr.String())
		}
	})
	t.Run("a relative socket path", func(t *testing.T) {
		f := newCLIFixture(t)
		f.env[callbackSockEnv] = "relative.sock"
		if code := f.run("open", "/a"); code != exitNotConnected {
			t.Fatalf("exit = %d, want 3", code)
		}
	})
	t.Run("a socket that does not exist", func(t *testing.T) {
		f := newCLIFixture(t)
		f.env[callbackSockEnv] = filepath.Join(shortDir(t), "gone.sock")
		start := time.Now()
		if code := f.run("open", "/a"); code != exitNotConnected {
			t.Fatalf("exit = %d, want 3; stderr %q", code, f.stderr.String())
		}
		if !strings.Contains(f.stderr.String(), "not connected") || time.Since(start) > time.Second {
			t.Fatalf("stderr %q after %s", f.stderr.String(), time.Since(start))
		}
	})
	t.Run("a stale socket nobody listens on", func(t *testing.T) {
		f := newCLIFixture(t)
		stale := filepath.Join(shortDir(t), "stale.sock")
		ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
		if err != nil {
			t.Fatal(err)
		}
		ln.SetUnlinkOnClose(false) // leave the socket file behind, as a crashed listener does
		ln.Close()
		f.env[callbackSockEnv] = stale
		start := time.Now()
		if code := f.run("open", "/a"); code != exitNotConnected {
			t.Fatalf("exit = %d, want 3; stderr %q", code, f.stderr.String())
		}
		if time.Since(start) > time.Second || !strings.Contains(f.stderr.String(), "not connected") {
			t.Fatalf("a stale socket must fail fast and clearly: %q after %s", f.stderr.String(), time.Since(start))
		}
	})
	t.Run("the app answers not-connected", func(t *testing.T) {
		f := newCLIFixture(t)
		f.reply = func(id int64) callbackReply { return errorReply(id, "not-connected", "project is not connected") }
		if code := f.run("open", "/a"); code != exitNotConnected || !strings.Contains(f.stderr.String(), "project is not connected") {
			t.Fatalf("exit %d stderr %q", code, f.stderr.String())
		}
	})
	t.Run("the connection closes before a reply", func(t *testing.T) {
		f := newCLIFixture(t)
		bare := filepath.Join(shortDir(t), "bare.sock")
		ln, err := net.Listen("unix", bare)
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		go func() {
			conn, err := ln.Accept()
			if err == nil {
				conn.Close() // drop it without a word
			}
		}()
		f.env[callbackSockEnv] = bare
		if code := f.run("open", "/a"); code != exitNotConnected {
			t.Fatalf("exit = %d, want 3; stderr %q", code, f.stderr.String())
		}
	})
}

func TestCLIRejectedByTheAppExitsFour(t *testing.T) {
	for _, code := range []string{"unsupported-op", "bad-request", "rate-limited"} {
		t.Run(code, func(t *testing.T) {
			f := newCLIFixture(t)
			f.reply = func(id int64) callbackReply { return errorReply(id, code, "no thanks") }
			if exit := f.run("open", "/a"); exit != exitRejected {
				t.Fatalf("exit = %d, want 4", exit)
			}
			if !strings.Contains(f.stderr.String(), code) || !strings.Contains(f.stderr.String(), "no thanks") {
				t.Fatalf("stderr %q must say what was refused", f.stderr.String())
			}
		})
	}
}

func TestCLIOtherFailuresExitOne(t *testing.T) {
	t.Run("timeout reply", func(t *testing.T) {
		f := newCLIFixture(t)
		f.reply = func(id int64) callbackReply { return errorReply(id, "timeout", "no confirmation within the deadline") }
		if exit := f.run("open", "/a"); exit != exitOther || !strings.Contains(f.stderr.String(), "may or may not have opened") {
			t.Fatalf("exit %d stderr %q", exit, f.stderr.String())
		}
	})
	t.Run("internal reply", func(t *testing.T) {
		f := newCLIFixture(t)
		f.reply = func(id int64) callbackReply { return errorReply(id, "internal", "internal error") }
		if exit := f.run("open", "/a"); exit != exitOther {
			t.Fatalf("exit = %d, want 1", exit)
		}
	})
	t.Run("a reply for another request", func(t *testing.T) {
		f := newCLIFixture(t)
		f.reply = func(int64) callbackReply { return okReply(77, map[string]any{"status": "dispatched"}) }
		if exit := f.run("open", "/a"); exit != exitOther {
			t.Fatalf("exit = %d, want 1 for a reply that answers a different id", exit)
		}
	})
	t.Run("a reply with id 0 is accepted (connection-level answer)", func(t *testing.T) {
		f := newCLIFixture(t)
		f.reply = func(int64) callbackReply { return errorReply(0, "rate-limited", "slow down") }
		if exit := f.run("open", "/a"); exit != exitRejected {
			t.Fatalf("exit = %d, want 4", exit)
		}
	})
	t.Run("a malformed reply", func(t *testing.T) {
		f := newCLIFixture(t)
		bad := filepath.Join(shortDir(t), "bad.sock")
		ln, err := net.Listen("unix", bad)
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = conn.Write([]byte{0, 0, 0, 5, '{', 'o', 'o', 'p', 's'})
			time.Sleep(200 * time.Millisecond)
		}()
		f.env[callbackSockEnv] = bad
		if exit := f.run("open", "/a"); exit != exitOther {
			t.Fatalf("exit = %d, want 1; stderr %q", exit, f.stderr.String())
		}
	})
	t.Run("an oversize reply frame", func(t *testing.T) {
		f := newCLIFixture(t)
		big := filepath.Join(shortDir(t), "big.sock")
		ln, err := net.Listen("unix", big)
		if err != nil {
			t.Fatal(err)
		}
		defer ln.Close()
		go func() {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = conn.Write([]byte{0x00, 0x01, 0x00, 0x01})
			time.Sleep(200 * time.Millisecond)
		}()
		f.env[callbackSockEnv] = big
		if exit := f.run("open", "/a"); exit != exitOther {
			t.Fatalf("exit = %d, want 1 for a reply over the frame cap", exit)
		}
	})
}

func TestCLIGivesUpWithinItsDeadlineWhenTheAppNeverReplies(t *testing.T) {
	f := newCLIFixture(t)
	f.deadline = 300 * time.Millisecond
	silent := filepath.Join(shortDir(t), "silent.sock")
	ln, err := net.Listen("unix", silent)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		time.Sleep(3 * time.Second) // hold the connection open, never answer
	}()
	f.env[callbackSockEnv] = silent
	start := time.Now()
	exit := f.run("open", "/a")
	elapsed := time.Since(start)
	if exit != exitOther || !strings.Contains(f.stderr.String(), "timed out") {
		t.Fatalf("exit %d stderr %q", exit, f.stderr.String())
	}
	if elapsed < 250*time.Millisecond || elapsed > 1500*time.Millisecond {
		t.Fatalf("gave up after %s, want about the 300ms deadline", elapsed)
	}
}

func TestCLIDefaultDeadlineIsFiveSeconds(t *testing.T) {
	if got := newCockpitEnv(nil).deadline; got != 5*time.Second {
		t.Fatalf("CLI deadline = %s, want 5s", got)
	}
}

func TestCLIStripsControlCharactersFromAppText(t *testing.T) {
	f := newCLIFixture(t)
	f.reply = func(id int64) callbackReply { return errorReply(id, "bad-request", "evil \x1b[31mred\x1b[0m\nline") }
	f.run("open", "/a")
	if strings.ContainsRune(f.stderr.String(), 0x1b) || strings.Count(f.stderr.String(), "\n") != 1 {
		t.Fatalf("stderr %q must contain no escape sequences or injected lines", f.stderr.String())
	}
}

func TestCockpitInvocation(t *testing.T) {
	cases := []struct {
		argv []string
		rest []string
		ok   bool
	}{
		{[]string{"cockpit", "open", "/a"}, []string{"open", "/a"}, true},
		{[]string{"/home/ann/.agent-cockpit/bin/linux-amd64/cockpit", "open", "/a"}, []string{"open", "/a"}, true},
		{[]string{"remote-helper", "cockpit", "open", "/a"}, []string{"open", "/a"}, true},
		{[]string{"/x/helper-0.1.0-linux-amd64", "cockpit"}, []string{}, true},
		{[]string{"cockpit"}, []string{}, true},
		{[]string{"/x/helper-0.1.0-linux-amd64"}, nil, false},
		{[]string{"/x/helper-0.1.0-linux-amd64", "version"}, nil, false},
		{[]string{"/x/cockpit-helper"}, nil, false},
		{[]string{"/x/not-cockpit"}, nil, false},
		{nil, nil, false},
	}
	for _, tc := range cases {
		rest, ok := cockpitInvocation(tc.argv)
		if ok != tc.ok || (ok && strings.Join(rest, "|") != strings.Join(tc.rest, "|")) {
			t.Fatalf("cockpitInvocation(%q) = %q, %v; want %q, %v", tc.argv, rest, ok, tc.rest, tc.ok)
		}
	}
}
