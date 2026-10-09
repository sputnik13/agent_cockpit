package protocol

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func TestFrameRoundTripPreservesBinaryPayload(t *testing.T) {
	t.Parallel()

	want := map[string]any{"type": "pane.write", "data": []byte{0x00, 0xff, 0x41}}
	var wire bytes.Buffer
	if err := Write(&wire, want); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	var got map[string]any
	if err := Read(&wire, &got); err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got["type"] != want["type"] {
		t.Fatalf("type = %v, want %v", got["type"], want["type"])
	}
	if !bytes.Equal(got["data"].([]byte), want["data"].([]byte)) {
		t.Fatalf("data = %x, want %x", got["data"], want["data"])
	}
}

func TestReadRejectsOversizedFrameBeforeAllocating(t *testing.T) {
	t.Parallel()

	var wire bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], MaxFrameBytes+1)
	wire.Write(header[:])

	var destination Hello
	if err := Read(&wire, &destination); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("Read() error = %v, want ErrFrameTooLarge", err)
	}
}

func TestReadReportsTruncatedFrame(t *testing.T) {
	t.Parallel()

	var wire bytes.Buffer
	var header [4]byte
	binary.BigEndian.PutUint32(header[:], 8)
	wire.Write(header[:])
	wire.WriteString("short")

	var destination Hello
	if err := Read(&wire, &destination); !errors.Is(err, ErrTruncatedFrame) {
		t.Fatalf("Read() error = %v, want ErrTruncatedFrame", err)
	}
}

func TestValidateHello(t *testing.T) {
	t.Parallel()

	if err := ValidateHello(Hello{Protocol: Version}); err != nil {
		t.Fatalf("ValidateHello() error = %v", err)
	}
	err := ValidateHello(Hello{Protocol: Version + 1})
	if !errors.Is(err, ErrVersionMismatch) || !strings.Contains(err.Error(), "client=") {
		t.Fatalf("ValidateHello() error = %v, want version mismatch with detail", err)
	}
}

func TestValidateRequest(t *testing.T) {
	t.Parallel()

	if err := ValidateRequest(Request{ID: 1, Method: "pane.write"}); err != nil {
		t.Fatalf("ValidateRequest() error = %v", err)
	}
	for _, request := range []Request{{Method: "pane.write"}, {ID: 1}} {
		if err := ValidateRequest(request); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("ValidateRequest(%+v) error = %v, want invalid request", request, err)
		}
	}
}
