//go:build libghostty

package daemon

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLiveShellInputAppearsInDaemonScrollback(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID:  created.SessionID,
		ClientID:   "scrollback-client",
		ClientKind: "cockpit",
		Cols:       80,
		Rows:       24,
	})

	const marker = "live-shell-scrollback-marker"
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{
		PaneID:   created.PaneID,
		ClientID: "scrollback-client",
		Data: []byte(
			"printf '%s\\n' " + marker +
				"; for i in $(seq 1 200); do echo live-shell-scrollback-tail-$i; done\n",
		),
	})
	if output := readSessionUntil(t, operations, created.SessionID, []byte("live-shell-scrollback-tail-200")); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live shell output = %q, want marker", output)
	}

	scrollbackData := requestOperation(t, operations, 4, methodScrollbackQuery, ScrollbackQueryRequest{
		PaneID:   created.PaneID,
		ClientID: "scrollback-client",
		Count:    1_000,
	})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), marker) {
		t.Fatalf("live daemon scrollback = %q, want marker", history.String())
	}
}

// Browser key events reach pane.write one character at a time. Keep that path
// distinct from a single paste-sized write: the terminal shadow must retain
// the shell's resulting output regardless of how the command was entered.
func TestLiveScrollbackRetainsCharacterByCharacterShellOutput(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "typed-history-client", ClientKind: "cockpit", Cols: 57, Rows: 24,
	})
	const marker = "typed-shell-scrollback-complete"
	command := "for i in $(seq 1 300); do echo typed-shell-scrollback-tail-$i; done; printf '%s%s\\n' 'typed-shell-scrollback-' 'complete'\n"
	for index, character := range []byte(command) {
		requestOperation(t, operations, uint64(3+index), methodPaneWrite, WritePaneRequest{
			PaneID: created.PaneID, ClientID: "typed-history-client", Data: []byte{character},
		})
	}
	if output := readSessionUntil(t, operations, created.SessionID, []byte(marker)); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live typed output = %q, want marker", output)
	}
	scrollbackData := requestOperation(t, operations, uint64(3+len(command)), methodScrollbackQuery, ScrollbackQueryRequest{
		PaneID: created.PaneID, ClientID: "typed-history-client", Count: 1_000,
	})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), "typed-shell-scrollback-tail-278") {
		t.Fatalf("typed shell daemon scrollback = %q, want retained tail", history.String())
	}
	attachedData := requestOperation(t, operations, uint64(4+len(command)), methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "typed-history-client", ClientKind: "cockpit", Cols: 57, Rows: 24,
	})
	var attached AttachSessionResponse
	decodeResponse(t, attachedData, &attached)
	if !bytes.Contains(attached.Seed, []byte(marker)) {
		t.Fatalf("typed shell attach seed = %q, want visible marker", attached.Seed)
	}
}

// A split pane can be resized several times while it is inactive, then receive
// a fresh renderer after an Electron reload. Its attach seed is the only source
// for the current screen in that renderer, so every resize must retain the
// newest visible output rather than only durable history.
func TestLiveAttachSeedRetainsCurrentScreenAcrossRepeatedResize(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "resize-seed-client", ClientKind: "cockpit", Cols: 57, Rows: 24,
	})
	const marker = "resized-attach-screen-marker"
	command := "for i in $(seq 1 300); do echo resized-attach-tail-$i; done; printf '%s%s\\n' 'resized-attach-' 'screen-marker'\n"
	for index, character := range []byte(command) {
		requestOperation(t, operations, uint64(3+index), methodPaneWrite, WritePaneRequest{
			PaneID: created.PaneID, ClientID: "resize-seed-client", Data: []byte{character},
		})
	}
	if output := readSessionUntil(t, operations, created.SessionID, []byte("resized-attach-tail-300")); !bytes.Contains(output, []byte("resized-attach-tail-300")) {
		t.Fatalf("live typed output = %q, want final tail", output)
	}
	if output := readSessionUntil(t, operations, created.SessionID, []byte(marker)); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live typed output = %q, want marker", output)
	}

	requestID := uint64(4 + len(command))
	for _, geometry := range []struct{ cols, rows uint16 }{{70, 24}, {45, 32}, {96, 28}, {57, 24}} {
		requestOperation(t, operations, requestID, methodPaneResize, ResizePaneRequest{
			PaneID: created.PaneID, ClientID: "resize-seed-client", Cols: geometry.cols, Rows: geometry.rows,
		})
		requestID++
		attachedData := requestOperation(t, operations, requestID, methodSessionAttach, AttachSessionRequest{
			SessionID: created.SessionID, ClientID: "resize-seed-client", ClientKind: "cockpit", Cols: geometry.cols, Rows: geometry.rows,
		})
		requestID++
		var attached AttachSessionResponse
		decodeResponse(t, attachedData, &attached)
		if !bytes.Contains(attached.Seed, []byte(marker)) {
			t.Fatalf("attach seed at %dx%d = %q, want %q", geometry.cols, geometry.rows, attached.Seed, marker)
		}
	}
}

func TestLiveScrollbackSurvivesRendererResize(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "resize-history-client", ClientKind: "cockpit", Cols: 80, Rows: 24,
	})
	const marker = "resize-history-marker"
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{
		PaneID: created.PaneID, ClientID: "resize-history-client",
		Data: []byte("printf '%s\\n' " + marker + "; for i in $(seq 1 900); do echo resize-history-tail-$i; done\n"),
	})
	if output := readSessionUntil(t, operations, created.SessionID, []byte("resize-history-tail-900")); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live output = %q, want marker", output)
	}
	requestOperation(t, operations, 4, methodPaneResize, ResizePaneRequest{
		PaneID: created.PaneID, ClientID: "resize-history-client", Cols: 100, Rows: 30,
	})
	scrollbackData := requestOperation(t, operations, 5, methodScrollbackQuery, ScrollbackQueryRequest{
		PaneID: created.PaneID, ClientID: "resize-history-client", Count: 1_000,
	})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), marker) {
		t.Fatalf("resized live daemon scrollback = %q, want marker", history.String())
	}
}

func TestLiveScrollbackSurvivesRendererReattach(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{SessionID: created.SessionID, ClientID: "reattach-history-client", ClientKind: "cockpit", Cols: 80, Rows: 24})
	const marker = "reattach-history-marker"
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{PaneID: created.PaneID, ClientID: "reattach-history-client", Data: []byte("printf '%s\\n' " + marker + "; for i in $(seq 1 900); do echo reattach-history-tail-$i; done\n")})
	if output := readSessionUntil(t, operations, created.SessionID, []byte("reattach-history-tail-900")); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live output = %q, want marker", output)
	}
	requestOperation(t, operations, 4, methodSessionAttach, AttachSessionRequest{SessionID: created.SessionID, ClientID: "reattach-history-client", ClientKind: "cockpit", Cols: 100, Rows: 30})
	scrollbackData := requestOperation(t, operations, 5, methodScrollbackQuery, ScrollbackQueryRequest{PaneID: created.PaneID, ClientID: "reattach-history-client", Count: 1_000})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), marker) {
		t.Fatalf("reattached live daemon scrollback = %q, want marker", history.String())
	}
}

// Exercise the same shell trampoline Cockpit uses for a renderer-created split.
// The mux must retain a split pane's primary-screen history even when its
// interactive shell emits startup control sequences before accepting input.
func TestLiveScrollbackSurvivesCockpitShellSplit(t *testing.T) {
	if _, err := os.Stat("/bin/zsh"); err != nil {
		t.Skip("the local default-shell regression requires /bin/zsh")
	}
	t.Setenv("SHELL", "/bin/zsh")
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/usr/bin/env",
		Args:    []string{"BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`},
	})
	var root CreateSessionResponse
	decodeResponse(t, createdData, &root)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: root.SessionID, ClientID: "cockpit-split-client", ClientKind: "cockpit", Cols: 80, Rows: 24,
	})

	splitData := requestOperation(t, operations, 3, methodPaneSplit, SplitPaneRequest{
		PaneID: root.PaneID, Command: "/usr/bin/env",
		Args:      []string{"BYOBU_DISABLE=1", "/bin/sh", "-c", `exec "${SHELL:-/bin/sh}"`},
		Direction: "vertical", Ratio: 0.5,
	})
	var split CreateSessionResponse
	decodeResponse(t, splitData, &split)
	requestOperation(t, operations, 4, methodSessionAttach, AttachSessionRequest{
		SessionID: split.SessionID, ClientID: "cockpit-split-client", ClientKind: "cockpit", Cols: 80, Rows: 24,
	})

	const marker = "cockpit-shell-split-history-marker"
	requestOperation(t, operations, 5, methodPaneWrite, WritePaneRequest{
		PaneID: split.PaneID, ClientID: "cockpit-split-client",
		Data: []byte("printf '%s\\n' " + marker + "; for i in $(seq 1 900); do echo cockpit-shell-split-tail-$i; done\n"),
	})
	if output := readSessionUntil(t, operations, split.SessionID, []byte("cockpit-shell-split-tail-900")); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live split output = %q, want marker", output)
	}
	scrollbackData := requestOperation(t, operations, 6, methodScrollbackQuery, ScrollbackQueryRequest{
		PaneID: split.PaneID, ClientID: "cockpit-split-client", Count: 1_000,
	})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), marker) {
		t.Fatalf("cockpit shell split live scrollback = %q, want marker", history.String())
	}
}

// Renderer layout settles asynchronously after a split.  Resize requests can
// therefore overlap a running command; none may discard the live Ghostty
// history that the recorder has already observed.
func TestLiveScrollbackSurvivesRapidResizeDuringOutput(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "resize-during-output-client", ClientKind: "cockpit", Cols: 80, Rows: 24,
	})
	const marker = "resize-during-output-history-marker"
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{
		PaneID: created.PaneID, ClientID: "resize-during-output-client",
		Data: []byte("printf '%s\\n' " + marker + "; for i in $(seq 1 300); do echo resize-during-output-tail-$i; sleep 0.001; done\n"),
	})
	for index := 0; index < 24; index++ {
		cols, rows := uint16(80), uint16(24)
		if index%2 == 1 {
			cols, rows = 117, 37
		}
		requestOperation(t, operations, uint64(4+index), methodPaneResize, ResizePaneRequest{
			PaneID: created.PaneID, ClientID: "resize-during-output-client", Cols: cols, Rows: rows,
		})
	}
	if output := readSessionUntil(t, operations, created.SessionID, []byte("resize-during-output-tail-300")); !bytes.Contains(output, []byte(marker)) {
		t.Fatalf("live output after rapid resize = %q, want marker", output)
	}
	scrollbackData := requestOperation(t, operations, 28, methodScrollbackQuery, ScrollbackQueryRequest{
		PaneID: created.PaneID, ClientID: "resize-during-output-client", Count: 1_000,
	})
	var scrollback ScrollbackQueryResponse
	decodeResponse(t, scrollbackData, &scrollback)
	var history strings.Builder
	for _, line := range scrollback.Lines {
		for _, run := range line.Runs {
			history.WriteString(run.Text)
		}
	}
	if !strings.Contains(history.String(), marker) {
		t.Fatalf("rapid-resize live daemon scrollback = %q, want marker", history.String())
	}
}

func TestPersistentAttachedWindowDestroyCompletes(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	rootData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	windowData := requestOperation(t, operations, 2, methodWindowNew, NewWindowRequest{
		SessionID: root.SessionID,
		Command:   "/bin/sh",
		Key:       "destroy-attached-window",
	})
	var window CreateSessionResponse
	decodeResponse(t, windowData, &window)
	requestOperation(t, operations, 3, methodSessionAttach, AttachSessionRequest{
		SessionID:  window.SessionID,
		ClientID:   "destroy-window-client",
		ClientKind: "cockpit",
		Cols:       80,
		Rows:       24,
	})

	operations.mu.Lock()
	windowID := operations.sessions[window.SessionID].windowID
	operations.mu.Unlock()
	done := make(chan error, 1)
	go func() {
		_, err := operations.Handle(context.Background(), operationRequest(t, 4, methodWindowDestroy, DestroyWindowRequest{
			SessionID: root.SessionID,
			WindowID:  windowID,
		}))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("destroy attached window: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("destroy attached persistent window did not complete")
	}
}

// A renderer closes a live pane while its output poller is active.  Exercise
// that exact session.destroy path after enough output to make the persistent
// recorder concurrent with attachment shutdown; this must not leave the IPC
// request waiting behind the native reader.
func TestPersistentAttachedSessionDestroyCompletesDuringOutput(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperations(home)
	defer operations.Close()

	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh"})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	requestOperation(t, operations, 2, methodSessionAttach, AttachSessionRequest{
		SessionID:  created.SessionID,
		ClientID:   "destroy-session-client",
		ClientKind: "cockpit",
		Cols:       80,
		Rows:       24,
	})
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{
		PaneID:   created.PaneID,
		ClientID: "destroy-session-client",
		Data:     []byte("for i in $(seq 1 400); do echo destroy-session-output-$i; done\n"),
	})
	if output := readSessionUntil(t, operations, created.SessionID, []byte("destroy-session-output-400")); len(output) == 0 {
		t.Fatal("expected live output before destroy")
	}

	done := make(chan error, 1)
	go func() {
		_, err := operations.Handle(context.Background(), operationRequest(t, 4, methodSessionDestroy, DestroySessionRequest{
			SessionID: created.SessionID,
		}))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("destroy attached session: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("destroy attached persistent session did not complete")
	}
}
