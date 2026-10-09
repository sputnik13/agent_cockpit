//go:build libghostty

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// NewHandoffOperations deliberately neither loads nor opens state.db: the
// parent daemon is still alive while its replacement imports live state. The
// child remembers the path but does not become a persistence writer until it
// has safely delivered its handoff ACK.
func NewHandoffOperations(home Home, persistScrollback bool, scrollbackLines ...uint) *Operations {
	operations := NewOperations()
	operations.handoffPersistencePath = filepath.Join(home.Path, "state.db")
	operations.persistScrollback = persistScrollback
	if len(scrollbackLines) > 0 && scrollbackLines[0] != 0 {
		operations.scrollbackLines = scrollbackLines[0]
	}
	return operations
}

// AdoptHandoff takes ownership of every pane descriptor named by manifest. On
// success, the matching entries are set to nil so callers can close the
// remaining listener/unused files without closing an adopted PTY.
func (operations *Operations) AdoptHandoff(manifest HandoffManifest, descriptors []*os.File) error {
	if err := VerifyHandoffManifest(manifest); err != nil {
		return err
	}
	if err := manifest.validateDescriptors(len(descriptors)); err != nil {
		return err
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if len(operations.sessions) != 0 {
		return fmt.Errorf("mux handoff target already has sessions")
	}
	for _, transferred := range manifest.Topology {
		state := &topologyState{
			activeWindowID:     transferred.ActiveWindowID,
			windowOrder:        append([]string(nil), transferred.WindowOrder...),
			activePaneByWindow: make(map[string]string, len(transferred.Windows)),
			zoomedPaneByWindow: make(map[string]string, len(transferred.Windows)),
			layoutByWindow:     make(map[string]*TopologyLayoutNode, len(transferred.Windows)),
		}
		for _, window := range transferred.Windows {
			state.activePaneByWindow[window.WindowID] = window.ActivePaneID
			state.zoomedPaneByWindow[window.WindowID] = window.ZoomedPaneID
			state.layoutByWindow[window.WindowID] = window.Layout
		}
		operations.topologyState[transferred.SessionID] = state
	}
	adopted := make([]*managedSession, 0, len(manifest.Panes))
	fail := func(err error) error {
		for _, session := range adopted {
			delete(operations.sessions, session.id)
			delete(operations.panes, session.paneID)
			if session.attachment != nil {
				if abandonable, ok := session.attachment.(interface{ AbandonUnstarted() error }); ok {
					_ = abandonable.AbandonUnstarted()
				}
			}
			if session.pane != nil {
				_ = session.pane.Close()
			}
		}
		return err
	}
	for _, state := range manifest.Panes {
		master := descriptors[state.MasterIndex]
		if master == nil {
			return fail(fmt.Errorf("mux handoff missing pane descriptor %d", state.MasterIndex))
		}
		pane, err := AdoptPane(master, state.ProcessGroupID, state.LeaderStartToken)
		if err != nil {
			return fail(err)
		}
		session := &managedSession{
			id: state.SessionID, paneID: state.PaneID, key: state.Key, projectID: state.ProjectID, broadcastGroup: state.BroadcastGroup,
			logicalSessionID: state.LogicalSessionID, windowID: state.WindowID, broadcastScope: state.BroadcastScope,
			pane: pane, broadcast: state.Broadcast, pinned: state.Pinned,
		}
		if session.projectID == "" {
			session.projectID = "standalone"
		}
		// Do not touch the shared catalog while the parent can still resume on a
		// NACK. Persistence starts only after all descriptors are adopted and the
		// child has acknowledged the handoff.
		attachment, err := newAdoptedSessionAttachment(pane, state, "", false, operations.persistScrollback, operations.scrollbackLines)
		if err != nil {
			_ = pane.Close()
			return fail(fmt.Errorf("adopt mux handoff pane %s: %w", state.PaneID, err))
		}
		session.attachment = attachment
		session.outputHistory = attachment
		descriptors[state.MasterIndex] = nil
		operations.sessions[session.id] = session
		operations.panes[session.paneID] = session
		operations.nextSession = maxIdentifierSuffix(operations.nextSession, session.id, "session-")
		operations.nextSession = maxIdentifierSuffix(operations.nextSession, session.paneID, "pane-")
		operations.nextWindow = maxIdentifierSuffix(operations.nextWindow, session.windowID, "window-")
		adopted = append(adopted, session)
	}
	for projectID, logicalID := range manifest.ActiveLogicalByProject {
		if operations.hasLogicalSessionLocked(logicalID) {
			operations.activeLogicalByProject[projectID] = logicalID
			operations.selectLogicalSessionLocked(logicalID)
		}
	}
	if operations.session == nil {
		operations.selectRemainingSessionLocked()
	}
	return nil
}

func maxIdentifierSuffix(current uint64, value, prefix string) uint64 {
	if !strings.HasPrefix(value, prefix) {
		return current
	}
	parsed, err := strconv.ParseUint(strings.TrimPrefix(value, prefix), 10, 64)
	if err != nil || parsed < current {
		return current
	}
	return parsed
}
