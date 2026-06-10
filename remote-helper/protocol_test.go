package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestFrameRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		msg  Request
	}{
		{"simple", Request{ID: 1, Method: "stat", Params: json.RawMessage(`{"path":"/tmp"}`)}},
		{"empty params", Request{ID: 7, Method: "handshake"}},
		{"unicode method", Request{ID: 42, Method: "readFile", Params: json.RawMessage(`{"path":"/tmp/ünïcödé"}`)}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := writeFrame(&buf, tc.msg); err != nil {
				t.Fatalf("writeFrame: %v", err)
			}
			got, err := decodeRequest(&buf)
			if err != nil {
				t.Fatalf("decodeRequest: %v", err)
			}
			if got.ID != tc.msg.ID || got.Method != tc.msg.Method {
				t.Fatalf("id/method mismatch: got %+v want %+v", got, tc.msg)
			}
			if !bytes.Equal(normalizeJSON(t, got.Params), normalizeJSON(t, tc.msg.Params)) {
				t.Fatalf("params mismatch: got %s want %s", got.Params, tc.msg.Params)
			}
		})
	}
}

func TestFrameMultipleSequential(t *testing.T) {
	var buf bytes.Buffer
	msgs := []Response{
		newResultResponse(1, map[string]any{"ok": true}),
		newErrorResponse(2, errString("boom")),
		newResultResponse(3, nil),
	}
	for _, m := range msgs {
		if err := writeFrame(&buf, m); err != nil {
			t.Fatalf("writeFrame: %v", err)
		}
	}
	for i, want := range msgs {
		body, err := readFrame(&buf)
		if err != nil {
			t.Fatalf("frame %d: readFrame: %v", i, err)
		}
		var got Response
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("frame %d: unmarshal: %v", i, err)
		}
		if got.ID != want.ID {
			t.Fatalf("frame %d: id got %d want %d", i, got.ID, want.ID)
		}
		if (got.Error == nil) != (want.Error == nil) {
			t.Fatalf("frame %d: error presence mismatch", i)
		}
	}
}

func TestHandshakeVersionMatch(t *testing.T) {
	s := &server{}
	raw := json.RawMessage(`{"protocolVersion":1}`)
	res, err := s.handleHandshake(raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	hr, ok := res.(HandshakeResult)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	if hr.ProtocolVersion != ProtocolVersion {
		t.Fatalf("protocolVersion got %d want %d", hr.ProtocolVersion, ProtocolVersion)
	}
	if hr.PID <= 0 {
		t.Fatalf("expected positive pid, got %d", hr.PID)
	}
}

func TestHandshakeVersionMismatch(t *testing.T) {
	s := &server{}
	raw := json.RawMessage(`{"protocolVersion":999}`)
	res, err := s.handleHandshake(raw)
	if err == nil {
		t.Fatalf("expected version-mismatch error, got result %+v", res)
	}
}

// errString is a tiny error type for test fixtures.
type errString string

func (e errString) Error() string { return string(e) }

func normalizeJSON(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	if len(raw) == 0 {
		return []byte("null")
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("normalize: %v", err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("normalize marshal: %v", err)
	}
	return out
}

func TestReflectResponseShape(t *testing.T) {
	// Guard against accidental field-name drift in the wire contract.
	want := []string{"id", "result", "error"}
	rt := reflect.TypeOf(Response{})
	for i, name := range want {
		tag := rt.Field(i).Tag.Get("json")
		if tag != name {
			t.Fatalf("Response field %d json tag = %q, want %q", i, tag, name)
		}
	}
}
