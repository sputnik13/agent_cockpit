//go:build libghostty

package daemon

import (
	"context"
	"fmt"
	"slices"
	"strings"
)

// PrepareHandoff pauses every live native reader at a grounded parser boundary
// and produces the exact manifest/descriptors that SendHandoff transfers. It
// rejects all mutating operations until PreparedHandoff.Release is called or a
// future ACK path commits the handoff and exits the old daemon.
func (operations *Operations) PrepareHandoff(ctx context.Context) (*PreparedHandoff, error) {
	operations.mu.Lock()
	if operations.handoffPrepared {
		operations.mu.Unlock()
		return nil, ErrHandoffInProgress
	}
	if len(operations.sessions) == 0 {
		operations.mu.Unlock()
		return nil, fmt.Errorf("mux handoff requires at least one live pane")
	}
	sessions := make([]*managedSession, 0, len(operations.sessions))
	for _, session := range operations.sessions {
		if session.pane == nil || session.attachment == nil {
			operations.mu.Unlock()
			return nil, fmt.Errorf("mux handoff cannot transfer exited pane %s", session.paneID)
		}
		if _, ok := session.attachment.(*shadowAttachment); !ok {
			operations.mu.Unlock()
			return nil, fmt.Errorf("mux handoff cannot transfer non-native pane %s", session.paneID)
		}
		sessions = append(sessions, session)
	}
	topology := operations.handoffTopologyLocked(sessions)
	operations.handoffPrepared = true
	operations.mu.Unlock()
	slices.SortFunc(sessions, func(left, right *managedSession) int { return strings.Compare(left.id, right.id) })
	prepared := &PreparedHandoff{operations: operations}
	fail := func(err error) (*PreparedHandoff, error) {
		prepared.Release()
		return nil, err
	}
	engineVersion, err := EngineVersion()
	if err != nil {
		return fail(err)
	}
	active := make(map[string]string, len(operations.activeLogicalByProject))
	for projectID, logicalID := range operations.activeLogicalByProject {
		active[projectID] = logicalID
	}
	prepared.Manifest = HandoffManifest{Version: handoffManifestVersion, EngineVersion: engineVersion, ListenerIndex: -1, Topology: topology, ActiveLogicalByProject: active}
	for index, session := range sessions {
		state, master, release, err := session.attachment.(*shadowAttachment).PrepareHandoff(ctx)
		if err != nil {
			return fail(fmt.Errorf("prepare mux handoff pane %s: %w", session.paneID, err))
		}
		prepared.releases = append(prepared.releases, release)
		prepared.Masters = append(prepared.Masters, master)
		prepared.Manifest.Panes = append(prepared.Manifest.Panes, HandoffPane{
			SessionID: session.id, PaneID: session.paneID, Key: session.key, ProjectID: session.projectID, BroadcastGroup: session.broadcastGroup,
			LogicalSessionID: session.logicalSessionID, WindowID: session.windowID, BroadcastScope: session.broadcastScope,
			Broadcast: session.broadcast, Pinned: session.pinned,
			MasterIndex: index, ProcessGroupID: session.pane.ProcessGroupID(), LeaderStartToken: session.pane.LeaderStartToken(), Boundary: state.Boundary, Snapshot: state.Snapshot, PrimarySnapshot: state.PrimarySnapshot, Metadata: state.Metadata,
		})
	}
	if err := prepared.Manifest.validate(); err != nil {
		return fail(err)
	}
	return prepared, nil
}

func (operations *Operations) handoffTopologyLocked(sessions []*managedSession) []HandoffTopologySession {
	windowsBySession := make(map[string]map[string]struct{})
	for _, session := range sessions {
		logicalID := logicalSessionID(session)
		windows := windowsBySession[logicalID]
		if windows == nil {
			windows = make(map[string]struct{})
			windowsBySession[logicalID] = windows
		}
		windows[session.windowID] = struct{}{}
	}
	logicalIDs := make([]string, 0, len(windowsBySession))
	for logicalID := range windowsBySession {
		logicalIDs = append(logicalIDs, logicalID)
	}
	slices.Sort(logicalIDs)
	result := make([]HandoffTopologySession, 0, len(logicalIDs))
	for _, logicalID := range logicalIDs {
		state := operations.topologyStateLocked(logicalID)
		windowIDs := normalizeWindowOrder(state.windowOrder, windowsBySession[logicalID])
		topology := HandoffTopologySession{SessionID: logicalID, WindowOrder: append([]string(nil), windowIDs...), ActiveWindowID: state.activeWindowID, Windows: make([]HandoffTopologyWindow, 0, len(windowIDs))}
		for _, windowID := range windowIDs {
			topology.Windows = append(topology.Windows, HandoffTopologyWindow{
				WindowID: windowID, ActivePaneID: state.activePaneByWindow[windowID], ZoomedPaneID: state.zoomedPaneByWindow[windowID], Layout: state.layoutByWindow[windowID],
			})
		}
		result = append(result, topology)
	}
	return result
}
