package main

// Terminal callback socket wire codec: the Go mirror of src/shared/wire/frame.ts
// bound to the callback's 64 KiB cap (src/shared/callback/protocol.ts). The cases
// both implementations must agree on are the JSON fixtures under
// src/shared/callback/fixtures; callback_wire_test.go replays the SAME files.
//
// Layout: a 4-byte big-endian uint32 body length, then that many bytes of UTF-8
// JSON. One request per connection. This codec is deliberately separate from the
// RPC stream codec in protocol.go (16 MiB cap, different failure policy): the two
// protocols differ on purpose and share only the layout.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
)

const (
	// callbackMaxFrameBytes is the largest frame body, either direction.
	callbackMaxFrameBytes = 64 * 1024
	// callbackFrameHeaderBytes is the length prefix.
	callbackFrameHeaderBytes = 4
)

type frameErrorCode string

const (
	// frameTooLarge: a header declares a body over the cap (rejected before any body
	// is buffered) or an encoded body exceeds it.
	frameTooLarge frameErrorCode = "too-large"
	// frameMalformed: a complete body is not valid JSON.
	frameMalformed frameErrorCode = "malformed"
)

// frameError is a frame the wire layout rejects.
type frameError struct {
	code frameErrorCode
	msg  string
}

func (e *frameError) Error() string { return e.msg }

// marshalCallbackBody is the JSON body of a callback message. HTML escaping is
// off so the bytes match what JSON.stringify produces for the same value.
func marshalCallbackBody(payload any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return nil, &frameError{code: frameMalformed, msg: "payload is not JSON-serializable: " + err.Error()}
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// encodeCallbackFrame encodes payload as one length-prefixed frame.
func encodeCallbackFrame(payload any) ([]byte, error) {
	body, err := marshalCallbackBody(payload)
	if err != nil {
		return nil, err
	}
	if len(body) > callbackMaxFrameBytes {
		return nil, &frameError{code: frameTooLarge, msg: fmt.Sprintf("frame too large: %d bytes", len(body))}
	}
	frame := make([]byte, callbackFrameHeaderBytes+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[callbackFrameHeaderBytes:], body)
	return frame, nil
}

// callbackFrameDecoder is an incremental frame decoder: feed it arbitrary chunks;
// it yields complete payloads as they become available, buffering partial frames
// across chunks. It mirrors FrameDecoder in src/shared/wire/frame.ts:
//
//   - an oversize length header is rejected as soon as its 4 bytes are readable,
//     before any body is buffered, so a hostile peer cannot make it allocate
//     against a bogus length;
//   - a complete body that is not valid JSON (including an empty body or one with
//     a byte-order mark) is malformed;
//   - after a failure the decoder is poisoned: every later Push returns the same
//     error and the caller is expected to drop the stream;
//   - a failing Push returns NO payloads, even ones completed earlier in the same
//     chunk, exactly like the TypeScript decoder throwing out of push().
type callbackFrameDecoder struct {
	maxBytes int
	buf      []byte
	// frameBytes is header+body of the frame being assembled; 0 until its header
	// is readable.
	frameBytes int
	failure    *frameError
}

func newCallbackFrameDecoder(maxBytes int) *callbackFrameDecoder {
	return &callbackFrameDecoder{maxBytes: maxBytes}
}

// PendingBytes is the number of received bytes that do not (yet) form a complete
// frame. Non-zero when the stream ends means the peer's final frame was truncated.
func (d *callbackFrameDecoder) PendingBytes() int { return len(d.buf) }

// Push appends chunk and returns any complete payloads decoded from the buffer.
func (d *callbackFrameDecoder) Push(chunk []byte) ([]json.RawMessage, error) {
	if d.failure != nil {
		return nil, d.failure
	}
	if len(chunk) == 0 {
		return nil, nil
	}
	d.buf = append(d.buf, chunk...)
	var out []json.RawMessage
	for {
		if d.frameBytes == 0 {
			if len(d.buf) < callbackFrameHeaderBytes {
				break
			}
			length := binary.BigEndian.Uint32(d.buf[:callbackFrameHeaderBytes])
			if uint64(length) > uint64(d.maxBytes) {
				return nil, d.fail(frameTooLarge, fmt.Sprintf("frame too large: %d bytes", length))
			}
			d.frameBytes = callbackFrameHeaderBytes + int(length)
		}
		if len(d.buf) < d.frameBytes {
			break
		}
		body := d.buf[callbackFrameHeaderBytes:d.frameBytes]
		if !json.Valid(body) {
			return nil, d.fail(frameMalformed, "frame body is not valid JSON")
		}
		out = append(out, append(json.RawMessage(nil), body...))
		// Copy the remainder down so the consumed frame's memory is released.
		d.buf = append([]byte(nil), d.buf[d.frameBytes:]...)
		d.frameBytes = 0
	}
	return out, nil
}

func (d *callbackFrameDecoder) fail(code frameErrorCode, msg string) *frameError {
	d.failure = &frameError{code: code, msg: msg}
	return d.failure
}
