package main

// Scenario 2 (Go mirror): identity and the request envelope. The cases mirror
// src/shared/callback/protocol.test.ts one for one; pane identity replays the
// shared identity.json fixture.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func validRequest(overrides map[string]any) []byte {
	request := map[string]any{"v": 1, "id": 5, "op": "open", "args": map[string]any{"path": "/a/b.md"}}
	for key, value := range overrides {
		if value == absent {
			delete(request, key)
			continue
		}
		request[key] = value
	}
	raw, err := json.Marshal(request)
	if err != nil {
		panic(err)
	}
	return raw
}

// absent marks a field to delete from validRequest.
var absent = &struct{ name string }{"absent"}

func TestCallbackProtocolConstantsAreThePinnedLimits(t *testing.T) {
	if callbackProtocolVersion != 1 {
		t.Fatalf("callbackProtocolVersion = %d", callbackProtocolVersion)
	}
	if callbackCLIDeadline != 5*time.Second {
		t.Fatalf("CLI deadline = %s, want 5s", callbackCLIDeadline)
	}
	if callbackMaxConnections != 16 {
		// Requirement 8: the HELPER caps concurrent CLI connections at 16 (main's
		// own listener allows 32).
		t.Fatalf("helper connection cap = %d, want 16", callbackMaxConnections)
	}
	if callbackForwardTimeout != 4*time.Second || callbackForwardTimeout >= callbackCLIDeadline {
		t.Fatalf("forward timeout %s must be 4s and shorter than the CLI deadline %s",
			callbackForwardTimeout, callbackCLIDeadline)
	}
	if got := strings.Join(callbackOps, ","); got != "open" {
		t.Fatalf("the v1 allowlist is %q, want open", got)
	}
	want := "unsupported-op,bad-request,rate-limited,timeout,not-connected,internal"
	if got := strings.Join(callbackErrorCodes, ","); got != want {
		t.Fatalf("error codes = %q, want %q", got, want)
	}
}

func TestOnlyOpenIsAllowlisted(t *testing.T) {
	if !isCallbackOp("open") {
		t.Fatal("open must be allowlisted")
	}
	for _, op := range []string{"Open", "review", "focus", "notify", "open ", "", "__proto__", "constructor"} {
		if isCallbackOp(op) {
			t.Fatalf("%q must not be allowlisted", op)
		}
	}
}

func TestEnvelopeAcceptsATmuxPaneAMuxPaneAndNoPane(t *testing.T) {
	tmux := parseCallbackEnvelope(validRequest(map[string]any{"pane": map[string]any{"kind": "tmux", "id": "%12"}}))
	if !tmux.ok || tmux.id != 5 || tmux.op != "open" || tmux.pane == nil || *tmux.pane != (callbackPane{"tmux", "%12"}) {
		t.Fatalf("tmux envelope: %+v", tmux)
	}
	mux := parseCallbackEnvelope(validRequest(map[string]any{"pane": map[string]any{"kind": "mux", "id": "term-3"}}))
	if !mux.ok || mux.pane == nil || *mux.pane != (callbackPane{"mux", "term-3"}) {
		t.Fatalf("mux envelope: %+v", mux)
	}
	none := parseCallbackEnvelope(validRequest(nil))
	if !none.ok || none.pane != nil {
		t.Fatalf("no-pane envelope: %+v", none)
	}
	null := parseCallbackEnvelope(validRequest(map[string]any{"pane": nil}))
	if !null.ok || null.pane != nil {
		t.Fatalf("pane:null must equal no pane: %+v", null)
	}
}

func TestEnvelopeNeverLetsARequestNameAProject(t *testing.T) {
	envelope := parseCallbackEnvelope(validRequest(map[string]any{
		"projectId": "other", "project": "other",
		"args": map[string]any{"path": "/a", "projectId": "other"},
	}))
	if !envelope.ok || envelope.op != "open" || envelope.id != 5 {
		t.Fatalf("unknown fields must be ignored: %+v", envelope)
	}
	// There is simply no field for a project on the result.
}

func TestEnvelopeRejectsAnUnknownProtocolVersionEchoingAValidID(t *testing.T) {
	for _, v := range []any{2, "1", absent} {
		got := parseCallbackEnvelope(validRequest(map[string]any{"v": v}))
		if got.ok || got.id != 5 {
			t.Fatalf("v=%v: %+v, want a failure echoing id 5", v, got)
		}
	}
}

func TestEnvelopeRepliesWithIDZeroWhenThereIsNoUsableID(t *testing.T) {
	raws := []string{
		`{"v":1,"op":"open"}`,
		`{"v":1,"id":0,"op":"open"}`,
		`{"v":1,"id":-1,"op":"open"}`,
		`{"v":1,"id":1.5,"op":"open"}`,
		`{"v":1,"id":"5","op":"open"}`,
		`{"v":1,"id":null,"op":"open"}`,
		`{"v":1,"id":9007199254740993,"op":"open"}`, // Number.MAX_SAFE_INTEGER + 2
	}
	for _, raw := range raws {
		got := parseCallbackEnvelope([]byte(raw))
		if got.ok || got.id != 0 {
			t.Fatalf("%s: %+v, want failure with id 0", raw, got)
		}
	}
	for _, junk := range []string{`null`, `"open"`, `7`, `[]`, `[{"v":1}]`, `not json`, ``} {
		got := parseCallbackEnvelope([]byte(junk))
		if got.ok || got.id != 0 || got.message != "request must be a JSON object" {
			t.Fatalf("%q: %+v, want the not-an-object failure with id 0", junk, got)
		}
	}
}

func TestEnvelopeAcceptsNumbersTheWayJavaScriptDoes(t *testing.T) {
	// JSON.parse("5.0") and JSON.parse("1e0") are the integers 5 and 1.
	got := parseCallbackEnvelope([]byte(`{"v":1.0,"id":5.0,"op":"open"}`))
	if !got.ok || got.id != 5 {
		t.Fatalf("5.0 / 1.0 must be accepted as integers: %+v", got)
	}
	got = parseCallbackEnvelope([]byte(`{"v":1e0,"id":5,"op":"open"}`))
	if !got.ok {
		t.Fatalf("1e0 must be accepted as 1: %+v", got)
	}
}

func TestEnvelopeRejectsABadOp(t *testing.T) {
	for _, op := range []any{absent, nil, 5, "", strings.Repeat("x", 33)} {
		got := parseCallbackEnvelope(validRequest(map[string]any{"op": op}))
		if got.ok || got.id != 5 {
			t.Fatalf("op=%v: %+v, want a failure echoing id 5", op, got)
		}
	}
	if got := parseCallbackEnvelope(validRequest(map[string]any{"op": strings.Repeat("x", 32)})); !got.ok {
		t.Fatalf("a 32-character op is the longest accepted: %+v", got)
	}
}

func TestEnvelopeLeavesTheAllowlistToTheCaller(t *testing.T) {
	got := parseCallbackEnvelope(validRequest(map[string]any{"op": "delete"}))
	if !got.ok || got.op != "delete" {
		t.Fatalf("an unknown op is a valid envelope: %+v", got)
	}
}

func TestEnvelopeRejectsAMalformedPaneButAcceptsAMissingOne(t *testing.T) {
	bad := []any{
		"tmux",
		[]any{},
		map[string]any{},
		map[string]any{"kind": "tmux"},
		map[string]any{"kind": "screen", "id": "%1"},
		map[string]any{"kind": "tmux", "id": ""},
		map[string]any{"kind": "tmux", "id": 7},
		map[string]any{"kind": "tmux", "id": "a\nb"},
		map[string]any{"kind": "tmux", "id": "a\u0000b"},
		map[string]any{"kind": "mux", "id": strings.Repeat("k", 129)},
	}
	for _, pane := range bad {
		got := parseCallbackEnvelope(validRequest(map[string]any{"pane": pane}))
		if got.ok || got.id != 5 {
			t.Fatalf("pane=%v: %+v, want a failure echoing id 5", pane, got)
		}
	}
}

func TestPaneIDLimitsCountUTF16UnitsLikeJavaScript(t *testing.T) {
	// 64 astral characters are 128 UTF-16 units (accepted); 65 are 130 (refused),
	// although 65 < 128 as Go runes.
	if !isPaneID(strings.Repeat("😀", 64)) {
		t.Fatal("64 astral characters are 128 UTF-16 units and must be accepted")
	}
	if isPaneID(strings.Repeat("😀", 65)) {
		t.Fatal("65 astral characters are 130 UTF-16 units and must be refused")
	}
	if isPaneID("") || isPaneID("a\x7fb") {
		t.Fatal("empty and DEL-bearing ids must be refused")
	}
}

func TestPaneFromEnvironmentFixtures(t *testing.T) {
	var fixtures struct {
		Cases []struct {
			Name string            `json:"name"`
			Env  map[string]string `json:"env"`
			Pane *callbackPane     `json:"pane"`
		} `json:"cases"`
	}
	readFixture(t, "identity.json", &fixtures)
	if len(fixtures.Cases) == 0 {
		t.Fatal("no identity fixtures loaded")
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			got := paneFromEnv(func(key string) string { return fixture.Env[key] })
			switch {
			case fixture.Pane == nil && got != nil:
				t.Fatalf("pane = %+v, want none", *got)
			case fixture.Pane != nil && (got == nil || *got != *fixture.Pane):
				t.Fatalf("pane = %v, want %+v", got, *fixture.Pane)
			}
		})
	}
}

func TestPaneFromEnvironmentProducesAPaneTheEnvelopeAccepts(t *testing.T) {
	pane := paneFromEnv(func(key string) string {
		if key == "TMUX_PANE" {
			return "%4"
		}
		return ""
	})
	if pane == nil {
		t.Fatal("expected a pane")
	}
	got := parseCallbackEnvelope(validRequest(map[string]any{"pane": pane}))
	if !got.ok || got.pane == nil || *got.pane != *pane {
		t.Fatalf("envelope = %+v", got)
	}
}

func TestInjectableEnvironmentValues(t *testing.T) {
	for _, bad := range []string{"a\x00b", "a\nb", "a\rb", "\n", "\x00"} {
		if isInjectableEnvValue(bad) {
			t.Fatalf("%q must not be injectable", bad)
		}
	}
	legal := []string{
		"",
		"/Users/me/Library/Application Support/Agent Cockpit/callback/abc.sock",
		"/tmp/it's here/$HOME;rm -rf ~ #x/a.sock",
		"\"quoted\" `tick` \\back\\slash",
		"日本語/ö",
	}
	for _, ok := range legal {
		if !isInjectableEnvValue(ok) {
			t.Fatalf("%q must be injectable (only NUL and line breaks are refused)", ok)
		}
	}
}

// ---- open's arguments (mirror of parseOpenArgs in protocol.test.ts) ----------------

func decodeArgs(t *testing.T, raw string) any {
	t.Helper()
	envelope := parseCallbackEnvelope([]byte(`{"v":1,"id":1,"op":"open","args":` + raw + `}`))
	if !envelope.ok {
		t.Fatalf("test envelope rejected: %+v", envelope)
	}
	return envelope.args
}

func TestParseOpenArgsAcceptsAnAbsolutePathWithOrWithoutACanonicalForm(t *testing.T) {
	got, problem := parseOpenArgs(decodeArgs(t, `{"path":"/a/b c.md"}`))
	if problem != "" || got != (openArgs{Path: "/a/b c.md"}) {
		t.Fatalf("got %+v %q", got, problem)
	}
	got, problem = parseOpenArgs(decodeArgs(t, `{"path":"/a/b.md","canonicalPath":"/private/a/b.md"}`))
	if problem != "" || got != (openArgs{Path: "/a/b.md", CanonicalPath: "/private/a/b.md"}) {
		t.Fatalf("got %+v %q", got, problem)
	}
	got, problem = parseOpenArgs(decodeArgs(t, `{"path":"/a/b.md","canonicalPath":null}`))
	if problem != "" || got != (openArgs{Path: "/a/b.md"}) {
		t.Fatalf("a null canonicalPath means none: got %+v %q", got, problem)
	}
}

func TestParseOpenArgsDropsEverythingItDoesNotKnow(t *testing.T) {
	got, problem := parseOpenArgs(decodeArgs(t,
		`{"path":"/a","projectId":"other","evil":{"deep":[1,2,3]},"canonicalPath":"/b","line":12}`))
	if problem != "" || got != (openArgs{Path: "/a", CanonicalPath: "/b"}) {
		t.Fatalf("got %+v %q: only path and canonicalPath survive", got, problem)
	}
}

func TestParseOpenArgsRejectsBadPaths(t *testing.T) {
	cases := map[string]string{
		`{"path":""}`:                               "path must be a non-empty string",
		`{"path":"README.md"}`:                      "path must be an absolute path",
		`{"path":"./x"}`:                            "path must be an absolute path",
		`{"path":"../x"}`:                           "path must be an absolute path",
		`{"path":" /x"}`:                            "path must be an absolute path",
		`{"path":5}`:                                "path must be a non-empty string",
		`{"path":null}`:                             "path must be a non-empty string",
		`{}`:                                        "path must be a non-empty string",
		`{"path":"/a\u0000b"}`:                      "path must not contain NUL",
		`{"path":"/a","canonicalPath":""}`:          "canonicalPath must be a non-empty string",
		`{"path":"/a","canonicalPath":"rel/x"}`:     "canonicalPath must be an absolute path",
		`{"path":"/a","canonicalPath":5}`:           "canonicalPath must be a non-empty string",
		`{"path":"/a","canonicalPath":"/a\u0000b"}`: "canonicalPath must not contain NUL",
	}
	for raw, want := range cases {
		if _, problem := parseOpenArgs(decodeArgs(t, raw)); problem != want {
			t.Fatalf("%s: problem = %q, want %q", raw, problem, want)
		}
	}
	for _, raw := range []string{`null`, `"x"`, `7`, `["/a"]`} {
		if _, problem := parseOpenArgs(decodeArgs(t, raw)); problem != "args must be an object" {
			t.Fatalf("%s: problem = %q, want an object error", raw, problem)
		}
	}
}

func TestParseOpenArgsBoundsAPathByBytesNotCharacters(t *testing.T) {
	ok := `{"path":"/` + strings.Repeat("a", callbackMaxPathBytes-1) + `"}`
	if _, problem := parseOpenArgs(decodeArgs(t, ok)); problem != "" {
		t.Fatalf("a %d-byte path is the longest accepted: %q", callbackMaxPathBytes, problem)
	}
	tooLong := `{"path":"/` + strings.Repeat("a", callbackMaxPathBytes) + `"}`
	if _, problem := parseOpenArgs(decodeArgs(t, tooLong)); problem != "path is longer than 4096 bytes" {
		t.Fatalf("problem = %q", problem)
	}
	// 1366 three-byte characters are 4098 bytes: under the limit by length, over by bytes.
	wide := `{"path":"/` + strings.Repeat("日", 1366) + `"}`
	if _, problem := parseOpenArgs(decodeArgs(t, wide)); problem == "" {
		t.Fatal("the limit counts bytes, not characters")
	}
}

func TestParseOpenArgsAllowsANewlineInAPath(t *testing.T) {
	if _, problem := parseOpenArgs(decodeArgs(t, `{"path":"/a/line\nbreak.md"}`)); problem != "" {
		t.Fatalf("a newline is legal on POSIX; only NUL is refused: %q", problem)
	}
}
