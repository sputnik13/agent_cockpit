package main

// The unix-socket server behind one project's callback endpoint: bind with
// newest-wins takeover, accept bounded one-request connections, close with an
// inode-checked unlink. It knows nothing about operations; every decoded request
// goes to `handle`, which is the callbackService's decision function. It is the Go
// counterpart of electron/main/callback/listener.ts and keeps the same contract.
//
// Takeover (requirement 5): the new owner binds a uniquely named temporary path
// in the same directory, chmods it 0600 (the 0700 directory is the real barrier),
// and renames it over the real path. rename(2) is atomic, so the path is never
// briefly absent, and the NEWEST listener always holds it: a stale predecessor
// (a helper left alive by a half-open ssh drop) stays bound to an inode nothing
// can reach. A fixed temp name would let an old listener's close unlink it.
//
// Every owner unlinks on close only if the path's inode is still its own
// (SetUnlinkOnClose(false) plus an explicit lstat identity check): the runtime
// unlinks only the name it BOUND (the temp name, already renamed away), never the
// final path, so this explicit unlink is the only thing that removes the socket
// file. Check-then-unlink has a tiny residual window, which is accepted.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	// acceptRetryDelay keeps a persistent accept error (for example EMFILE) from
	// becoming a hot loop.
	acceptRetryDelay = 50 * time.Millisecond
	// closeGrace is how long Close lets in-flight connections finish writing their
	// reply (a pending request answers `not-connected`) before dropping them.
	closeGrace = 750 * time.Millisecond
	// readChunkBytes is the size of one read from a connection.
	readChunkBytes = 4096
)

type callbackListenerOptions struct {
	// socketPath is the final socket path. Its directory must already exist and
	// be verified (preparePrivateDir).
	socketPath string
	// maxConnections caps concurrent connections; further ones are dropped.
	maxConnections int
	// readDeadline is the absolute per-connection deadline for receiving the
	// request, from accept.
	readDeadline time.Duration
	// writeDeadline bounds writing the reply.
	writeDeadline time.Duration
	// handle answers the one decoded request of a connection. A panic becomes
	// `internal`.
	handle func(request json.RawMessage) callbackReply
	// peerAllowed vets an accepted connection's peer (Linux: SO_PEERCRED uid).
	// nil means the platform default.
	peerAllowed func(*net.UnixConn) bool
	logf        func(format string, args ...any)
}

// fileIdentity names a file independently of its path.
type fileIdentity struct{ dev, ino uint64 }

func identityOf(fi os.FileInfo) (fileIdentity, bool) {
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, false
	}
	return fileIdentity{dev: uint64(sys.Dev), ino: uint64(sys.Ino)}, true
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on supported platforms; a clock-derived name is
		// still unique enough for a temp path that is renamed away immediately.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

type callbackListener struct {
	opts     callbackListenerOptions
	ln       *net.UnixListener
	path     string
	identity fileIdentity
	slots    chan struct{}

	wg        sync.WaitGroup
	closing   atomic.Bool
	beginOnce sync.Once

	mu    sync.Mutex
	conns map[*net.UnixConn]struct{}
}

// startCallbackListener binds, chmods 0600 and renames into place. On any
// failure nothing is left behind.
func startCallbackListener(opts callbackListenerOptions) (*callbackListener, error) {
	if opts.maxConnections <= 0 {
		opts.maxConnections = callbackMaxConnections
	}
	if opts.readDeadline <= 0 {
		opts.readDeadline = callbackCLIDeadline
	}
	if opts.writeDeadline <= 0 {
		opts.writeDeadline = callbackWriteDeadline
	}
	if opts.peerAllowed == nil {
		opts.peerAllowed = defaultPeerAllowed
	}
	if opts.logf == nil {
		opts.logf = func(string, ...any) {}
	}

	tempPath := filepath.Join(
		filepath.Dir(opts.socketPath),
		strings.TrimSuffix(filepath.Base(opts.socketPath), ".sock")+"."+randomHex(3)+".tmp",
	)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: tempPath, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	abort := func(cause error) (*callbackListener, error) {
		_ = ln.Close()
		_ = os.Remove(tempPath)
		return nil, cause
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		return abort(err)
	}
	fi, err := os.Lstat(tempPath)
	if err != nil {
		return abort(err)
	}
	if fi.Mode()&os.ModeSocket == 0 {
		return abort(fmt.Errorf("%s is not a socket", tempPath))
	}
	identity, ok := identityOf(fi)
	if !ok {
		return abort(fmt.Errorf("cannot identify %s", tempPath))
	}
	if err := os.Rename(tempPath, opts.socketPath); err != nil {
		return abort(err)
	}
	l := &callbackListener{
		opts:     opts,
		ln:       ln,
		path:     opts.socketPath,
		identity: identity,
		slots:    make(chan struct{}, opts.maxConnections),
		conns:    make(map[*net.UnixConn]struct{}),
	}
	l.wg.Add(1)
	go l.acceptLoop()
	return l, nil
}

// SocketPath is the path the listener serves.
func (l *callbackListener) SocketPath() string { return l.path }

// Close unlinks the socket if it is still ours, stops accepting, lets in-flight
// connections finish (they answer `not-connected` once the owner signals its own
// shutdown) for a short grace period, then drops whatever is left. The unlink
// comes first and is synchronous, so the path is gone the moment Close is called.
func (l *callbackListener) Close() {
	l.beginClose()
	l.waitClosed()
}

// beginClose is the part of Close that must happen at once and never waits: mark
// the listener closing, unlink the socket if it is still ours, stop accepting, and
// wake connections blocked waiting for a request so they can answer. Idempotent.
func (l *callbackListener) beginClose() {
	l.beginOnce.Do(func() {
		l.closing.Store(true)
		l.unlinkIfOurs()
		_ = l.ln.Close()
		l.mu.Lock()
		for conn := range l.conns {
			_ = conn.SetReadDeadline(time.Now())
		}
		l.mu.Unlock()
	})
}

// waitClosed gives in-flight connections a short grace period to finish writing
// their reply, then drops whatever is left. Safe to call from several goroutines
// (each waits for the same drain); call it after beginClose.
func (l *callbackListener) waitClosed() {
	done := make(chan struct{})
	go func() {
		l.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(closeGrace):
		l.mu.Lock()
		for conn := range l.conns {
			_ = conn.Close()
		}
		l.mu.Unlock()
		select {
		case <-done:
		case <-time.After(closeGrace):
		}
	}
}

func (l *callbackListener) isClosing() bool { return l.closing.Load() }

func (l *callbackListener) unlinkIfOurs() {
	fi, err := os.Lstat(l.path)
	if err != nil {
		return // already gone
	}
	id, ok := identityOf(fi)
	if fi.Mode()&os.ModeSocket != 0 && ok && id == l.identity {
		_ = os.Remove(l.path)
	}
	// Otherwise it was replaced by a newer owner: nothing of ours to remove.
}

func (l *callbackListener) acceptLoop() {
	defer l.wg.Done()
	for {
		conn, err := l.ln.AcceptUnix()
		if err != nil {
			if l.isClosing() || errors.Is(err, net.ErrClosed) {
				return
			}
			l.opts.logf("callback accept error: %v", err)
			time.Sleep(acceptRetryDelay)
			continue
		}
		l.admit(conn)
	}
}

// admit applies the connection cap and the peer check, then serves the
// connection on its own goroutine. A connection beyond the cap is turned away with
// a `rate-limited` reply.
func (l *callbackListener) admit(conn *net.UnixConn) {
	select {
	case l.slots <- struct{}{}:
	default:
		l.turnAway(conn)
		return
	}
	if !l.opts.peerAllowed(conn) {
		l.opts.logf("callback connection refused: peer is not the helper's user")
		<-l.slots
		_ = conn.Close()
		return
	}
	l.mu.Lock()
	if l.isClosing() {
		l.mu.Unlock()
		<-l.slots
		_ = conn.Close()
		return
	}
	l.conns[conn] = struct{}{}
	l.wg.Add(1)
	l.mu.Unlock()
	go func() {
		defer l.wg.Done()
		defer func() { <-l.slots }()
		defer func() {
			l.mu.Lock()
			delete(l.conns, conn)
			l.mu.Unlock()
		}()
		l.serveConn(conn)
	}()
}

// turnAway answers a connection past the cap with `rate-limited` (under the write
// deadline, so a peer that never reads cannot hold the accept loop) and closes it.
// Silence would leave the CLI reporting "connection closed before a reply", which
// reads as "not connected" when the truth is "busy, try again".
func (l *callbackListener) turnAway(conn *net.UnixConn) {
	l.writeReply(conn, errorReply(0, "rate-limited", "too many concurrent requests"))
	_ = conn.Close()
}

// serveConn handles one connection: decode the first complete frame, answer it,
// and close. An absolute deadline from accept bounds a silent or slowloris peer
// (and, because the connection is closed after the reply, a peer that never
// closes).
func (l *callbackListener) serveConn(conn *net.UnixConn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(l.opts.readDeadline))
	if l.isClosing() {
		// Close woke the tracked connections before this goroutine set its own
		// deadline (which would have overwritten the wake-up): wake ourselves.
		_ = conn.SetReadDeadline(time.Now())
	}
	decoder := newCallbackFrameDecoder(callbackMaxFrameBytes)
	buf := make([]byte, readChunkBytes)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			requests, perr := decoder.Push(buf[:n])
			if perr != nil {
				l.writeReply(conn, errorReply(0, "bad-request", perr.Error()))
				return
			}
			if len(requests) > 0 {
				// One request per connection: anything after it is ignored.
				l.writeReply(conn, l.decide(requests[0]))
				return
			}
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				if l.isClosing() {
					l.writeReply(conn, errorReply(0, "not-connected", "the helper is shutting down"))
				} else {
					l.writeReply(conn, errorReply(0, "timeout", "request not received in time"))
				}
			}
			// EOF mid-frame or a reset: the peer finished without a complete
			// request and there is nobody to answer.
			return
		}
	}
}

// decide runs the owner's decision function; a panic becomes `internal` rather
// than taking the helper down.
func (l *callbackListener) decide(request json.RawMessage) (reply callbackReply) {
	defer func() {
		if r := recover(); r != nil {
			l.opts.logf("callback handler panic: %v", r)
			reply = errorReply(0, "internal", "internal error")
		}
	}()
	return l.opts.handle(request)
}

func (l *callbackListener) writeReply(conn *net.UnixConn, reply callbackReply) {
	frame, err := encodeCallbackFrame(reply)
	if err != nil {
		// A reply over the frame cap must not become a missing reply.
		frame, _ = encodeCallbackFrame(errorReply(0, "internal", "internal error"))
	}
	_ = conn.SetWriteDeadline(time.Now().Add(l.opts.writeDeadline))
	_, _ = conn.Write(frame)
}
