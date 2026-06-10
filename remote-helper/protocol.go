package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// ProtocolVersion is the wire protocol version implemented by this helper.
// The client sends its requested version in the initial handshake; a mismatch
// causes the client to re-provision a compatible helper binary.
const ProtocolVersion = 1

// Version is the helper release version. The Makefile may override it via
// -ldflags "-X main.Version=...".
var Version = "0.1.0"

// SourceHash is a build-time content hash over the Go source files (main
// package + go.mod). build.sh computes it and embeds it via
// -ldflags "-X main.SourceHash=<hex>". When empty (local dev builds without
// build.sh), the helper reports "dev" so the provisioner always treats it as
// potentially stale (safe: triggers a re-upload during development).
var SourceHash = "dev"

// maxMessageBytes caps a single framed message to guard against absurd or
// malicious length headers (16 MiB).
const maxMessageBytes = 16 << 20

// Request is an inbound RPC request from the client.
type Request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Response is the reply to a Request. Exactly one of Result/Error is meaningful;
// Error is non-nil on failure.
type Response struct {
	ID     int         `json:"id"`
	Result interface{} `json:"result"`
	Error  *string     `json:"error"`
}

// Event is an unsolicited server-push message (no id field on the wire).
type Event struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

// newErrorResponse builds a Response carrying an error string.
func newErrorResponse(id int, err error) Response {
	msg := err.Error()
	return Response{ID: id, Result: nil, Error: &msg}
}

// newResultResponse builds a successful Response.
func newResultResponse(id int, result interface{}) Response {
	return Response{ID: id, Result: result, Error: nil}
}

// writeFrame encodes payload as JSON and writes it with a 4-byte big-endian
// length prefix to w. It is the caller's responsibility to serialize writes.
func writeFrame(w io.Writer, payload interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal frame: %w", err)
	}
	if len(body) > maxMessageBytes {
		return fmt.Errorf("frame too large: %d bytes", len(body))
	}
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(body)))
	if _, err := w.Write(header[:]); err != nil {
		return fmt.Errorf("write frame header: %w", err)
	}
	if _, err := w.Write(body); err != nil {
		return fmt.Errorf("write frame body: %w", err)
	}
	return nil
}

// readFrame reads one length-prefixed frame from r and returns the raw JSON
// body. It returns io.EOF when the stream is cleanly closed before a header.
func readFrame(r io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return nil, io.ErrUnexpectedEOF
		}
		return nil, err
	}
	length := binary.BigEndian.Uint32(header[:])
	if length > maxMessageBytes {
		return nil, fmt.Errorf("frame too large: %d bytes", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return nil, fmt.Errorf("read frame body: %w", err)
	}
	return body, nil
}

// decodeRequest reads and parses one Request frame from r.
func decodeRequest(r io.Reader) (Request, error) {
	body, err := readFrame(r)
	if err != nil {
		return Request{}, err
	}
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		return Request{}, fmt.Errorf("decode request: %w", err)
	}
	return req, nil
}

// HandshakeParams is the params object for the handshake method.
type HandshakeParams struct {
	ProtocolVersion int `json:"protocolVersion"`
}

// HandshakeResult is returned on a successful handshake.
type HandshakeResult struct {
	ProtocolVersion int `json:"protocolVersion"`
	PID             int `json:"pid"`
}
