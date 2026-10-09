package daemon

import "sync"

// MaxOutputChunkBytes keeps every producer chunk comfortably below the wire
// frame cap. A poll response is separately bounded, so a noisy PTY can never
// turn one read into an un-sendable MessagePack frame.
const MaxOutputChunkBytes = 1 << 20

// Output is a byte-exact chunk from the PTY live path.
type Output struct {
	Sequence uint64 `msgpack:"sequence"`
	Data     []byte `msgpack:"data"`
}

// Seed is delivered before any Output at or after ResumeSequence.
type Seed struct {
	Data []byte `msgpack:"data"`
	// Graphics is a live-daemon, renderer-specific rehydration seed. It is
	// deliberately not persisted or included in handoff snapshots.
	Graphics       []byte `msgpack:"graphics,omitempty"`
	ResumeSequence uint64 `msgpack:"resume_sequence"`
}

// Stream serializes PTY output with attach seed generation. Its lock establishes
// the barrier: output observed after Snapshot returns has a sequence no lower than
// ResumeSequence, so it cannot be duplicated into the seed's live tail.
type Stream struct {
	mu       sync.Mutex
	sequence uint64
	outputs  []Output
}

func (stream *Stream) Append(data []byte) []Output {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if len(data) == 0 {
		return nil
	}
	outputs := make([]Output, 0, (len(data)+MaxOutputChunkBytes-1)/MaxOutputChunkBytes)
	for len(data) > 0 {
		size := min(len(data), MaxOutputChunkBytes)
		stream.sequence++
		output := Output{Sequence: stream.sequence, Data: append([]byte(nil), data[:size]...)}
		stream.outputs = append(stream.outputs, output)
		outputs = append(outputs, output)
		data = data[size:]
	}
	return outputs
}

// OutputsFrom returns copies of every raw PTY chunk at or after sequence. M1A
// retains this small in-memory fixture stream solely to prove the seed barrier;
// bounded streaming and flow control are a later package.
func (stream *Stream) OutputsFrom(sequence uint64) []Output {
	return stream.OutputsFromBounded(sequence, 0)
}

// OutputsFromBounded returns ordered output chunks up to maximumBytes. A zero
// limit is reserved for in-process callers such as tests; protocol responses
// always provide a finite limit.
func (stream *Stream) OutputsFromBounded(sequence uint64, maximumBytes int) []Output {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	start := len(stream.outputs)
	for index, output := range stream.outputs {
		if output.Sequence >= sequence {
			start = index
			break
		}
	}
	outputs := make([]Output, 0, len(stream.outputs)-start)
	bytes := 0
	for _, output := range stream.outputs[start:] {
		if maximumBytes > 0 && len(outputs) > 0 && bytes+len(output.Data) > maximumBytes {
			break
		}
		outputs = append(outputs, Output{
			Sequence: output.Sequence,
			Data:     append([]byte(nil), output.Data...),
		})
		bytes += len(output.Data)
	}
	return outputs
}

// Snapshot runs build while output sequencing is held, then returns the exact
// sequence at which clients must resume live delivery.
func (stream *Stream) Snapshot(build func() ([]byte, error)) (Seed, error) {
	return stream.SnapshotWithGraphics(func() ([]byte, []byte, error) {
		data, err := build()
		return data, nil, err
	})
}

// SnapshotWithGraphics captures text and live graphics under the same output
// barrier. Raw PTY data assigned at ResumeSequence is therefore always newer
// than both seeds.
func (stream *Stream) SnapshotWithGraphics(build func() ([]byte, []byte, error)) (Seed, error) {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	data, graphics, err := build()
	if err != nil {
		return Seed{}, err
	}
	return Seed{Data: data, Graphics: graphics, ResumeSequence: stream.sequence + 1}, nil
}
