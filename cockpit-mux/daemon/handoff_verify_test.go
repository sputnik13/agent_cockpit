//go:build libghostty

package daemon

import (
	"strings"
	"testing"
)

func TestVerifyHandoffManifestImportsGroundedSnapshotsOnly(t *testing.T) {
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
	shadow.Feed([]byte("handoff active\r\n"))
	primary.Feed([]byte("handoff primary\r\n"))
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
	engineVersion, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	manifest := HandoffManifest{Version: handoffManifestVersion, EngineVersion: engineVersion, ListenerIndex: -1, Panes: []HandoffPane{{
		SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "session-1", WindowID: "window-1",
		MasterIndex: 0, ProcessGroupID: 1234, LeaderStartToken: "Tue Sep 9 12:34:56 2026", Boundary: "grounded", Snapshot: snapshot, PrimarySnapshot: primarySnapshot, Metadata: metadata,
	}}, Topology: []HandoffTopologySession{{SessionID: "session-1", WindowOrder: []string{"window-1"}, Windows: []HandoffTopologyWindow{{WindowID: "window-1", Layout: &TopologyLayoutNode{PaneID: "pane-1"}}}}}}
	if err := VerifyHandoffManifest(manifest); err != nil {
		t.Fatalf("verify grounded handoff manifest: %v", err)
	}
	manifest.Panes[0].Boundary = "forced"
	if err := VerifyHandoffManifest(manifest); err == nil || !strings.Contains(err.Error(), "invalid mux handoff pane") {
		t.Fatalf("forced handoff manifest error = %v", err)
	}
}

func TestVerifyHandoffManifestRejectsDuplicateIDsAndUnknownActiveWindow(t *testing.T) {
	manifest := HandoffManifest{Version: handoffManifestVersion, EngineVersion: "ghostty-v1", ListenerIndex: -1,
		Panes:    []HandoffPane{{SessionID: "session-1", PaneID: "pane-1", LogicalSessionID: "logical-1", WindowID: "window-1", MasterIndex: 0, ProcessGroupID: 1234, LeaderStartToken: "Tue Sep 9 12:34:56 2026", Boundary: "grounded", Snapshot: []byte("snapshot")}},
		Topology: []HandoffTopologySession{{SessionID: "logical-1", WindowOrder: []string{"window-1"}, ActiveWindowID: "window-1", Windows: []HandoffTopologyWindow{{WindowID: "window-1", Layout: &TopologyLayoutNode{PaneID: "pane-1"}}}}},
	}
	if err := manifest.validate(); err != nil {
		t.Fatalf("valid baseline handoff manifest: %v", err)
	}

	missingOrder := manifest
	missingOrder.Topology = append([]HandoffTopologySession(nil), manifest.Topology...)
	missingOrder.Topology[0].WindowOrder = nil
	if err := missingOrder.validate(); err == nil || !strings.Contains(err.Error(), "window order") {
		t.Fatalf("missing window order error = %v", err)
	}

	unknownActive := manifest
	unknownActive.Topology = append([]HandoffTopologySession(nil), manifest.Topology...)
	unknownActive.Topology[0].ActiveWindowID = "window-missing"
	if err := unknownActive.validate(); err == nil || !strings.Contains(err.Error(), "active window") {
		t.Fatalf("unknown active window error = %v", err)
	}

	duplicateSession := manifest
	duplicateSession.Panes = append(append([]HandoffPane(nil), manifest.Panes...), manifest.Panes[0])
	duplicateSession.Panes[1].PaneID = "pane-2"
	duplicateSession.Panes[1].MasterIndex = 1
	if err := duplicateSession.validate(); err == nil || !strings.Contains(err.Error(), "duplicate mux handoff session") {
		t.Fatalf("duplicate session error = %v", err)
	}

	duplicatePane := manifest
	duplicatePane.Panes = append(append([]HandoffPane(nil), manifest.Panes...), manifest.Panes[0])
	duplicatePane.Panes[1].SessionID = "session-2"
	duplicatePane.Panes[1].MasterIndex = 1
	if err := duplicatePane.validate(); err == nil || !strings.Contains(err.Error(), "duplicate mux handoff pane") {
		t.Fatalf("duplicate pane error = %v", err)
	}
}
