package main

// Scenarios 7 (Go side: takeover) and 14 (listener: frame cap, read deadline, one
// request per connection, slowloris, peer check) with REAL unix sockets in a
// short temporary directory.

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// dispatchedReply is what a handler returns for an accepted request.
func dispatchedReply(json.RawMessage) callbackReply {
	return okReply(1, map[string]any{"status": "dispatched"})
}

// startTestListener binds a listener on a fresh short path.
func startTestListener(t *testing.T, handle func(json.RawMessage) callbackReply, tweak func(*callbackListenerOptions)) (*callbackListener, string) {
	t.Helper()
	sock := filepath.Join(shortDir(t), "t.sock")
	return startListenerAt(t, sock, handle, tweak), sock
}

func startListenerAt(t *testing.T, sock string, handle func(json.RawMessage) callbackReply, tweak func(*callbackListenerOptions)) *callbackListener {
	t.Helper()
	opts := callbackListenerOptions{
		socketPath:  sock,
		handle:      handle,
		peerAllowed: func(*net.UnixConn) bool { return true },
	}
	if tweak != nil {
		tweak(&opts)
	}
	l, err := startCallbackListener(opts)
	if err != nil {
		t.Fatalf("start listener: %v", err)
	}
	t.Cleanup(l.Close)
	return l
}

func validOpenFrame(t *testing.T) []byte {
	t.Helper()
	return mustFrame(t, callbackRequest{V: 1, ID: 1, Op: "open", Args: openArgs{Path: "/a/b.md"}})
}

func TestListenerServesAValidRequestAndBindsOwnerOnly(t *testing.T) {
	guard := goroutineGuard(t)
	l, sock := startTestListener(t, dispatchedReply, nil)

	st, err := os.Lstat(sock)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %v, want a socket with permissions 0600", st.Mode())
	}
	reply, closed := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if reply["ok"] != true || !closed {
		t.Fatalf("reply=%v closed=%v, want ok and a closed connection", reply, closed)
	}
	if entries, _ := os.ReadDir(filepath.Dir(sock)); len(entries) != 1 {
		t.Fatalf("the directory holds %d entries, want only the socket (the temp name must be renamed away)", len(entries))
	}
	l.Close()
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("the socket must be unlinked on close: %v", err)
	}
	guard()
}

func TestListenerAnswersOneRequestPerConnection(t *testing.T) {
	var calls atomic.Int32
	_, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		calls.Add(1)
		return okReply(1, map[string]any{"status": "dispatched"})
	}, nil)
	two := append(validOpenFrame(t), validOpenFrame(t)...)
	reply, closed := exchange(t, sock, two, 2*time.Second)
	if reply["ok"] != true || !closed {
		t.Fatalf("reply=%v closed=%v", reply, closed)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("handler ran %d times, want exactly once (anything after the one request is ignored)", got)
	}
}

func TestListenerRejectsAFrameOverTheCapBeforeReadingAnyBody(t *testing.T) {
	_, sock := startTestListener(t, dispatchedReply, func(o *callbackListenerOptions) {
		o.readDeadline = 5 * time.Second // a body-waiting implementation would answer `timeout` only after 5 s
	})
	start := time.Now()
	// A header declaring 64 KiB + 1, and no body at all.
	reply, closed := exchange(t, sock, []byte{0x00, 0x01, 0x00, 0x01}, 3*time.Second)
	if errorCode(reply) != "bad-request" || !closed {
		t.Fatalf("reply=%v closed=%v, want bad-request and a closed connection", reply, closed)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("the oversize header was rejected after %s; it must be rejected before any body is awaited", elapsed)
	}
}

func TestListenerAcceptsABodyExactlyAtTheCap(t *testing.T) {
	var got atomic.Int64
	_, sock := startTestListener(t, func(raw json.RawMessage) callbackReply {
		got.Store(int64(len(raw)))
		return dispatchedReply(raw)
	}, nil)
	reply, _ := exchange(t, sock, mustFrame(t, strings.Repeat("a", callbackMaxFrameBytes-2)), 3*time.Second)
	if reply["ok"] != true || got.Load() != callbackMaxFrameBytes {
		t.Fatalf("reply=%v bodyBytes=%d, want ok with a %d-byte body", reply, got.Load(), callbackMaxFrameBytes)
	}
}

func TestListenerAnswersBadRequestToMalformedJSON(t *testing.T) {
	_, sock := startTestListener(t, dispatchedReply, nil)
	reply, _ := exchange(t, sock, []byte{0, 0, 0, 5, '{', 'o', 'o', 'p', 's'}, 2*time.Second)
	if errorCode(reply) != "bad-request" || reply["id"] != float64(0) {
		t.Fatalf("reply = %v, want bad-request with id 0", reply)
	}
}

func TestListenerDoesNotAnswerATruncatedFrame(t *testing.T) {
	_, sock := startTestListener(t, dispatchedReply, nil)
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	frame := validOpenFrame(t)
	if _, err := conn.Write(frame[:len(frame)/2]); err != nil {
		t.Fatal(err)
	}
	if err := conn.(*net.UnixConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	reply, closed := readReplyFrame(t, conn, 2*time.Second)
	if reply != nil || !closed {
		t.Fatalf("reply=%v closed=%v: a peer that finished mid-frame has nobody to answer", reply, closed)
	}
}

func TestListenerAnswersTimeoutToASilentPeer(t *testing.T) {
	_, sock := startTestListener(t, dispatchedReply, func(o *callbackListenerOptions) {
		o.readDeadline = 300 * time.Millisecond
	})
	start := time.Now()
	reply, closed := exchange(t, sock, nil, 3*time.Second)
	if errorCode(reply) != "timeout" || !closed {
		t.Fatalf("reply=%v closed=%v, want timeout", reply, closed)
	}
	if elapsed := time.Since(start); elapsed < 250*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("timeout arrived after %s, want about the 300ms deadline", elapsed)
	}
}

func TestListenerDeadlineIsAbsoluteSoASlowlorisPeerIsCutOff(t *testing.T) {
	var calls atomic.Int32
	_, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		calls.Add(1)
		return dispatchedReply(nil)
	}, func(o *callbackListenerOptions) { o.readDeadline = 400 * time.Millisecond })

	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Declare a 1000-byte body, then trickle one byte every 50 ms. An IDLE timeout
	// would be refreshed by every byte and never fire inside a second.
	start := time.Now()
	_, _ = conn.Write([]byte{0, 0, 0x03, 0xe8})
	done := make(chan map[string]any, 1)
	go func() {
		reply, _ := readReplyFrame(t, conn, 5*time.Second)
		done <- reply
	}()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var reply map[string]any
loop:
	for {
		select {
		case reply = <-done:
			break loop
		case <-ticker.C:
			_, _ = conn.Write([]byte{'x'})
		}
	}
	if errorCode(reply) != "timeout" {
		t.Fatalf("reply = %v, want timeout", reply)
	}
	if elapsed := time.Since(start); elapsed > 1500*time.Millisecond {
		t.Fatalf("the trickling peer was cut off after %s; the deadline must be absolute from accept", elapsed)
	}
	if calls.Load() != 0 {
		t.Fatal("an incomplete request must never reach the handler")
	}
}

func TestListenerTurnsAwayConnectionsPastMaxConnectionsWithARateLimitedReply(t *testing.T) {
	var calls atomic.Int32
	l, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		calls.Add(1)
		return dispatchedReply(nil)
	}, func(o *callbackListenerOptions) {
		o.maxConnections = 2
		o.readDeadline = 10 * time.Second
	})
	hold := func() net.Conn {
		conn, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	first, second := hold(), hold()
	waitFor(t, "two connections admitted", func() bool { return len(l.slots) == 2 })

	// The third connection is told why (not dropped silently, which the CLI would
	// report as "connection closed before a reply", i.e. "not connected"): the
	// reply is `rate-limited`, it is closed, and its request never reaches the handler.
	reply, closed := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if errorCode(reply) != "rate-limited" || !closed {
		t.Fatalf("the third connection got reply=%v closed=%v; want a rate-limited reply and a closed connection", reply, closed)
	}
	if calls.Load() != 0 {
		t.Fatal("a connection past the cap must not reach the handler")
	}

	// Freeing a slot makes the listener serve again.
	first.Close()
	waitFor(t, "a slot freed", func() bool { return len(l.slots) == 1 })
	fourth, closed := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if fourth["ok"] != true || !closed {
		t.Fatalf("after a slot freed: reply=%v closed=%v", fourth, closed)
	}
	_ = second
}

func TestOverCapConnectionsThatNeverReadCannotHoldTheAcceptLoop(t *testing.T) {
	l, sock := startTestListener(t, dispatchedReply, func(o *callbackListenerOptions) {
		o.maxConnections = 1
		o.readDeadline = 10 * time.Second
		o.writeDeadline = 200 * time.Millisecond
	})
	holder, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	waitFor(t, "the one slot taken", func() bool { return len(l.slots) == 1 })

	// A crowd of over-cap peers that connect and never read their reply.
	var crowd []net.Conn
	for i := 0; i < 60; i++ {
		conn, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		crowd = append(crowd, conn)
	}
	defer func() {
		for _, conn := range crowd {
			conn.Close()
		}
	}()

	// The accept queue is FIFO and the turn-away is synchronous in the accept loop, so
	// a probe connected AFTER the crowd is answered only once the whole crowd has been
	// turned away. Answered promptly means the loop was not held by peers that never
	// read; it also guarantees no crowd member is still queued to take the slot freed
	// below (which would make the next step race the accept loop).
	start := time.Now()
	probe, closed := exchange(t, sock, validOpenFrame(t), 3*time.Second)
	if errorCode(probe) != "rate-limited" || !closed {
		t.Fatalf("probe: reply=%v closed=%v; want a rate-limited reply behind the crowd", probe, closed)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("a probe took %s behind a crowd of over-cap peers", elapsed)
	}

	holder.Close()
	waitFor(t, "the slot freed", func() bool { return len(l.slots) == 0 })
	reply, _ := exchange(t, sock, validOpenFrame(t), 3*time.Second)
	if reply["ok"] != true {
		t.Fatalf("reply = %v: the listener stopped serving behind a crowd of over-cap peers", reply)
	}
}

func TestListenerDefaultsToTheHelperConnectionCap(t *testing.T) {
	l, _ := startTestListener(t, dispatchedReply, nil)
	if cap(l.slots) != callbackMaxConnections || callbackMaxConnections != 16 {
		t.Fatalf("slots = %d, want the helper's cap of 16", cap(l.slots))
	}
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestListenerTurnsAHandlerPanicIntoInternal(t *testing.T) {
	_, sock := startTestListener(t, func(json.RawMessage) callbackReply { panic("boom") }, nil)
	reply, _ := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if errorCode(reply) != "internal" {
		t.Fatalf("reply = %v, want internal", reply)
	}
	// The listener survives and serves the next request (still panicking -> internal).
	reply, _ = exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if errorCode(reply) != "internal" {
		t.Fatalf("second reply = %v", reply)
	}
}

func TestListenerRefusesAPeerThePeerCheckRejects(t *testing.T) {
	var calls atomic.Int32
	_, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		calls.Add(1)
		return dispatchedReply(nil)
	}, func(o *callbackListenerOptions) {
		o.peerAllowed = func(*net.UnixConn) bool { return false }
	})
	reply, closed := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if reply != nil || !closed {
		t.Fatalf("reply=%v closed=%v: a refused peer gets no service", reply, closed)
	}
	if calls.Load() != 0 {
		t.Fatal("the handler must not run for a refused peer")
	}
}

func TestListenerOverReplyBecomesInternalNotSilence(t *testing.T) {
	_, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		return okReply(1, map[string]any{"blob": strings.Repeat("x", callbackMaxFrameBytes)})
	}, nil)
	reply, _ := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if errorCode(reply) != "internal" {
		t.Fatalf("reply = %v, want internal for a reply that cannot be framed", reply)
	}
}

func TestCloseWakesAnIdleConnectionWithNotConnected(t *testing.T) {
	l, sock := startTestListener(t, dispatchedReply, func(o *callbackListenerOptions) {
		o.readDeadline = 10 * time.Second
	})
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	waitFor(t, "connection admitted", func() bool { return len(l.slots) == 1 })

	start := time.Now()
	go l.Close()
	reply, closed := readReplyFrame(t, conn, 3*time.Second)
	if errorCode(reply) != "not-connected" || !closed {
		t.Fatalf("reply=%v closed=%v, want not-connected", reply, closed)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("Close took %s with an idle connection", elapsed)
	}
}

// ---- Takeover (scenario 7, Go side) ---------------------------------------------

func TestNewestListenerWinsThePathAndAStalePredecessorCannotDeleteIt(t *testing.T) {
	sock := filepath.Join(shortDir(t), "t.sock")
	var oldCalls, newCalls atomic.Int32
	old := startListenerAt(t, sock, func(json.RawMessage) callbackReply {
		oldCalls.Add(1)
		return okReply(1, map[string]any{"owner": "old"})
	}, nil)
	newer := startListenerAt(t, sock, func(json.RawMessage) callbackReply {
		newCalls.Add(1)
		return okReply(1, map[string]any{"owner": "new"})
	}, nil)

	reply, _ := exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if result, _ := reply["result"].(map[string]any); result["owner"] != "new" {
		t.Fatalf("the path reached %v; the NEWEST listener must win unconditionally", reply)
	}
	if oldCalls.Load() != 0 {
		t.Fatal("the stale predecessor must be unreachable through the path")
	}

	// The predecessor closing must not unlink the newer owner's socket (inode check).
	old.Close()
	if _, err := os.Lstat(sock); err != nil {
		t.Fatalf("the stale predecessor's close removed the newer socket: %v", err)
	}
	reply, _ = exchange(t, sock, validOpenFrame(t), 2*time.Second)
	if result, _ := reply["result"].(map[string]any); result["owner"] != "new" || newCalls.Load() != 2 {
		t.Fatalf("after the predecessor closed, reply=%v newCalls=%d", reply, newCalls.Load())
	}

	// The owner closing removes its own socket.
	newer.Close()
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("the owner's close must unlink its own socket: %v", err)
	}
}

func TestCloseNeverRemovesAnythingItDoesNotOwn(t *testing.T) {
	sock := filepath.Join(shortDir(t), "t.sock")
	l := startListenerAt(t, sock, dispatchedReply, nil)
	// Something else takes the path: a regular file.
	if err := os.Remove(sock); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sock, []byte("not ours"), 0o600); err != nil {
		t.Fatal(err)
	}
	l.Close()
	if data, err := os.ReadFile(sock); err != nil || string(data) != "not ours" {
		t.Fatalf("Close removed or changed a file it does not own: %v %q", err, data)
	}
}

func TestStartLeavesNoTempNameBehindOnFailure(t *testing.T) {
	dir := shortDir(t)
	sock := filepath.Join(dir, "t.sock")
	// A directory at the final path makes the rename fail after the bind succeeded.
	if err := os.Mkdir(sock, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sock, "keep"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := startCallbackListener(callbackListenerOptions{socketPath: sock, handle: dispatchedReply})
	if err == nil {
		t.Fatal("expected the rename onto a non-empty directory to fail")
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != "t.sock" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("directory holds %v after a failed start; the temp name must be removed", names)
	}
}

func TestEveryStartBindsAUniqueTempName(t *testing.T) {
	// A fixed temp name would let an old listener's close unlink a new one's: two
	// starts racing for the same path must never collide on the temp name.
	dir := shortDir(t)
	sock := filepath.Join(dir, "t.sock")
	for i := 0; i < 20; i++ {
		l, err := startCallbackListener(callbackListenerOptions{socketPath: sock, handle: dispatchedReply})
		if err != nil {
			t.Fatalf("start %d: %v", i, err)
		}
		t.Cleanup(l.Close)
	}
}

func TestBeginCloseNeverWaitsForInFlightWork(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	l, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		started <- struct{}{}
		<-release // a handler that is stuck far longer than the close grace
		return dispatchedReply(nil)
	}, nil)
	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write(validOpenFrame(t)); err != nil {
		t.Fatal(err)
	}
	<-started

	start := time.Now()
	l.beginClose()
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("beginClose took %s; it must not wait for in-flight connections", elapsed)
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("beginClose must unlink the socket at once: %v", err)
	}
	if _, err := net.Dial("unix", sock); err == nil {
		t.Fatal("a closing listener must refuse new connections")
	}

	// waitClosed is where the grace period lives: it waits, then force-drops.
	begin := time.Now()
	l.waitClosed()
	if elapsed := time.Since(begin); elapsed < closeGrace/2 {
		t.Fatalf("waitClosed returned after %s without the stuck connection finishing", elapsed)
	}
	close(release)
}
