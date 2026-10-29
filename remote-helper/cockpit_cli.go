package main

// The `cockpit` CLI: a multi-call mode of this binary (docs/design/terminal-callback-socket.md, "The `cockpit`
// CLI"). It is invoked as
// `cockpit` (a symlink to this binary, see cockpit_link.go) or as
// `remote-helper cockpit …`, and dispatches in main() BEFORE bootstrapPath() and
// before anything that could start the RPC server: it is a short-lived client that
// must not import a login shell's PATH (a slow, noisy side effect) nor read stdin.
//
// `cockpit open <path>` makes `path` absolute from the LOGICAL working directory
// ($PWD when it names the current directory) plus a lexical clean, computes the
// canonical form (symlink-resolved PARENT directory joined with the base name, so
// a symlinked file inside a worktree is not misclassified as external), reads
// COCKPIT_CALLBACK_SOCK and the pane identity from the environment, sends one
// request and prints nothing on success.
//
// Exit codes:
//
//	0  the request was accepted (dispatched)
//	1  anything else: no confirmation within the deadline, an internal error, a
//	   malformed reply, or the working directory could not be determined
//	2  usage
//	3  not connected: no socket in the environment, nothing listening on it, the
//	   connection closed before a reply, or the app answered `not-connected`
//	4  rejected by the app (unsupported-op, bad-request, rate-limited)

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	exitOK           = 0
	exitOther        = 1
	exitUsage        = 2
	exitNotConnected = 3
	exitRejected     = 4
)

const cockpitUsage = `usage: cockpit open <path>

Open a file in the Content panel of the Agent Cockpit project this terminal
belongs to. Run it inside an Agent Cockpit terminal (it reads
COCKPIT_CALLBACK_SOCK from the environment); prefer: "$COCKPIT_CLI" open <path>

exit status: 0 dispatched, 1 other failure, 2 usage, 3 not connected, 4 rejected
`

// cockpitInvocation reports whether argv invokes the `cockpit` CLI (program name
// `cockpit`, or `<helper> cockpit …`) and returns the arguments after the
// command name.
func cockpitInvocation(argv []string) ([]string, bool) {
	if len(argv) == 0 {
		return nil, false
	}
	if filepath.Base(argv[0]) == "cockpit" {
		return argv[1:], true
	}
	if len(argv) >= 2 && argv[1] == "cockpit" {
		return argv[2:], true
	}
	return nil, false
}

// cockpitEnv is everything the CLI touches in the outside world, so tests can
// drive it without a real terminal.
type cockpitEnv struct {
	args         []string
	getenv       func(string) string
	getwd        func() (string, error)
	evalSymlinks func(string) (string, error)
	dial         func(path string, timeout time.Duration) (net.Conn, error)
	now          func() time.Time
	// deadline is the CLI's overall deadline (connect, send, wait for the reply).
	deadline time.Duration
	stdout   io.Writer
	stderr   io.Writer
}

func newCockpitEnv(args []string) cockpitEnv {
	return cockpitEnv{
		args: args,
		// os.Getwd returns $PWD when it is absolute and names the current directory
		// (the logical path), and the physical path otherwise.
		getenv:       os.Getenv,
		getwd:        os.Getwd,
		evalSymlinks: filepath.EvalSymlinks,
		dial: func(path string, timeout time.Duration) (net.Conn, error) {
			return net.DialTimeout("unix", path, timeout)
		},
		now:      time.Now,
		deadline: callbackCLIDeadline,
		stdout:   os.Stdout,
		stderr:   os.Stderr,
	}
}

// runCockpitCLI runs the CLI and returns its exit code.
func runCockpitCLI(e cockpitEnv) int {
	if len(e.args) == 0 {
		fmt.Fprint(e.stderr, cockpitUsage)
		return exitUsage
	}
	switch e.args[0] {
	case "open":
		return e.runOpen(e.args[1:])
	case "-h", "--help", "help":
		fmt.Fprint(e.stdout, cockpitUsage)
		return exitOK
	default:
		fmt.Fprintf(e.stderr, "cockpit: unknown command %q\n%s", sanitizeForTerminal(e.args[0]), cockpitUsage)
		return exitUsage
	}
}

func (e cockpitEnv) fail(code int, format string, args ...any) int {
	fmt.Fprintf(e.stderr, "cockpit: "+format+"\n", args...)
	return code
}

// sanitizeForTerminal replaces control characters, so text from the peer or the
// command line can never inject terminal escape sequences into the user's shell.
func sanitizeForTerminal(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return '?'
		}
		return r
	}, s)
}

// parseOpenCommandArgs accepts exactly one non-empty path; `--` ends option
// parsing. (Not to be confused with parseOpenArgs, which validates the REQUEST
// arguments on the wire.)
func parseOpenCommandArgs(args []string) (string, string) {
	var path string
	havePath, endOfOptions := false, false
	for _, arg := range args {
		if !endOfOptions && arg == "--" {
			endOfOptions = true
			continue
		}
		if !endOfOptions && strings.HasPrefix(arg, "-") && arg != "-" {
			return "", fmt.Sprintf("unknown option %q", sanitizeForTerminal(arg))
		}
		if havePath {
			return "", "open takes exactly one path"
		}
		path, havePath = arg, true
	}
	if !havePath || path == "" {
		return "", "open needs a path"
	}
	return path, ""
}

// absolutePath makes arg absolute from the logical working directory and
// lexically cleans it.
func (e cockpitEnv) absolutePath(arg string) (string, error) {
	if filepath.IsAbs(arg) {
		return filepath.Clean(arg), nil
	}
	wd, err := e.getwd()
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Join(wd, arg)), nil
}

// canonicalPath is the symlink-resolved PARENT directory joined with the base
// name. ok is false when the parent cannot be resolved; the request then carries
// the logical path only and main classifies by lexical match.
func (e cockpitEnv) canonicalPath(abs string) (string, bool) {
	parent, err := e.evalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", false
	}
	return filepath.Join(parent, filepath.Base(abs)), true
}

func (e cockpitEnv) runOpen(args []string) int {
	path, usageProblem := parseOpenCommandArgs(args)
	if usageProblem != "" {
		fmt.Fprintf(e.stderr, "cockpit: %s\n%s", usageProblem, cockpitUsage)
		return exitUsage
	}
	sock := e.getenv(callbackSockEnv)
	if sock == "" {
		return e.fail(exitNotConnected, "not connected to Agent Cockpit: %s is not set "+
			"(this terminal was not started by a connected Agent Cockpit project)", callbackSockEnv)
	}
	if !filepath.IsAbs(sock) {
		return e.fail(exitNotConnected, "not connected to Agent Cockpit: %s must be an absolute path", callbackSockEnv)
	}
	abs, err := e.absolutePath(path)
	if err != nil {
		return e.fail(exitOther, "cannot determine the current directory: %v", err)
	}

	open := openArgs{Path: abs}
	if canonical, ok := e.canonicalPath(abs); ok {
		open.CanonicalPath = canonical
	}
	request := callbackRequest{
		V:    callbackProtocolVersion,
		ID:   1,
		Op:   "open",
		Pane: paneFromEnv(e.getenv),
		Args: open,
	}
	frame, err := encodeCallbackFrame(request)
	if err != nil {
		return e.fail(exitOther, "cannot encode the request: %v", err)
	}

	overall := e.now().Add(e.deadline)
	conn, err := e.dial(sock, e.deadline)
	if err != nil {
		return e.fail(exitNotConnected, "not connected to Agent Cockpit: cannot reach %s: %s",
			sanitizeForTerminal(sock), describeDialError(err))
	}
	defer conn.Close()
	_ = conn.SetDeadline(overall)
	if _, err := conn.Write(frame); err != nil {
		return e.failIO(err)
	}

	reply, code := e.readReply(conn)
	if code != exitOK {
		return code
	}
	if reply.ID != request.ID && reply.ID != 0 {
		return e.fail(exitOther, "unexpected reply from Agent Cockpit (id %d)", reply.ID)
	}
	if reply.OK {
		return exitOK
	}
	return e.failReply(reply)
}

// readReply reads until the first complete reply frame.
func (e cockpitEnv) readReply(conn net.Conn) (callbackReply, int) {
	decoder := newCallbackFrameDecoder(callbackMaxFrameBytes)
	buf := make([]byte, 4096)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			payloads, perr := decoder.Push(buf[:n])
			if perr != nil {
				return callbackReply{}, e.fail(exitOther, "malformed reply from Agent Cockpit: %v", perr)
			}
			if len(payloads) > 0 {
				var reply callbackReply
				if err := json.Unmarshal(payloads[0], &reply); err != nil {
					return callbackReply{}, e.fail(exitOther, "malformed reply from Agent Cockpit: %v", err)
				}
				return reply, exitOK
			}
		}
		if err != nil {
			return callbackReply{}, e.failIO(err)
		}
	}
}

// failIO reports a read/write failure: the deadline means no confirmation; a
// closed or reset connection means the app side went away.
func (e cockpitEnv) failIO(err error) int {
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return e.fail(exitOther, "timed out waiting for Agent Cockpit (no confirmation; the file may or may not have opened)")
	}
	return e.fail(exitNotConnected, "not connected to Agent Cockpit: the connection closed before a reply (is the project still connected?)")
}

// failReply maps an error reply to an exit code and message.
func (e cockpitEnv) failReply(reply callbackReply) int {
	if reply.Error == nil {
		return e.fail(exitOther, "Agent Cockpit refused the request without a reason")
	}
	code, message := reply.Error.Code, sanitizeForTerminal(reply.Error.Message)
	switch code {
	case "not-connected":
		return e.fail(exitNotConnected, "not connected to Agent Cockpit: %s", message)
	case "timeout":
		return e.fail(exitOther, "no confirmation from Agent Cockpit: %s (the file may or may not have opened)", message)
	case "internal":
		return e.fail(exitOther, "Agent Cockpit reported an internal error: %s", message)
	case "unsupported-op", "bad-request", "rate-limited":
		return e.fail(exitRejected, "Agent Cockpit rejected the request (%s): %s", code, message)
	default:
		return e.fail(exitOther, "unexpected reply from Agent Cockpit (%s): %s", sanitizeForTerminal(code), message)
	}
}

// describeDialError turns a dial failure into the reason a user can act on.
func describeDialError(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "no such socket (the project is not connected, or this terminal is from a previous session)"
	case errors.Is(err, os.ErrPermission):
		return "permission denied"
	case errors.Is(err, os.ErrDeadlineExceeded):
		return "timed out"
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Err != nil {
		msg := opErr.Err.Error()
		// "connect: connection refused" is the stale-socket case.
		if strings.Contains(msg, "refused") {
			return "connection refused (nothing is listening: the project is not connected)"
		}
		return msg
	}
	return err.Error()
}
