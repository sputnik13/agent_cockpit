//go:build libghostty

package daemon

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

const (
	crashWriterEnv  = "COCKPIT_MUX_TEST_CRASH_WRITER"
	crashPathEnv    = "COCKPIT_MUX_TEST_CRASH_PATH"
	crashReadyEnv   = "COCKPIT_MUX_TEST_CRASH_READY"
	crashTailPrefix = "committed-before-kill"
)

func TestRecorderUsesGroundedAndForcedKeyframes(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(1, []byte("abcd")); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if keyframe.Boundary != "grounded" || len(tail) != 0 {
		t.Fatalf("grounded cap keyframe = %#v tail=%q", keyframe, tail)
	}
	if err := recorder.Record(2, []byte("\x1b]unterminated")); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(3, []byte("more")); err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err = store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if keyframe.Boundary != "forced" || len(tail) != 0 {
		t.Fatalf("forced cap keyframe = %#v tail=%q", keyframe, tail)
	}
}

func TestRecorderPrefersGroundedBoundaryAtHardCeiling(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(1, []byte("\x1b]1234567890")); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(2, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(3, []byte("\a")); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, _, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if keyframe.Boundary != "grounded" {
		t.Fatalf("boundary = %q, want grounded", keyframe.Boundary)
	}
}

func TestRecorderFlushDefinesCrashRecoveryBoundary(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	path := filepath.Join(t.TempDir(), "mux.db")
	store, err := persistence.Open(path, 64)
	if err != nil {
		t.Fatal(err)
	}
	recorder, err := NewRecorder(store, shadow, 128)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(1, []byte("committed")); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(2, []byte("-not-durable")); err != nil {
		t.Fatal(err)
	}
	// Simulate a daemon death between tail-batch commits: the recorder's pending
	// bytes vanish with memory, while SQLite closes and a new process opens the
	// committed WAL state.
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	recoveredStore, err := persistence.Open(path, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer recoveredStore.Close()
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := recoveredStore.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if got := bytes.Join(tail, nil); !bytes.Equal(got, []byte("committed")) {
		t.Fatalf("durable tail = %q, want committed boundary", got)
	}
	recovered, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	for _, chunk := range tail {
		recovered.Feed(chunk)
	}
	want, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer want.Close()
	want.Feed([]byte("committed"))
	gotSeed, err := recovered.Seed()
	if err != nil {
		t.Fatal(err)
	}
	wantSeed, err := want.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotSeed, wantSeed) {
		t.Fatal("recovery included data recorded after the committed boundary")
	}
}

func TestRecorderCrashWriterHelper(t *testing.T) {
	if os.Getenv(crashWriterEnv) != "1" {
		return
	}
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(os.Getenv(crashPathEnv), 64)
	if err != nil {
		t.Fatal(err)
	}
	recorder, err := NewRecorder(store, shadow, 128)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(1, []byte(crashTailPrefix)); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(2, []byte("-lost-with-process")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv(crashReadyEnv), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
}

func TestRecorderRecoversAfterWriterIsKilledBetweenBatches(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "mux.db")
	ready := filepath.Join(root, "writer-ready")
	command := exec.Command(os.Args[0], "-test.run=^TestRecorderCrashWriterHelper$")
	command.Env = append(os.Environ(), crashWriterEnv+"=1", crashPathEnv+"="+path, crashReadyEnv+"="+ready)
	if err := command.Run(); err == nil {
		t.Fatal("crash writer exited without SIGKILL")
	} else if _, ok := err.(*exec.ExitError); !ok {
		t.Fatalf("run crash writer: %v", err)
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatalf("crash writer did not reach the between-batches boundary: %v", err)
	}
	store, err := persistence.Open(path, 64)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if got := bytes.Join(tail, nil); !bytes.Equal(got, []byte(crashTailPrefix)) {
		t.Fatalf("tail after killed writer = %q, want committed batch only", got)
	}
	recovered, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	for _, batch := range tail {
		recovered.Feed(batch)
	}
	want, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer want.Close()
	want.Feed([]byte(crashTailPrefix))
	gotSeed, err := recovered.Seed()
	if err != nil {
		t.Fatal(err)
	}
	wantSeed, err := want.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotSeed, wantSeed) {
		t.Fatal("killed-writer recovery differs from committed control")
	}
}

func TestRecorderFlushesAt64KiBBatchBoundary(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), 2<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 64<<10)
	if err := recorder.Record(1, chunk); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	_, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 1 || !bytes.Equal(tail[0], chunk) {
		t.Fatalf("64 KiB flush tail = %d records / %d bytes", len(tail), len(bytes.Join(tail, nil)))
	}
}

func TestRecorderBoundsTailDuringAlternateScreenFlood(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	const capBytes = 64
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), capBytes*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, capBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Record(1, []byte("\x1b[?1049h")); err != nil {
		t.Fatal(err)
	}
	// The production risk is an alternate-screen program that never emits a
	// newline. Exercise the proposal's 100 MiB acceptance volume in 64 KiB
	// PTY-sized chunks, rather than proving the bound only on a tiny fixture.
	const floodBytes = 100 << 20
	flood := bytes.Repeat([]byte("a"), 64<<10)
	for sequence, recorded := uint64(2), 0; recorded < floodBytes; sequence, recorded = sequence+1, recorded+len(flood) {
		if err := recorder.Record(sequence, flood); err != nil {
			t.Fatalf("alternate-screen flood record %d: %v", sequence, err)
		}
	}
	if err := recorder.Flush(); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if keyframe.Boundary != "grounded" {
		t.Fatalf("alternate flood boundary = %q, want grounded", keyframe.Boundary)
	}
	if tailBytes := len(bytes.Join(tail, nil)); tailBytes >= capBytes {
		t.Fatalf("alternate-screen tail grew to %d bytes, cap is %d", tailBytes, capBytes)
	}
	recovered, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	for _, batch := range tail {
		recovered.Feed(batch)
	}
	got, err := recovered.Seed()
	if err != nil {
		t.Fatal(err)
	}
	want, err := shadow.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatal("alternate-screen flood recovery differs from authoritative shadow")
	}
}

func TestRecorderForcesKeyframePastKittyGraphicsAPCCeiling(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, persistence.DefaultTailCap)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	// A Kitty graphics transmission is an APC string (`ESC _ G … ESC \\`).
	// Deliberately omit the terminator, then exceed the hard continuation ceiling
	// to verify that persistence cannot grow without bound waiting for a parser
	// ground state.
	if err := recorder.Record(1, []byte("\x1b_Ga=T,f=24;")); err != nil {
		t.Fatal(err)
	}
	chunk := bytes.Repeat([]byte("x"), 32<<10)
	for sequence := uint64(2); sequence <= 130; sequence++ {
		if err := recorder.Record(sequence, chunk); err != nil {
			t.Fatalf("record at sequence %d: %v", sequence, err)
		}
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if keyframe.Boundary != "forced" || len(tail) != 0 {
		t.Fatalf("forced keyframe = %#v tail records=%d", keyframe, len(tail))
	}
	restored, err := RestoreShadow(keyframe.Snapshot)
	if err != nil {
		t.Fatalf("forced snapshot did not restore: %v", err)
	}
	defer restored.Close()
	restored.Feed([]byte("\a"))
	if _, err := restored.Seed(); err != nil {
		t.Fatalf("restored forced snapshot cannot format: %v", err)
	}
}

func TestRecorderWithoutScrollbackPersistsOnlyBlankKeyframes(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorderWithPersistence(store, shadow, persistence.DefaultTailCap, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	secret := []byte("sensitive-terminal-content")
	shadow.Feed(secret)
	if err := recorder.RecordFed(1, secret); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Finalize(); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("scrollback-disabled tail = %q, want no rows", tail)
	}
	if bytes.Contains(keyframe.Snapshot, secret) || bytes.Contains(keyframe.Metadata, secret) {
		t.Fatal("scrollback-disabled keyframe retained terminal content")
	}
}

func TestRecorderDisablingScrollbackErasesPreviouslyPersistedContent(t *testing.T) {
	shadow, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer shadow.Close()
	store, err := persistence.Open(filepath.Join(t.TempDir(), "mux.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recorder, err := NewRecorder(store, shadow, persistence.DefaultTailCap)
	if err != nil {
		t.Fatal(err)
	}
	if err := recorder.Initialize(); err != nil {
		t.Fatal(err)
	}
	secret := []byte("secret-before-privacy-toggle")
	if err := recorder.Record(1, secret); err != nil {
		t.Fatal(err)
	}
	if err := recorder.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := recorder.SetPersistScrollback(false); err != nil {
		t.Fatal(err)
	}
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load(version)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("privacy toggle retained tail = %q", tail)
	}
	if bytes.Contains(keyframe.Snapshot, secret) || bytes.Contains(keyframe.Metadata, secret) {
		t.Fatal("privacy toggle retained earlier terminal content")
	}
}
