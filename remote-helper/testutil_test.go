package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
)

// shortDir returns a fresh directory with a SHORT path. A unix socket path is
// limited to 104 bytes on macOS, and t.TempDir() paths there are too long. The
// directory is removed when the test ends.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "achk")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// fixtureDir is the directory of the TypeScript reference's wire fixtures. The Go
// mirror replays the SAME files (src/shared/callback/fixtures).
func fixtureDir() string {
	return filepath.Join("..", "src", "shared", "callback", "fixtures")
}

func readFixture(t *testing.T, name string, into any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir(), name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse fixture %s: %v", name, err)
	}
}

// mustFrame encodes payload as a callback frame or fails the test.
func mustFrame(t *testing.T, payload any) []byte {
	t.Helper()
	frame, err := encodeCallbackFrame(payload)
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}
	return frame
}

// exchangeOrErr connects to sock, writes raw (may be empty), and decodes the
// first reply frame. closed reports whether the server closed the connection
// within the wait (always true unless the wait elapsed first). It never touches
// testing.T, so goroutines may use it.
func exchangeOrErr(sock string, raw []byte, wait time.Duration) (reply map[string]any, closed bool, err error) {
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, false, err
	}
	defer conn.Close()
	if len(raw) > 0 {
		// A server that refuses or turns the peer away may already have closed the
		// connection by the time the request is written: EPIPE/ECONNRESET then mean
		// "no reply", which the caller observes as a nil reply, not a test failure.
		if _, err := conn.Write(raw); err != nil && !peerGone(err) {
			return nil, false, err
		}
	}
	reply, closed = readReplyFrame(nil, conn, wait)
	return reply, closed, nil
}

// peerGone reports an error that only says the other side already closed.
func peerGone(err error) bool {
	return errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ECONNRESET)
}

// exchange is exchangeOrErr that fails the test on a connection error.
func exchange(t *testing.T, sock string, raw []byte, wait time.Duration) (map[string]any, bool) {
	t.Helper()
	reply, closed, err := exchangeOrErr(sock, raw, wait)
	if err != nil {
		t.Fatalf("exchange with %s: %v", sock, err)
	}
	return reply, closed
}

// readReplyFrame reads until the server closes the connection (or wait elapses),
// returning the first decoded frame (nil when none arrived).
func readReplyFrame(_ *testing.T, conn net.Conn, wait time.Duration) (map[string]any, bool) {
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	decoder := newCallbackFrameDecoder(callbackMaxFrameBytes)
	buf := make([]byte, 4096)
	var reply map[string]any
	for {
		n, err := conn.Read(buf)
		if n > 0 && reply == nil {
			payloads, perr := decoder.Push(buf[:n])
			if perr == nil && len(payloads) > 0 {
				_ = json.Unmarshal(payloads[0], &reply)
			}
		}
		if err != nil {
			return reply, !errors.Is(err, os.ErrDeadlineExceeded)
		}
	}
}

// errorCode extracts reply.error.code ("" when the reply is nil or ok).
func errorCode(reply map[string]any) string {
	if reply == nil {
		return ""
	}
	body, _ := reply["error"].(map[string]any)
	code, _ := body["code"].(string)
	return code
}

// goroutineGuard fails the test if goroutines started since it was taken are
// still running shortly after the test body finishes. It only makes sense in
// tests that do not run in parallel.
func goroutineGuard(t *testing.T) func() {
	t.Helper()
	before := runtime.NumGoroutine()
	return func() {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			after := runtime.NumGoroutine()
			if after <= before {
				return
			}
			if time.Now().After(deadline) {
				buf := make([]byte, 1<<16)
				buf = buf[:runtime.Stack(buf, true)]
				t.Fatalf("goroutine leak: %d before, %d after\n%s", before, after, buf)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// pipeServer is a helper server over in-memory pipes, with the test acting as
// main: it sends RPC requests and reads responses and server-push events.
type pipeServer struct {
	t        *testing.T
	s        *server
	toHelper *io.PipeWriter
	events   chan map[string]any
	done     chan error

	responses map[int]chan map[string]any
	nextID    int
	mu        chan struct{} // 1-slot lock for responses/nextID
	stopped   bool
}

// newPipeServer starts serve() on a server with the given callback config. Each
// prep hook runs on the server before serve() starts (set cliPath, a handler...).
func newPipeServer(t *testing.T, cfg callbackConfig, prep ...func(*server)) *pipeServer {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	s := newServer(inR, outW, nil)
	s.cb = cfg
	for _, hook := range prep {
		hook(s)
	}
	p := &pipeServer{
		t:         t,
		s:         s,
		toHelper:  inW,
		events:    make(chan map[string]any, 256),
		done:      make(chan error, 1),
		responses: make(map[int]chan map[string]any),
		mu:        make(chan struct{}, 1),
	}
	p.mu <- struct{}{}
	go func() { p.done <- s.serve(); _ = outW.Close() }()
	go p.pump(outR)
	t.Cleanup(func() {
		if !p.stopped {
			_ = p.stop()
		}
	})
	return p
}

// pump routes everything the helper writes: responses to their waiting call,
// events to the events channel.
func (p *pipeServer) pump(r io.Reader) {
	for {
		body, err := readFrame(r)
		if err != nil {
			return
		}
		var msg map[string]any
		if err := json.Unmarshal(body, &msg); err != nil {
			continue
		}
		if _, isEvent := msg["event"]; isEvent {
			p.events <- msg
			continue
		}
		id, _ := msg["id"].(float64)
		<-p.mu
		ch := p.responses[int(id)]
		p.mu <- struct{}{}
		if ch != nil {
			ch <- msg
		}
	}
}

// start sends a request and returns a channel for its response.
func (p *pipeServer) start(method string, params any) chan map[string]any {
	p.t.Helper()
	<-p.mu
	p.nextID++
	id := p.nextID
	ch := make(chan map[string]any, 1)
	p.responses[id] = ch
	p.mu <- struct{}{}
	raw, err := json.Marshal(params)
	if err != nil {
		p.t.Fatalf("marshal params: %v", err)
	}
	// The pipe is synchronous: a write only completes once the helper's reader has
	// consumed it. Time-box it so a reader that stopped reading fails the test fast
	// instead of hanging it.
	written := make(chan error, 1)
	go func() { written <- writeFrame(p.toHelper, Request{ID: id, Method: method, Params: raw}) }()
	select {
	case err := <-written:
		if err != nil {
			p.t.Fatalf("write request: %v", err)
		}
	case <-time.After(10 * time.Second):
		p.t.Fatalf("writing %q blocked for 10s: the helper's reader is not consuming the stream", method)
	}
	return ch
}

// call sends a request and waits for its response.
func (p *pipeServer) call(method string, params any) map[string]any {
	p.t.Helper()
	return p.await(p.start(method, params), 5*time.Second)
}

func (p *pipeServer) await(ch chan map[string]any, wait time.Duration) map[string]any {
	p.t.Helper()
	select {
	case msg := <-ch:
		return msg
	case <-time.After(wait):
		p.t.Fatalf("no response within %s", wait)
		return nil
	}
}

// nextEvent waits for the next server-push event.
func (p *pipeServer) nextEvent(wait time.Duration) map[string]any {
	p.t.Helper()
	select {
	case ev := <-p.events:
		return ev
	case <-time.After(wait):
		p.t.Fatalf("no event within %s", wait)
		return nil
	}
}

// stop ends the stream (EOF on the helper's stdin) and waits for serve to return.
func (p *pipeServer) stop() error {
	p.t.Helper()
	p.stopped = true
	_ = p.toHelper.Close()
	select {
	case err := <-p.done:
		return err
	case <-time.After(10 * time.Second):
		p.t.Fatalf("serve did not return after EOF")
		return nil
	}
}

// testCallbackConfig is a callback config rooted in a private short directory:
// short deadlines, no shared /tmp state, and no peer check.
func testCallbackConfig(t *testing.T) callbackConfig {
	t.Helper()
	root := shortDir(t)
	return callbackConfig{
		home:           root,
		hostname:       "testhost",
		xdgRuntimeDir:  "",
		tmpRoot:        filepath.Join(root, "tmp"),
		uid:            os.Getuid(),
		readDeadline:   2 * time.Second,
		writeDeadline:  time.Second,
		forwardTimeout: 2 * time.Second,
		peerAllowed:    func(*net.UnixConn) bool { return true },
	}
}

// handshakeResult unpacks a successful handshake response.
func handshakeResult(t *testing.T, resp map[string]any) (sock, cli string) {
	t.Helper()
	if resp["error"] != nil {
		t.Fatalf("handshake failed: %v", resp["error"])
	}
	result, _ := resp["result"].(map[string]any)
	sock, _ = result["callbackSock"].(string)
	cli, _ = result["cliPath"].(string)
	return sock, cli
}
