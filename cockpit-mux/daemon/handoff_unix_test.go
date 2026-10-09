//go:build darwin || linux

package daemon

import (
	"net"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

func TestHandoffTransfersVersionedManifestAndDescriptors(t *testing.T) {
	left, right := handoffSocketPair(t)
	defer left.Close()
	defer right.Close()
	master, err := os.CreateTemp(t.TempDir(), "mux-handoff-master-")
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	manifest := HandoffManifest{
		Version:       handoffManifestVersion,
		EngineVersion: "ghostty-v1",
		ListenerIndex: -1,
		Panes: []HandoffPane{{
			SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "session-1", WindowID: "window-1",
			MasterIndex: 0, ProcessGroupID: 1234, LeaderStartToken: "Tue Sep 9 12:34:56 2026", Boundary: "grounded", Snapshot: []byte("snapshot"), PrimarySnapshot: []byte("primary"), Metadata: []byte("metadata"),
		}},
		Topology: []HandoffTopologySession{{SessionID: "session-1", WindowOrder: []string{"window-1"}, Windows: []HandoffTopologyWindow{{WindowID: "window-1", Layout: &TopologyLayoutNode{PaneID: "pane-1"}}}}},
	}
	sent := make(chan error, 1)
	go func() { sent <- SendHandoff(left, manifest, []*os.File{master}) }()
	receivedManifest, masters, err := ReceiveHandoff(right)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, received := range masters {
			_ = received.Close()
		}
	}()
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if receivedManifest.EngineVersion != manifest.EngineVersion || len(receivedManifest.Panes) != 1 || receivedManifest.Panes[0].PaneID != "pane-1" || receivedManifest.Panes[0].LeaderStartToken != manifest.Panes[0].LeaderStartToken {
		t.Fatalf("received handoff manifest = %#v", receivedManifest)
	}
	if len(masters) != 1 {
		t.Fatalf("received masters = %d, want 1", len(masters))
	}
	if _, err := unix.FcntlInt(masters[0].Fd(), unix.F_GETFD, 0); err != nil {
		t.Fatalf("received descriptor is unusable: %v", err)
	}
}

func TestHandoffManifestRejectsInvalidDescriptorMap(t *testing.T) {
	manifest := HandoffManifest{
		Version: handoffManifestVersion, EngineVersion: "ghostty-v1", ListenerIndex: -1,
		Panes: []HandoffPane{{
			SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "session-1", WindowID: "window-1",
			MasterIndex: 1, ProcessGroupID: 1234, LeaderStartToken: "Tue Sep 9 12:34:56 2026", Boundary: "grounded", Snapshot: []byte("one"),
		}},
		Topology: []HandoffTopologySession{{SessionID: "session-1", WindowOrder: []string{"window-1"}, Windows: []HandoffTopologyWindow{{WindowID: "window-1", Layout: &TopologyLayoutNode{PaneID: "pane-1"}}}}},
	}
	if err := manifest.validate(); err != nil {
		t.Fatalf("structurally valid manifest error = %v", err)
	}
	if err := manifest.validateDescriptors(1); err == nil {
		t.Fatal("manifest accepted an out-of-range descriptor index")
	}
}

func TestHandoffManifestRejectsMissingLeaderIdentity(t *testing.T) {
	manifest := HandoffManifest{
		Version: handoffManifestVersion, EngineVersion: "ghostty-v1", ListenerIndex: -1,
		Panes: []HandoffPane{{
			SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "session-1", WindowID: "window-1",
			MasterIndex: 0, ProcessGroupID: 1234, Boundary: "grounded", Snapshot: []byte("snapshot"),
		}},
		Topology: []HandoffTopologySession{{SessionID: "session-1", WindowOrder: []string{"window-1"}, Windows: []HandoffTopologyWindow{{WindowID: "window-1", Layout: &TopologyLayoutNode{PaneID: "pane-1"}}}}},
	}
	if err := manifest.validate(); err == nil {
		t.Fatal("manifest without original leader identity was accepted")
	}
}

func TestHandoffManifestRejectsOlderVersionWithoutLeaderIdentity(t *testing.T) {
	manifest := HandoffManifest{Version: 4, EngineVersion: "ghostty-v1", ListenerIndex: -1}
	if err := manifest.validate(); err == nil {
		t.Fatal("legacy handoff manifest without original leader identity was accepted")
	}
}

func handoffSocketPair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	descriptors, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	leftFile := os.NewFile(uintptr(descriptors[0]), "mux-handoff-left")
	rightFile := os.NewFile(uintptr(descriptors[1]), "mux-handoff-right")
	left, err := net.FileConn(leftFile)
	if closeErr := leftFile.Close(); closeErr != nil && err == nil {
		err = closeErr
	}
	if err != nil {
		_ = rightFile.Close()
		t.Fatal(err)
	}
	right, err := net.FileConn(rightFile)
	if closeErr := rightFile.Close(); closeErr != nil && err == nil {
		err = closeErr
	}
	if err != nil {
		_ = left.Close()
		t.Fatal(err)
	}
	leftUnix, ok := left.(*net.UnixConn)
	if !ok {
		_ = left.Close()
		_ = right.Close()
		t.Fatal("left socket pair endpoint is not a UnixConn")
	}
	rightUnix, ok := right.(*net.UnixConn)
	if !ok {
		_ = left.Close()
		_ = right.Close()
		t.Fatal("right socket pair endpoint is not a UnixConn")
	}
	return leftUnix, rightUnix
}
