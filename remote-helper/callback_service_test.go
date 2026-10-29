package main

// Scenario 13 (Go side): the remote reply path. The test plays the role of main:
// it sends RPC requests over a pipe and reads responses and `callback` events.

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

const testProject = "project-a"

func withCLI(s *server) { s.cliPath = "/home/test/.agent-cockpit/bin/test/cockpit" }

func handshakeParams(project string) map[string]any {
	params := map[string]any{"protocolVersion": ProtocolVersion}
	if project != "" {
		params["projectId"] = project
	}
	return params
}

// openCallback starts a pipe server, handshakes for testProject and returns the
// server with the reported socket path.
func openCallback(t *testing.T, cfg callbackConfig, prep ...func(*server)) (*pipeServer, string) {
	t.Helper()
	p := newPipeServer(t, cfg, append([]func(*server){withCLI}, prep...)...)
	sock, cli := handshakeResult(t, p.call("handshake", handshakeParams(testProject)))
	if sock == "" || cli == "" {
		t.Fatalf("handshake reported callbackSock=%q cliPath=%q, want both", sock, cli)
	}
	return p, sock
}

// pendingCLI sends a request over the socket the way the CLI does and returns a
// channel for the reply.
func pendingCLI(t *testing.T, sock string, raw []byte, wait time.Duration) chan map[string]any {
	t.Helper()
	out := make(chan map[string]any, 1)
	go func() {
		reply, _, err := exchangeOrErr(sock, raw, wait)
		if err != nil {
			reply = map[string]any{"dialError": err.Error()}
		}
		out <- reply
	}()
	return out
}

func eventData(t *testing.T, ev map[string]any) map[string]any {
	t.Helper()
	if ev["event"] != "callback" {
		t.Fatalf("event = %v, want callback", ev["event"])
	}
	data, _ := ev["data"].(map[string]any)
	return data
}

func dispatchedFor(id int64) map[string]any {
	return map[string]any{"id": id, "ok": true, "result": map[string]any{"status": "dispatched"}}
}

// ---- Handshake -------------------------------------------------------------------

func TestHandshakeStartsTheProjectListenerAndReportsPaths(t *testing.T) {
	cfg := testCallbackConfig(t)
	p, sock := openCallback(t, cfg)

	wantName := callbackHostHash(cfg.hostname) + "-" + callbackProjectHash(testProject) + ".sock"
	wantDir := filepath.Join(cfg.home, ".agent-cockpit", "callback")
	if sock != filepath.Join(wantDir, wantName) {
		t.Fatalf("callbackSock = %s, want %s", sock, filepath.Join(wantDir, wantName))
	}
	if got := mode(t, wantDir); got != 0o700 {
		t.Fatalf("the socket directory mode = %o, want 700", got)
	}
	st, err := os.Lstat(sock)
	if err != nil || st.Mode()&os.ModeSocket == 0 || st.Mode().Perm() != 0o600 {
		t.Fatalf("socket: %v %v, want a 0600 socket", st, err)
	}

	// The handshake still reports what it always did.
	resp := p.call("handshake", handshakeParams(testProject))
	result := resp["result"].(map[string]any)
	if result["protocolVersion"] != float64(ProtocolVersion) || result["pid"] != float64(os.Getpid()) {
		t.Fatalf("handshake result = %v", result)
	}
}

func TestHandshakeWithoutAProjectStartsNoListener(t *testing.T) {
	cfg := testCallbackConfig(t)
	p := newPipeServer(t, cfg, withCLI)
	resp := p.call("handshake", handshakeParams(""))
	sock, cli := handshakeResult(t, resp)
	if sock != "" || cli != "" {
		t.Fatalf("callbackSock=%q cliPath=%q, want neither without a project id", sock, cli)
	}
	result := resp["result"].(map[string]any)
	if _, present := result["callbackSock"]; present {
		t.Fatal("empty callback fields must be omitted from the wire result")
	}
	if _, err := os.Stat(filepath.Join(cfg.home, ".agent-cockpit")); !os.IsNotExist(err) {
		t.Fatal("no directory may be created when no listener is started")
	}
}

func TestHandshakeVersionMismatchStillFailsFirst(t *testing.T) {
	p := newPipeServer(t, testCallbackConfig(t), withCLI)
	resp := p.call("handshake", map[string]any{"protocolVersion": ProtocolVersion + 1, "projectId": testProject})
	if resp["error"] == nil {
		t.Fatalf("a version mismatch must fail the handshake: %v", resp)
	}
}

func TestHandshakeDisablesCallbackWithoutACLILink(t *testing.T) {
	p := newPipeServer(t, testCallbackConfig(t)) // cliPath stays empty
	sock, cli := handshakeResult(t, p.call("handshake", handshakeParams(testProject)))
	if sock != "" || cli != "" {
		t.Fatalf("callbackSock=%q cliPath=%q: without a CLI link nothing can be injected, so no listener runs", sock, cli)
	}
}

func TestHandshakeSurvivesAnUnusableDirectory(t *testing.T) {
	cfg := testCallbackConfig(t)
	// Home is a regular file, so the callback directory cannot be created.
	home := filepath.Join(cfg.home, "afile")
	if err := os.WriteFile(home, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.home = home
	// A long fallback root as well, so the /tmp fallback cannot rescue it either.
	cfg.tmpRoot = filepath.Join(home, "tmp")
	p := newPipeServer(t, cfg, withCLI)
	resp := p.call("handshake", handshakeParams(testProject))
	sock, cli := handshakeResult(t, resp) // fails the test if the handshake itself errored
	if sock != "" || cli != "" {
		t.Fatalf("callbackSock=%q cliPath=%q, want callback disabled", sock, cli)
	}
}

func TestLongHomeFallsBackToTheShortTmpDirectoryAndReportsIt(t *testing.T) {
	cfg := testCallbackConfig(t)
	longHome := filepath.Join(cfg.home, strings.Repeat("a-long-directory-name", 4))
	if err := os.MkdirAll(longHome, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.home = longHome
	p := newPipeServer(t, cfg, withCLI)
	sock, _ := handshakeResult(t, p.call("handshake", handshakeParams(testProject)))
	if want := filepath.Join(cfg.tmpRoot, "ac-cb-"+strconv.Itoa(cfg.uid)); filepath.Dir(sock) != want {
		t.Fatalf("callbackSock = %s, want it under the fallback %s", sock, want)
	}
	reply, _ := exchange(t, sock, mustFrame(t, callbackRequest{V: 1, ID: 1, Op: "bogus", Args: map[string]any{}}), 2*time.Second)
	if errorCode(reply) != "unsupported-op" {
		t.Fatalf("the fallback socket must serve: %v", reply)
	}
}

// ---- Forward and reply -------------------------------------------------------------

func TestRequestIsForwardedToMainAndTheReplyRelayedToTheCLI(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	sent := callbackRequest{
		V: 1, ID: 7, Op: "open", Pane: &callbackPane{Kind: "tmux", ID: "%3"},
		Args: openArgs{Path: "/Users/me/repo/a b.md", CanonicalPath: "/Users/me/repo/a b.md"},
	}
	cli := pendingCLI(t, sock, mustFrame(t, sent), 5*time.Second)

	data := eventData(t, p.nextEvent(3*time.Second))
	connID, _ := data["connId"].(float64)
	if connID < 1 {
		t.Fatalf("the event must carry a connId: %v", data)
	}
	forwarded, _ := json.Marshal(data["request"])
	want, _ := json.Marshal(sent)
	assertSameJSON(t, forwarded, want) // exactly what the CLI sent, nothing renamed or added

	resp := p.call("callback.reply", map[string]any{"connId": connID, "reply": dispatchedFor(7)})
	if resp["error"] != nil || resp["result"].(map[string]any)["delivered"] != true {
		t.Fatalf("callback.reply = %v, want delivered", resp)
	}
	reply := <-cli
	if reply["ok"] != true || reply["id"] != float64(7) ||
		reply["result"].(map[string]any)["status"] != "dispatched" {
		t.Fatalf("the CLI received %v, want main's dispatched reply", reply)
	}
}

func TestAConnectionIdentifiesItselfPerRequest(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	a := pendingCLI(t, sock, mustFrame(t, callbackRequest{V: 1, ID: 1, Op: "open", Args: openArgs{Path: "/a"}}), 5*time.Second)
	b := pendingCLI(t, sock, mustFrame(t, callbackRequest{V: 1, ID: 2, Op: "open", Args: openArgs{Path: "/b"}}), 5*time.Second)
	first, second := eventData(t, p.nextEvent(3*time.Second)), eventData(t, p.nextEvent(3*time.Second))
	if first["connId"] == second["connId"] {
		t.Fatalf("two connections shared connId %v", first["connId"])
	}
	// Answer them in the opposite order: each CLI must get ITS reply.
	for _, data := range []map[string]any{second, first} {
		request := data["request"].(map[string]any)
		id := int64(request["id"].(float64))
		p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(id)})
	}
	if got := (<-a)["id"]; got != float64(1) {
		t.Fatalf("first CLI received reply id %v", got)
	}
	if got := (<-b)["id"]; got != float64(2) {
		t.Fatalf("second CLI received reply id %v", got)
	}
}

func TestEdgeValidationAnswersWithoutForwarding(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cases := []struct {
		name string
		raw  []byte
		code string
		id   float64
	}{
		{"an operation outside the allowlist", mustFrame(t, callbackRequest{V: 1, ID: 3, Op: "review", Args: map[string]any{}}), "unsupported-op", 3},
		{"a case variant of open", mustFrame(t, callbackRequest{V: 1, ID: 4, Op: "Open", Args: map[string]any{}}), "unsupported-op", 4},
		{"an unknown protocol version", mustFrame(t, map[string]any{"v": 2, "id": 5, "op": "open", "args": map[string]any{}}), "bad-request", 5},
		{"a request that is not an object", mustFrame(t, []any{1, 2}), "bad-request", 0},
		{"a request without an id", mustFrame(t, map[string]any{"v": 1, "op": "open"}), "bad-request", 0},
		{"a malformed pane", mustFrame(t, map[string]any{"v": 1, "id": 6, "op": "open", "pane": map[string]any{"kind": "x", "id": "y"}}), "bad-request", 6},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reply, _ := exchange(t, sock, tc.raw, 3*time.Second)
			if errorCode(reply) != tc.code || reply["id"] != tc.id {
				t.Fatalf("reply = %v, want %s for id %v", reply, tc.code, tc.id)
			}
		})
	}
	select {
	case ev := <-p.events:
		t.Fatalf("a request rejected at the edge was forwarded to main: %v", ev)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestTheAllowlistIsEnforcedAtTheEdgeNotJustByMain(t *testing.T) {
	// Default-deny: even if main were permissive, the helper never forwards an
	// operation it does not know.
	p, sock := openCallback(t, testCallbackConfig(t))
	for _, op := range []string{"delete", "focus", "notify", "OPEN", "open ", "__proto__"} {
		reply, _ := exchange(t, sock, mustFrame(t, callbackRequest{V: 1, ID: 1, Op: op, Args: map[string]any{}}), 3*time.Second)
		if errorCode(reply) != "unsupported-op" {
			t.Fatalf("op %q: reply = %v, want unsupported-op", op, reply)
		}
	}
	select {
	case ev := <-p.events:
		t.Fatalf("an unsupported operation was forwarded: %v", ev)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestNoConfirmationFromMainAnswersTimeoutAndALateReplyFindsNobody(t *testing.T) {
	cfg := testCallbackConfig(t)
	cfg.forwardTimeout = 150 * time.Millisecond
	p, sock := openCallback(t, cfg)
	cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
	data := eventData(t, p.nextEvent(3*time.Second))
	start := time.Now()
	reply := <-cli
	if errorCode(reply) != "timeout" || reply["id"] != float64(1) {
		t.Fatalf("reply = %v, want timeout for id 1", reply)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("timeout reply took %s", elapsed)
	}
	resp := p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(1)})
	if resp["error"] != nil || resp["result"].(map[string]any)["delivered"] != false {
		t.Fatalf("a late reply must report delivered=false, not an error: %v", resp)
	}
}

func TestADuplicateReplyIsNotDeliveredTwice(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
	data := eventData(t, p.nextEvent(3*time.Second))
	first := p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(1)})
	if first["result"].(map[string]any)["delivered"] != true {
		t.Fatalf("first reply = %v", first)
	}
	<-cli
	second := p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(1)})
	if second["result"].(map[string]any)["delivered"] != false {
		t.Fatalf("second reply = %v, want delivered=false", second)
	}
}

func TestShutdownMidRequestAnswersNotConnectedAndReleasesThePath(t *testing.T) {
	guard := goroutineGuard(t)
	p, sock := openCallback(t, testCallbackConfig(t))
	cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
	p.nextEvent(3 * time.Second)

	// The RPC stream ends (main went away, or the ssh channel dropped).
	if err := p.stop(); err != nil {
		t.Fatalf("serve returned %v on a clean EOF", err)
	}
	reply := <-cli
	if errorCode(reply) != "not-connected" {
		t.Fatalf("reply = %v, want not-connected for a request pending at shutdown", reply)
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("a helper that loses its RPC stream must close its listener and unlink the socket: %v", err)
	}
	guard()
}

func TestASecondHandshakeReplacesTheListener(t *testing.T) {
	cfg := testCallbackConfig(t)
	p := newPipeServer(t, cfg, withCLI)
	first, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-one")))
	second, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-two")))
	if first == second {
		t.Fatal("two projects must have two sockets")
	}
	if _, err := os.Lstat(first); !os.IsNotExist(err) {
		t.Fatalf("the replaced listener's socket must be gone: %v", err)
	}
	reply, _ := exchange(t, second, mustFrame(t, callbackRequest{V: 1, ID: 1, Op: "bogus", Args: map[string]any{}}), 2*time.Second)
	if errorCode(reply) != "unsupported-op" {
		t.Fatalf("the newest listener must serve: %v", reply)
	}

	// Handshaking again for the SAME project must take the path over, not fail.
	again, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-two")))
	if again != second {
		t.Fatalf("the same project must keep the same path: %s vs %s", again, second)
	}
	reply, _ = exchange(t, second, mustFrame(t, callbackRequest{V: 1, ID: 1, Op: "bogus", Args: map[string]any{}}), 2*time.Second)
	if errorCode(reply) != "unsupported-op" {
		t.Fatalf("after re-handshake the path must still serve (the old owner's close must not unlink the new socket): %v", reply)
	}
}

// ---- callback.reply validation and normalization ------------------------------------

func TestCallbackReplyParamsAreValidated(t *testing.T) {
	p := newPipeServer(t, testCallbackConfig(t), withCLI)
	for name, params := range map[string]any{
		"no connId":     map[string]any{"reply": dispatchedFor(1)},
		"no reply":      map[string]any{"connId": 1},
		"negative id":   map[string]any{"connId": -1, "reply": dispatchedFor(1)},
		"string connId": map[string]any{"connId": "1", "reply": dispatchedFor(1)},
		"not an object": []any{1},
		"fractional":    map[string]any{"connId": 1.5, "reply": dispatchedFor(1)},
	} {
		t.Run(name, func(t *testing.T) {
			resp := p.call("callback.reply", params)
			if resp["error"] == nil {
				t.Fatalf("callback.reply %v must be an RPC error, got %v", params, resp)
			}
		})
	}
	// Unknown but well-formed: not an error, just undelivered.
	resp := p.call("callback.reply", map[string]any{"connId": 99, "reply": dispatchedFor(1)})
	if resp["error"] != nil || resp["result"].(map[string]any)["delivered"] != false {
		t.Fatalf("an unknown connId must answer delivered=false: %v", resp)
	}
}

func TestMainReplyIsNormalizedBeforeItReachesTheCLI(t *testing.T) {
	cases := []struct {
		name    string
		reply   any
		wantOK  bool
		wantErr string
	}{
		{"not an object", "dispatched", false, "internal"},
		{"no ok field", map[string]any{"id": 1}, false, "internal"},
		{"ok without a result", map[string]any{"id": 1, "ok": true}, false, "internal"},
		{"ok with a non-object result", map[string]any{"id": 1, "ok": true, "result": "x"}, false, "internal"},
		{"error without a body", map[string]any{"id": 1, "ok": false}, false, "internal"},
		{"error with an unknown code", map[string]any{"id": 1, "ok": false, "error": map[string]any{"code": "weird", "message": "m"}}, false, "internal"},
		{"a known error is relayed", map[string]any{"id": 1, "ok": false, "error": map[string]any{"code": "rate-limited", "message": "too many requests"}}, false, "rate-limited"},
		{"a wrong id is re-stamped", map[string]any{"id": 999, "ok": true, "result": map[string]any{"status": "dispatched"}}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p, sock := openCallback(t, testCallbackConfig(t))
			cli := pendingCLI(t, sock, mustFrame(t, callbackRequest{V: 1, ID: 11, Op: "open", Args: openArgs{Path: "/a"}}), 5*time.Second)
			data := eventData(t, p.nextEvent(3*time.Second))
			p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": tc.reply})
			reply := <-cli
			if (reply["ok"] == true) != tc.wantOK || errorCode(reply) != tc.wantErr || reply["id"] != float64(11) {
				t.Fatalf("CLI received %v, want ok=%v code=%q id=11", reply, tc.wantOK, tc.wantErr)
			}
		})
	}
}

func TestRelayedErrorMessagesAreBounded(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
	data := eventData(t, p.nextEvent(3*time.Second))
	p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": map[string]any{
		"id": 1, "ok": false, "error": map[string]any{"code": "bad-request", "message": strings.Repeat("m", 5000)},
	}})
	reply := <-cli
	message := reply["error"].(map[string]any)["message"].(string)
	if len(message) != maxRelayedMessageBytes {
		t.Fatalf("relayed message is %d bytes, want it bounded to %d", len(message), maxRelayedMessageBytes)
	}
}

func TestForwardTimeoutDefaultsToFourSecondsBelowTheCLIDeadline(t *testing.T) {
	service := newCallbackService(callbackServiceOptions{emit: func(Event) error { return nil }})
	if service.opts.forwardTimeout != 4*time.Second || service.opts.forwardTimeout >= callbackCLIDeadline {
		t.Fatalf("default forward timeout = %s, want 4s and below the CLI deadline %s",
			service.opts.forwardTimeout, callbackCLIDeadline)
	}
	service.close()
}

// gateWriter wraps the helper's output so a test can make it stall or fail, like
// a stuck or broken ssh stream.
type gateWriter struct {
	mu      sync.Mutex
	inner   io.Writer
	mode    string // "", "stall" or "fail"
	release chan struct{}
}

func newGateWriter(inner io.Writer) *gateWriter {
	return &gateWriter{inner: inner, release: make(chan struct{})}
}

func (g *gateWriter) setMode(mode string) {
	g.mu.Lock()
	g.mode = mode
	g.mu.Unlock()
}

func (g *gateWriter) Write(p []byte) (int, error) {
	g.mu.Lock()
	mode := g.mode
	g.mu.Unlock()
	switch mode {
	case "stall":
		<-g.release
	case "fail":
		return 0, errors.New("write: broken pipe")
	}
	return g.inner.Write(p)
}

func gated(gate **gateWriter) func(*server) {
	return func(s *server) {
		*gate = newGateWriter(s.out)
		s.out = *gate
	}
}

func TestAStuckOutputStreamStillAnswersTimeoutOnTime(t *testing.T) {
	cfg := testCallbackConfig(t)
	cfg.forwardTimeout = 200 * time.Millisecond
	var gate *gateWriter
	p, sock := openCallback(t, cfg, gated(&gate))
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release) // let the held event write finish before the server stops
		}
	})

	gate.setMode("stall") // the stream to main stops draining
	start := time.Now()
	reply, _ := exchange(t, sock, validOpenFrame(t), 3*time.Second)
	if errorCode(reply) != "timeout" {
		t.Fatalf("reply = %v, want timeout", reply)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("timeout reply took %s; a stuck output stream must not stretch the forward timeout", elapsed)
	}
	_ = p
}

func TestAFailedEventWriteAnswersNotConnectedAtOnce(t *testing.T) {
	cfg := testCallbackConfig(t)
	cfg.forwardTimeout = 3 * time.Second
	var gate *gateWriter
	_, sock := openCallback(t, cfg, gated(&gate))

	gate.setMode("fail") // the stream to main is dead
	start := time.Now()
	reply, _ := exchange(t, sock, validOpenFrame(t), 5*time.Second)
	if errorCode(reply) != "not-connected" {
		t.Fatalf("reply = %v, want not-connected", reply)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("not-connected took %s; a failed write must not wait out the %s forward timeout",
			elapsed, cfg.forwardTimeout)
	}
}

func TestAStalledStreamBoundsTheHelperBacklogInsteadOfAccumulatingGoroutines(t *testing.T) {
	cfg := testCallbackConfig(t)
	cfg.forwardTimeout = 20 * time.Millisecond
	cfg.rateLimitPerSecond = 100_000 // this test is about the backlog, not the burst limit
	var gate *gateWriter
	_, sock := openCallback(t, cfg, gated(&gate))
	t.Cleanup(func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	})

	gate.setMode("stall")
	before := runtime.NumGoroutine()
	var timeouts, notConnected int
	for i := 0; i < callbackEventBacklog+40; i++ {
		reply, _ := exchange(t, sock, validOpenFrame(t), 3*time.Second)
		switch errorCode(reply) {
		case "timeout":
			timeouts++
		case "not-connected":
			notConnected++
		default:
			t.Fatalf("request %d: reply = %v, want timeout or not-connected", i, reply)
		}
	}
	// The first events fit the backlog (and each CLI hears `timeout`); once it is
	// full every further request is refused at once instead of queueing a goroutine.
	if timeouts == 0 || notConnected == 0 {
		t.Fatalf("timeouts=%d notConnected=%d: expected both while the backlog fills", timeouts, notConnected)
	}
	if grown := runtime.NumGoroutine() - before; grown > 10 {
		t.Fatalf("%d goroutines accumulated behind a stalled stream; the backlog must be bounded", grown)
	}
}

// ---- Forwarding only validated fields; the helper's own limits --------------------------

// rawFrame frames arbitrary JSON bytes exactly as given (the CLI is not trusted to
// send only the fields we know).
func rawFrame(t *testing.T, body string) []byte {
	t.Helper()
	return mustFrame(t, json.RawMessage(body))
}

func TestForwardedRequestIsRebuiltFromValidatedFieldsOnly(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cli := pendingCLI(t, sock, rawFrame(t, `{
		"v": 1, "id": 7, "op": "open",
		"pane": {"kind": "tmux", "id": "%3", "extra": "x"},
		"projectId": "other-project", "junk": {"a": [1, 2, 3], "b": "`+strings.Repeat("z", 2000)+`"},
		"args": {"path": "/srv/a b.md", "canonicalPath": "/srv/a b.md", "line": 12, "evil": {"deep": true}}
	}`), 5*time.Second)

	data := eventData(t, p.nextEvent(3*time.Second))
	forwarded, _ := json.Marshal(data["request"])
	want := `{"v":1,"id":7,"op":"open","pane":{"kind":"tmux","id":"%3"},` +
		`"args":{"path":"/srv/a b.md","canonicalPath":"/srv/a b.md"}}`
	assertSameJSON(t, forwarded, json.RawMessage(want))
	for _, forbidden := range []string{"projectId", "junk", "line", "evil", "extra", "zzzz"} {
		if strings.Contains(string(forwarded), forbidden) {
			t.Fatalf("the forwarded request still carries %q: %s", forbidden, forwarded)
		}
	}

	p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(7)})
	if reply := <-cli; reply["ok"] != true || reply["id"] != float64(7) {
		t.Fatalf("the CLI received %v", reply)
	}
}

func TestForwardedRequestKeepsAMissingPaneAndCanonicalOmitted(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cli := pendingCLI(t, sock, rawFrame(t, `{"v":1,"id":2,"op":"open","pane":null,"args":{"path":"/a","canonicalPath":null}}`), 5*time.Second)
	data := eventData(t, p.nextEvent(3*time.Second))
	forwarded, _ := json.Marshal(data["request"])
	assertSameJSON(t, forwarded, json.RawMessage(`{"v":1,"id":2,"op":"open","args":{"path":"/a"}}`))
	p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": dispatchedFor(2)})
	<-cli
}

func TestInvalidArgumentsAreRefusedAtTheEdgeWithoutForwarding(t *testing.T) {
	p, sock := openCallback(t, testCallbackConfig(t))
	cases := []struct{ name, args, message string }{
		{"a relative path", `{"path":"README.md"}`, "path must be an absolute path"},
		{"no path", `{}`, "path must be a non-empty string"},
		{"a NUL in the path", `{"path":"/a\u0000b"}`, "path must not contain NUL"},
		{"args that are not an object", `"/a"`, "args must be an object"},
		{"a relative canonical form", `{"path":"/a","canonicalPath":"rel"}`, "canonicalPath must be an absolute path"},
		{"an oversize path", `{"path":"/` + strings.Repeat("a", callbackMaxPathBytes) + `"}`, "path is longer than 4096 bytes"},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id := i + 10
			reply, _ := exchange(t, sock, rawFrame(t, `{"v":1,"id":`+strconv.Itoa(id)+`,"op":"open","args":`+tc.args+`}`), 3*time.Second)
			errBody, _ := reply["error"].(map[string]any)
			if errorCode(reply) != "bad-request" || errBody["message"] != tc.message || reply["id"] != float64(id) {
				t.Fatalf("reply = %v, want bad-request %q for id %d", reply, tc.message, id)
			}
		})
	}
	select {
	case ev := <-p.events:
		t.Fatalf("a request with invalid arguments was forwarded: %v", ev)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestTheHelperRateLimitsBeforeForwardingAndRefillsOverTime(t *testing.T) {
	clock := newFakeClock()
	cfg := testCallbackConfig(t)
	cfg.now = clock.now
	cfg.forwardTimeout = 10 * time.Second // the burst stays pending; the test releases it at the end
	p, sock := openCallback(t, cfg)

	// Requests the edge refuses on their own merits never consume the budget.
	for i := 0; i < 25; i++ {
		exchange(t, sock, rawFrame(t, `{"v":1,"id":1,"op":"review","args":{}}`), 2*time.Second)
		exchange(t, sock, rawFrame(t, `{"v":1,"id":1,"op":"open","args":{"path":"rel"}}`), 2*time.Second)
	}

	// The burst (10) is forwarded...
	var pending []chan map[string]any
	for i := 0; i < callbackRateLimitPerSecond; i++ {
		pending = append(pending, pendingCLI(t, sock, validOpenFrame(t), 20*time.Second))
		eventData(t, p.nextEvent(3*time.Second))
	}
	// ...the 11th is refused at once, without an event.
	start := time.Now()
	reply, _ := exchange(t, sock, validOpenFrame(t), 3*time.Second)
	if errorCode(reply) != "rate-limited" || time.Since(start) > time.Second {
		t.Fatalf("reply = %v after %s, want an immediate rate-limited", reply, time.Since(start))
	}
	select {
	case ev := <-p.events:
		t.Fatalf("a rate-limited request was forwarded: %v", ev)
	case <-time.After(100 * time.Millisecond):
	}

	// Time refills the bucket: 100 ms at 10/s is one token.
	clock.advance(101 * time.Millisecond)
	pending = append(pending, pendingCLI(t, sock, validOpenFrame(t), 20*time.Second))
	eventData(t, p.nextEvent(3*time.Second))
	again, _ := exchange(t, sock, validOpenFrame(t), 3*time.Second)
	if errorCode(again) != "rate-limited" {
		t.Fatalf("only one token refilled, got %v", again)
	}

	// Release the pending requests.
	if err := p.stop(); err != nil {
		t.Fatal(err)
	}
	for _, ch := range pending {
		if errorCode(<-ch) != "not-connected" {
			t.Fatal("a request pending at shutdown must be answered not-connected")
		}
	}
}

func TestCorrelationIDsAreServerWideAndAStaleReplyCannotCrossToAnotherCLI(t *testing.T) {
	cfg := testCallbackConfig(t)
	p := newPipeServer(t, cfg, withCLI)
	sockA, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-one")))

	// A request is pending on the FIRST service (its reply has not come back yet).
	cliA := pendingCLI(t, sockA, rawFrame(t, `{"v":1,"id":1,"op":"open","args":{"path":"/a"}}`), 5*time.Second)
	eventA := eventData(t, p.nextEvent(3*time.Second))
	connA, _ := eventA["connId"].(float64)

	// A second handshake replaces the service (the first answers not-connected).
	sockB, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-two")))
	if errorCode(<-cliA) != "not-connected" {
		t.Fatal("the replaced service must answer its pending request not-connected")
	}
	cliB := pendingCLI(t, sockB, rawFrame(t, `{"v":1,"id":2,"op":"open","args":{"path":"/b"}}`), 5*time.Second)
	eventB := eventData(t, p.nextEvent(3*time.Second))
	connB, _ := eventB["connId"].(float64)

	// Ids never restart: per-service counters would give the new request the old id.
	if connB <= connA {
		t.Fatalf("connId %v after %v: correlation ids must be unique across services", connB, connA)
	}
	// main's late reply to the OLD request must not reach the new request.
	stale := p.call("callback.reply", map[string]any{"connId": connA, "reply": dispatchedFor(1)})
	if stale["result"].(map[string]any)["delivered"] != false {
		t.Fatalf("a stale reply was delivered: %v", stale)
	}
	select {
	case reply := <-cliB:
		t.Fatalf("the new request was answered by a stale reply: %v", reply)
	case <-time.After(100 * time.Millisecond):
	}
	fresh := p.call("callback.reply", map[string]any{"connId": connB, "reply": dispatchedFor(2)})
	if fresh["result"].(map[string]any)["delivered"] != true {
		t.Fatalf("the right reply was not delivered: %v", fresh)
	}
	if reply := <-cliB; reply["id"] != float64(2) || reply["ok"] != true {
		t.Fatalf("the new request received %v", reply)
	}
}

func TestRetiringAServiceReleasesItsPathAtOnceAndAnswersItsPendingRequests(t *testing.T) {
	guard := goroutineGuard(t)
	cfg := testCallbackConfig(t)
	p := newPipeServer(t, cfg, withCLI)
	sockA, _ := handshakeResult(t, p.call("handshake", handshakeParams("project-one")))
	cliA := pendingCLI(t, sockA, validOpenFrame(t), 5*time.Second)
	p.nextEvent(3 * time.Second)

	start := time.Now()
	handshakeResult(t, p.call("handshake", handshakeParams("project-two")))
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("the replacing handshake took %s; draining the old listener must not hold it", elapsed)
	}
	if _, err := os.Lstat(sockA); !os.IsNotExist(err) {
		t.Fatalf("the retired listener's socket must be gone when the replacing handshake returns: %v", err)
	}
	if errorCode(<-cliA) != "not-connected" {
		t.Fatal("the pending request of the retired service must be answered not-connected")
	}
	if err := p.stop(); err != nil {
		t.Fatal(err)
	}
	guard() // the background drain of the retired listener ends too
}

func TestRetireDoesNotWaitForAConnectionThatIsStuck(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	l, sock := startTestListener(t, func(json.RawMessage) callbackReply {
		entered <- struct{}{}
		<-release // a connection that stays in flight far longer than the close grace
		return dispatchedReply(nil)
	}, nil)
	svc := newCallbackService(callbackServiceOptions{emit: func(Event) error { return nil }})
	svc.listener = l

	conn, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write(validOpenFrame(t)); err != nil {
		t.Fatal(err)
	}
	<-entered

	// A replaced service is retired by the handshake that replaces it, on the helper's
	// single worker: it must hand back the path and return, not wait out the grace.
	start := time.Now()
	svc.retire()
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("retire took %s; it must not wait for in-flight connections", elapsed)
	}
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("retire must release the socket path at once: %v", err)
	}
	close(release)
}

// ---- Relayed text -----------------------------------------------------------------------

func TestRelayedErrorMessagesAreCutOnACharacterBoundary(t *testing.T) {
	cases := map[string]string{
		"all multi-byte":    strings.Repeat("日", 300),                              // 900 bytes
		"boundary mid-rune": strings.Repeat("a", maxRelayedMessageBytes-1) + "日日日", // the cap falls inside the first 日
	}
	for name, message := range cases {
		t.Run(name, func(t *testing.T) {
			p, sock := openCallback(t, testCallbackConfig(t))
			cli := pendingCLI(t, sock, validOpenFrame(t), 5*time.Second)
			data := eventData(t, p.nextEvent(3*time.Second))
			p.call("callback.reply", map[string]any{"connId": data["connId"], "reply": map[string]any{
				"id": 1, "ok": false, "error": map[string]any{"code": "bad-request", "message": message},
			}})
			reply := <-cli
			got := reply["error"].(map[string]any)["message"].(string)
			if !utf8.ValidString(got) || strings.ContainsRune(got, utf8.RuneError) {
				t.Fatalf("relayed message %q is not valid UTF-8 / contains a replacement character", got)
			}
			if len(got) > maxRelayedMessageBytes || !strings.HasPrefix(message, got) {
				t.Fatalf("relayed message is %d bytes (max %d) and must be a prefix of the original", len(got), maxRelayedMessageBytes)
			}
		})
	}
}

func TestTruncateUTF8(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 5, "hello"},
		{"hello", 3, "hel"},
		{"日本語", 9, "日本語"},
		{"日本語", 8, "日本"},
		{"日本語", 7, "日本"},
		{"日本語", 6, "日本"},
		{"日本語", 5, "日"},
		{"日本語", 2, ""},
		{"a😀b", 3, "a"},
		{"a😀b", 5, "a😀"},
	}
	for _, tc := range cases {
		if got := truncateUTF8(tc.in, tc.max); got != tc.want {
			t.Fatalf("truncateUTF8(%q, %d) = %q, want %q", tc.in, tc.max, got, tc.want)
		}
	}
}
