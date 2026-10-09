//go:build darwin || linux

package daemon

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sync"

	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/sys/unix"
)

const (
	handoffManifestVersion uint16 = 5
	handoffControlTag             = "CMUXH1"
)

// HandoffManifest is the versioned state contract exchanged by two daemon
// processes. The descriptor order is explicit rather than inferred from map
// iteration: pane.MasterIndex identifies the matching SCM_RIGHTS entry.
//
// This type intentionally contains only transfer state. The parent/child
// lifecycle (pause, verified import, ACK/NACK, and old-daemon exit) remains
// responsible for deciding when it is safe to call SendHandoff.
type HandoffManifest struct {
	Version       uint16 `msgpack:"version"`
	EngineVersion string `msgpack:"engine_version"`
	// ListenerIndex is -1 during preflight-only verification. A committed
	// handoff names the inherited listening socket's descriptor index.
	ListenerIndex          int                      `msgpack:"listener_index"`
	Panes                  []HandoffPane            `msgpack:"panes"`
	Topology               []HandoffTopologySession `msgpack:"topology"`
	ActiveLogicalByProject map[string]string        `msgpack:"active_logical_by_project,omitempty"`
}

// HandoffTopologySession captures daemon-owned interaction state that cannot
// be inferred from PTY descriptors: session-owned window placement, the active
// window/pane, zoom, and exact binary split tree must survive a live upgrade
// unchanged.
type HandoffTopologySession struct {
	SessionID      string                  `msgpack:"session_id"`
	WindowOrder    []string                `msgpack:"window_order"`
	ActiveWindowID string                  `msgpack:"active_window_id,omitempty"`
	Windows        []HandoffTopologyWindow `msgpack:"windows"`
}

type HandoffTopologyWindow struct {
	WindowID     string              `msgpack:"window_id"`
	ActivePaneID string              `msgpack:"active_pane_id,omitempty"`
	ZoomedPaneID string              `msgpack:"zoomed_pane_id,omitempty"`
	Layout       *TopologyLayoutNode `msgpack:"layout,omitempty"`
}

type HandoffPane struct {
	SessionID        string `msgpack:"session_id"`
	PaneID           string `msgpack:"pane_id"`
	Key              string `msgpack:"key,omitempty"`
	ProjectID        string `msgpack:"project_id,omitempty"`
	BroadcastGroup   string `msgpack:"broadcast_group,omitempty"`
	LogicalSessionID string `msgpack:"logical_session_id"`
	WindowID         string `msgpack:"window_id"`
	BroadcastScope   string `msgpack:"broadcast_scope"`
	Broadcast        bool   `msgpack:"broadcast"`
	Pinned           bool   `msgpack:"pinned"`
	MasterIndex      int    `msgpack:"master_index"`
	ProcessGroupID   int    `msgpack:"process_group_id"`
	LeaderStartToken string `msgpack:"leader_start_token"`
	Boundary         string `msgpack:"boundary"`
	Snapshot         []byte `msgpack:"snapshot"`
	PrimarySnapshot  []byte `msgpack:"primary_snapshot"`
	Metadata         []byte `msgpack:"metadata"`
}

// HandoffResult is the explicit child-to-parent acknowledgement. A failed
// verification is never inferred from process exit: the old daemon keeps every
// descriptor until it receives Accepted=true.
type HandoffResult struct {
	Accepted bool   `msgpack:"accepted"`
	Error    string `msgpack:"error,omitempty"`
}

// HandoffState is captured while a native attachment's reader is paused. It
// deliberately excludes identifiers and descriptors; Operations adds those
// daemon-owned identities when it constructs the full manifest.
type HandoffState struct {
	Boundary        string
	Snapshot        []byte
	PrimarySnapshot []byte
	Metadata        []byte
}

// PreparedHandoff owns the pause-release closures for one all-pane handoff
// attempt. Release is mandatory on every non-commit outcome; it is idempotent
// so timeout, NACK, and parent-error paths can safely converge on it.
type PreparedHandoff struct {
	Manifest HandoffManifest
	Masters  []*os.File

	operations *Operations
	releases   []func()
	once       sync.Once
}

func (prepared *PreparedHandoff) Release() {
	prepared.once.Do(func() {
		for _, release := range prepared.releases {
			release()
		}
		prepared.operations.mu.Lock()
		prepared.operations.handoffPrepared = false
		prepared.operations.mu.Unlock()
	})
}

func (manifest HandoffManifest) validate() error {
	if manifest.Version != handoffManifestVersion {
		return fmt.Errorf("unsupported mux handoff manifest version %d", manifest.Version)
	}
	if manifest.EngineVersion == "" {
		return fmt.Errorf("mux handoff manifest has no engine version")
	}
	if manifest.ListenerIndex < -1 {
		return fmt.Errorf("invalid mux handoff listener descriptor index %d", manifest.ListenerIndex)
	}
	seenDescriptors := make(map[int]struct{}, len(manifest.Panes))
	seenSessions := make(map[string]struct{}, len(manifest.Panes))
	seenPanes := make(map[string]struct{}, len(manifest.Panes))
	logicalWindows := make(map[string]map[string]map[string]struct{})
	for _, pane := range manifest.Panes {
		if pane.SessionID == "" || pane.PaneID == "" || pane.LogicalSessionID == "" || pane.WindowID == "" || pane.MasterIndex < 0 || pane.ProcessGroupID <= 0 || pane.LeaderStartToken == "" || pane.Boundary != "grounded" || len(pane.Snapshot) == 0 {
			return fmt.Errorf("invalid mux handoff pane %q", pane.PaneID)
		}
		if pane.MasterIndex == manifest.ListenerIndex {
			return fmt.Errorf("mux handoff pane %q overlaps the listener descriptor", pane.PaneID)
		}
		if _, exists := seenDescriptors[pane.MasterIndex]; exists {
			return fmt.Errorf("duplicate mux handoff descriptor index %d", pane.MasterIndex)
		}
		seenDescriptors[pane.MasterIndex] = struct{}{}
		if _, exists := seenSessions[pane.SessionID]; exists {
			return fmt.Errorf("duplicate mux handoff session %q", pane.SessionID)
		}
		seenSessions[pane.SessionID] = struct{}{}
		if _, exists := seenPanes[pane.PaneID]; exists {
			return fmt.Errorf("duplicate mux handoff pane %q", pane.PaneID)
		}
		seenPanes[pane.PaneID] = struct{}{}
		windows := logicalWindows[pane.LogicalSessionID]
		if windows == nil {
			windows = make(map[string]map[string]struct{})
			logicalWindows[pane.LogicalSessionID] = windows
		}
		panes := windows[pane.WindowID]
		if panes == nil {
			panes = make(map[string]struct{})
			windows[pane.WindowID] = panes
		}
		panes[pane.PaneID] = struct{}{}
	}
	if len(manifest.Topology) != len(logicalWindows) {
		return fmt.Errorf("mux handoff topology has %d logical sessions, want %d", len(manifest.Topology), len(logicalWindows))
	}
	seenTopology := make(map[string]struct{}, len(manifest.Topology))
	for _, state := range manifest.Topology {
		if state.SessionID == "" {
			return fmt.Errorf("mux handoff topology has no session id")
		}
		if _, exists := seenTopology[state.SessionID]; exists {
			return fmt.Errorf("duplicate mux handoff topology session %q", state.SessionID)
		}
		seenTopology[state.SessionID] = struct{}{}
		expectedWindows, exists := logicalWindows[state.SessionID]
		if !exists || len(state.Windows) != len(expectedWindows) {
			return fmt.Errorf("mux handoff topology windows do not match logical session %q", state.SessionID)
		}
		if len(state.WindowOrder) != len(expectedWindows) {
			return fmt.Errorf("mux handoff topology window order does not match logical session %q", state.SessionID)
		}
		seenOrder := make(map[string]struct{}, len(state.WindowOrder))
		for _, windowID := range state.WindowOrder {
			if _, exists := expectedWindows[windowID]; !exists {
				return fmt.Errorf("mux handoff topology window order has unknown window %q", windowID)
			}
			if _, duplicate := seenOrder[windowID]; duplicate {
				return fmt.Errorf("duplicate mux handoff topology window order %q", windowID)
			}
			seenOrder[windowID] = struct{}{}
		}
		seenWindows := make(map[string]struct{}, len(state.Windows))
		for _, window := range state.Windows {
			panes, exists := expectedWindows[window.WindowID]
			if !exists {
				return fmt.Errorf("mux handoff topology has unknown window %q", window.WindowID)
			}
			if _, duplicate := seenWindows[window.WindowID]; duplicate {
				return fmt.Errorf("duplicate mux handoff topology window %q", window.WindowID)
			}
			seenWindows[window.WindowID] = struct{}{}
			if window.ActivePaneID != "" {
				if _, exists := panes[window.ActivePaneID]; !exists {
					return fmt.Errorf("mux handoff topology active pane %q is not in window %q", window.ActivePaneID, window.WindowID)
				}
			}
			if window.ZoomedPaneID != "" {
				if _, exists := panes[window.ZoomedPaneID]; !exists {
					return fmt.Errorf("mux handoff topology zoomed pane %q is not in window %q", window.ZoomedPaneID, window.WindowID)
				}
			}
			if err := validateHandoffLayout(window.Layout, panes); err != nil {
				return fmt.Errorf("mux handoff topology window %q: %w", window.WindowID, err)
			}
		}
		if state.ActiveWindowID != "" {
			if _, exists := seenWindows[state.ActiveWindowID]; !exists {
				return fmt.Errorf("mux handoff topology active window %q is not in logical session %q", state.ActiveWindowID, state.SessionID)
			}
		}
	}
	return nil
}

func validateHandoffLayout(layout *TopologyLayoutNode, expected map[string]struct{}) error {
	if layout == nil {
		return errors.New("has no layout")
	}
	leaves := make(map[string]struct{}, len(expected))
	var visit func(*TopologyLayoutNode) error
	visit = func(node *TopologyLayoutNode) error {
		if node == nil {
			return errors.New("has an empty layout node")
		}
		if node.PaneID != "" {
			if node.Direction != "" || node.First != nil || node.Second != nil {
				return fmt.Errorf("leaf pane %q has split fields", node.PaneID)
			}
			if _, exists := expected[node.PaneID]; !exists {
				return fmt.Errorf("references unknown pane %q", node.PaneID)
			}
			if _, duplicate := leaves[node.PaneID]; duplicate {
				return fmt.Errorf("references pane %q twice", node.PaneID)
			}
			leaves[node.PaneID] = struct{}{}
			return nil
		}
		if (node.Direction != "horizontal" && node.Direction != "vertical") || node.Ratio <= 0 || node.Ratio >= 1 {
			return errors.New("has an invalid split")
		}
		if err := visit(node.First); err != nil {
			return err
		}
		return visit(node.Second)
	}
	if err := visit(layout); err != nil {
		return err
	}
	if len(leaves) != len(expected) {
		return errors.New("does not include every pane")
	}
	return nil
}

func (manifest HandoffManifest) validateDescriptors(descriptorCount int) error {
	expected := len(manifest.Panes)
	if manifest.ListenerIndex >= 0 {
		expected++
	}
	if descriptorCount != expected {
		return fmt.Errorf("mux handoff has %d descriptors, want %d", descriptorCount, expected)
	}
	if manifest.ListenerIndex >= descriptorCount {
		return fmt.Errorf("mux handoff listener descriptor index %d is out of range", manifest.ListenerIndex)
	}
	for _, pane := range manifest.Panes {
		if pane.MasterIndex >= descriptorCount {
			return fmt.Errorf("mux handoff master descriptor index %d is out of range", pane.MasterIndex)
		}
	}
	return nil
}

// SendHandoff transfers the owned PTY master descriptors atomically with a
// fixed control tag, then writes the potentially-large MessagePack manifest as
// an ordinary framed record. Splitting the two avoids imposing a snapshot-size
// ceiling on sendmsg while preserving descriptor/message ordering on the same
// Unix stream.
func SendHandoff(connection *net.UnixConn, manifest HandoffManifest, masters []*os.File) error {
	if err := manifest.validate(); err != nil {
		return err
	}
	if err := manifest.validateDescriptors(len(masters)); err != nil {
		return err
	}
	fileDescriptors := make([]int, len(masters))
	for index, master := range masters {
		if master == nil {
			return fmt.Errorf("nil mux handoff master at index %d", index)
		}
		fileDescriptors[index] = int(master.Fd())
	}
	if err := sendHandoffControl(connection, fileDescriptors); err != nil {
		return err
	}
	payload, err := msgpack.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode mux handoff manifest: %w", err)
	}
	if err := protocol.Write(connection, payload); err != nil {
		return fmt.Errorf("write mux handoff manifest: %w", err)
	}
	return nil
}

// ReceiveHandoff validates and returns independently-owned descriptor files.
// The caller closes every returned file on NACK or after successful import.
func ReceiveHandoff(connection *net.UnixConn) (HandoffManifest, []*os.File, error) {
	var tag [len(handoffControlTag)]byte
	received, err := receiveHandoffControl(connection, tag[:])
	if err != nil {
		return HandoffManifest{}, nil, err
	}
	masters := make([]*os.File, 0, len(received))
	for index, fd := range received {
		masters = append(masters, os.NewFile(uintptr(fd), fmt.Sprintf("mux-handoff-master-%d", index)))
	}
	closeMasters := func() {
		for _, master := range masters {
			_ = master.Close()
		}
	}
	var payload []byte
	if err := protocol.Read(connection, &payload); err != nil {
		closeMasters()
		return HandoffManifest{}, nil, fmt.Errorf("read mux handoff manifest: %w", err)
	}
	var manifest HandoffManifest
	if err := msgpack.Unmarshal(payload, &manifest); err != nil {
		closeMasters()
		return HandoffManifest{}, nil, fmt.Errorf("decode mux handoff manifest: %w", err)
	}
	if err := manifest.validate(); err != nil {
		closeMasters()
		return HandoffManifest{}, nil, err
	}
	if err := manifest.validateDescriptors(len(masters)); err != nil {
		closeMasters()
		return HandoffManifest{}, nil, err
	}
	return manifest, masters, nil
}

func sendHandoffControl(connection *net.UnixConn, descriptors []int) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return fmt.Errorf("access mux handoff socket: %w", err)
	}
	var sendErr error
	if err := raw.Write(func(fd uintptr) bool {
		written, err := unix.SendmsgN(int(fd), []byte(handoffControlTag), unix.UnixRights(descriptors...), nil, 0)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
			return false
		}
		if err != nil {
			sendErr = fmt.Errorf("send mux handoff descriptors: %w", err)
			return true
		}
		if written != len(handoffControlTag) {
			sendErr = fmt.Errorf("short mux handoff descriptor tag write: %d", written)
		}
		return true
	}); err != nil {
		return fmt.Errorf("write mux handoff descriptors: %w", err)
	}
	return sendErr
}

func receiveHandoffControl(connection *net.UnixConn, tag []byte) ([]int, error) {
	raw, err := connection.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("access mux handoff socket: %w", err)
	}
	oob := make([]byte, unix.CmsgSpace(4096))
	var received []int
	var receiveErr error
	if err := raw.Read(func(fd uintptr) bool {
		count, controlCount, _, _, err := unix.Recvmsg(int(fd), tag, oob, 0)
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
			return false
		}
		if err != nil {
			receiveErr = fmt.Errorf("receive mux handoff descriptors: %w", err)
			return true
		}
		if count != len(handoffControlTag) || string(tag) != handoffControlTag {
			receiveErr = fmt.Errorf("invalid mux handoff descriptor tag")
			return true
		}
		messages, err := unix.ParseSocketControlMessage(oob[:controlCount])
		if err != nil {
			receiveErr = fmt.Errorf("parse mux handoff descriptors: %w", err)
			return true
		}
		for _, message := range messages {
			rights, err := unix.ParseUnixRights(&message)
			if err != nil {
				receiveErr = fmt.Errorf("parse mux handoff descriptor rights: %w", err)
				return true
			}
			received = append(received, rights...)
		}
		return true
	}); err != nil {
		return nil, fmt.Errorf("read mux handoff descriptors: %w", err)
	}
	return received, receiveErr
}
