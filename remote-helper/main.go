// Command remote-helper is a static Go binary uploaded to a remote host by the
// Agent Cockpit desktop app and run over SSH to serve read-only repository data
// via a length-prefixed JSON-RPC protocol on stdin/stdout.
//
// The same binary is also the multi-call `cockpit` CLI (cockpit_cli.go): invoked
// as `cockpit` (a symlink) or `remote-helper cockpit …` it is a short-lived
// client of the terminal callback socket and never starts the RPC server.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
)

// server holds the I/O channels and dispatch state for one helper process.
type server struct {
	in  io.Reader
	out io.Writer

	writeMu sync.Mutex // serializes concurrent frame writes (responses + events)
	watch   *watchManager
	log     *log.Logger

	// handler runs one queued request on the worker. nil means s.handle; tests
	// substitute it to hold the worker without touching the real methods.
	handler func(Request) (interface{}, error)

	// Terminal callback socket: host facts and limits (cb), the path of the
	// `cockpit` CLI link the handshake reports (cliPath, set once before serve),
	// and the live service (callback, replaced by each handshake; newest wins).
	cb       callbackConfig
	cliPath  string
	cbMu     sync.Mutex
	callback *callbackService
	// connSeq allocates the `callback` event correlation ids for EVERY service this
	// server ever builds (see callbackServiceOptions.nextConnID).
	connSeq atomic.Uint64
}

// newServer builds a helper server over the given stream.
func newServer(in io.Reader, out io.Writer, logger *log.Logger) *server {
	s := &server{in: in, out: out, log: logger, cb: defaultCallbackConfig()}
	s.watch = newWatchManager(s.emit)
	return s
}

func main() {
	// The multi-call `cockpit` CLI dispatches FIRST: before the PATH bootstrap (a
	// login-shell import that is slow and noisy and has no business in a CLI) and
	// before anything that could start the RPC server or read stdin. This ordering
	// is load-bearing; TestCockpitDispatchesBeforeBootstrapPath pins it.
	if args, ok := cockpitInvocation(os.Args); ok {
		os.Exit(runCockpitCLI(newCockpitEnv(args)))
	}

	// Handle the `version` subcommand: print the build-time source hash on
	// stdout and exit. The provisioner runs `helper version` over a non-login
	// exec channel to decide whether the remote binary is up-to-date without
	// doing a full handshake. Stdout must be clean (single line, no extra text)
	// so the provisioner can compare it directly to the manifest sourceHash.
	if len(os.Args) >= 2 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(SourceHash)
		return
	}

	// Fix the helper process PATH (login-shell import + static fallback dirs)
	// before any tool is spawned, so bare-name execs (br, git) resolve even
	// though the ssh exec PATH omits ~/.local/bin / Homebrew. Mirrors the local
	// bootstrapPath() in electron/main/pathBootstrap.ts.
	bootstrapPath()

	logger := log.New(os.Stderr, "remote-helper: ", log.LstdFlags|log.Lmsgprefix)
	logger.Printf("starting version=%s protocol=%d source=%s pid=%d path=%s", Version, ProtocolVersion, SourceHash, os.Getpid(), os.Getenv("PATH"))

	s := newServer(bufio.NewReader(os.Stdin), os.Stdout, logger)
	s.setupCockpitLink()

	if err := s.serve(); err != nil {
		logger.Printf("serve exited with error: %v", err)
		os.Exit(1)
	}
	logger.Printf("clean shutdown")
}

// logf logs when a logger is attached (the zero-value server of a unit test has none).
func (s *server) logf(format string, args ...any) {
	if s.log != nil {
		s.log.Printf(format, args...)
	}
}

// serve runs the reader loop until stdin reaches EOF (or breaks).
//
// The helper is split into a READER (this goroutine) and a single WORKER. The
// reader only decodes frames: it answers `callback.reply` itself, immediately,
// and queues every other request on an unbounded FIFO that the worker drains in
// arrival order. So a slow beadsExec, diff or status can no longer delay main's
// reply to a pending `cockpit open` (or the next frame), while every existing
// method keeps the ordering it always had.
//
// When the stream ends the callback listener is released at once (nothing can
// answer a forwarded request any more, and the path must be free for the next
// helper), then the worker finishes what was already accepted, in order, exactly
// as the synchronous loop would have: every request that arrived before EOF was
// always executed.
func (s *server) serve() error {
	defer s.watch.closeAll()
	defer s.closeCallback()

	queue := newRequestQueue()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for {
			req, ok := queue.pop()
			if !ok {
				return
			}
			s.dispatch(req)
		}
	}()

	err := s.readLoop(queue)

	s.closeCallback()
	queue.close()
	<-workerDone
	return err
}

// readLoop decodes requests until the stream ends. It never blocks on a method.
func (s *server) readLoop(queue *requestQueue) error {
	for {
		req, err := decodeRequest(s.in)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil // clean shutdown on EOF
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				s.logf("stdin closed mid-frame")
				return nil
			}
			// A malformed frame is unrecoverable for the stream framing.
			return fmt.Errorf("decode request: %w", err)
		}
		if req.Method == "callback.reply" {
			s.dispatchInline(req)
			continue
		}
		queue.push(req)
	}
}

// dispatch routes a single request to its handler and writes the response.
func (s *server) dispatch(req Request) {
	invoke := s.handle
	if s.handler != nil {
		invoke = s.handler
	}
	result, err := invoke(req)
	s.respond(req, result, err)
}

// dispatchInline answers a request on the reader itself. Only methods that never
// wait on anything may be answered here.
func (s *server) dispatchInline(req Request) {
	result, err := s.handleCallbackReply(req.Params)
	s.respond(req, result, err)
}

func (s *server) respond(req Request, result interface{}, err error) {
	if err != nil {
		s.logf("method=%s id=%d error: %v", req.Method, req.ID, err)
		s.writeFrame(newErrorResponse(req.ID, err))
		return
	}
	s.writeFrame(newResultResponse(req.ID, result))
}

// handle invokes the named method. Watch methods are handled inline because
// they need access to the server's watch manager.
func (s *server) handle(req Request) (interface{}, error) {
	switch req.Method {
	case "handshake":
		return s.handleHandshake(req.Params)
	case "readFile":
		return handleReadFile(req.Params)
	case "readFileBytes":
		return handleReadFileBytes(req.Params)
	case "stat":
		return handleStat(req.Params)
	case "gitStatus":
		return handleGitStatus(req.Params)
	case "gitDiff":
		return handleGitDiff(req.Params)
	case "getDiffBundle":
		return handleGetDiffBundle(req.Params)
	case "gitBranchPoint":
		return handleGitBranchPoint(req.Params)
	case "listWorktrees":
		return handleListWorktrees(req.Params)
	case "beadsExec":
		return handleBeadsExec(req.Params)
	case "listDir":
		return handleListDir(req.Params)
	case "watch.subscribe":
		return s.watch.subscribe(req.Params)
	case "watch.unsubscribe":
		return s.watch.unsubscribe(req.Params)
	default:
		return nil, fmt.Errorf("unknown method %q", req.Method)
	}
}

// handleHandshake validates the client's requested protocol version and, when
// the client names a project, starts that project's callback listener and reports
// where it is (callbackSock) and where the `cockpit` CLI is linked (cliPath).
// Both are empty when callback is not available on this host; that never fails
// the handshake.
func (s *server) handleHandshake(raw json.RawMessage) (interface{}, error) {
	var p HandshakeParams
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, fmt.Errorf("handshake: decode params: %w", err)
		}
	}
	if p.ProtocolVersion != ProtocolVersion {
		return nil, fmt.Errorf("protocol version mismatch: client requested %d, helper provides %d", p.ProtocolVersion, ProtocolVersion)
	}
	result := HandshakeResult{ProtocolVersion: ProtocolVersion, PID: os.Getpid()}
	if p.ProjectID != "" {
		result.CallbackSock, result.CLIPath = s.startCallback(p.ProjectID)
	}
	return result, nil
}

// setupCockpitLink creates the directories and the per-os/arch `cockpit` link at
// startup (cockpit_link.go). Best effort: without it the handshake reports no
// callback, and the helper otherwise works as before.
func (s *server) setupCockpitLink() {
	exe, err := os.Executable()
	if err != nil {
		s.logf("cockpit CLI link unavailable: cannot locate the helper binary: %v", err)
		return
	}
	link, err := ensureCockpitLink(s.cb.home, exe, runtime.GOOS, runtime.GOARCH, s.cb.uid)
	if err != nil {
		s.logf("cockpit CLI link unavailable: %v", err)
		return
	}
	s.cliPath = link
}

// emit writes a server-push event frame. Safe for concurrent use.
func (s *server) emit(ev Event) {
	s.writeFrame(ev)
}

// writeFrame serializes a payload to the output stream under the write lock.
func (s *server) writeFrame(payload interface{}) {
	_ = s.send(payload)
}

// send is writeFrame that reports a failed write (still logged), for the callers
// that must tell a dead stream from a slow one.
func (s *server) send(payload interface{}) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	err := writeFrame(s.out, payload)
	if err != nil {
		s.logf("write frame failed: %v", err)
	}
	return err
}
