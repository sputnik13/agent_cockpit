package main

// Scenario 3 (Go mirror): the callback wire codec. These tests replay the SAME
// fixture files the TypeScript reference (src/shared/callback/protocol.test.ts)
// replays, so the two implementations cannot drift apart silently.

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

type frameFixtureFile struct {
	MaxFrameBytes int                `json:"maxFrameBytes"`
	Cases         []frameFixtureCase `json:"cases"`
}

type frameFixtureCase struct {
	Name   string            `json:"name"`
	Chunks []json.RawMessage `json:"chunks"`
	Expect struct {
		Payloads     []json.RawMessage `json:"payloads"`
		PendingBytes int               `json:"pendingBytes"`
		Error        string            `json:"error"`
	} `json:"expect"`
}

// fixtureChunk expands a chunk: a lowercase hex string, or {"jsonStringFrame": N},
// one complete frame whose body is a JSON string of N "a" characters.
func fixtureChunk(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var hexChunk string
	if err := json.Unmarshal(raw, &hexChunk); err == nil {
		out, err := hex.DecodeString(hexChunk)
		if err != nil {
			t.Fatalf("bad hex chunk %q: %v", hexChunk, err)
		}
		return out
	}
	var spec struct {
		JSONStringFrame int `json:"jsonStringFrame"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil || spec.JSONStringFrame == 0 {
		t.Fatalf("unsupported chunk %s", raw)
	}
	return mustFrame(t, strings.Repeat("a", spec.JSONStringFrame))
}

// fixturePayload expands an expected payload: any JSON value, or {"jsonString": N}
// for a string of N "a" characters. Both sides are normalized through any.
func fixturePayload(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var spec struct {
		JSONString *int `json:"jsonString"`
	}
	if err := json.Unmarshal(raw, &spec); err == nil && spec.JSONString != nil {
		return strings.Repeat("a", *spec.JSONString)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("bad payload %s: %v", raw, err)
	}
	return value
}

func TestCallbackWireIsBoundToTheDocumentedCap(t *testing.T) {
	var fixtures frameFixtureFile
	readFixture(t, "frames.json", &fixtures)
	if callbackMaxFrameBytes != 64*1024 {
		t.Fatalf("callbackMaxFrameBytes = %d, want 64 KiB", callbackMaxFrameBytes)
	}
	if fixtures.MaxFrameBytes != callbackMaxFrameBytes {
		t.Fatalf("fixture cap %d != callbackMaxFrameBytes %d", fixtures.MaxFrameBytes, callbackMaxFrameBytes)
	}
}

func TestCallbackFrameFixtures(t *testing.T) {
	var fixtures frameFixtureFile
	readFixture(t, "frames.json", &fixtures)
	if len(fixtures.Cases) == 0 {
		t.Fatal("no frame fixtures loaded")
	}
	for _, fixture := range fixtures.Cases {
		t.Run(fixture.Name, func(t *testing.T) {
			decoder := newCallbackFrameDecoder(fixtures.MaxFrameBytes)
			var decoded []json.RawMessage
			var failure error
			for _, chunk := range fixture.Chunks {
				payloads, err := decoder.Push(fixtureChunk(t, chunk))
				if err != nil {
					failure = err
					break
				}
				decoded = append(decoded, payloads...)
			}
			if fixture.Expect.Error != "" {
				var fe *frameError
				if failure == nil {
					t.Fatalf("expected a %q error, decoded %d payloads", fixture.Expect.Error, len(decoded))
				}
				if !errorsAs(failure, &fe) || string(fe.code) != fixture.Expect.Error {
					t.Fatalf("error = %v, want code %q", failure, fixture.Expect.Error)
				}
				return
			}
			if failure != nil {
				t.Fatalf("unexpected error: %v", failure)
			}
			got := make([]any, 0, len(decoded))
			for _, payload := range decoded {
				var value any
				if err := json.Unmarshal(payload, &value); err != nil {
					t.Fatalf("decoded payload is not JSON: %v", err)
				}
				got = append(got, value)
			}
			want := make([]any, 0, len(fixture.Expect.Payloads))
			for _, payload := range fixture.Expect.Payloads {
				want = append(want, fixturePayload(t, payload))
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("payloads = %v, want %v", got, want)
			}
			if decoder.PendingBytes() != fixture.Expect.PendingBytes {
				t.Fatalf("pendingBytes = %d, want %d", decoder.PendingBytes(), fixture.Expect.PendingBytes)
			}
		})
	}
}

// errorsAs is errors.As without importing it in every test file.
func errorsAs(err error, target **frameError) bool {
	fe, ok := err.(*frameError)
	if ok {
		*target = fe
	}
	return ok
}

// The fixtures' request frames are byte-exact: the Go encoder must produce the
// SAME bytes the TypeScript encoder did, not merely equivalent JSON.
func TestEncodeMatchesTheFixtureBytes(t *testing.T) {
	var fixtures frameFixtureFile
	readFixture(t, "frames.json", &fixtures)
	byName := map[string]frameFixtureCase{}
	for _, fixture := range fixtures.Cases {
		byName[fixture.Name] = fixture
	}
	first := callbackRequest{
		V: 1, ID: 1, Op: "open",
		Pane: &callbackPane{Kind: "tmux", ID: "%3"},
		Args: openArgs{Path: "/Users/me/repo/README.md", CanonicalPath: "/Users/me/repo/README.md"},
	}
	second := callbackRequest{V: 1, ID: 2, Op: "open", Args: openArgs{Path: "/tmp/a b/notes.md"}}
	nonASCII := callbackRequest{V: 1, ID: 9, Op: "open", Args: openArgs{Path: "/tmp/日本語/ö é.md"}}

	cases := []struct {
		fixture string
		want    []callbackRequest
	}{
		{"one frame in one chunk", []callbackRequest{first}},
		{"two frames in one chunk", []callbackRequest{first, second}},
		{"non-ASCII path survives the round trip", []callbackRequest{nonASCII}},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			fixture, ok := byName[tc.fixture]
			if !ok {
				t.Fatalf("fixture %q missing", tc.fixture)
			}
			var expected []byte
			for _, chunk := range fixture.Chunks {
				expected = append(expected, fixtureChunk(t, chunk)...)
			}
			var got []byte
			for _, request := range tc.want {
				got = append(got, mustFrame(t, request)...)
			}
			if !bytes.Equal(got, expected) {
				t.Fatalf("encoded bytes differ\n got %x\nwant %x", got, expected)
			}
		})
	}
}

func TestEncodeRejectsAFrameOverTheCap(t *testing.T) {
	_, err := encodeCallbackFrame(okReply(1, map[string]any{"blob": strings.Repeat("x", callbackMaxFrameBytes)}))
	var fe *frameError
	if !errorsAs(err, &fe) || fe.code != frameTooLarge || !strings.Contains(fe.msg, "frame too large") {
		t.Fatalf("err = %v, want a too-large frameError", err)
	}
	// Exactly at the cap is accepted (a JSON string of 65534 characters has a
	// 65536-byte body once quoted).
	if _, err := encodeCallbackFrame(strings.Repeat("a", callbackMaxFrameBytes-2)); err != nil {
		t.Fatalf("a body exactly at the cap must encode: %v", err)
	}
	if _, err := encodeCallbackFrame(strings.Repeat("a", callbackMaxFrameBytes-1)); err == nil {
		t.Fatal("a body one byte over the cap must not encode")
	}
}

func TestDecoderIsPoisonedAfterAFailure(t *testing.T) {
	decoder := newCallbackFrameDecoder(callbackMaxFrameBytes)
	if _, err := decoder.Push([]byte{0x00, 0x01, 0x00, 0x01}); err == nil {
		t.Fatal("an oversize header must fail")
	}
	good := mustFrame(t, map[string]any{"v": 1})
	if _, err := decoder.Push(good); err == nil {
		t.Fatal("a poisoned decoder must keep failing")
	}
}

func TestDecoderReturnsNoPayloadsFromAFailingPush(t *testing.T) {
	// One chunk: a complete valid frame followed by an oversize header. Like the
	// TypeScript decoder throwing out of push(), the failing call yields nothing —
	// the Node and Go listeners therefore answer this input identically.
	chunk := append(mustFrame(t, map[string]any{"v": 1}), 0xff, 0xff, 0xff, 0xff)
	payloads, err := newCallbackFrameDecoder(callbackMaxFrameBytes).Push(chunk)
	if err == nil || len(payloads) != 0 {
		t.Fatalf("payloads=%v err=%v, want no payloads and an error", payloads, err)
	}
}

func TestOversizeHeaderIsRejectedBeforeAnyBody(t *testing.T) {
	decoder := newCallbackFrameDecoder(callbackMaxFrameBytes)
	// Declares 64 KiB + 1; not a single body byte has arrived.
	_, err := decoder.Push([]byte{0x00, 0x01, 0x00, 0x01})
	var fe *frameError
	if !errorsAs(err, &fe) || fe.code != frameTooLarge {
		t.Fatalf("err = %v, want too-large", err)
	}
	if decoder.PendingBytes() > callbackFrameHeaderBytes {
		t.Fatalf("buffered %d bytes against a bogus length", decoder.PendingBytes())
	}
}

func TestMessageFixturesRoundTripThroughTheWire(t *testing.T) {
	var fixtures struct {
		Requests []struct {
			Name    string          `json:"name"`
			Request json.RawMessage `json:"request"`
		} `json:"requests"`
		Replies []struct {
			Name  string          `json:"name"`
			Reply json.RawMessage `json:"reply"`
		} `json:"replies"`
	}
	readFixture(t, "messages.json", &fixtures)
	if len(fixtures.Requests) == 0 || len(fixtures.Replies) == 0 {
		t.Fatal("no message fixtures loaded")
	}
	for _, fixture := range fixtures.Requests {
		t.Run("request: "+fixture.Name, func(t *testing.T) {
			envelope := parseCallbackEnvelope(fixture.Request)
			if !envelope.ok || envelope.op != "open" || !isCallbackOp(envelope.op) {
				t.Fatalf("the golden request must be accepted: %+v", envelope)
			}
			payloads, err := newCallbackFrameDecoder(callbackMaxFrameBytes).Push(mustFrame(t, json.RawMessage(fixture.Request)))
			if err != nil || len(payloads) != 1 {
				t.Fatalf("round trip: %v (%d payloads)", err, len(payloads))
			}
			assertSameJSON(t, payloads[0], fixture.Request)
		})
	}
	for _, fixture := range fixtures.Replies {
		t.Run("reply: "+fixture.Name, func(t *testing.T) {
			payloads, err := newCallbackFrameDecoder(callbackMaxFrameBytes).Push(mustFrame(t, json.RawMessage(fixture.Reply)))
			if err != nil || len(payloads) != 1 {
				t.Fatalf("round trip: %v (%d payloads)", err, len(payloads))
			}
			assertSameJSON(t, payloads[0], fixture.Reply)
			var reply callbackReply
			if err := json.Unmarshal(fixture.Reply, &reply); err != nil {
				t.Fatal(err)
			}
			if !reply.OK && !isCallbackErrorCode(reply.Error.Code) {
				t.Fatalf("fixture error code %q is not a known code", reply.Error.Code)
			}
		})
	}
}

func TestReplyBuildersProduceTheFixtureShapes(t *testing.T) {
	var fixtures struct {
		Replies []struct {
			Name  string          `json:"name"`
			Reply json.RawMessage `json:"reply"`
		} `json:"replies"`
	}
	readFixture(t, "messages.json", &fixtures)
	byName := map[string]json.RawMessage{}
	for _, r := range fixtures.Replies {
		byName[r.Name] = r.Reply
	}
	encode := func(v any) json.RawMessage {
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	assertSameJSON(t, encode(okReply(1, map[string]any{"status": "dispatched"})), byName["dispatched"])
	assertSameJSON(t, encode(errorReply(8, "not-connected", "project is not connected")), byName["not-connected"])
	assertSameJSON(t, encode(errorReply(0, "bad-request", "request must be a JSON object")),
		byName["reply to a request whose id could not be read"])
}

func assertSameJSON(t *testing.T, got, want json.RawMessage) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("got is not JSON: %v", err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("want is not JSON: %v", err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("JSON differs\n got %s\nwant %s", got, want)
	}
}
