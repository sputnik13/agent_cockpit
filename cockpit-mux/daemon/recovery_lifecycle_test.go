//go:build libghostty

package daemon

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

const (
	daemonDeathWriterEnv  = "COCKPIT_MUX_TEST_DAEMON_DEATH_WRITER"
	daemonDeathHomeEnv    = "COCKPIT_MUX_TEST_DAEMON_DEATH_HOME"
	daemonDeathReadyEnv   = "COCKPIT_MUX_TEST_DAEMON_DEATH_READY"
	daemonDeathPayloadEnv = "COCKPIT_MUX_TEST_DAEMON_DEATH_PAYLOAD"
)

func onlyRecoveredCatalogItem(t *testing.T, operations *Operations) SessionListItem {
	t.Helper()
	listedData := requestOperation(t, operations, 99, methodSessionList, struct{}{})
	var listed ListSessionsResponse
	decodeResponse(t, listedData, &listed)
	if len(listed.Sessions) != 1 {
		t.Fatalf("recovered catalog inventory = %#v, want one session", listed.Sessions)
	}
	return listed.Sessions[0]
}

func TestDaemonDeathRecoveryWriter(t *testing.T) {
	if os.Getenv(daemonDeathWriterEnv) != "1" {
		return
	}
	home, err := OpenHome(os.Getenv(daemonDeathHomeEnv))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte(os.Getenv(daemonDeathPayloadEnv))
	operations := NewPersistentOperations(home)
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "printf '" + string(payload) + "'; sleep 30"},
	})
	var create CreateSessionResponse
	decodeResponse(t, created, &create)
	if output := readSessionUntil(t, operations, create.SessionID, []byte("alternate")); !bytes.Contains(output, []byte("alternate")) {
		t.Fatalf("writer output = %q, want alternate payload", output)
	}
	operations.mu.Lock()
	attachment, ok := operations.session.attachment.(*shadowAttachment)
	operations.mu.Unlock()
	if !ok {
		t.Fatal("persistent writer did not create a native attachment")
	}
	if err := attachment.recorder.Flush(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv(daemonDeathReadyEnv), []byte("ready"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(os.Getpid(), syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
}

func TestPersistentOperationsRecoversCommittedTailAfterDaemonSIGKILL(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("\x1b[1;1Hprimary\x1b[?1049h\x1b[32m\x1b[2;1Halternate\x1b7\x1b[?2004h\x1b]2;tail-recovery-title\a")
	ready := filepath.Join(home.Path, "writer-ready")
	command := exec.Command(os.Args[0], "-test.run=^TestDaemonDeathRecoveryWriter$")
	command.Env = append(os.Environ(), daemonDeathWriterEnv+"=1", daemonDeathHomeEnv+"="+home.Path,
		daemonDeathReadyEnv+"="+ready, daemonDeathPayloadEnv+"="+string(payload))
	if err := command.Run(); err == nil {
		t.Fatal("daemon-death writer exited without SIGKILL")
	} else if _, ok := err.(*exec.ExitError); !ok {
		t.Fatalf("run daemon-death writer: %v", err)
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatalf("daemon-death writer did not commit its tail before SIGKILL: %v", err)
	}

	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(filepath.Join(home.Path, "state.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	_, tail, loadErr := store.Load(version)
	if closeErr := store.Close(); closeErr != nil && loadErr == nil {
		loadErr = closeErr
	}
	if loadErr != nil {
		t.Fatal(loadErr)
	}
	if len(tail) == 0 {
		t.Fatal("SIGKILL recovery record has no committed tail to replay")
	}

	recovered := NewPersistentOperations(home)
	recoveredItem := onlyRecoveredCatalogItem(t, recovered)
	attached := requestOperation(t, recovered, 1, methodSessionAttach, AttachSessionRequest{
		SessionID: recoveredItem.SessionID, Cols: 100, Rows: 32,
	})
	var attach AttachSessionResponse
	decodeResponse(t, attached, &attach)
	consumer, err := NewShadow(100, 32)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	consumer.Feed(attach.Seed)
	expected, err := NewShadow(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer expected.Close()
	expected.Feed(payload)
	if err := expected.Resize(100, 32); err != nil {
		t.Fatal(err)
	}
	assertSameShadowSeed(t, consumer, expected, "SIGKILL recovery seed")

	activeRestore := []byte("\x1b8\x1b[3;1Hactive-restored")
	consumer.Feed(activeRestore)
	expected.Feed(activeRestore)
	assertSameShadowSeed(t, consumer, expected, "active DECRC after SIGKILL recovery")
	primaryRestore := []byte("\x1b[?1049l\x1b[2;1Hprimary-restored")
	consumer.Feed(primaryRestore)
	expected.Feed(primaryRestore)
	assertSameShadowSeed(t, consumer, expected, "primary screen after SIGKILL recovery")
	requestOperation(t, recovered, 2, methodSessionDestroy, DestroySessionRequest{SessionID: recoveredItem.SessionID})
}

func TestPersistentOperationsDaemonShutdownReapsTerminatedPane(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	payload := []byte("\x1b[1;1Hprimary\x1b[?1049h\x1b[32m\x1b[2;1Halternate\x1b7\x1b[?2004h\x1b]2;recovery-title\a")
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf '" + string(payload) + "'; sleep 30"},
	})
	var create CreateSessionResponse
	decodeResponse(t, created, &create)
	if output := readSessionUntil(t, operations, create.SessionID, []byte("alternate")); !bytes.Contains(output, []byte("alternate")) {
		t.Fatalf("live output = %q, want alternate payload", output)
	}

	if err := operations.Close(); err != nil {
		t.Fatalf("clean operations shutdown: %v", err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	listed := requestOperation(t, recovered, 2, methodSessionList, struct{}{})
	var sessions ListSessionsResponse
	decodeResponse(t, listed, &sessions)
	if len(sessions.Sessions) != 0 {
		t.Fatalf("daemon shutdown restored terminated sessions: %#v", sessions.Sessions)
	}
}

func TestPersistentOperationsDaemonShutdownReapsScrollback(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	payload := strings.Repeat("recovery-history\n", 30)
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "printf '" + payload + "'; sleep 30"},
	})
	var create CreateSessionResponse
	decodeResponse(t, created, &create)
	if output := readSessionUntil(t, operations, create.SessionID, []byte("recovery-history")); !bytes.Contains(output, []byte("recovery-history")) {
		t.Fatalf("live output = %q, want history payload", output)
	}
	if err := operations.Close(); err != nil {
		t.Fatalf("clean operations shutdown: %v", err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	listed := requestOperation(t, recovered, 2, methodSessionList, struct{}{})
	var sessions ListSessionsResponse
	decodeResponse(t, listed, &sessions)
	if len(sessions.Sessions) != 0 {
		t.Fatalf("daemon shutdown retained terminated sessions: %#v", sessions.Sessions)
	}
}

func TestPersistentOperationsDaemonShutdownFinalizesBeforeReapingCatalog(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	first := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "printf first-catalog; sleep 30"}})
	var firstCreated CreateSessionResponse
	decodeResponse(t, first, &firstCreated)
	second := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{PaneID: firstCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "printf second-catalog; sleep 30"}})
	var secondCreated CreateSessionResponse
	decodeResponse(t, second, &secondCreated)
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("first-catalog")); !bytes.Contains(output, []byte("first-catalog")) {
		t.Fatalf("first output = %q", output)
	}
	if output := readSessionUntil(t, operations, secondCreated.SessionID, []byte("second-catalog")); !bytes.Contains(output, []byte("second-catalog")) {
		t.Fatalf("second output = %q", output)
	}
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}
	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	listed := requestOperation(t, recovered, 3, methodSessionList, struct{}{})
	var list ListSessionsResponse
	decodeResponse(t, listed, &list)
	if len(list.Sessions) != 0 {
		t.Fatalf("daemon shutdown retained terminated catalog panes: %#v", list.Sessions)
	}
}

func TestPersistentOperationsDaemonShutdownDropsLiveTopology(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	operations.nextWindow = 8
	root := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "printf root-topology; sleep 30"}, Key: "root",
	})
	var rootCreated CreateSessionResponse
	decodeResponse(t, root, &rootCreated)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: rootCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "printf split-topology; sleep 30"}, Key: "split", Direction: "vertical", Ratio: 0.3,
	})
	var splitCreated CreateSessionResponse
	decodeResponse(t, split, &splitCreated)
	window := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: rootCreated.SessionID, Command: "/bin/sh", Args: []string{"-c", "printf window-topology; sleep 30"}, Key: "window",
	})
	var windowCreated CreateSessionResponse
	decodeResponse(t, window, &windowCreated)
	thirdWindow := requestOperation(t, operations, 4, methodWindowNew, NewWindowRequest{
		SessionID: rootCreated.SessionID, Command: "/bin/sh", Args: []string{"-c", "printf third-window-topology; sleep 30"}, Key: "third-window",
	})
	var thirdWindowCreated CreateSessionResponse
	decodeResponse(t, thirdWindow, &thirdWindowCreated)
	rootRecord, err := operations.requireSession(rootCreated.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	requestOperation(t, operations, 5, methodWindowSelect, SelectWindowRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID,
	})
	requestOperation(t, operations, 6, methodPaneSelect, SelectPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID,
	})
	requestOperation(t, operations, 7, methodPaneZoom, ZoomPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID,
	})
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	response := requestOperation(t, recovered, 8, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, response, &topology)
	if len(topology.Sessions) != 0 {
		t.Fatalf("daemon shutdown restored terminated topology: %#v", topology.Sessions)
	}
	if windowCreated.SessionID == splitCreated.SessionID || thirdWindowCreated.SessionID == windowCreated.SessionID {
		t.Fatal("new window did not retain an independent pane record")
	}
}

func TestPersistentOperationsDaemonShutdownReapsProjectScopedSession(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	createdData, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "project-scope-recovery",
	}))
	if err != nil {
		t.Fatal(err)
	}
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	for projectID := range map[string]struct{}{"project-a": {}, "project-b": {}, "standalone": {}} {
		listedData, err := recovered.Handle(context.Background(), scopedOperationRequest(t, projectID, 10, methodSessionList, struct{}{}))
		if err != nil {
			t.Fatal(err)
		}
		var listed ListSessionsResponse
		decodeResponse(t, listedData, &listed)
		if len(listed.Sessions) != 0 {
			t.Fatalf("daemon shutdown retained %s inventory = %#v", projectID, listed.Sessions)
		}
	}
	if _, err := recovered.Handle(context.Background(), scopedOperationRequest(t, "project-a", 4, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("destroy after daemon shutdown error = %v, want ErrSessionNotFound", err)
	}
}

func TestPersistentOperationsDaemonShutdownReapsFallbackSessions(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	create := func(id uint64, key string) CreateSessionResponse {
		data, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", id, methodSessionCreate, CreateSessionRequest{
			Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: key,
		}))
		if err != nil {
			t.Fatal(err)
		}
		var created CreateSessionResponse
		decodeResponse(t, data, &created)
		return created
	}
	first := create(1, "first")
	second := create(2, "second")
	_ = create(3, "third")
	secondRecord, err := operations.requireSession(second.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 4, methodWindowSelect, SelectWindowRequest{SessionID: second.SessionID, WindowID: secondRecord.windowID})); err != nil {
		t.Fatal(err)
	}
	if _, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 5, methodSessionDestroy, DestroySessionRequest{SessionID: second.SessionID})); err != nil {
		t.Fatal(err)
	}
	selectedData, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 6, methodSessionTopology, struct{}{}))
	if err != nil {
		t.Fatal(err)
	}
	var selected TopologyResponse
	decodeResponse(t, selectedData, &selected)
	if selected.ActiveSessionID != first.SessionID {
		t.Fatalf("selected fallback = %q, want stable first survivor %q", selected.ActiveSessionID, first.SessionID)
	}
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	recoveredData, err := recovered.Handle(context.Background(), scopedOperationRequest(t, "project-a", 7, methodSessionTopology, struct{}{}))
	if err != nil {
		t.Fatal(err)
	}
	var topology TopologyResponse
	decodeResponse(t, recoveredData, &topology)
	if topology.ActiveSessionID != "" || len(topology.Sessions) != 0 {
		t.Fatalf("daemon shutdown retained fallback topology = %#v", topology)
	}
}

func TestPersistentOperationsReapsNaturalPaneExitFromDisk(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/usr/bin/true", Key: "natural-exit"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	deadline := time.Now().Add(3 * time.Second)
	for {
		listedData := requestOperation(t, operations, 2, methodSessionList, struct{}{})
		var listed ListSessionsResponse
		decodeResponse(t, listedData, &listed)
		if len(listed.Sessions) == 1 && listed.Sessions[0].Exited {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("naturally exited pane still live: %#v", listed.Sessions)
		}
		time.Sleep(20 * time.Millisecond)
	}
	requestOperation(t, operations, 3, methodMuxShutdown, struct{}{})
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := persistence.Open(filepath.Join(home.Path, "state.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	evicted, err := store.Evict(time.Now().AddDate(0, 0, persistence.DefaultRetentionDays+1), persistence.DefaultRetentionDays, persistence.DefaultDatabaseCap)
	if err != nil {
		t.Fatal(err)
	}
	if len(evicted) != 0 {
		t.Fatalf("naturally exited session remained on disk until retention eviction: %#v", evicted)
	}
}

func TestPersistentOperationsDaemonShutdownReusesReapedIdentities(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	firstData, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "original"}))
	if err != nil {
		t.Fatal(err)
	}
	var first CreateSessionResponse
	decodeResponse(t, firstData, &first)
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	secondData, err := recovered.Handle(context.Background(), scopedOperationRequest(t, "project-b", 2, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "new"}))
	if err != nil {
		t.Fatal(err)
	}
	var second CreateSessionResponse
	decodeResponse(t, secondData, &second)
	if second.SessionID != "session-1" || second.PaneID != "pane-1" {
		t.Fatalf("new identity after daemon state was reaped = %+v, want a fresh catalog identity", second)
	}
	for projectID, want := range map[string]int{"project-a": 0, "project-b": 1} {
		listedData, err := recovered.Handle(context.Background(), scopedOperationRequest(t, projectID, 3, methodSessionList, struct{}{}))
		if err != nil {
			t.Fatal(err)
		}
		var listed ListSessionsResponse
		decodeResponse(t, listedData, &listed)
		if len(listed.Sessions) != want {
			t.Fatalf("%s inventory after create = %#v", projectID, listed.Sessions)
		}
	}
	if _, err := recovered.Handle(context.Background(), scopedOperationRequest(t, "project-b", 5, methodSessionDestroy, DestroySessionRequest{SessionID: second.SessionID})); err != nil {
		t.Fatalf("destroy fresh session after daemon restart: %v", err)
	}
}

func TestPersistentOperationsDaemonShutdownMakesPrimaryUnavailable(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}
	recovered := NewPersistentOperations(home)
	if _, err := recovered.Handle(context.Background(), operationRequest(t, 2, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})); !errors.Is(err, ErrSessionNotFound) {
		_ = recovered.Close()
		t.Fatalf("destroy after daemon shutdown error = %v, want ErrSessionNotFound", err)
	}
	if err := recovered.Close(); err != nil {
		t.Fatal(err)
	}
	final := NewPersistentOperations(home)
	defer final.Close()
	listedData := requestOperation(t, final, 3, methodSessionList, struct{}{})
	var listed ListSessionsResponse
	decodeResponse(t, listedData, &listed)
	if len(listed.Sessions) != 0 {
		t.Fatalf("destroyed recovered primary resurrected: %#v", listed.Sessions)
	}
}

func TestPersistentOperationsRejectsDiagnosticRecoveryRecords(t *testing.T) {
	for name, scenario := range map[string]struct {
		engineVersion string
		boundary      string
		want          string
	}{
		"forced":       {engineVersion: "current", boundary: "forced", want: "forced-boundary"},
		"incompatible": {engineVersion: "incompatible", boundary: "grounded", want: "incompatible mux snapshot engine"},
	} {
		t.Run(name, func(t *testing.T) {
			home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
			if err != nil {
				t.Fatal(err)
			}
			version, err := EngineVersion()
			if err != nil {
				t.Fatal(err)
			}
			engineVersion := scenario.engineVersion
			if engineVersion == "current" {
				engineVersion = version
			}
			shadow, err := NewShadow(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer shadow.Close()
			primary, err := NewShadow(80, 24)
			if err != nil {
				t.Fatal(err)
			}
			defer primary.Close()
			snapshot, err := shadow.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			primarySnapshot, err := primary.Snapshot()
			if err != nil {
				t.Fatal(err)
			}
			metadata, err := marshalRecoveryMetadata(ModeState{}, false, 80, 24)
			if err != nil {
				t.Fatal(err)
			}
			store, err := persistence.Open(filepath.Join(home.Path, "state.db"), persistence.DefaultTailCap*4)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.SaveKeyframe(persistence.Keyframe{EngineVersion: engineVersion, Boundary: scenario.boundary, Snapshot: snapshot, PrimarySnapshot: primarySnapshot, Metadata: metadata}); err != nil {
				store.Close()
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}

			operations := NewPersistentOperations(home)
			_, err = operations.Handle(context.Background(), operationRequest(t, 1, methodSessionAttach, AttachSessionRequest{SessionID: "recovered-session", Cols: 80, Rows: 24}))
			if err == nil || !strings.Contains(err.Error(), scenario.want) {
				t.Fatalf("diagnostic attach error = %v, want %q", err, scenario.want)
			}
			_, err = operations.Handle(context.Background(), operationRequest(t, 2, methodSessionCreate, CreateSessionRequest{Command: "/bin/true"}))
			if !errors.Is(err, ErrRecoveryConflict) {
				t.Fatalf("diagnostic record allowed overwrite: %v", err)
			}
			requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: "recovered-session"})
		})
	}
}

func TestPersistentOperationsDaemonShutdownFinalizesAndReapsCatalogKeyframes(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "printf catalog-recovery; sleep 30"}, Key: "catalog-recovery",
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: session.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"},
	})
	var sibling CreateSessionResponse
	decodeResponse(t, split, &sibling)
	if sibling.SessionID == session.SessionID || sibling.PaneID == session.PaneID {
		t.Fatal("split did not create an independent pane record")
	}
	if err := operations.Close(); err != nil {
		t.Fatal(err)
	}

	recovered := NewPersistentOperations(home)
	defer recovered.Close()
	listed := requestOperation(t, recovered, 3, methodSessionList, struct{}{})
	var sessions ListSessionsResponse
	decodeResponse(t, listed, &sessions)
	if len(sessions.Sessions) != 0 {
		t.Fatalf("daemon shutdown retained terminated catalog keyframes: %#v", sessions.Sessions)
	}
}

func assertSameShadowSeed(t *testing.T, got, want *Shadow, phase string) {
	t.Helper()
	gotSeed, err := got.Seed()
	if err != nil {
		t.Fatal(err)
	}
	wantSeed, err := want.Seed()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotSeed, wantSeed) {
		t.Fatalf("%s differs from authoritative state\n got: %q\nwant: %q", phase, gotSeed, wantSeed)
	}
}
