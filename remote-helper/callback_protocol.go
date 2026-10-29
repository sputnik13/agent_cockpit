package main

// Terminal callback socket protocol (terminal -> app): the versioned
// request/reply envelope, its limits, and the pure validation the helper's
// listener and the `cockpit` CLI share. This is the Go mirror of
// src/shared/callback/protocol.ts; the JSON fixtures under
// src/shared/callback/fixtures pin the cases both must agree on
// (callback_protocol_test.go replays them).
//
// Identity is not a secret: a request names no project (the project is the one
// that owns the socket it arrived on) and `pane` is attribution metadata only.
//
// Governing doc: docs/design/terminal-callback-socket.md ("Envelope, wire and limits").

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	callbackProtocolVersion = 1

	// callbackCLIDeadline is the CLI's overall deadline, and the listener's read
	// deadline.
	callbackCLIDeadline = 5 * time.Second
	// callbackForwardTimeout is how long the helper waits for main's reply to a
	// forwarded request. It is SHORTER than the CLI's deadline so that `timeout`
	// can reach the user instead of the CLI giving up first.
	callbackForwardTimeout = 4 * time.Second
	// callbackWriteDeadline bounds writing one reply to a CLI connection.
	callbackWriteDeadline = 1 * time.Second
	// callbackMaxConnections is the number of concurrent CLI connections the
	// helper serves (requirement 8; main's own listener allows 32). Further
	// connections are dropped.
	callbackMaxConnections = 16

	// callbackMaxPathBytes is the longest accepted `path` / `canonicalPath`
	// (PATH_MAX on Linux).
	callbackMaxPathBytes = 4096

	// callbackRateLimitPerSecond is the helper's own burst limit for requests it
	// would forward (the same number main applies per project): a same-user flood
	// is refused here, with `rate-limited`, before it can occupy the RPC stream.
	callbackRateLimitPerSecond = 10

	maxOpChars     = 32
	maxPaneIDChars = 128

	// Variables the app owns in a pane's environment.
	callbackSockEnv   = "COCKPIT_CALLBACK_SOCK"
	callbackMuxKeyEnv = "COCKPIT_CALLBACK_MUX_KEY"
)

// callbackOps is the default-deny operation allowlist. Anything else is
// `unsupported-op`.
var callbackOps = []string{"open"}

func isCallbackOp(op string) bool {
	for _, allowed := range callbackOps {
		if op == allowed {
			return true
		}
	}
	return false
}

// callbackErrorCodes are the typed error codes of a reply.
var callbackErrorCodes = []string{
	"unsupported-op",
	"bad-request",
	"rate-limited",
	"timeout",
	"not-connected",
	"internal",
}

func isCallbackErrorCode(code string) bool {
	for _, known := range callbackErrorCodes {
		if code == known {
			return true
		}
	}
	return false
}

// callbackPane says which terminal a request came from. Attribution metadata:
// main cannot verify it.
type callbackPane struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// openArgs are `open`'s arguments.
type openArgs struct {
	// Path is the absolute logical path, as the user named it (lexically cleaned).
	Path string `json:"path"`
	// CanonicalPath is the absolute canonical form (symlink-resolved parent joined
	// with the base name); omitted when the CLI could not compute it.
	CanonicalPath string `json:"canonicalPath,omitempty"`
}

// callbackRequest is the request a client sends (what the CLI builds). Field
// order matches the TypeScript reference so the encoded bytes are identical.
type callbackRequest struct {
	V    int           `json:"v"`
	ID   int64         `json:"id"`
	Op   string        `json:"op"`
	Pane *callbackPane `json:"pane,omitempty"`
	Args any           `json:"args"`
}

type callbackErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// callbackReply is `{id, ok:true, result}` or `{id, ok:false, error:{code, message}}`.
type callbackReply struct {
	ID     int64              `json:"id"`
	OK     bool               `json:"ok"`
	Result any                `json:"result,omitempty"`
	Error  *callbackErrorBody `json:"error,omitempty"`
}

func okReply(id int64, result any) callbackReply {
	return callbackReply{ID: id, OK: true, Result: result}
}

func errorReply(id int64, code, message string) callbackReply {
	return callbackReply{ID: id, OK: false, Error: &callbackErrorBody{Code: code, Message: message}}
}

// ---- Envelope validation ----------------------------------------------------

// utf16Len is the length JavaScript's String#length reports, so the character
// limits below agree with the TypeScript reference for every input.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// hasControlChars reports a character in [U+0000-U+001F] or U+007F.
func hasControlChars(s string) bool {
	for _, r := range s {
		if r <= 0x1f || r == 0x7f {
			return true
		}
	}
	return false
}

func isPaneID(s string) bool {
	n := utf16Len(s)
	return n > 0 && n <= maxPaneIDChars && !hasControlChars(s)
}

// jsSafeInteger mirrors Number.isSafeInteger for a decoded JSON number.
func jsSafeInteger(v any) (int64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(n.String(), 64)
	if err != nil || f != math.Trunc(f) || math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

func parsePane(raw any) *callbackPane {
	rec, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	kind, _ := rec["kind"].(string)
	id, idOK := rec["id"].(string)
	if (kind != "tmux" && kind != "mux") || !idOK || !isPaneID(id) {
		return nil
	}
	return &callbackPane{Kind: kind, ID: id}
}

// envelopeResult is the outcome of validating a request's envelope (not the
// operation's arguments).
type envelopeResult struct {
	ok bool
	// id is the request's own id when it has a valid one, else 0 (a valid id is
	// always >= 1), so a failure reply can still be correlated.
	id      int64
	message string // when !ok
	op      string
	pane    *callbackPane
	// args is the request's `args` as decoded (numbers stay json.Number), for the
	// operation's own validator.
	args any
}

// parseCallbackEnvelope validates the envelope's shape: a JSON object with
// v == 1, a positive integer id, a short non-empty string op, and an optional
// well-formed pane. Unknown top-level fields are ignored; in particular nothing
// in a request can name a project: the receiving socket decides that.
func parseCallbackEnvelope(raw []byte) envelopeResult {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return envelopeResult{message: "request must be a JSON object"}
	}
	rec, ok := value.(map[string]any)
	if !ok {
		return envelopeResult{message: "request must be a JSON object"}
	}
	var id int64
	if n, isInt := jsSafeInteger(rec["id"]); isInt && n >= 1 {
		id = n
	}
	if v, isInt := jsSafeInteger(rec["v"]); !isInt || v != callbackProtocolVersion {
		return envelopeResult{id: id, message: "unsupported protocol version (expected v=" + strconv.Itoa(callbackProtocolVersion) + ")"}
	}
	if id == 0 {
		return envelopeResult{message: "id must be a positive integer"}
	}
	op, isString := rec["op"].(string)
	if !isString || op == "" || utf16Len(op) > maxOpChars {
		return envelopeResult{id: id, message: "op must be a non-empty string"}
	}
	res := envelopeResult{ok: true, id: id, op: op, args: rec["args"]}
	if paneRaw, present := rec["pane"]; present && paneRaw != nil {
		pane := parsePane(paneRaw)
		if pane == nil {
			return envelopeResult{id: id, message: `pane must be {kind: "tmux" | "mux", id: string}`}
		}
		res.pane = pane
	}
	return res
}

// ---- Operation arguments ----------------------------------------------------

// parseAbsolutePath validates a path argument the way parseAbsolutePath in
// protocol.ts does: a non-empty absolute string, no NUL, at most
// callbackMaxPathBytes BYTES (not characters). The second result is the problem
// ("" when the path is fine).
func parseAbsolutePath(value any, field string) (string, string) {
	path, isString := value.(string)
	if !isString || path == "" {
		return "", field + " must be a non-empty string"
	}
	if !strings.HasPrefix(path, "/") {
		return "", field + " must be an absolute path"
	}
	if strings.ContainsRune(path, 0) {
		return "", field + " must not contain NUL"
	}
	if len(path) > callbackMaxPathBytes {
		return "", fmt.Sprintf("%s is longer than %d bytes", field, callbackMaxPathBytes)
	}
	return path, ""
}

// parseOpenArgs validates `open`'s arguments (mirror of parseOpenArgs in
// protocol.ts): an absolute `path` and an optional absolute `canonicalPath`.
// Anything else in `args` is dropped, so what the helper forwards is built from
// validated fields only. The second result is the problem ("" when valid).
func parseOpenArgs(raw any) (openArgs, string) {
	rec, ok := raw.(map[string]any)
	if !ok {
		return openArgs{}, "args must be an object"
	}
	path, problem := parseAbsolutePath(rec["path"], "path")
	if problem != "" {
		return openArgs{}, problem
	}
	canonicalRaw, present := rec["canonicalPath"]
	if !present || canonicalRaw == nil {
		return openArgs{Path: path}, ""
	}
	canonical, problem := parseAbsolutePath(canonicalRaw, "canonicalPath")
	if problem != "" {
		return openArgs{}, problem
	}
	return openArgs{Path: path, CanonicalPath: canonical}, ""
}

// ---- Identity ---------------------------------------------------------------

// paneFromEnv is the pane identity a client reads from its own environment (the
// Go mirror of paneFromEnv in protocol.ts): the app-chosen mux key WINS when
// present, because an app launched from a tmux pane makes its mux daemon inherit
// a stale TMUX_PANE; otherwise tmux's TMUX_PANE; otherwise none (a missing pane
// is accepted).
func paneFromEnv(get func(string) string) *callbackPane {
	if key := get(callbackMuxKeyEnv); isPaneID(key) {
		return &callbackPane{Kind: "mux", ID: key}
	}
	if pane := get("TMUX_PANE"); isPaneID(pane) {
		return &callbackPane{Kind: "tmux", ID: pane}
	}
	return nil
}

// isInjectableEnvValue reports whether value may be injected into a terminal
// environment: values are never restricted by charset, only rejected when they
// contain NUL or a line break, which cannot survive an environment block or a
// tmux command line.
func isInjectableEnvValue(value string) bool {
	for _, r := range value {
		if r == 0 || r == '\n' || r == '\r' {
			return false
		}
	}
	return true
}
