package main

// The server's callback lifecycle: configuration, starting a project's listener
// at handshake, answering `callback.reply`, and releasing the listener when the
// RPC stream ends (a helper that loses its RPC stream also closes its listener).

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"time"
)

// callbackConfig is the host facts and limits the callback service runs with.
// Production uses defaultCallbackConfig; tests substitute their own (short
// deadlines, a private tmp root, a fake peer check).
type callbackConfig struct {
	home          string
	hostname      string
	xdgRuntimeDir string
	// tmpRoot is the parent of the /tmp fallback directory; "" means /tmp.
	tmpRoot string
	uid     int

	// Zero values select the documented defaults.
	maxConnections int
	readDeadline   time.Duration
	writeDeadline  time.Duration
	forwardTimeout time.Duration
	peerAllowed    func(*net.UnixConn) bool
	// rateLimitPerSecond and now configure the helper's burst limiter (defaults:
	// 10 per second, time.Now); tests inject a fake clock.
	rateLimitPerSecond int
	now                func() time.Time
}

func defaultCallbackConfig() callbackConfig {
	home, _ := os.UserHomeDir()
	hostname, _ := os.Hostname()
	return callbackConfig{
		home:          home,
		hostname:      hostname,
		xdgRuntimeDir: os.Getenv("XDG_RUNTIME_DIR"),
		uid:           os.Getuid(),
	}
}

// startCallback binds the project's callback socket and returns the socket path
// and the CLI path to report in the handshake, or two empty strings when callback
// is unavailable (one log line says why; the helper otherwise works as before).
// The NEWEST listener always wins the path: a previous one in this process is
// closed after the new one holds it, and closing it unlinks only its own inode.
func (s *server) startCallback(projectID string) (sock, cli string) {
	disabled := func(reason, detail string, args ...any) (string, string) {
		s.logf("callback disabled project=%s reason=%s detail=%q", projectID, reason, fmt.Sprintf(detail, args...))
		return "", ""
	}
	if s.cliPath == "" {
		return disabled("no-cli", "the cockpit CLI link could not be created")
	}
	location, err := deriveCallbackLocation(callbackLocationOptions{
		projectID:     projectID,
		hostname:      s.cb.hostname,
		home:          s.cb.home,
		xdgRuntimeDir: s.cb.xdgRuntimeDir,
		uid:           s.cb.uid,
		tmpRoot:       s.cb.tmpRoot,
	})
	if err != nil {
		return disabled(pathErrorCode(err), "%v", err)
	}
	if err := preparePrivateDir(location.dir, s.cb.uid); err != nil {
		return disabled(pathErrorCode(err), "%v", err)
	}

	service := newCallbackService(callbackServiceOptions{
		emit:               func(ev Event) error { return s.send(ev) },
		forwardTimeout:     s.cb.forwardTimeout,
		nextConnID:         func() uint64 { return s.connSeq.Add(1) },
		rateLimitPerSecond: s.cb.rateLimitPerSecond,
		now:                s.cb.now,
	})
	listener, err := startCallbackListener(callbackListenerOptions{
		socketPath:     location.socketPath,
		maxConnections: s.cb.maxConnections,
		readDeadline:   s.cb.readDeadline,
		writeDeadline:  s.cb.writeDeadline,
		handle:         service.handleRequest,
		peerAllowed:    s.cb.peerAllowed,
		logf:           s.logf,
	})
	if err != nil {
		return disabled("bind-failed", "%v", err)
	}
	service.listener = listener

	s.cbMu.Lock()
	previous := s.callback
	s.callback = service
	s.cbMu.Unlock()
	if previous != nil {
		// The older listener releases the path and answers its pending requests at
		// once; draining its connections must not hold this handshake (the worker).
		previous.retire()
	}
	s.logf("callback listening project=%s path=%q fallback=%t", projectID, location.socketPath, location.fallback)
	return location.socketPath, s.cliPath
}

func pathErrorCode(err error) string {
	var pathErr *callbackPathError
	if errors.As(err, &pathErr) {
		return string(pathErr.code)
	}
	return "path-error"
}

// closeCallback releases the live callback service, if any. Idempotent.
func (s *server) closeCallback() {
	s.cbMu.Lock()
	service := s.callback
	s.callback = nil
	s.cbMu.Unlock()
	if service != nil {
		service.close()
	}
}

// handleCallbackReply is the `callback.reply` RPC: main's answer to a forwarded
// `callback` event. The reader answers it inline, so it must not wait on anything.
// delivered=false means nobody was waiting (the request already timed out, the
// connection went away, or the helper has no listener): not an error.
func (s *server) handleCallbackReply(raw json.RawMessage) (interface{}, error) {
	var p struct {
		ConnID *uint64         `json:"connId"`
		Reply  json.RawMessage `json:"reply"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("callback.reply: decode params: %w", err)
	}
	if p.ConnID == nil {
		return nil, fmt.Errorf("callback.reply: connId is required")
	}
	if len(p.Reply) == 0 {
		return nil, fmt.Errorf("callback.reply: reply is required")
	}
	s.cbMu.Lock()
	service := s.callback
	s.cbMu.Unlock()
	delivered := service != nil && service.deliverReply(*p.ConnID, p.Reply)
	return map[string]any{"delivered": delivered}, nil
}
