package main

// The helper's side of the remote reply path (requirement 8 of
// docs/requirements/terminal-callback-socket.md). The listener hands every
// decoded request to handleRequest, which:
//
//  1. validates the envelope (bad-request), applies the operation allowlist
//     (unsupported-op) and validates the operation's arguments (bad-request) —
//     default-deny at the edge, so none of these costs a round trip — then applies
//     the helper's own burst limit (rate-limited);
//  2. forwards what survived to main as a `callback` event carrying a helper-chosen
//     correlation id (`connId`) and a RE-ENCODED request built only from the
//     validated fields (v, id, op, pane, the operation's arguments): unknown
//     fields, and anything else a same-user process put in the 64 KiB frame, never
//     reach main;
//  3. waits for main's `callback.reply` RPC (answered by the READER goroutine, never
//     queued behind a slow method) and relays that reply to the CLI;
//  4. answers `timeout` when main does not reply within the forward timeout (4 s,
//     shorter than the CLI's 5 s deadline so the message can reach the user) and
//     `not-connected` when the helper shuts down while a request is pending.
//
// The decision itself (connection status, path classification, and the
// authoritative copy of every check above) belongs to main's CallbackBroker, the
// single decision function shared with the local listener, which re-validates the
// envelope and the arguments: the helper does the socket-level checks, the
// default-deny edge checks above, and forwards. A `timeout` reply means "no
// confirmation", not "the tab did not open".

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

// maxRelayedMessageBytes bounds the error message relayed from main to a CLI.
const maxRelayedMessageBytes = 512

// callbackEventBacklog bounds the `callback` events waiting to be written to the
// RPC stream. One writer goroutine drains them, so a stalled stream holds ONE
// goroutine and at most this many queued events, however fast a same-user process
// connects; further requests are answered `not-connected` at once.
const callbackEventBacklog = 64

type callbackServiceOptions struct {
	// emit writes a server-push event frame (safe for concurrent use) and reports
	// a failed write. It can block on a stuck output stream; the service never
	// waits on it past the forward timeout.
	emit func(Event) error
	// forwardTimeout is how long a forwarded request waits for main's reply.
	forwardTimeout time.Duration
	// nextConnID allocates a correlation id. It MUST be server-wide, not
	// per-service: a second handshake builds a new service, and ids that restarted
	// at 1 would let a late `callback.reply` meant for the old service's request
	// be delivered to a different CLI's request in the new one. nil falls back to a
	// process-wide counter.
	nextConnID func() uint64
	// rateLimitPerSecond is the burst limit for forwarded requests (default 10).
	rateLimitPerSecond int
	// now is the limiter's clock (default time.Now).
	now func() time.Time
}

// processConnSeq backs nextConnID when a service is built without one.
var processConnSeq atomic.Uint64

// eventJob is one `callback` event queued for the writer; done receives the
// outcome of the write.
type eventJob struct {
	event Event
	done  chan error
}

type callbackService struct {
	opts     callbackServiceOptions
	listener *callbackListener
	events   chan eventJob
	limiter  *tokenBucket

	mu        sync.Mutex
	pending   map[uint64]chan json.RawMessage
	closing   chan struct{}
	closeOnce sync.Once
}

func newCallbackService(opts callbackServiceOptions) *callbackService {
	if opts.forwardTimeout <= 0 {
		opts.forwardTimeout = callbackForwardTimeout
	}
	if opts.nextConnID == nil {
		opts.nextConnID = func() uint64 { return processConnSeq.Add(1) }
	}
	if opts.rateLimitPerSecond <= 0 {
		opts.rateLimitPerSecond = callbackRateLimitPerSecond
	}
	c := &callbackService{
		opts:    opts,
		events:  make(chan eventJob, callbackEventBacklog),
		limiter: newTokenBucket(opts.rateLimitPerSecond, float64(opts.rateLimitPerSecond), opts.now),
		pending: make(map[uint64]chan json.RawMessage),
		closing: make(chan struct{}),
	}
	go c.writeEvents()
	return c
}

// writeEvents is the single goroutine that writes `callback` events to the RPC
// stream. It can block on a stuck stream; nothing waits on it past the forward
// timeout, and the bounded queue in front of it keeps a stall from accumulating
// goroutines.
func (c *callbackService) writeEvents() {
	for {
		select {
		case job := <-c.events:
			job.done <- c.opts.emit(job.event)
		case <-c.closing:
			return
		}
	}
}

// handleRequest is the listener's decision function for one decoded request.
func (c *callbackService) handleRequest(raw json.RawMessage) callbackReply {
	envelope := parseCallbackEnvelope(raw)
	if !envelope.ok {
		return errorReply(envelope.id, "bad-request", envelope.message)
	}
	if !isCallbackOp(envelope.op) {
		return errorReply(envelope.id, "unsupported-op", "unsupported operation")
	}
	// The allowlist has exactly one operation; each future one adds its own
	// argument validator here, and nothing unvalidated is ever forwarded.
	var args any
	switch envelope.op {
	case "open":
		open, problem := parseOpenArgs(envelope.args)
		if problem != "" {
			return errorReply(envelope.id, "bad-request", problem)
		}
		args = open
	default:
		return errorReply(envelope.id, "unsupported-op", "unsupported operation")
	}
	if !c.limiter.tryTake() {
		return errorReply(envelope.id, "rate-limited", "too many requests")
	}
	// Forward a request rebuilt from the validated fields only.
	forwarded, err := marshalCallbackBody(callbackRequest{
		V:    callbackProtocolVersion,
		ID:   envelope.id,
		Op:   envelope.op,
		Pane: envelope.pane,
		Args: args,
	})
	if err != nil {
		return errorReply(envelope.id, "internal", "internal error")
	}
	return c.forward(envelope.id, forwarded)
}

func (c *callbackService) register() (uint64, chan json.RawMessage, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.closing:
		return 0, nil, false
	default:
	}
	connID := c.opts.nextConnID()
	ch := make(chan json.RawMessage, 1)
	c.pending[connID] = ch
	return connID, ch, true
}

func (c *callbackService) unregister(connID uint64) {
	c.mu.Lock()
	delete(c.pending, connID)
	c.mu.Unlock()
}

// forward sends the request to main and waits for the reply. The event is queued
// for the writer goroutine and the wait starts at once, so a stuck output stream
// cannot stretch the answer past the forward timeout (the CLI then hears
// `timeout`, "no confirmation", exactly as for a main that never replies), a
// failed write answers `not-connected` immediately instead of after the timeout,
// and a full backlog (a stream stalled for long) answers `not-connected` at once.
func (c *callbackService) forward(id int64, raw json.RawMessage) callbackReply {
	connID, replies, ok := c.register()
	if !ok {
		return errorReply(id, "not-connected", "the helper is shutting down")
	}
	defer c.unregister(connID)

	job := eventJob{
		event: Event{Event: "callback", Data: map[string]any{"connId": connID, "request": raw}},
		done:  make(chan error, 1),
	}
	select {
	case c.events <- job:
	default:
		return errorReply(id, "not-connected", "the helper cannot reach the app (its output is backed up)")
	}

	timer := time.NewTimer(c.opts.forwardTimeout)
	defer timer.Stop()
	written := job.done
	for {
		select {
		case err := <-written:
			if err != nil {
				return errorReply(id, "not-connected", "the helper cannot reach the app")
			}
			written = nil // delivered; a nil channel never fires again
		case reply := <-replies:
			return normalizeMainReply(id, reply)
		case <-timer.C:
			return errorReply(id, "timeout", "no confirmation within the deadline")
		case <-c.closing:
			return errorReply(id, "not-connected", "the helper is shutting down")
		}
	}
}

// deliverReply hands main's reply to the connection waiting on connID. It
// reports whether anyone was waiting: a reply that arrives after the timeout (or
// twice) finds nobody, which is not an error.
func (c *callbackService) deliverReply(connID uint64, reply json.RawMessage) bool {
	c.mu.Lock()
	replies, ok := c.pending[connID]
	c.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case replies <- reply:
		return true
	default:
		return false // a reply was already delivered
	}
}

// close releases the socket path and answers every pending request
// `not-connected`, waiting (briefly) for in-flight connections to finish writing
// their reply. Idempotent.
func (c *callbackService) close() {
	c.closeOnce.Do(func() {
		close(c.closing)
		if c.listener != nil {
			c.listener.Close()
		}
	})
}

// retire is close for a service a newer one has replaced: the path is released
// and every pending request is answered at once, but waiting for the old
// connections to drain happens in the background so the caller (the helper's
// single worker, in the middle of a handshake) is never held for the grace period.
func (c *callbackService) retire() {
	c.closeOnce.Do(func() {
		close(c.closing)
		if c.listener != nil {
			c.listener.beginClose()
			go c.listener.waitClosed()
		}
	})
}

// normalizeMainReply turns main's reply into the reply the CLI receives. The
// helper is a conduit, not an authority, but a malformed reply must not reach the
// CLI as if it were an answer: it becomes `internal`. The reply is re-stamped
// with the request's own id so correlation never depends on main.
func normalizeMainReply(id int64, raw json.RawMessage) callbackReply {
	var reply struct {
		OK     *bool           `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &reply); err != nil || reply.OK == nil {
		return errorReply(id, "internal", "internal error")
	}
	if *reply.OK {
		var result map[string]any
		if err := json.Unmarshal(reply.Result, &result); err != nil || result == nil {
			return errorReply(id, "internal", "internal error")
		}
		return okReply(id, result)
	}
	if reply.Error == nil || !isCallbackErrorCode(reply.Error.Code) {
		return errorReply(id, "internal", "internal error")
	}
	return errorReply(id, reply.Error.Code, truncateUTF8(reply.Error.Message, maxRelayedMessageBytes))
}

// truncateUTF8 cuts s to at most max bytes without splitting a multi-byte
// character (a split one would reach the user as a replacement character).
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
