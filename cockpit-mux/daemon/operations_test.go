package daemon

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

func TestOperationsRetainsPaneAfterClientDisconnect(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "while IFS= read -r line; do printf 'reply:%s\\n' \"$line\"; done"},
	})
	var create CreateSessionResponse
	decodeResponse(t, created, &create)

	// A client connection is intentionally not represented in Operations. The second
	// request simulates a reconnect and must target the same daemon-owned PTY.
	written := requestOperation(t, operations, 2, methodPaneWrite, WritePaneRequest{
		PaneID: create.PaneID,
		Data:   []byte("after-disconnect\n"),
	})
	var write WritePaneResponse
	decodeResponse(t, written, &write)
	if write.Written != len("after-disconnect\n") {
		t.Fatalf("written = %d, want %d", write.Written, len("after-disconnect\n"))
	}

	output := readSessionUntil(t, operations, create.SessionID, []byte("reply:after-disconnect"))
	if !bytes.Contains(output, []byte("reply:after-disconnect")) {
		t.Fatalf("pane output = %q, want reply from retained pane", output)
	}

	attached := requestOperation(t, operations, 3, methodSessionAttach, AttachSessionRequest{
		SessionID: create.SessionID,
		Cols:      100,
		Rows:      32,
	})
	var attach AttachSessionResponse
	decodeResponse(t, attached, &attach)
	if attach.SessionID != create.SessionID || attach.PaneID != create.PaneID {
		t.Fatalf("attach = %+v, want stable session and pane identity", attach)
	}

	requestOperation(t, operations, 4, methodSessionDestroy, DestroySessionRequest{SessionID: create.SessionID})
}

func TestDirectGraphicsFeatureRequiresExplicitRendererCapability(t *testing.T) {
	if supportsDirectGraphics(nil) {
		t.Fatal("absent renderer features must not receive a graphics seed")
	}
	if supportsDirectGraphics([]string{"some_future_feature"}) {
		t.Fatal("unknown renderer feature must not receive a graphics seed")
	}
	if !supportsDirectGraphics([]string{"some_future_feature", "direct_graphics_v1"}) {
		t.Fatal("WTerm direct graphics capability must opt into a graphics seed")
	}
}

func TestOperationsAttachSendsLiveGraphicsOnlyToNegotiatedWTerm(t *testing.T) {
	operations := NewOperations()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf '\\033[2;3H\\033_Ga=T,f=32,s=1,v=1,i=93,q=2;/wAA/w==\\033\\\\'; sleep 2"},
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	if output := readSessionUntil(t, operations, created.SessionID, []byte("i=93")); !bytes.Contains(output, []byte("i=93")) {
		t.Fatalf("live graphics output = %q, want direct image", output)
	}

	plainData := requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "xterm", ClientKind: "cockpit", Cols: 80, Rows: 24,
	})
	var plain AttachSessionResponse
	decodeResponse(t, plainData, &plain)
	if len(plain.GraphicsSeed) != 0 {
		t.Fatalf("non-WTerm attach received graphics seed %q", plain.GraphicsSeed)
	}

	wtermData := requestOperation(t, operations, 3, methodSessionAttach, AttachSessionRequest{
		SessionID:        created.SessionID,
		ClientID:         "wterm",
		ClientKind:       "cockpit",
		RendererFeatures: []string{"direct_graphics_v1"},
		Cols:             80,
		Rows:             24,
	})
	var wterm AttachSessionResponse
	decodeResponse(t, wtermData, &wterm)
	if !bytes.Contains(wterm.GraphicsSeed, []byte("a=t,f=32,s=1,v=1,i=93,q=2")) {
		t.Fatalf("WTerm attach graphics seed = %q, want retained direct image", wterm.GraphicsSeed)
	}
	requestOperation(t, operations, 4, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})
}

func TestOperationsRejectsNonFiniteSplitRatioBeforeCreatingPane(t *testing.T) {
	operations := NewOperations()
	rootData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	if _, err := operations.Handle(context.Background(), operationRequest(t, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: root.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Ratio: math.NaN(),
	})); err == nil || !strings.Contains(err.Error(), "must be finite") {
		t.Fatalf("non-finite split error = %v", err)
	}
	listed := requestOperation(t, operations, 3, methodSessionList, struct{}{})
	var sessions ListSessionsResponse
	decodeResponse(t, listed, &sessions)
	if len(sessions.Sessions) != 1 {
		t.Fatalf("non-finite split created sessions: %#v", sessions.Sessions)
	}
}

func TestOperationsOutputReportsNormalChildExit(t *testing.T) {
	operations := NewOperations()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "exit 0"}, Key: "exits-normally",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	deadline := time.Now().Add(5 * time.Second)
	for {
		operations.mu.Lock()
		session := operations.sessions[created.SessionID]
		exited := session != nil && session.pane == nil
		operations.mu.Unlock()
		if exited {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child exit was not observed by mux lifecycle")
		}
		time.Sleep(10 * time.Millisecond)
	}
	outputData := requestOperation(t, operations, 2, methodPaneOutput, ReadPaneOutputRequest{
		PaneID: created.PaneID,
	})
	var output ReadPaneOutputResponse
	decodeResponse(t, outputData, &output)
	if !output.Exited {
		t.Fatalf("pane.output = %#v, want exited=true", output)
	}
	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})
}

func TestOperationsNaturalShellExitReapsReparentedPTYHelpers(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()
	helperFile := filepath.Join(t.TempDir(), "helper.pid")
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: bash,
		Args:    []string{"--noprofile", "--norc", "-m", "-c", fmt.Sprintf(`sleep 60 & child=$!; disown; printf '%%s' "$child" > %q; exit`, helperFile)},
		Key:     "natural-shell-exit-with-helper",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	operations.mu.Lock()
	pane := operations.sessions[created.SessionID].pane
	operations.mu.Unlock()
	if pane == nil {
		t.Fatal("created session has no PTY pane")
	}

	deadline := time.Now().Add(3 * time.Second)
	var helperPID int
	for time.Now().Before(deadline) && helperPID == 0 {
		if contents, readErr := os.ReadFile(helperFile); readErr == nil {
			_, _ = fmt.Sscanf(string(contents), "%d", &helperPID)
		}
		if helperPID == 0 {
			time.Sleep(10 * time.Millisecond)
		}
	}
	if helperPID <= 0 {
		t.Fatal("shell did not write its helper PID")
	}

	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		operations.mu.Lock()
		exited := operations.sessions[created.SessionID].pane == nil
		operations.mu.Unlock()
		if exited {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	operations.mu.Lock()
	exited := operations.sessions[created.SessionID].pane == nil
	operations.mu.Unlock()
	if !exited {
		t.Fatal("natural shell exit was not finalized by the mux lifecycle watcher")
	}
	if err := syscall.Kill(helperPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("reparented PTY helper %d survived natural shell exit (kill check: %v)", helperPID, err)
	}
}

func TestOperationsDestroyWindowRemovesEveryPaneAtomically(t *testing.T) {
	operations := NewOperations()
	rootData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	splitData := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: root.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "split",
	})
	var split CreateSessionResponse
	decodeResponse(t, splitData, &split)
	windowData := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: root.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "window",
	})
	var createdWindow CreateSessionResponse
	decodeResponse(t, windowData, &createdWindow)

	operations.mu.Lock()
	windowID := operations.sessions[createdWindow.SessionID].windowID
	operations.mu.Unlock()
	destroyedData := requestOperation(t, operations, 4, methodWindowDestroy, DestroyWindowRequest{
		SessionID: root.SessionID, WindowID: windowID,
	})
	var topology TopologyResponse
	decodeResponse(t, destroyedData, &topology)
	if len(topology.Sessions) != 1 || len(topology.Sessions[0].Windows) != 1 {
		t.Fatalf("topology after window destroy = %#v, want one surviving window", topology)
	}
	if got := topology.Sessions[0].Windows[0].Panes; len(got) != 2 || got[0].PaneID != root.PaneID || got[1].PaneID != split.PaneID {
		t.Fatalf("surviving panes = %#v, want root and split", got)
	}
	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: root.SessionID})
}

func TestOperationsKeepsWindowPlacementIndependentOfWindowIDSort(t *testing.T) {
	operations := NewOperations()
	// Cross the lexical boundary: window-10 sorts before window-9, but a user
	// who creates 9, 10, and 11 expects that creation placement to remain.
	operations.nextWindow = 8
	rootData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	secondData := requestOperation(t, operations, 2, methodWindowNew, NewWindowRequest{
		SessionID: root.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "second",
	})
	var second CreateSessionResponse
	decodeResponse(t, secondData, &second)
	thirdData := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: root.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "third",
	})
	var third CreateSessionResponse
	decodeResponse(t, thirdData, &third)

	topologyData := requestOperation(t, operations, 4, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, topologyData, &topology)
	if len(topology.Sessions) != 1 {
		t.Fatalf("topology sessions = %#v", topology.Sessions)
	}
	if topology.ActiveSessionID != root.SessionID {
		t.Fatalf("topology active session = %q, want %q", topology.ActiveSessionID, root.SessionID)
	}
	assertTopologyWindowOrder(t, topology.Sessions[0], []string{"window-9", "window-10", "window-11"})

	requestOperation(t, operations, 5, methodWindowSelect, SelectWindowRequest{SessionID: root.SessionID, WindowID: "window-10"})
	destroyedData := requestOperation(t, operations, 6, methodWindowDestroy, DestroyWindowRequest{SessionID: root.SessionID, WindowID: "window-10"})
	decodeResponse(t, destroyedData, &topology)
	if len(topology.Sessions) != 1 || topology.Sessions[0].ActiveWindowID != "window-11" {
		t.Fatalf("topology after middle placement close = %#v", topology.Sessions)
	}
	assertTopologyWindowOrder(t, topology.Sessions[0], []string{"window-9", "window-11"})

	destroyedData = requestOperation(t, operations, 7, methodWindowDestroy, DestroyWindowRequest{SessionID: root.SessionID, WindowID: "window-11"})
	decodeResponse(t, destroyedData, &topology)
	if len(topology.Sessions) != 1 || topology.Sessions[0].ActiveWindowID != "window-9" {
		t.Fatalf("topology after final placement close = %#v", topology.Sessions)
	}
	assertTopologyWindowOrder(t, topology.Sessions[0], []string{"window-9"})
	requestOperation(t, operations, 8, methodSessionDestroy, DestroySessionRequest{SessionID: root.SessionID})
	if second.SessionID == third.SessionID {
		t.Fatal("new windows did not create independent pane records")
	}
}

func TestOperationsKeepsLogicalSessionSelectedAfterPaneDestroy(t *testing.T) {
	operations := NewOperations()
	firstData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "first-logical-session",
	})
	var first CreateSessionResponse
	decodeResponse(t, firstData, &first)
	secondData := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "second-logical-session",
	})
	var second CreateSessionResponse
	decodeResponse(t, secondData, &second)
	splitData := requestOperation(t, operations, 3, methodPaneSplit, SplitPaneRequest{
		PaneID: first.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "first-logical-split",
	})
	var split CreateSessionResponse
	decodeResponse(t, splitData, &split)
	operations.mu.Lock()
	secondWindowID := operations.sessions[second.SessionID].windowID
	operations.mu.Unlock()
	requestOperation(t, operations, 4, methodWindowSelect, SelectWindowRequest{SessionID: second.SessionID, WindowID: secondWindowID})

	destroyed := requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: split.SessionID})
	var response DestroySessionResponse
	decodeResponse(t, destroyed, &response)
	if response.SessionID != split.SessionID {
		t.Fatalf("destroyed session = %q, want %q", response.SessionID, split.SessionID)
	}
	topologyData := requestOperation(t, operations, 6, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, topologyData, &topology)
	if topology.ActiveSessionID != second.SessionID {
		t.Fatalf("active logical session after background pane destroy = %q, want %q", topology.ActiveSessionID, second.SessionID)
	}
	requestOperation(t, operations, 7, methodSessionDestroy, DestroySessionRequest{SessionID: first.SessionID})
	requestOperation(t, operations, 8, methodSessionDestroy, DestroySessionRequest{SessionID: second.SessionID})
}

func TestOperationsDestroyDoesNotRetargetDeletedRuntimeSessionToLogicalSibling(t *testing.T) {
	operations := NewOperations()
	rootData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "destroy-root",
	})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	splitData := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: root.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "destroy-sibling",
	})
	var sibling CreateSessionResponse
	decodeResponse(t, splitData, &sibling)

	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: root.SessionID})
	if _, err := operations.destroy(DestroySessionRequest{SessionID: root.SessionID}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("retry destroy root error = %v, want ErrSessionNotFound", err)
	}
	listedData := requestOperation(t, operations, 4, methodSessionList, struct{}{})
	var listed ListSessionsResponse
	decodeResponse(t, listedData, &listed)
	if len(listed.Sessions) != 1 || listed.Sessions[0].SessionID != sibling.SessionID {
		t.Fatalf("retry destroy removed logical sibling: %#v", listed.Sessions)
	}
	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: sibling.SessionID})
}

func assertTopologyWindowOrder(t *testing.T, session TopologySession, want []string) {
	t.Helper()
	if len(session.Windows) != len(want) || len(session.WindowOrder) != len(want) {
		t.Fatalf("topology windows/order = %#v / %#v, want %#v", session.Windows, session.WindowOrder, want)
	}
	for index, windowID := range want {
		if session.WindowOrder[index] != windowID || session.Windows[index].WindowID != windowID {
			t.Fatalf("topology windows/order = %#v / %#v, want %#v", session.Windows, session.WindowOrder, want)
		}
	}
}

func TestOperationsProjectScopeFiltersInventoryAndRejectsCrossProjectMutation(t *testing.T) {
	operations := NewOperations()
	createdData, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "project-a-terminal",
	}))
	if err != nil {
		t.Fatal(err)
	}
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	t.Cleanup(func() {
		_, _ = operations.Handle(context.Background(), scopedOperationRequest(t, "project-a", 99, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID}))
	})

	listedData, err := operations.Handle(context.Background(), scopedOperationRequest(t, "project-b", 2, methodSessionList, struct{}{}))
	if err != nil {
		t.Fatal(err)
	}
	var listed ListSessionsResponse
	decodeResponse(t, listedData, &listed)
	if len(listed.Sessions) != 0 {
		t.Fatalf("project-b inventory leaked project-a session: %#v", listed.Sessions)
	}
	globalData, err := operations.Handle(context.Background(), operationRequest(t, 21, methodSessionList, struct{}{}))
	if err != nil {
		t.Fatal(err)
	}
	var global ListSessionsResponse
	decodeResponse(t, globalData, &global)
	if len(global.Sessions) != 1 || global.Sessions[0].ProjectID != "project-a" {
		t.Fatalf("same-user fallback discovery = %#v, want project-a session", global.Sessions)
	}

	_, err = operations.Handle(context.Background(), scopedOperationRequest(t, "project-b", 3, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID}))
	if !errors.Is(err, ErrProjectScope) {
		t.Fatalf("cross-project destroy error = %v, want ErrProjectScope", err)
	}
	_, err = operations.Handle(context.Background(), scopedOperationRequest(t, "project-b", 4, methodPaneWrite, WritePaneRequest{PaneID: created.PaneID, Data: []byte("blocked\n")}))
	if !errors.Is(err, ErrProjectScope) {
		t.Fatalf("cross-project write error = %v, want ErrProjectScope", err)
	}
}

func TestPersistentOperationsRecordAndDestroyLifecycleTopology(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "catalog-session"})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	requestOperation(t, operations, 2, methodSessionPin, PinSessionRequest{SessionID: session.SessionID, Pinned: true})

	database, err := sql.Open("sqlite", filepath.Join(home.Path, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	var sessions, windows, panes, pinned int
	if err := database.QueryRow(`SELECT COUNT(*), COALESCE(MAX(pinned), 0) FROM sessions`).Scan(&sessions, &pinned); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM windows`).Scan(&windows); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT COUNT(*) FROM panes`).Scan(&panes); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if sessions != 1 || windows != 1 || panes != 1 || pinned != 1 {
		database.Close()
		t.Fatalf("catalog counts sessions=%d windows=%d panes=%d pinned=%d, want 1/1/1/1", sessions, windows, panes, pinned)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}

	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
	database, err = sql.Open("sqlite", filepath.Join(home.Path, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if err := database.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("destroy retained %d catalog sessions", sessions)
	}
}

func TestOperationsConfiguresDaemonWideScrollbackPersistence(t *testing.T) {
	operations := NewOperations()
	if operations.PersistScrollback() {
		t.Fatal("new non-persistent operations unexpectedly enable scrollback persistence")
	}
	response := requestOperation(t, operations, 1, methodMuxConfigure, ConfigureMuxRequest{PersistScrollback: true, ScrollbackLines: 12_345})
	var configured ConfigureMuxResponse
	decodeResponse(t, response, &configured)
	if !configured.PersistScrollback || !operations.PersistScrollback() || configured.ScrollbackLines != 12_345 || operations.ScrollbackLines() != 12_345 {
		t.Fatal("mux.configure did not enable scrollback persistence")
	}
	response = requestOperation(t, operations, 2, methodMuxConfigure, ConfigureMuxRequest{PersistScrollback: false, ScrollbackLines: 4321})
	decodeResponse(t, response, &configured)
	if configured.PersistScrollback || operations.PersistScrollback() || configured.ScrollbackLines != 4321 || operations.ScrollbackLines() != 4321 {
		t.Fatal("mux.configure did not disable scrollback persistence")
	}
	if _, err := operations.Handle(context.Background(), operationRequest(t, 3, methodMuxConfigure, ConfigureMuxRequest{ScrollbackLines: MaxScrollbackLines + 1})); err == nil {
		t.Fatal("mux.configure accepted an unbounded scrollback target")
	}
}

func TestOperationsRejectsUnknownSessionPaneAndGeometry(t *testing.T) {
	operations := NewOperations()
	if _, err := operations.Handle(context.Background(), operationRequest(t, 1, methodPaneWrite, WritePaneRequest{PaneID: "pane-1"})); err == nil || !errors.Is(err, ErrPaneNotFound) {
		t.Fatalf("write before create error = %v, want ErrPaneNotFound", err)
	}
	requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	defer requestOperation(t, operations, 6, methodSessionDestroy, DestroySessionRequest{SessionID: "session-1"})
	for _, request := range []protocol.Request{
		operationRequest(t, 3, methodPaneResize, ResizePaneRequest{PaneID: "pane-1", Cols: 0, Rows: 24}),
		operationRequest(t, 4, methodSessionAttach, AttachSessionRequest{SessionID: "missing", Cols: 80, Rows: 24}),
		operationRequest(t, 5, "pane.missing", struct{}{}),
	} {
		if _, err := operations.Handle(context.Background(), request); err == nil {
			t.Fatalf("Handle(%s) unexpectedly succeeded", request.Method)
		}
	}
}

func TestOperationsOwnsMultipleIndependentSessions(t *testing.T) {
	operations := NewOperations()
	first := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'one:%s\\n' \"$line\"; done"},
	})
	second := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'two:%s\\n' \"$line\"; done"},
	})
	var firstCreated, secondCreated CreateSessionResponse
	decodeResponse(t, first, &firstCreated)
	decodeResponse(t, second, &secondCreated)
	if firstCreated.SessionID == secondCreated.SessionID || firstCreated.PaneID == secondCreated.PaneID {
		t.Fatalf("session identities collided: first=%+v second=%+v", firstCreated, secondCreated)
	}

	// Terminal clients send carriage return for Enter. Use that wire form here so
	// the two owned PTYs exercise the same line discipline as Cockpit/xterm.
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{PaneID: firstCreated.PaneID, Data: []byte("alpha\r")})
	requestOperation(t, operations, 4, methodPaneWrite, WritePaneRequest{PaneID: secondCreated.PaneID, Data: []byte("beta\r")})
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("one:alpha")); !bytes.Contains(output, []byte("one:alpha")) {
		t.Fatalf("first pane output = %q", output)
	}
	if output := readSessionUntil(t, operations, secondCreated.SessionID, []byte("two:beta")); !bytes.Contains(output, []byte("two:beta")) {
		t.Fatalf("second pane output = %q", output)
	}

	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: firstCreated.SessionID})
	requestOperation(t, operations, 6, methodPaneWrite, WritePaneRequest{PaneID: secondCreated.PaneID, Data: []byte("still-live\r")})
	if output := readSessionUntil(t, operations, secondCreated.SessionID, []byte("two:still-live")); !bytes.Contains(output, []byte("two:still-live")) {
		t.Fatalf("second pane after first destroy = %q", output)
	}
	requestOperation(t, operations, 7, methodSessionDestroy, DestroySessionRequest{SessionID: secondCreated.SessionID})
}

func TestOperationsBroadcastsInputButNeverTerminalReplies(t *testing.T) {
	operations := NewOperations()
	first := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'first:%s\\n' \"$line\"; done"},
	})
	second := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'second:%s\\n' \"$line\"; done"},
	})
	var firstCreated, secondCreated CreateSessionResponse
	decodeResponse(t, first, &firstCreated)
	decodeResponse(t, second, &secondCreated)
	operations.mu.Lock()
	operations.sessions[secondCreated.SessionID].logicalSessionID = operations.sessions[firstCreated.SessionID].logicalSessionID
	operations.sessions[secondCreated.SessionID].windowID = operations.sessions[firstCreated.SessionID].windowID
	operations.mu.Unlock()
	requestOperation(t, operations, 3, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: firstCreated.PaneID, Enabled: true})
	requestOperation(t, operations, 4, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: secondCreated.PaneID, Enabled: true})

	requestOperation(t, operations, 5, methodPaneWrite, WritePaneRequest{PaneID: firstCreated.PaneID, Data: []byte("input\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("first:input")); !bytes.Contains(output, []byte("first:input")) {
		t.Fatalf("source broadcast output = %q", output)
	}
	if output := readSessionUntil(t, operations, secondCreated.SessionID, []byte("second:input")); !bytes.Contains(output, []byte("second:input")) {
		t.Fatalf("peer broadcast output = %q", output)
	}

	requestOperation(t, operations, 6, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: firstCreated.PaneID, Enabled: false})
	requestOperation(t, operations, 7, methodPaneWrite, WritePaneRequest{PaneID: firstCreated.PaneID, Data: []byte("disabled\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("first:disabled")); !bytes.Contains(output, []byte("first:disabled")) {
		t.Fatalf("disabled source output = %q", output)
	}
	time.Sleep(50 * time.Millisecond)
	operations.mu.Lock()
	peer := operations.sessions[secondCreated.SessionID]
	operations.mu.Unlock()
	if peer.attachment != nil {
		for _, chunk := range peer.attachment.OutputsFrom(1) {
			if bytes.Contains(chunk.Data, []byte("second:disabled")) {
				t.Fatalf("disabled source was broadcast to peer: %q", chunk.Data)
			}
		}
	}

	requestOperation(t, operations, 8, methodPaneWrite, WritePaneRequest{PaneID: firstCreated.PaneID, Data: []byte("reply\r"), Kind: "reply"})
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("first:reply")); !bytes.Contains(output, []byte("first:reply")) {
		t.Fatalf("source reply output = %q", output)
	}
	time.Sleep(50 * time.Millisecond)
	operations.mu.Lock()
	peer = operations.sessions[secondCreated.SessionID]
	operations.mu.Unlock()
	if peer.attachment != nil {
		for _, chunk := range peer.attachment.OutputsFrom(1) {
			if bytes.Contains(chunk.Data, []byte("second:reply")) {
				t.Fatalf("reply was broadcast to peer: %q", chunk.Data)
			}
		}
	}
	requestOperation(t, operations, 9, methodSessionDestroy, DestroySessionRequest{SessionID: firstCreated.SessionID})
	requestOperation(t, operations, 10, methodSessionDestroy, DestroySessionRequest{SessionID: secondCreated.SessionID})
}

func TestOperationsBroadcastDoesNotCrossProjectGroups(t *testing.T) {
	operations := NewOperations()
	first := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'first:%s\\n' \"$line\"; done"}, BroadcastGroup: "project-a",
	})
	second := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'second:%s\\n' \"$line\"; done"}, BroadcastGroup: "project-b",
	})
	var firstCreated, secondCreated CreateSessionResponse
	decodeResponse(t, first, &firstCreated)
	decodeResponse(t, second, &secondCreated)
	requestOperation(t, operations, 3, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: firstCreated.PaneID, Enabled: true})
	requestOperation(t, operations, 4, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: secondCreated.PaneID, Enabled: true})

	requestOperation(t, operations, 5, methodPaneWrite, WritePaneRequest{PaneID: firstCreated.PaneID, Data: []byte("isolated\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, firstCreated.SessionID, []byte("first:isolated")); !bytes.Contains(output, []byte("first:isolated")) {
		t.Fatalf("source output = %q", output)
	}
	time.Sleep(50 * time.Millisecond)
	operations.mu.Lock()
	peer := operations.sessions[secondCreated.SessionID]
	operations.mu.Unlock()
	if peer.attachment != nil {
		for _, chunk := range peer.attachment.OutputsFrom(1) {
			if bytes.Contains(chunk.Data, []byte("second:isolated")) {
				t.Fatalf("cross-project input was broadcast to peer: %q", chunk.Data)
			}
		}
	}
	requestOperation(t, operations, 6, methodSessionDestroy, DestroySessionRequest{SessionID: firstCreated.SessionID})
	requestOperation(t, operations, 7, methodSessionDestroy, DestroySessionRequest{SessionID: secondCreated.SessionID})
}

func TestOperationsBroadcastScopesToWindowOrLogicalSession(t *testing.T) {
	operations := NewOperations()
	root := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'root:%s\\n' \"$line\"; done"}, BroadcastGroup: "project-a",
	})
	var rootCreated CreateSessionResponse
	decodeResponse(t, root, &rootCreated)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: rootCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'split:%s\\n' \"$line\"; done"},
	})
	var splitCreated CreateSessionResponse
	decodeResponse(t, split, &splitCreated)
	window := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: rootCreated.SessionID, Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'window:%s\\n' \"$line\"; done"},
	})
	var windowCreated CreateSessionResponse
	decodeResponse(t, window, &windowCreated)
	if splitCreated.SessionID == rootCreated.SessionID || windowCreated.SessionID == rootCreated.SessionID || splitCreated.SessionID == windowCreated.SessionID {
		t.Fatalf("topology creation must return the concrete session record: root=%+v split=%+v window=%+v", rootCreated, splitCreated, windowCreated)
	}
	operations.mu.Lock()
	splitRecord := operations.panes[splitCreated.PaneID]
	windowRecord := operations.panes[windowCreated.PaneID]
	operations.mu.Unlock()
	if splitRecord == nil || windowRecord == nil {
		t.Fatal("topology pane was not registered")
	}
	if splitRecord.id != splitCreated.SessionID || windowRecord.id != windowCreated.SessionID {
		t.Fatalf("creation response does not identify its created record: split=%+v window=%+v", splitCreated, windowCreated)
	}
	if splitRecord.logicalSessionID != rootCreated.SessionID || windowRecord.logicalSessionID != rootCreated.SessionID {
		t.Fatalf("topology logical session mismatch: split=%q window=%q root=%q", splitRecord.logicalSessionID, windowRecord.logicalSessionID, rootCreated.SessionID)
	}
	if splitRecord.windowID != operations.panes[rootCreated.PaneID].windowID || windowRecord.windowID == splitRecord.windowID {
		t.Fatalf("topology windows were not assigned correctly: split=%q window=%q", splitRecord.windowID, windowRecord.windowID)
	}
	requestOperation(t, operations, 4, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: rootCreated.PaneID, Enabled: true})
	requestOperation(t, operations, 5, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: splitCreated.PaneID, Enabled: true})
	requestOperation(t, operations, 6, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: windowCreated.PaneID, Enabled: true})

	requestOperation(t, operations, 7, methodPaneWrite, WritePaneRequest{PaneID: rootCreated.PaneID, Data: []byte("window-only\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, splitRecord.id, []byte("split:window-only")); !bytes.Contains(output, []byte("split:window-only")) {
		t.Fatalf("window peer output = %q", output)
	}
	time.Sleep(50 * time.Millisecond)
	operations.mu.Lock()
	var windowChunks []Output
	if windowRecord.attachment != nil {
		windowChunks = windowRecord.attachment.OutputsFrom(1)
	}
	operations.mu.Unlock()
	for _, chunk := range windowChunks {
		if bytes.Contains(chunk.Data, []byte("window:window-only")) {
			t.Fatalf("window-scoped input reached a different window: %q", chunk.Data)
		}
	}

	requestOperation(t, operations, 8, methodSessionBroadcastScope, SetBroadcastScopeRequest{SessionID: rootCreated.SessionID, Scope: "session"})
	requestOperation(t, operations, 9, methodPaneWrite, WritePaneRequest{PaneID: rootCreated.PaneID, Data: []byte("session-wide\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, windowRecord.id, []byte("window:session-wide")); !bytes.Contains(output, []byte("window:session-wide")) {
		t.Fatalf("session peer output = %q", output)
	}
	requestOperation(t, operations, 10, methodSessionDestroy, DestroySessionRequest{SessionID: rootCreated.SessionID})
	requestOperation(t, operations, 11, methodSessionDestroy, DestroySessionRequest{SessionID: splitRecord.id})
	requestOperation(t, operations, 12, methodSessionDestroy, DestroySessionRequest{SessionID: windowRecord.id})
}

func TestOperationsTopologyGroupsPanesByLogicalSessionAndWindow(t *testing.T) {
	operations := NewOperations()
	root := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	})
	var rootCreated CreateSessionResponse
	decodeResponse(t, root, &rootCreated)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: rootCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "split",
	})
	var splitCreated CreateSessionResponse
	decodeResponse(t, split, &splitCreated)
	window := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: rootCreated.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "window",
	})
	var windowCreated CreateSessionResponse
	decodeResponse(t, window, &windowCreated)

	response := requestOperation(t, operations, 4, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, response, &topology)
	if len(topology.Sessions) != 1 {
		t.Fatalf("topology sessions = %#v", topology.Sessions)
	}
	logical := topology.Sessions[0]
	if logical.SessionID != rootCreated.SessionID || len(logical.Windows) != 2 {
		t.Fatalf("topology logical session = %#v", logical)
	}
	if logical.ActiveWindowID != logical.Windows[1].WindowID {
		t.Fatalf("topology active window = %q, latest created window = %q", logical.ActiveWindowID, logical.Windows[1].WindowID)
	}
	if len(logical.Windows[0].Panes) != 2 || len(logical.Windows[1].Panes) != 1 {
		t.Fatalf("topology windows = %#v", logical.Windows)
	}
	seen := map[string]bool{}
	for _, window := range logical.Windows {
		if window.ActivePaneID == "" {
			t.Fatalf("topology window has no active pane: %#v", window)
		}
		for _, pane := range window.Panes {
			seen[pane.SessionID] = true
		}
	}
	for _, id := range []string{rootCreated.SessionID, splitCreated.SessionID, windowCreated.SessionID} {
		if !seen[id] {
			t.Fatalf("topology omitted session %q: %#v", id, logical)
		}
	}

	for index, id := range []string{rootCreated.SessionID, splitCreated.SessionID, windowCreated.SessionID} {
		requestOperation(t, operations, uint64(index+5), methodSessionDestroy, DestroySessionRequest{SessionID: id})
	}
}

func TestOperationsTopologySnapshotsHaveMonotonicRevisions(t *testing.T) {
	operations := NewOperations()
	firstReply := requestOperation(t, operations, 1, methodSessionTopology, struct{}{})
	var first TopologyResponse
	decodeResponse(t, firstReply, &first)
	if first.Revision == 0 {
		t.Fatal("first topology revision must be non-zero")
	}
	if first.Epoch == "" {
		t.Fatal("first topology epoch must be non-empty")
	}

	createdReply := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "revision-pane",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdReply, &created)
	secondReply := requestOperation(t, operations, 3, methodSessionTopology, struct{}{})
	var second TopologyResponse
	decodeResponse(t, secondReply, &second)
	if second.Revision <= first.Revision {
		t.Fatalf("topology revisions must increase: first=%d second=%d", first.Revision, second.Revision)
	}
	if second.Epoch != first.Epoch {
		t.Fatalf("topology epoch changed within one daemon: first=%q second=%q", first.Epoch, second.Epoch)
	}
	requestOperation(t, operations, 4, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})
}

func TestOperationsTopologyEpochChangesForRecoveredDaemon(t *testing.T) {
	before := NewOperations()
	beforeReply := requestOperation(t, before, 1, methodSessionTopology, struct{}{})
	var beforeTopology TopologyResponse
	decodeResponse(t, beforeReply, &beforeTopology)

	after := NewOperations()
	afterReply := requestOperation(t, after, 1, methodSessionTopology, struct{}{})
	var afterTopology TopologyResponse
	decodeResponse(t, afterReply, &afterTopology)

	if beforeTopology.Epoch == afterTopology.Epoch {
		t.Fatalf("daemon epochs must differ: %q", beforeTopology.Epoch)
	}
}

func TestOperationsTopologySelectionAndZoomAreDaemonOwned(t *testing.T) {
	operations := NewOperations()
	root := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	})
	var rootCreated CreateSessionResponse
	decodeResponse(t, root, &rootCreated)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: rootCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "split",
	})
	var splitCreated CreateSessionResponse
	decodeResponse(t, split, &splitCreated)
	window := requestOperation(t, operations, 3, methodWindowNew, NewWindowRequest{
		SessionID: rootCreated.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "window",
	})
	var windowCreated CreateSessionResponse
	decodeResponse(t, window, &windowCreated)

	rootRecord, err := operations.requireSession(rootCreated.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if state := operations.topologyState[rootCreated.SessionID]; state == nil || state.layoutByWindow[rootRecord.windowID] == nil {
		t.Fatalf("stored split layout = %#v", state)
	}
	windowRecord, err := operations.requireSession(windowCreated.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	selected := requestOperation(t, operations, 4, methodWindowSelect, SelectWindowRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID,
	})
	var selectedTopology TopologyResponse
	decodeResponse(t, selected, &selectedTopology)
	if got := selectedTopology.Sessions[0].ActiveWindowID; got != rootRecord.windowID {
		t.Fatalf("active window after select = %q, want %q", got, rootRecord.windowID)
	}

	focused := requestOperation(t, operations, 5, methodPaneSelect, SelectPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID,
	})
	var focusedTopology TopologyResponse
	decodeResponse(t, focused, &focusedTopology)
	if got := focusedTopology.Sessions[0].Windows[0].ActivePaneID; got != splitCreated.PaneID {
		t.Fatalf("active pane after select = %q, want %q", got, splitCreated.PaneID)
	}

	zoomed := requestOperation(t, operations, 6, methodPaneZoom, ZoomPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID,
	})
	var zoomedTopology TopologyResponse
	decodeResponse(t, zoomed, &zoomedTopology)
	if got := zoomedTopology.Sessions[0].Windows[0].ZoomedPaneID; got != splitCreated.PaneID {
		t.Fatalf("zoomed pane = %q, want %q", got, splitCreated.PaneID)
	}

	cleared := requestOperation(t, operations, 7, methodPaneZoom, ZoomPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID,
	})
	var clearedTopology TopologyResponse
	decodeResponse(t, cleared, &clearedTopology)
	if got := clearedTopology.Sessions[0].Windows[0].ZoomedPaneID; got != "" {
		t.Fatalf("zoomed pane after clear = %q", got)
	}
	requestOperation(t, operations, 8, methodPaneZoom, ZoomPaneRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID,
	})
	requestOperation(t, operations, 9, methodSessionDestroy, DestroySessionRequest{SessionID: splitCreated.SessionID})
	recovered := requestOperation(t, operations, 10, methodSessionTopology, struct{}{})
	var recoveredTopology TopologyResponse
	decodeResponse(t, recovered, &recoveredTopology)
	rootWindow := recoveredTopology.Sessions[0].Windows[0]
	if rootWindow.ActivePaneID != rootCreated.PaneID || rootWindow.ZoomedPaneID != "" {
		t.Fatalf("destroyed selected pane left stale topology: %#v", rootWindow)
	}
	if rootWindow.Layout == nil || rootWindow.Layout.PaneID != rootCreated.PaneID || rootWindow.Layout.First != nil || rootWindow.Layout.Second != nil {
		t.Fatalf("destroyed pane left stale layout leaf: %#v", rootWindow.Layout)
	}
	if windowRecord.windowID == rootRecord.windowID {
		t.Fatal("new window reused the root window identity")
	}

	for index, id := range []string{rootCreated.SessionID, windowCreated.SessionID} {
		requestOperation(t, operations, uint64(index+11), methodSessionDestroy, DestroySessionRequest{SessionID: id})
	}
}

func TestOperationsTopologyPreservesDirectionalSplitAndRatio(t *testing.T) {
	operations := NewOperations()
	root := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root",
	})
	var rootCreated CreateSessionResponse
	decodeResponse(t, root, &rootCreated)
	split := requestOperation(t, operations, 2, methodPaneSplit, SplitPaneRequest{
		PaneID: rootCreated.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "split", Direction: "vertical", Ratio: 0.3,
	})
	var splitCreated CreateSessionResponse
	decodeResponse(t, split, &splitCreated)
	rootRecord, err := operations.requireSession(rootCreated.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	topologyReply := requestOperation(t, operations, 3, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, topologyReply, &topology)
	layout := topology.Sessions[0].Windows[0].Layout
	if layout == nil || layout.Direction != "vertical" || layout.Ratio != 0.3 || layout.First.PaneID != rootCreated.PaneID || layout.Second.PaneID != splitCreated.PaneID {
		t.Fatalf("initial split layout = %#v", layout)
	}
	resized := requestOperation(t, operations, 4, methodPaneResizeSplit, ResizeSplitRequest{
		SessionID: rootCreated.SessionID, WindowID: rootRecord.windowID, PaneID: splitCreated.PaneID, Ratio: 0.7,
	})
	decodeResponse(t, resized, &topology)
	if got := topology.Sessions[0].Windows[0].Layout.Ratio; got != 0.7 {
		t.Fatalf("resized split ratio = %v, want 0.7", got)
	}
	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: rootCreated.SessionID})
	requestOperation(t, operations, 6, methodSessionDestroy, DestroySessionRequest{SessionID: splitCreated.SessionID})
}

func TestOperationsListsLiveSessionsInStableOrder(t *testing.T) {
	operations := NewOperations()
	first := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	second := requestOperation(t, operations, 2, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var firstCreated, secondCreated CreateSessionResponse
	decodeResponse(t, first, &firstCreated)
	decodeResponse(t, second, &secondCreated)
	requestOperation(t, operations, 3, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: secondCreated.PaneID, Enabled: true})

	listed := requestOperation(t, operations, 4, methodSessionList, struct{}{})
	var response ListSessionsResponse
	decodeResponse(t, listed, &response)
	if len(response.Sessions) != 2 {
		t.Fatalf("session list = %#v", response.Sessions)
	}
	if response.Sessions[0].SessionID != firstCreated.SessionID || response.Sessions[1].SessionID != secondCreated.SessionID {
		t.Fatalf("session list order = %#v", response.Sessions)
	}
	if response.Sessions[0].Exited || response.Sessions[0].Broadcast || response.Sessions[1].Exited || !response.Sessions[1].Broadcast {
		t.Fatalf("session list state = %#v", response.Sessions)
	}
	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: firstCreated.SessionID})
	requestOperation(t, operations, 6, methodSessionDestroy, DestroySessionRequest{SessionID: secondCreated.SessionID})
}

func TestOperationsPinsAndUnpinsSessions(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	requestOperation(t, operations, 2, methodSessionPin, PinSessionRequest{SessionID: session.SessionID, Pinned: true})
	listed := requestOperation(t, operations, 3, methodSessionList, struct{}{})
	var response ListSessionsResponse
	decodeResponse(t, listed, &response)
	if len(response.Sessions) != 1 || !response.Sessions[0].Pinned {
		t.Fatalf("pinned session list = %#v", response.Sessions)
	}
	requestOperation(t, operations, 4, methodSessionPin, PinSessionRequest{SessionID: session.SessionID, Pinned: false})
	listed = requestOperation(t, operations, 5, methodSessionList, struct{}{})
	decodeResponse(t, listed, &response)
	if response.Sessions[0].Pinned {
		t.Fatalf("unpin session list = %#v", response.Sessions)
	}
	requestOperation(t, operations, 6, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
}

func TestOperationsRefusesShutdownWhilePanesAreLive(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	_, err := operations.Handle(context.Background(), operationRequest(t, 2, methodMuxShutdown, struct{}{}))
	if !errors.Is(err, ErrLiveSessions) {
		t.Fatalf("mux.shutdown error = %v, want ErrLiveSessions", err)
	}
	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
	if _, err := operations.Handle(context.Background(), operationRequest(t, 4, methodMuxShutdown, struct{}{})); err != nil {
		t.Fatalf("mux.shutdown after destroy: %v", err)
	}
}

func TestOperationsNewAttachStealsExclusiveClientOwnership(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'owned:%s\\n' \"$line\"; done"},
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	first := requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{SessionID: session.SessionID, ClientID: "cockpit-a", ClientKind: "cockpit", Cols: 80, Rows: 24})
	var firstAttach AttachSessionResponse
	decodeResponse(t, first, &firstAttach)
	if firstAttach.Stole {
		t.Fatal("first attach unexpectedly reported a steal")
	}
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, ClientID: "cockpit-a", Data: []byte("first\r"), Kind: "input"})
	requestOperation(t, operations, 31, methodPaneBroadcast, SetPaneBroadcastRequest{PaneID: session.PaneID, ClientID: "cockpit-a", Enabled: true})
	second := requestOperation(t, operations, 4, methodSessionAttach, AttachSessionRequest{SessionID: session.SessionID, ClientID: "tty-b", ClientKind: "tty", Cols: 80, Rows: 24})
	var secondAttach AttachSessionResponse
	decodeResponse(t, second, &secondAttach)
	if !secondAttach.Stole {
		t.Fatal("second attach did not report a steal")
	}
	listed := requestOperation(t, operations, 5, methodSessionList, struct{}{})
	var list ListSessionsResponse
	decodeResponse(t, listed, &list)
	if len(list.Sessions) != 1 || list.Sessions[0].AttachedKind != "tty" || !list.Sessions[0].Broadcast {
		t.Fatalf("attach owner list = %#v", list.Sessions)
	}
	_, err := operations.Handle(context.Background(), operationRequest(t, 6, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, ClientID: "cockpit-a", Data: []byte("stale\r"), Kind: "input"}))
	if !errors.Is(err, ErrSessionStolen) {
		t.Fatalf("stale client write error = %v, want ErrSessionStolen", err)
	}
	requestOperation(t, operations, 7, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, ClientID: "tty-b", Data: []byte("fresh\r"), Kind: "input"})
	if output := readSessionUntil(t, operations, session.SessionID, []byte("owned:fresh")); !bytes.Contains(output, []byte("owned:fresh")) {
		t.Fatalf("replacement owner output = %q", output)
	}
	requestOperation(t, operations, 8, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
}

func TestOperationsDetachClearsExclusiveAttachOwner(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{SessionID: session.SessionID, ClientID: "cockpit-a", ClientKind: "cockpit", Cols: 80, Rows: 24})
	requestOperation(t, operations, 3, methodSessionDetach, DetachSessionRequest{SessionID: session.SessionID, ClientID: "cockpit-a"})
	listed := requestOperation(t, operations, 4, methodSessionList, struct{}{})
	var response ListSessionsResponse
	decodeResponse(t, listed, &response)
	if len(response.Sessions) != 1 || response.Sessions[0].AttachedKind != "" {
		t.Fatalf("detached session list = %#v", response.Sessions)
	}
	requestOperation(t, operations, 5, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
}

func TestServerOperationsCorrelatesReconnectToRetainedSession(t *testing.T) {
	operations := NewOperations()
	home, stop := startTestServer(t, operations.Handle)
	defer stop()

	first := dialTestClient(t, home)
	writeHello(t, first)
	writeOperation(t, first, 11, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "while IFS= read -r line; do printf 'socket:%s\\n' \"$line\"; done"},
	})
	var created protocol.Response
	readOperationResponse(t, first, &created)
	if created.ID != 11 || created.Error != "" {
		t.Fatalf("create response = %+v", created)
	}
	var create CreateSessionResponse
	decodeResponse(t, created.Data, &create)
	first.Close()

	second := dialTestClient(t, home)
	defer second.Close()
	writeHello(t, second)
	writeOperation(t, second, 12, methodPaneWrite, WritePaneRequest{PaneID: create.PaneID, Data: []byte("reconnected\n")})
	var wrote protocol.Response
	readOperationResponse(t, second, &wrote)
	if wrote.ID != 12 || wrote.Error != "" {
		t.Fatalf("write response = %+v", wrote)
	}

	if output := readSessionUntil(t, operations, create.SessionID, []byte("socket:reconnected")); !bytes.Contains(output, []byte("socket:reconnected")) {
		t.Fatalf("pane output after socket reconnect = %q", output)
	}

	writeOperation(t, second, 13, methodSessionDestroy, DestroySessionRequest{SessionID: create.SessionID})
	var destroyed protocol.Response
	readOperationResponse(t, second, &destroyed)
	if destroyed.ID != 13 || destroyed.Error != "" {
		t.Fatalf("destroy response = %+v", destroyed)
	}
}

func requestOperation(t *testing.T, operations *Operations, id uint64, method string, value any) []byte {
	t.Helper()
	response, err := operations.Handle(context.Background(), operationRequest(t, id, method, value))
	if err != nil {
		t.Fatalf("Handle(%s) error = %v", method, err)
	}
	return response
}

func operationRequest(t *testing.T, id uint64, method string, value any) protocol.Request {
	t.Helper()
	data, err := msgpack.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Request{ID: id, Method: method, Data: data}
}

func scopedOperationRequest(t *testing.T, projectID string, id uint64, method string, value any) protocol.Request {
	request := operationRequest(t, id, method, value)
	request.ProjectID = projectID
	return request
}

func decodeResponse(t *testing.T, data []byte, destination any) {
	t.Helper()
	if err := msgpack.Unmarshal(data, destination); err != nil {
		t.Fatal(err)
	}
}

func writeOperation(t *testing.T, connection *net.UnixConn, id uint64, method string, value any) {
	t.Helper()
	if err := protocol.Write(connection, operationRequest(t, id, method, value)); err != nil {
		t.Fatal(err)
	}
}

func readOperationResponse(t *testing.T, connection *net.UnixConn, response *protocol.Response) {
	t.Helper()
	if err := protocol.Read(connection, response); err != nil {
		t.Fatal(err)
	}
}

func readUntil(t *testing.T, pane *Pane, needle []byte) []byte {
	t.Helper()
	buffer := make([]byte, 256)
	var output []byte
	for len(output) < 4096 {
		n, _, err := pane.ReadLive(buffer)
		if n > 0 {
			output = append(output, buffer[:n]...)
			if bytes.Contains(output, needle) {
				return output
			}
		}
		if err != nil {
			if err == io.EOF {
				break
			}
			t.Fatalf("read retained pane: %v", err)
		}
	}
	return output
}

// readSessionUntil observes the same raw stream exposed to native fixture clients.
// A non-native control-plane test retains the direct PTY reader so its suite stays
// independent of libghostty-vt.
func readSessionUntil(t *testing.T, operations *Operations, sessionID string, needle []byte) []byte {
	t.Helper()
	operations.mu.Lock()
	session := operations.sessions[sessionID]
	operations.mu.Unlock()
	if session == nil {
		t.Fatal("session unexpectedly absent")
	}
	if session.attachment == nil {
		return readUntil(t, session.pane, needle)
	}

	// A complete native suite concurrently exercises persistence, handoff, and
	// other PTY-backed cases.  A split default shell can therefore take longer
	// than the interactive two-second budget to drain a large output burst.
	// Keep this finite so a real stalled reader still fails, while allowing the
	// live-output assertions to observe a fully scheduled mux under suite load.
	deadline := time.Now().Add(5 * time.Second)
	var lastOutput []byte
	for time.Now().Before(deadline) {
		var output []byte
		for _, chunk := range session.attachment.OutputsFrom(1) {
			output = append(output, chunk.Data...)
		}
		if bytes.Contains(output, needle) {
			return output
		}
		lastOutput = output
		time.Sleep(10 * time.Millisecond)
	}
	processState := "unavailable"
	if session.pane != nil && session.pane.cmd != nil && session.pane.cmd.Process != nil {
		processState = fmt.Sprintf("pid=%d state=%v", session.pane.cmd.Process.Pid, session.pane.cmd.ProcessState)
	}
	t.Fatalf("timed out waiting for retained output %q; retained=%q; %s", needle, lastOutput, processState)
	return nil
}
