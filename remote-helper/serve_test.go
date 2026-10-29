package main

// Scenario 13 (Go side): the reader/worker split. A slow method must never delay
// `callback.reply`, the next frame, or the stream's EOF; and every existing method
// keeps the arrival ordering it had when the read loop was also the executor.

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// gatedHandler wraps the real method table: "slow" blocks until released, and
// every request is recorded in worker order.
type gatedHandler struct {
	mu      sync.Mutex
	order   []string
	started chan string
	release chan struct{}
}

func newGatedHandler() *gatedHandler {
	return &gatedHandler{started: make(chan string, 64), release: make(chan struct{})}
}

func (g *gatedHandler) install(s *server) {
	real := s.handle
	s.handler = func(req Request) (interface{}, error) {
		g.mu.Lock()
		g.order = append(g.order, req.Method)
		g.mu.Unlock()
		if req.Method == "slow" {
			g.started <- req.Method
			<-g.release
			return map[string]any{"method": "slow"}, nil
		}
		if strings.HasPrefix(req.Method, "echo:") {
			return map[string]any{"method": req.Method}, nil
		}
		return real(req)
	}
}

func (g *gatedHandler) executed() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.order...)
}

func TestASlowMethodDoesNotDelayACallbackReply(t *testing.T) {
	gate := newGatedHandler()
	p, sock := openCallback(t, testCallbackConfig(t), gate.install)
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	})

	cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
	data := eventData(t, p.nextEvent(3*time.Second))

	// A slow method is now running on the worker...
	slow := p.start("slow", map[string]any{})
	select {
	case <-gate.started:
	case <-time.After(2 * time.Second):
		t.Fatal("the slow method never started")
	}

	// ...and main's reply is still answered immediately by the reader, and the CLI
	// gets its answer, while the worker is blocked.
	start := time.Now()
	resp := p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(1)})
	if resp["error"] != nil || resp["result"].(map[string]any)["delivered"] != true {
		t.Fatalf("callback.reply = %v", resp)
	}
	select {
	case reply := <-cli:
		if reply["ok"] != true {
			t.Fatalf("the CLI received %v", reply)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the CLI was not answered while a slow method held the worker: the reader is blocked behind the executor")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("callback.reply took %s behind a blocked worker", elapsed)
	}
	select {
	case <-slow:
		t.Fatal("the slow method finished before it was released")
	default:
	}

	close(gate.release)
	if resp := p.await(slow, 3*time.Second); resp["error"] != nil {
		t.Fatalf("slow method response = %v", resp)
	}
}

func TestExistingMethodsKeepTheirArrivalOrder(t *testing.T) {
	gate := newGatedHandler()
	p := newPipeServer(t, testCallbackConfig(t), gate.install)
	first := p.start("slow", map[string]any{})
	<-gate.started
	var rest []chan map[string]any
	for i := 0; i < 5; i++ {
		rest = append(rest, p.start(fmt.Sprintf("echo:%d", i), map[string]any{}))
	}
	// Nothing queued behind the slow method may run before it finishes.
	time.Sleep(100 * time.Millisecond)
	if got := gate.executed(); len(got) != 1 {
		t.Fatalf("executed %v while the first method was still running", got)
	}
	close(gate.release)
	p.await(first, 3*time.Second)
	for i, ch := range rest {
		resp := p.await(ch, 3*time.Second)
		if want := fmt.Sprintf("echo:%d", i); resp["result"].(map[string]any)["method"] != want {
			t.Fatalf("response %d = %v, want %s", i, resp, want)
		}
	}
	want := []string{"slow", "echo:0", "echo:1", "echo:2", "echo:3", "echo:4"}
	got := gate.executed()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("worker order = %v, want %v", got, want)
	}
}

func TestTheQueueIsUnboundedAndTheReaderNeverBlocksOnABusyWorker(t *testing.T) {
	gate := newGatedHandler()
	p := newPipeServer(t, testCallbackConfig(t), gate.install)
	p.start("slow", map[string]any{})
	<-gate.started

	const burst = 3000
	written := make(chan struct{})
	var chans []chan map[string]any
	go func() {
		defer close(written)
		for i := 0; i < burst; i++ {
			chans = append(chans, p.start("echo:burst", map[string]any{}))
		}
	}()
	select {
	case <-written:
	case <-time.After(5 * time.Second):
		t.Fatal("the reader stopped consuming the stream while the worker was busy: the queue is not unbounded")
	}
	close(gate.release)
	for i, ch := range chans {
		if resp := p.await(ch, 10*time.Second); resp["error"] != nil {
			t.Fatalf("burst response %d = %v", i, resp)
		}
	}
}

func TestEOFWhileTheWorkerIsBusyStillExecutesEveryAcceptedRequest(t *testing.T) {
	gate := newGatedHandler()
	p := newPipeServer(t, testCallbackConfig(t), gate.install)
	first := p.start("slow", map[string]any{})
	<-gate.started
	second := p.start("echo:a", map[string]any{})
	third := p.start("echo:b", map[string]any{})

	// The stream ends while the worker is still busy: serve must not return until
	// everything accepted before EOF was executed and answered, exactly as the
	// synchronous loop always did.
	_ = p.toHelper.Close()
	select {
	case <-p.done:
		t.Fatal("serve returned while an accepted request was still running")
	case <-time.After(150 * time.Millisecond):
	}
	close(gate.release)
	for _, ch := range []chan map[string]any{first, second, third} {
		if resp := p.await(ch, 3*time.Second); resp["error"] != nil {
			t.Fatalf("response = %v", resp)
		}
	}
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatalf("serve returned %v after a clean EOF", err)
		}
		p.stopped = true
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not return after the queue drained")
	}
}

func TestEOFReleasesTheCallbackPathBeforeASlowMethodFinishes(t *testing.T) {
	gate := newGatedHandler()
	p, sock := openCallback(t, testCallbackConfig(t), gate.install)
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	})
	p.start("slow", map[string]any{})
	<-gate.started

	_ = p.toHelper.Close()
	waitFor(t, "the callback socket to be unlinked while the worker is still busy", func() bool {
		_, err := exchangeProbe(sock)
		return err != nil
	})
	close(gate.release)
	select {
	case <-p.done:
		p.stopped = true
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not return")
	}
}

// exchangeProbe dials sock and reports the dial error (nil when something listens).
func exchangeProbe(sock string) (bool, error) {
	_, _, err := exchangeOrErr(sock, nil, 50*time.Millisecond)
	return err == nil, err
}

func TestAMalformedFrameEndsTheStreamWithAnErrorAfterDraining(t *testing.T) {
	p := newPipeServer(t, testCallbackConfig(t), newGatedHandler().install)
	ok := p.start("echo:ok", map[string]any{})
	// A length header over the RPC cap is unrecoverable for the stream framing.
	if _, err := p.toHelper.Write([]byte{0xff, 0xff, 0xff, 0xff}); err != nil {
		t.Fatal(err)
	}
	if resp := p.await(ok, 3*time.Second); resp["error"] != nil {
		t.Fatalf("the request accepted before the bad frame must still be answered: %v", resp)
	}
	select {
	case err := <-p.done:
		if err == nil {
			t.Fatal("serve must report the framing error")
		}
		p.stopped = true
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not return after a malformed frame")
	}
}

func TestCallbackReplyIsAnsweredInlineEvenBeforeAnyHandshake(t *testing.T) {
	gate := newGatedHandler()
	p := newPipeServer(t, testCallbackConfig(t), gate.install)
	p.start("slow", map[string]any{})
	<-gate.started
	resp := p.call("callback.reply", map[string]any{"connId": 1, "reply": dispatchedFor(1)})
	if resp["error"] != nil || resp["result"].(map[string]any)["delivered"] != false {
		t.Fatalf("a reply with no service must be delivered=false, immediately: %v", resp)
	}
	close(gate.release)
}

func TestRequestQueueIsFIFOAndDrainsAfterClose(t *testing.T) {
	q := newRequestQueue()
	for i := 1; i <= 3; i++ {
		q.push(Request{ID: i, Method: "m", Params: json.RawMessage(`{}`)})
	}
	q.close()
	q.push(Request{ID: 99}) // ignored after close
	for want := 1; want <= 3; want++ {
		req, ok := q.pop()
		if !ok || req.ID != want {
			t.Fatalf("pop = %v %v, want id %d", req, ok, want)
		}
	}
	if _, ok := q.pop(); ok {
		t.Fatal("a closed, drained queue must report ok=false")
	}
}

func TestRequestQueuePopBlocksUntilPush(t *testing.T) {
	q := newRequestQueue()
	got := make(chan Request, 1)
	go func() {
		req, _ := q.pop()
		got <- req
	}()
	select {
	case <-got:
		t.Fatal("pop returned from an empty queue")
	case <-time.After(50 * time.Millisecond):
	}
	q.push(Request{ID: 7})
	select {
	case req := <-got:
		if req.ID != 7 {
			t.Fatalf("got %v", req)
		}
	case <-time.After(time.Second):
		t.Fatal("pop did not wake on push")
	}
}
