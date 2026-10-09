package daemon

import (
	"bytes"
	"testing"
)

func TestSnapshotBarrierSeparatesSeedFromLaterLiveOutput(t *testing.T) {
	stream := new(Stream)
	first := stream.Append([]byte("before"))[0]
	if first.Sequence != 1 {
		t.Fatalf("first sequence = %d, want 1", first.Sequence)
	}

	seed, err := stream.Snapshot(func() ([]byte, error) { return []byte("seed"), nil })
	if err != nil {
		t.Fatalf("Snapshot() error = %v", err)
	}
	if seed.ResumeSequence != 2 {
		t.Fatalf("resume sequence = %d, want 2", seed.ResumeSequence)
	}

	live := stream.Append([]byte{0x00, 0xff})[0]
	if live.Sequence != seed.ResumeSequence {
		t.Fatalf("live sequence = %d, want resume sequence %d", live.Sequence, seed.ResumeSequence)
	}
	if !bytes.Equal(live.Data, []byte{0x00, 0xff}) {
		t.Fatalf("live data = %x, want 00ff", live.Data)
	}
}

func TestOutputsFromReturnsBarrierAndLaterChunksWithoutAliasing(t *testing.T) {
	stream := new(Stream)
	stream.Append([]byte("before"))
	seed, err := stream.Snapshot(func() ([]byte, error) { return []byte("seed"), nil })
	if err != nil {
		t.Fatal(err)
	}
	stream.Append([]byte{0x00, 0xff})
	stream.Append([]byte("after"))

	outputs := stream.OutputsFrom(seed.ResumeSequence)
	if len(outputs) != 2 {
		t.Fatalf("outputs = %#v, want two post-barrier chunks", outputs)
	}
	if outputs[0].Sequence != seed.ResumeSequence || !bytes.Equal(outputs[0].Data, []byte{0x00, 0xff}) {
		t.Fatalf("first post-barrier output = %#v", outputs[0])
	}
	outputs[0].Data[0] = 0x7f
	again := stream.OutputsFrom(seed.ResumeSequence)
	if !bytes.Equal(again[0].Data, []byte{0x00, 0xff}) {
		t.Fatalf("stored output was aliased by caller: %x", again[0].Data)
	}
}

func TestSnapshotBarrierQueuesOutputProducedDuringSeed(t *testing.T) {
	stream := new(Stream)
	started := make(chan struct{})
	release := make(chan struct{})
	seedDone := make(chan Seed, 1)
	go func() {
		seed, err := stream.Snapshot(func() ([]byte, error) {
			close(started)
			<-release
			return []byte("seed"), nil
		})
		if err != nil {
			t.Errorf("Snapshot() error = %v", err)
		}
		seedDone <- seed
	}()
	<-started
	appended := make(chan Output, 1)
	go func() { appended <- stream.Append([]byte("during-seed"))[0] }()
	select {
	case output := <-appended:
		t.Fatalf("output escaped seed barrier: %#v", output)
	default:
	}
	close(release)
	seed := <-seedDone
	output := <-appended
	if output.Sequence != seed.ResumeSequence {
		t.Fatalf("during-seed output sequence = %d, resume sequence = %d", output.Sequence, seed.ResumeSequence)
	}
	outputs := stream.OutputsFrom(seed.ResumeSequence)
	if len(outputs) != 1 || !bytes.Equal(outputs[0].Data, []byte("during-seed")) {
		t.Fatalf("post-barrier outputs = %#v", outputs)
	}
}

func TestAppendSplitsLargeProducerOutputIntoOneMiBChunks(t *testing.T) {
	stream := new(Stream)
	data := bytes.Repeat([]byte{'x'}, MaxOutputChunkBytes*2+17)
	outputs := stream.Append(data)
	if len(outputs) != 3 {
		t.Fatalf("chunk count = %d, want 3", len(outputs))
	}
	for index, output := range outputs {
		if output.Sequence != uint64(index+1) {
			t.Fatalf("chunk %d sequence = %d", index, output.Sequence)
		}
		if index < 2 && len(output.Data) != MaxOutputChunkBytes {
			t.Fatalf("chunk %d bytes = %d, want %d", index, len(output.Data), MaxOutputChunkBytes)
		}
	}
	if got := len(outputs[2].Data); got != 17 {
		t.Fatalf("last chunk bytes = %d, want 17", got)
	}

	bounded := stream.OutputsFromBounded(1, MaxOutputChunkBytes)
	if len(bounded) != 1 || len(bounded[0].Data) != MaxOutputChunkBytes {
		t.Fatalf("bounded response = %#v, want one one-MiB chunk", bounded)
	}
}
