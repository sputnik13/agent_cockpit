// Command remote-helper is a static Go binary uploaded to a remote host by the
// Agent Cockpit desktop app and run over SSH to serve read-only repository data
// via a length-prefixed JSON-RPC protocol on stdin/stdout.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
)

// server holds the I/O channels and dispatch state for one helper process.
type server struct {
	in  io.Reader
	out io.Writer

	writeMu sync.Mutex // serializes concurrent frame writes (responses + events)
	watch   *watchManager
	log     *log.Logger
}

func main() {
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

	s := &server{
		in:  bufio.NewReader(os.Stdin),
		out: os.Stdout,
		log: logger,
	}
	s.watch = newWatchManager(s.emit)

	if err := s.serve(); err != nil {
		logger.Printf("serve exited with error: %v", err)
		os.Exit(1)
	}
	logger.Printf("clean shutdown")
}

// serve runs the read/dispatch loop until stdin reaches EOF.
func (s *server) serve() error {
	defer s.watch.closeAll()

	for {
		req, err := decodeRequest(s.in)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil // clean shutdown on EOF
			}
			if errors.Is(err, io.ErrUnexpectedEOF) {
				s.log.Printf("stdin closed mid-frame")
				return nil
			}
			// A malformed frame is unrecoverable for the stream framing.
			return fmt.Errorf("decode request: %w", err)
		}
		s.dispatch(req)
	}
}

// dispatch routes a single request to its handler and writes the response.
func (s *server) dispatch(req Request) {
	result, err := s.handle(req)
	if err != nil {
		s.log.Printf("method=%s id=%d error: %v", req.Method, req.ID, err)
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
	case "stat":
		return handleStat(req.Params)
	case "gitStatus":
		return handleGitStatus(req.Params)
	case "gitDiff":
		return handleGitDiff(req.Params)
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

// handleHandshake validates the client's requested protocol version.
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
	return HandshakeResult{ProtocolVersion: ProtocolVersion, PID: os.Getpid()}, nil
}

// emit writes a server-push event frame. Safe for concurrent use.
func (s *server) emit(ev Event) {
	s.writeFrame(ev)
}

// writeFrame serializes a payload to the output stream under the write lock.
func (s *server) writeFrame(payload interface{}) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if err := writeFrame(s.out, payload); err != nil {
		s.log.Printf("write frame failed: %v", err)
	}
}
