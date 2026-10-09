//go:build libghostty

package daemon

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestAdoptedHandoffReaderSurvivesParentDescriptorClosure(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	parent := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer parent.Close()
	created := requestOperation(t, parent, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'adopted:%s\\n' \"$line\"; done"},
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	prepared, err := parent.PrepareHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Release()
	adopted := NewHandoffOperations(home, true)
	defer adopted.Close()
	childDescriptor, err := unix.Dup(int(prepared.Masters[0].Fd()))
	if err != nil {
		t.Fatal(err)
	}
	descriptors := []*os.File{os.NewFile(uintptr(childDescriptor), "handoff-child-master")}
	if err := adopted.AdoptHandoff(prepared.Manifest, descriptors); err != nil {
		t.Fatal(err)
	}
	if adopted.persistencePath != "" {
		t.Fatalf("unacknowledged handoff opened shared persistence path %q", adopted.persistencePath)
	}
	attachment := adopted.sessions[session.SessionID].attachment.(*shadowAttachment)
	requestOperation(t, adopted, 2, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("before-ack\n"), Kind: "input"})
	time.Sleep(100 * time.Millisecond)
	if outputs := attachment.OutputsFrom(1); len(outputs) != 0 {
		t.Fatalf("unacknowledged handoff consumed PTY bytes: %#v", outputs)
	}
	if err := adopted.ActivateHandoffPersistence(); err != nil {
		t.Fatal(err)
	}
	parentAttachment := parent.sessions[session.SessionID].attachment.(*shadowAttachment)
	if err := parentAttachment.poll.Close(); err != nil {
		t.Fatal(err)
	}
	if err := parent.sessions[session.SessionID].pane.master.Close(); err != nil {
		t.Fatal(err)
	}
	requestOperation(t, adopted, 3, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("continued\n"), Kind: "input"})
	time.Sleep(250 * time.Millisecond)
	if attachment.pumpErr != nil {
		t.Fatalf("adopted reader stopped: %v", attachment.pumpErr)
	}
	if len(attachment.OutputsFrom(1)) == 0 {
		t.Fatal("adopted reader produced no output and no reader error")
	}
	outputData := requestOperation(t, adopted, 4, methodPaneOutput, ReadPaneOutputRequest{
		PaneID: session.PaneID,
	})
	var output ReadPaneOutputResponse
	decodeResponse(t, outputData, &output)
	var protocolOutput []byte
	for _, chunk := range output.Outputs {
		protocolOutput = append(protocolOutput, chunk.Data...)
	}
	if !bytes.Contains(protocolOutput, []byte("adopted:continued")) {
		t.Fatalf("adopted pane.output = %q, want output through the daemon protocol", protocolOutput)
	}
}

func TestAbandonedHandoffChildDoesNotTerminateParentPTYS(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	parent := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer parent.Close()
	created := requestOperation(t, parent, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "while IFS= read -r line; do printf 'parent:%s\\n' \"$line\"; done"},
	})
	var session CreateSessionResponse
	decodeResponse(t, created, &session)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	prepared, err := parent.PrepareHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Release()
	duplicated, err := unix.Dup(int(prepared.Masters[0].Fd()))
	if err != nil {
		t.Fatal(err)
	}
	child := NewHandoffOperations(home, true)
	if err := child.AdoptHandoff(prepared.Manifest, []*os.File{os.NewFile(uintptr(duplicated), "uncommitted-child-master")}); err != nil {
		t.Fatal(err)
	}
	if err := child.AbandonHandoff(); err != nil {
		t.Fatalf("AbandonHandoff() error = %v", err)
	}
	prepared.Release()

	parentAttachment := parent.sessions[session.SessionID].attachment.(*shadowAttachment)
	requestOperation(t, parent, 2, methodPaneWrite, WritePaneRequest{PaneID: session.PaneID, Data: []byte("still-owned\n"), Kind: "input"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, output := range parentAttachment.OutputsFrom(1) {
			if bytes.Contains(output.Data, []byte("parent:still-owned")) {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("parent daemon lost its PTY reader or process after child rollback")
}

func TestAdoptHandoffPreservesTopologyInteractionState(t *testing.T) {
	home, err := OpenHome(filepath.Join(t.TempDir(), "mux"))
	if err != nil {
		t.Fatal(err)
	}
	parent := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer parent.Close()
	rootData := requestOperation(t, parent, 1, methodSessionCreate, CreateSessionRequest{Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "root"})
	var root CreateSessionResponse
	decodeResponse(t, rootData, &root)
	splitData := requestOperation(t, parent, 2, methodPaneSplit, SplitPaneRequest{PaneID: root.PaneID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "split", Direction: "vertical", Ratio: 0.3})
	var split CreateSessionResponse
	decodeResponse(t, splitData, &split)
	windowData := requestOperation(t, parent, 3, methodWindowNew, NewWindowRequest{SessionID: root.SessionID, Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "window"})
	var window CreateSessionResponse
	decodeResponse(t, windowData, &window)
	parent.mu.Lock()
	rootWindowID := parent.panes[root.PaneID].windowID
	secondWindowID := parent.panes[window.PaneID].windowID
	parent.mu.Unlock()
	requestOperation(t, parent, 4, methodWindowSelect, SelectWindowRequest{SessionID: root.SessionID, WindowID: rootWindowID})
	requestOperation(t, parent, 5, methodPaneSelect, SelectPaneRequest{SessionID: root.SessionID, WindowID: rootWindowID, PaneID: split.PaneID})
	requestOperation(t, parent, 6, methodPaneZoom, ZoomPaneRequest{SessionID: root.SessionID, WindowID: rootWindowID, PaneID: split.PaneID})

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	prepared, err := parent.PrepareHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer prepared.Release()
	descriptors := make([]*os.File, len(prepared.Masters))
	for index, master := range prepared.Masters {
		duplicated, err := unix.Dup(int(master.Fd()))
		if err != nil {
			t.Fatal(err)
		}
		descriptors[index] = os.NewFile(uintptr(duplicated), "handoff-child-master")
	}
	adopted := NewHandoffOperations(home, true)
	defer adopted.Close()
	if err := adopted.AdoptHandoff(prepared.Manifest, descriptors); err != nil {
		t.Fatal(err)
	}
	if err := adopted.ActivateHandoffPersistence(); err != nil {
		t.Fatal(err)
	}
	topologyData := requestOperation(t, adopted, 7, methodSessionTopology, struct{}{})
	var topology TopologyResponse
	decodeResponse(t, topologyData, &topology)
	if len(topology.Sessions) != 1 || topology.Sessions[0].ActiveWindowID != rootWindowID {
		t.Fatalf("adopted active window = %#v, want %q", topology, rootWindowID)
	}
	for _, current := range topology.Sessions[0].Windows {
		if current.WindowID != rootWindowID {
			if current.WindowID == secondWindowID && len(current.Panes) != 1 {
				t.Fatalf("adopted second window = %#v", current)
			}
			continue
		}
		if current.ActivePaneID != split.PaneID || current.ZoomedPaneID != split.PaneID || current.Layout == nil || current.Layout.Direction != "vertical" || current.Layout.Ratio != 0.3 {
			t.Fatalf("adopted root window interaction state = %#v", current)
		}
		secondContext, secondCancel := context.WithTimeout(context.Background(), time.Second)
		defer secondCancel()
		second, err := adopted.PrepareHandoff(secondContext)
		if err != nil {
			t.Fatalf("prepare second handoff: %v", err)
		}
		defer second.Release()
		if len(second.Manifest.Topology) != 1 || second.Manifest.Topology[0].ActiveWindowID != rootWindowID || len(second.Manifest.Topology[0].Windows) != 2 {
			t.Fatalf("second handoff topology = %#v", second.Manifest.Topology)
		}
		var secondRoot *HandoffTopologyWindow
		for index := range second.Manifest.Topology[0].Windows {
			window := &second.Manifest.Topology[0].Windows[index]
			if window.WindowID == rootWindowID {
				secondRoot = window
			}
		}
		if secondRoot == nil || secondRoot.ActivePaneID != split.PaneID || secondRoot.ZoomedPaneID != split.PaneID || secondRoot.Layout == nil || secondRoot.Layout.Direction != "vertical" || secondRoot.Layout.Ratio != 0.3 || secondRoot.Layout.First == nil || secondRoot.Layout.First.PaneID != root.PaneID || secondRoot.Layout.Second == nil || secondRoot.Layout.Second.PaneID != split.PaneID {
			t.Fatalf("second handoff root interaction state = %#v", secondRoot)
		}
		return
	}
	t.Fatalf("adopted topology omitted root window %q: %#v", rootWindowID, topology)
}
