//go:build libghostty

package daemon

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestOperationsPrepareHandoffBlocksMutationsUntilReleased(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'resumed:%s\\n' \"$line\"; done"}, BroadcastGroup: "project-a",
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	prepared, err := operations.PrepareHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared.Manifest.Panes) != 1 || len(prepared.Masters) != 1 {
		prepared.Release()
		t.Fatalf("prepared handoff = %#v masters=%d", prepared.Manifest, len(prepared.Masters))
	}
	if pane := prepared.Manifest.Panes[0]; pane.SessionID != session.SessionID || pane.PaneID != session.PaneID || pane.Boundary != "grounded" || len(pane.Snapshot) == 0 {
		prepared.Release()
		t.Fatalf("prepared pane = %#v", pane)
	}
	_, err = operations.Handle(context.Background(), operationRequest(t, 2, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("blocked\r")}))
	if !errors.Is(err, ErrHandoffInProgress) {
		prepared.Release()
		t.Fatalf("write during prepared handoff error = %v", err)
	}
	prepared.Release()
	requestOperation(t, operations, 3, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("resumed\r")})
	if output := readSessionUntil(t, operations, session.SessionID, []byte("resumed:resumed")); len(output) == 0 {
		t.Fatal("released handoff did not resume pane output")
	}
	requestOperation(t, operations, 4, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
}

func TestOperationsPrepareHandoffAbortsAtUngroundedParserBoundary(t *testing.T) {
	operations := NewOperations()
	created := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf '\\033_Ga=t;payload'; IFS= read -r line; printf '\\033\\\\resumed:%s\\n' \"$line\""},
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	if output := readSessionUntil(t, operations, session.SessionID, []byte("payload")); len(output) == 0 {
		t.Fatal("fixture did not emit the ungrounded APC")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := operations.PrepareHandoff(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ungrounded handoff error = %v, want deadline exceeded", err)
	}

	requestOperation(t, operations, 2, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("continued\r")})
	if output := readSessionUntil(t, operations, session.SessionID, []byte("resumed:continued")); len(output) == 0 {
		t.Fatal("aborted handoff did not resume the ungrounded pane")
	}
	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: session.SessionID})
}
