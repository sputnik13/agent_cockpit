// Package protocol defines the standalone cockpit-mux wire framing.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/vmihailenco/msgpack/v5"
)

const (
	// Version is negotiated before a client may issue a state-changing request.
	Version uint16 = 1
	// MaxFrameBytes bounds every MessagePack payload; larger producer data is chunked.
	MaxFrameBytes = 16 << 20
)

var (
	ErrFrameTooLarge   = errors.New("mux protocol frame exceeds 16 MiB")
	ErrTruncatedFrame  = errors.New("mux protocol frame is truncated")
	ErrVersionMismatch = errors.New("mux protocol version mismatch")
	ErrInvalidRequest  = errors.New("mux protocol request is invalid")
)

// Hello is the first frame sent by a client. It makes protocol negotiation happen
// before any state-changing request.
type Hello struct {
	Protocol uint16 `msgpack:"protocol"`
}

// Request is a single client operation. Data remains MessagePack binary rather
// than text so terminal input and future pane payloads are not transformed by
// the control protocol.
type Request struct {
	ID        uint64 `msgpack:"id"`
	Method    string `msgpack:"method"`
	ProjectID string `msgpack:"project_id,omitempty"`
	Data      []byte `msgpack:"data,omitempty"`
}

// Response is correlated with exactly one Request by ID. A non-empty Error
// denotes an application-level failure; malformed requests instead close the
// connection before an operation can run.
type Response struct {
	ID    uint64 `msgpack:"id"`
	Data  []byte `msgpack:"data,omitempty"`
	Error string `msgpack:"error,omitempty"`
}

// Event is an unsolicited server notification. Events never reuse a request ID,
// so clients can distinguish lifecycle changes from correlated responses.
type Event struct {
	Event     string `msgpack:"event"`
	SessionID string `msgpack:"session_id"`
	ByKind    string `msgpack:"by_kind,omitempty"`
}

// ValidateHello rejects an incompatible client before it can mutate daemon state.
func ValidateHello(hello Hello) error {
	if hello.Protocol != Version {
		return fmt.Errorf("%w: client=%d daemon=%d", ErrVersionMismatch, hello.Protocol, Version)
	}
	return nil
}

// ValidateRequest rejects malformed operation envelopes before daemon state can
// be affected. Method-specific validation belongs to the request handler.
func ValidateRequest(request Request) error {
	if request.ID == 0 {
		return fmt.Errorf("%w: id must be non-zero", ErrInvalidRequest)
	}
	if request.Method == "" {
		return fmt.Errorf("%w: method is required", ErrInvalidRequest)
	}
	return nil
}

// Write encodes value as MessagePack and writes one length-prefixed frame.
func Write(writer io.Writer, value any) error {
	payload, err := msgpack.Marshal(value)
	if err != nil {
		return fmt.Errorf("marshal mux frame: %w", err)
	}
	if len(payload) > MaxFrameBytes {
		return ErrFrameTooLarge
	}

	var header [4]byte
	binary.BigEndian.PutUint32(header[:], uint32(len(payload)))
	if _, err := writer.Write(header[:]); err != nil {
		return fmt.Errorf("write mux frame header: %w", err)
	}
	if _, err := writer.Write(payload); err != nil {
		return fmt.Errorf("write mux frame payload: %w", err)
	}
	return nil
}

// Read reads exactly one length-prefixed MessagePack frame into destination.
func Read(reader io.Reader, destination any) error {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return frameReadError(err)
	}

	size := binary.BigEndian.Uint32(header[:])
	if size > MaxFrameBytes {
		return ErrFrameTooLarge
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return frameReadError(err)
	}
	if err := msgpack.Unmarshal(payload, destination); err != nil {
		return fmt.Errorf("decode mux frame: %w", err)
	}
	return nil
}

func frameReadError(err error) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return fmt.Errorf("%w: %v", ErrTruncatedFrame, err)
	}
	return fmt.Errorf("read mux frame: %w", err)
}
