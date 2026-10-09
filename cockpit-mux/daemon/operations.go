package daemon

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
	"github.com/local-repo-explorer/cockpit-mux/persistence/history"
	"github.com/local-repo-explorer/cockpit-mux/protocol"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	methodSessionCreate         = "session.create"
	methodSessionAttach         = "session.attach"
	methodSessionDetach         = "session.detach"
	methodSessionDestroy        = "session.destroy"
	methodSessionList           = "session.list"
	methodSessionTopology       = "session.topology"
	methodSessionPin            = "session.pin"
	methodSessionBroadcastScope = "session.broadcastScope"
	methodWindowSelect          = "window.select"
	methodPaneSelect            = "pane.select"
	methodPaneZoom              = "pane.zoom"
	methodPaneSplit             = "pane.split"
	methodPaneResizeSplit       = "pane.resizeSplit"
	methodWindowNew             = "window.new"
	methodWindowDestroy         = "window.destroy"
	methodPaneWrite             = "pane.write"
	methodPaneResize            = "pane.resize"
	methodPaneOutput            = "pane.output"
	methodPaneBroadcast         = "pane.broadcast"
	methodScrollbackQuery       = "scrollback.query"
	methodMuxConfigure          = "mux.configure"
	methodMuxShutdown           = "mux.shutdown"
)

var (
	ErrSessionExists     = errors.New("mux session already exists")
	ErrSessionNotFound   = errors.New("mux session not found")
	ErrPaneNotFound      = errors.New("mux pane not found")
	ErrInvalidGeometry   = errors.New("mux pane geometry must be non-zero")
	ErrCommandRequired   = errors.New("mux pane command is required")
	ErrPaneExited        = errors.New("mux pane is recovered and read-only")
	ErrLiveSessions      = errors.New("mux shutdown refused while live sessions exist")
	ErrSessionStolen     = errors.New("mux session is attached by another client")
	ErrHandoffInProgress = errors.New("mux handoff is in progress")
	ErrRecoveryConflict  = errors.New("mux recovery record must be explicitly destroyed before creating a session")
	ErrProjectScope      = errors.New("mux request cannot access another project's session")
	ErrUnknownOperation  = errors.New("unknown mux operation")
)

// Operations owns daemon sessions. Session state belongs to the daemon, not to a
// socket connection: disconnecting a client never closes a Pane or child process.
// `session` remains the recovery-record compatibility handle; live lookup uses
// the maps so every pane has a stable independently addressable identity.
type Operations struct {
	mu              sync.Mutex
	starter         PaneStarter
	persistencePath string
	// handoffPersistencePath is intentionally separate until the child has
	// delivered its ACK. A failed adoption must be a purely in-memory attempt:
	// the still-running parent remains the only writer to state.db.
	handoffPersistencePath string
	persistScrollback      bool
	scrollbackLines        uint
	recoveryErr            error
	session                *managedSession
	sessions               map[string]*managedSession
	panes                  map[string]*managedSession
	nextSession            uint64
	nextWindow             uint64
	topologyState          map[string]*topologyState
	activeLogicalByProject map[string]string
	// topologyEpoch changes every time the daemon starts. A recovered daemon
	// begins its revision counter again, so clients compare revisions only
	// within this epoch.
	topologyEpoch string
	// topologyRevision is assigned under mu whenever a snapshot is assembled.
	// It is a daemon-instance monotonic clock, not a persisted user preference.
	// Its sole job is to let Cockpit discard an IPC response that was queued
	// before a later create/select/close lifecycle operation.
	topologyRevision uint64
	handoffPrepared  bool
	cleanupStop      chan struct{}
	cleanupOnce      sync.Once
}

// topologyState is the daemon-owned interaction state for one logical mux
// session. It remains separate from managedSession because a logical session
// has many independent PTY records.
type topologyState struct {
	activeWindowID     string
	windowOrder        []string
	activePaneByWindow map[string]string
	zoomedPaneByWindow map[string]string
	layoutByWindow     map[string]*TopologyLayoutNode
}

// TopologyLayoutNode is a content-free binary split tree. Leaves carry PaneID;
// branches carry a direction, a first-child ratio, and two children.
type TopologyLayoutNode struct {
	PaneID    string              `msgpack:"pane_id,omitempty" json:"pane_id,omitempty"`
	Direction string              `msgpack:"direction,omitempty" json:"direction,omitempty"`
	Ratio     float64             `msgpack:"ratio,omitempty" json:"ratio,omitempty"`
	First     *TopologyLayoutNode `msgpack:"first,omitempty" json:"first,omitempty"`
	Second    *TopologyLayoutNode `msgpack:"second,omitempty" json:"second,omitempty"`
}

// persistedWindowTopology occupies windows.layout_json, which is already part
// of the non-content mux catalog. It intentionally excludes terminal bytes.
type persistedWindowTopology struct {
	ActiveWindow bool                `json:"active_window,omitempty"`
	ActivePaneID string              `json:"active_pane_id,omitempty"`
	ZoomedPaneID string              `json:"zoomed_pane_id,omitempty"`
	Layout       *TopologyLayoutNode `json:"layout,omitempty"`
}

// PaneStarter lets tests provide a deterministic PTY launcher while production uses
// StartPane. It deliberately returns the existing Pane abstraction so all writes and
// resizes continue to use its raw-byte PTY boundary.
type PaneStarter func(command string, args ...string) (*Pane, error)

type managedSession struct {
	id                 string
	paneID             string
	key                string
	projectID          string
	broadcastGroup     string
	logicalSessionID   string
	windowID           string
	broadcastScope     string
	pane               *Pane
	attachment         sessionAttachment
	outputHistory      paneOutputHistory
	broadcast          bool
	pinned             bool
	cwd                string
	command            string
	cols               uint16
	rows               uint16
	clientID           string
	clientKind         string
	recoveryDiagnostic string
}

// paneOutputHistory retains only the in-memory PTY stream after a pane exits.
// It deliberately excludes attachment/database APIs, which are closed as part
// of normal lifecycle cleanup.
type paneOutputHistory interface {
	OutputsFromBounded(sequence uint64, maximumBytes int) []Output
}

// sessionAttachment is the native-only data path that ties one owned PTY to its
// Ghostty shadow. A no-native build keeps the control plane testable but cannot
// emit a reattach seed.
type sessionAttachment interface {
	Attach(cols, rows, cellWidth, cellHeight uint16) (Seed, error)
	Resize(cols, rows uint16) error
	OutputsFrom(sequence uint64) []Output
	OutputsFromBounded(sequence uint64, maximumBytes int) []Output
	Scrollback(before, count uint) ([]ScrollbackLine, error)
	SetScrollbackLines(lines uint) error
	SetPersistScrollback(enabled bool) error
	EnablePersistence(path, paneID string, mirrorLegacy, persistScrollback bool) error
	Start() error
	Finalize() error
	Close() error
	Done() <-chan struct{}
}

const (
	DefaultScrollbackLines uint = 10_000
	MaxScrollbackLines     uint = 1_000_000
)

// NewOperations returns the request handler state for one standalone mux daemon.
func NewOperations() *Operations {
	return &Operations{
		starter:                StartPane,
		sessions:               make(map[string]*managedSession),
		panes:                  make(map[string]*managedSession),
		topologyState:          make(map[string]*topologyState),
		activeLogicalByProject: make(map[string]string),
		topologyEpoch:          newTopologyEpoch(),
		scrollbackLines:        DefaultScrollbackLines,
	}
}

// NewPersistentOperations enables M1B recovery state for the standalone
// daemon. Tests and pure protocol consumers may continue to use NewOperations.
func NewPersistentOperations(home Home) *Operations {
	return NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
}

// PersistentOptions are daemon-wide because one mux home is shared by all
// Cockpit installations for that user and host.
type PersistentOptions struct {
	PersistScrollback bool
	ScrollbackLines   uint
}

// NewPersistentOperationsWithOptions enables persistence with an explicit
// privacy policy. The compatibility constructor above remains content-persistent
// by default.
func NewPersistentOperationsWithOptions(home Home, options PersistentOptions) *Operations {
	if options.ScrollbackLines == 0 {
		options.ScrollbackLines = DefaultScrollbackLines
	}
	path := filepath.Join(home.Path, "state.db")
	operations := &Operations{
		starter:                StartPane,
		persistencePath:        path,
		persistScrollback:      options.PersistScrollback,
		scrollbackLines:        options.ScrollbackLines,
		sessions:               make(map[string]*managedSession),
		panes:                  make(map[string]*managedSession),
		topologyState:          make(map[string]*topologyState),
		activeLogicalByProject: make(map[string]string),
		topologyEpoch:          newTopologyEpoch(),
		cleanupStop:            make(chan struct{}),
	}
	operations.cleanupCatalog()
	go operations.cleanupLoop()
	recoveredCatalog, catalogErr := loadRecoveredCatalog(path)
	legacy, legacyErr := loadRecoveredSession(path)
	if len(recoveredCatalog) > 0 {
		for _, session := range recoveredCatalog {
			operations.sessions[session.id] = session
			operations.panes[session.paneID] = session
			operations.session = session
		}
	} else if legacy != nil {
		operations.session = legacy
		operations.sessions[legacy.id] = legacy
		operations.panes[legacy.paneID] = legacy
	} else if catalogErr != nil {
		operations.recoveryErr = catalogErr
	} else {
		operations.recoveryErr = legacyErr
	}
	for _, session := range operations.sessions {
		operations.observeRecoveredIdentifiers(session)
	}
	operations.rebuildTopologyLocked()
	operations.loadPersistedTopologyLocked()
	operations.loadActiveLogicalSessionsLocked()
	return operations
}

func (operations *Operations) PersistScrollback() bool {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	return operations.persistScrollback
}

func (operations *Operations) ScrollbackLines() uint {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	return operations.scrollbackLines
}

func (operations *Operations) cleanupCatalog() {
	if operations.persistencePath == "" {
		return
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return
	}
	defer store.Close()
	_, _ = store.Evict(time.Now(), persistence.DefaultRetentionDays, persistence.DefaultDatabaseCap)
}

func (operations *Operations) cleanupLoop() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-operations.cleanupStop:
			return
		case <-ticker.C:
			operations.cleanupCatalog()
		}
	}
}

func (operations *Operations) stopCleanup() {
	if operations.cleanupStop != nil {
		operations.cleanupOnce.Do(func() { close(operations.cleanupStop) })
	}
}

// persistTopologyLocked keeps the M3 lifecycle catalog separate from the
// M1 recovery payload while storing both in the same private database. The
// caller holds operations.mu, so a topology update describes one coherent mux
// operation even though SQLite commits its catalog rows independently.
func (operations *Operations) persistTopologyLocked(session *managedSession) error {
	if operations.persistencePath == "" {
		return nil
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux lifecycle catalog: %w", err)
	}
	defer store.Close()
	name := session.key
	if name == "" {
		name = session.logicalSessionID
	}
	now := time.Now()
	if err := store.UpsertSession(persistence.SessionRecord{
		ID: session.logicalSessionID, Name: name, ProjectID: session.projectID, Kind: "local", Status: "live",
		Pinned: session.pinned, CreatedAt: now, LastAttachedAt: now,
	}); err != nil {
		return fmt.Errorf("persist mux session lifecycle: %w", err)
	}
	if err := store.UpsertWindow(persistence.WindowRecord{
		ID: session.windowID, SessionID: session.logicalSessionID, Name: session.windowID, Index: operations.windowPlacementIndexLocked(session), LayoutJSON: "{}",
	}); err != nil {
		return fmt.Errorf("persist mux window lifecycle: %w", err)
	}
	if err := store.UpsertPane(persistence.PaneRecord{
		ID: session.paneID, WindowID: session.windowID, SessionID: session.logicalSessionID,
		Cwd: session.cwd, Command: session.command, Cols: int(session.cols), Rows: int(session.rows), Broadcast: session.broadcast,
	}); err != nil {
		return fmt.Errorf("persist mux pane lifecycle: %w", err)
	}
	return nil
}

func (operations *Operations) persistPinLocked(session *managedSession) error {
	if operations.persistencePath == "" {
		return nil
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux lifecycle catalog: %w", err)
	}
	defer store.Close()
	if err := store.SetSessionPinned(session.logicalSessionID, session.pinned); err != nil {
		return fmt.Errorf("persist mux session pin: %w", err)
	}
	return nil
}

func (operations *Operations) destroyPersistedPaneLocked(session *managedSession) error {
	if operations.persistencePath == "" {
		return nil
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux lifecycle catalog: %w", err)
	}
	defer store.Close()
	archive, err := history.Open(filepath.Join(filepath.Dir(operations.persistencePath), "history.db"))
	if err != nil {
		return fmt.Errorf("open mux history archive: %w", err)
	}
	defer archive.Close()
	if err := archive.ReapPane(session.paneID); err != nil {
		return fmt.Errorf("reap mux pane history: %w", err)
	}
	if err := store.DestroyPane(session.paneID); err != nil {
		return fmt.Errorf("destroy mux pane lifecycle: %w", err)
	}
	return nil
}

// watchPaneExit makes the owned child process the canonical lifecycle signal.
// Native attachments drain their final PTY bytes first; the pure-Go control-plane
// build has no attachment and must still surface a normal child exit.
func (operations *Operations) watchPaneExit(session *managedSession) {
	if session.pane == nil {
		return
	}
	sessionID, paneID, pane, attachment := session.id, session.paneID, session.pane, session.attachment
	go func() {
		waitErr := pane.Wait()
		// Owned panes already performed this cleanup before reaping their shell.
		// Adopted panes do not own/reap the leader and must stop only the members
		// whose identities were captured while that leader was verifiable.
		processErr := pane.terminateSessionProcesses()
		operations.mu.Lock()
		defer operations.mu.Unlock()
		current := operations.sessions[sessionID]
		if current == nil || current.paneID != paneID || current.pane != pane || current.attachment != attachment {
			return
		}
		// Serialize native attachment finalization with Operations.Close. Both
		// paths own the same recorder and SQLite handles; touching the attachment
		// before taking operations.mu allowed Close/Finalize to race its teardown.
		var attachmentErr error
		if attachment != nil {
			select {
			case <-attachment.Done():
				attachmentErr = errors.Join(attachmentErr, attachment.Finalize())
			case <-time.After(2 * time.Second):
				// A helper may have retained the PTY despite session cleanup. Stop
				// the reader before closing stores; Finalize cannot safely run after
				// Close has released those native/database resources.
				attachmentErr = errors.Join(attachmentErr, attachment.Close())
			}
			attachmentErr = errors.Join(attachmentErr, attachment.Close())
		}
		paneErr := pane.Close()
		if err := errors.Join(waitErr, processErr, attachmentErr, paneErr); err != nil {
			current.recoveryDiagnostic = err.Error()
		}
		current.pane = nil
		// The attachment's SQLite/native resources are closed, but retain the
		// narrow in-memory stream reference so clients can drain final PTY bytes.
		current.attachment = nil
		current.clientID = ""
		current.clientKind = ""
		if err := operations.markLogicalSessionDeadLocked(logicalSessionID(current)); err != nil {
			current.recoveryDiagnostic = err.Error()
		}
	}()
}

func (operations *Operations) markLogicalSessionDeadLocked(logicalID string) error {
	if logicalID == "" || operations.persistencePath == "" {
		return nil
	}
	for _, session := range operations.sessions {
		if logicalSessionID(session) == logicalID && session.pane != nil {
			return nil
		}
	}
	archive, archiveErr := history.Open(filepath.Join(filepath.Dir(operations.persistencePath), "history.db"))
	if archiveErr == nil {
		for _, session := range operations.sessions {
			if logicalSessionID(session) != logicalID {
				continue
			}
			if err := archive.ReapPane(session.paneID); err != nil && archiveErr == nil {
				archiveErr = err
			}
		}
		if err := archive.Close(); err != nil && archiveErr == nil {
			archiveErr = err
		}
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux lifecycle catalog: %w", err)
	}
	defer store.Close()
	if err := store.DestroySession(logicalID); err != nil {
		return fmt.Errorf("reap closed mux session persistence: %w", err)
	}
	// The M1 single-pane compatibility keyframe is not tied to the catalog's
	// foreign-key cascade. A closed primary session must not resurrect terminal
	// content after its process is gone.
	if logicalID == "session-1" {
		if err := store.Clear(); err != nil {
			return fmt.Errorf("reap closed legacy mux recovery: %w", err)
		}
	}
	if archiveErr != nil {
		return fmt.Errorf("reap mux history for closed session: %w", archiveErr)
	}
	return nil
}

// ActivateHandoffPersistence begins catalog recording only after a child has
// adopted every descriptor. Before that point the parent remains authoritative,
// so handoff adoption must be memory-only and cannot mutate the shared state.db.
func (operations *Operations) ActivateHandoffPersistence() error {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if operations.persistencePath == "" {
		operations.persistencePath = operations.handoffPersistencePath
	}
	var activationErr error
	for _, session := range operations.sessions {
		if err := operations.persistTopologyLocked(session); err != nil {
			activationErr = err
			break
		}
	}
	if activationErr == nil {
		for _, session := range operations.sessions {
			if session.attachment == nil {
				continue
			}
			if err := session.attachment.EnablePersistence(operations.persistencePath, session.paneID, session.logicalSessionID == "session-1", operations.persistScrollback); err != nil {
				activationErr = fmt.Errorf("enable adopted mux persistence for %s: %w", session.paneID, err)
				break
			}
		}
	}
	if activationErr == nil {
		for _, session := range operations.sessions {
			if err := operations.persistTopologyInteractionLocked(logicalSessionID(session)); err != nil {
				activationErr = err
				break
			}
		}
	}
	// ACK has been delivered even if catalog activation failed. The child is now
	// the sole PTY owner, so it must begin consuming bytes regardless of an
	// optional recovery-record failure.
	for _, session := range operations.sessions {
		if session.attachment != nil {
			if err := session.attachment.Start(); err != nil && activationErr == nil {
				activationErr = fmt.Errorf("start adopted mux pane %s: %w", session.paneID, err)
			}
		}
		// Adoption is not authoritative until the caller has written the ACK.
		// Start exit monitoring only here so an abandoned child cannot tear down
		// the still-live parent's PTYs.
		operations.watchPaneExit(session)
	}
	return activationErr
}

func (operations *Operations) requireMutableLocked() error {
	if operations.handoffPrepared {
		return ErrHandoffInProgress
	}
	return nil
}

// authorizeProject is the daemon-side namespace boundary for a mux home shared
// by multiple Cockpit projects. UI filtering is not a security or correctness
// boundary: every request that names a pane or session is checked before the
// operation may look it up or mutate it.
func (operations *Operations) authorizeProject(request protocol.Request, projectID string) error {
	switch request.Method {
	case methodSessionCreate, methodSessionList, methodSessionTopology, methodMuxConfigure, methodMuxShutdown:
		return nil
	}
	var input map[string]any
	if err := msgpack.Unmarshal(request.Data, &input); err != nil {
		return fmt.Errorf("decode mux project scope: %w", err)
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	for _, field := range []string{"session_id", "pane_id"} {
		id, ok := input[field].(string)
		if !ok || id == "" {
			continue
		}
		var session *managedSession
		if field == "pane_id" {
			session = operations.panes[id]
		} else {
			session = operations.logicalSessionLocked(id)
		}
		if session != nil && session.projectID != projectID {
			return ErrProjectScope
		}
	}
	return nil
}

// logicalSessionLocked resolves both a runtime session ID and its durable
// logical ID. Recovery assigns a new runtime ID, so project authorization must
// use the same identity resolution as logical-session operations.
func (operations *Operations) logicalSessionLocked(sessionID string) *managedSession {
	if session := operations.sessions[sessionID]; session != nil {
		return session
	}
	for _, session := range operations.sessions {
		if logicalSessionID(session) == sessionID {
			return session
		}
	}
	return nil
}

// Handle executes one request received after protocol validation. Responses are
// MessagePack payloads; Server retains correlation and error framing.
func (operations *Operations) Handle(_ context.Context, request protocol.Request) ([]byte, error) {
	projectID := request.ProjectID
	// A project-less session.list is the same-user tty fallback's explicit
	// discovery operation. It intentionally sees every project so `cockpit-mux
	// ls` can identify the owner before attach stamps that project namespace.
	// Every other project-less request remains in the standalone namespace.
	if projectID == "" && request.Method != methodSessionList {
		projectID = "standalone"
	}
	if err := operations.authorizeProject(request, projectID); err != nil {
		return nil, err
	}
	switch request.Method {
	case methodSessionCreate:
		var input CreateSessionRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.create(input, projectID)
	case methodPaneWrite:
		var input WritePaneRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.write(input)
	case methodPaneResize:
		var input ResizePaneRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.resize(input)
	case methodPaneOutput:
		var input ReadPaneOutputRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.output(input)
	case methodPaneBroadcast:
		var input SetPaneBroadcastRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.setBroadcast(input)
	case methodScrollbackQuery:
		var input ScrollbackQueryRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.scrollback(input)
	case methodMuxConfigure:
		var input ConfigureMuxRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.configure(input)
	case methodMuxShutdown:
		return operations.shutdown()
	case methodSessionAttach:
		var input AttachSessionRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.attach(input)
	case methodSessionDetach:
		var input DetachSessionRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.detach(input)
	case methodSessionDestroy:
		var input DestroySessionRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.destroy(input)
	case methodSessionList:
		return operations.list(projectID)
	case methodSessionTopology:
		return operations.topology(projectID)
	case methodSessionPin:
		var input PinSessionRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.pin(input)
	case methodSessionBroadcastScope:
		var input SetBroadcastScopeRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.setBroadcastScope(input)
	case methodWindowSelect:
		var input SelectWindowRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.selectWindow(input)
	case methodPaneSelect:
		var input SelectPaneRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.selectPane(input)
	case methodPaneZoom:
		var input ZoomPaneRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.zoomPane(input)
	case methodPaneSplit:
		var input SplitPaneRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.split(input)
	case methodPaneResizeSplit:
		var input ResizeSplitRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.resizeSplit(input)
	case methodWindowNew:
		var input NewWindowRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.newWindow(input)
	case methodWindowDestroy:
		var input DestroyWindowRequest
		if err := decodeOperation(request.Data, &input); err != nil {
			return nil, err
		}
		return operations.destroyWindow(input)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnknownOperation, request.Method)
	}
}

// CreateSessionRequest deliberately includes the launch command for M1A's
// standalone fixture. Cockpit-derived project/window metadata comes in later work.
type CreateSessionRequest struct {
	Command        string   `msgpack:"command"`
	Args           []string `msgpack:"args"`
	Cwd            string   `msgpack:"cwd"`
	Key            string   `msgpack:"key"`
	BroadcastGroup string   `msgpack:"broadcast_group,omitempty"`
	ProjectID      string   `msgpack:"-"`
}

type CreateSessionResponse struct {
	SessionID string `msgpack:"session_id"`
	PaneID    string `msgpack:"pane_id"`
}

type WritePaneRequest struct {
	PaneID   string `msgpack:"pane_id"`
	ClientID string `msgpack:"client_id,omitempty"`
	Data     []byte `msgpack:"data"`
	// Kind is input or reply. Only interactive input can be broadcast; terminal
	// capability replies must always remain attached to their originating PTY.
	Kind string `msgpack:"kind,omitempty"`
}

type WritePaneResponse struct {
	Written int `msgpack:"written"`
}

type SetPaneBroadcastRequest struct {
	PaneID   string `msgpack:"pane_id"`
	ClientID string `msgpack:"client_id,omitempty"`
	Enabled  bool   `msgpack:"enabled"`
}

type PinSessionRequest struct {
	SessionID string `msgpack:"session_id"`
	Pinned    bool   `msgpack:"pinned"`
}

// SetBroadcastScopeRequest chooses peers by the pane's logical window or its
// complete logical session. It intentionally never crosses broadcastGroup.
type SetBroadcastScopeRequest struct {
	SessionID string `msgpack:"session_id"`
	Scope     string `msgpack:"scope"`
}

type SplitPaneRequest struct {
	PaneID    string   `msgpack:"pane_id"`
	Command   string   `msgpack:"command"`
	Args      []string `msgpack:"args"`
	Cwd       string   `msgpack:"cwd"`
	Key       string   `msgpack:"key"`
	Direction string   `msgpack:"direction,omitempty"`
	Ratio     float64  `msgpack:"ratio,omitempty"`
}

type NewWindowRequest struct {
	SessionID string   `msgpack:"session_id"`
	Command   string   `msgpack:"command"`
	Args      []string `msgpack:"args"`
	Cwd       string   `msgpack:"cwd"`
	Key       string   `msgpack:"key"`
}

type SelectWindowRequest struct {
	SessionID string `msgpack:"session_id"`
	WindowID  string `msgpack:"window_id"`
}

type SelectPaneRequest struct {
	SessionID string `msgpack:"session_id"`
	WindowID  string `msgpack:"window_id"`
	PaneID    string `msgpack:"pane_id"`
}

// ZoomPaneRequest selects PaneID as the only visible pane for WindowID. An
// empty PaneID clears the zoom. The request is deliberately explicit instead
// of a client-side toggle so reconnect retries are idempotent.
type ZoomPaneRequest struct {
	SessionID string `msgpack:"session_id"`
	WindowID  string `msgpack:"window_id"`
	PaneID    string `msgpack:"pane_id,omitempty"`
}

type ResizeSplitRequest struct {
	SessionID string  `msgpack:"session_id"`
	WindowID  string  `msgpack:"window_id"`
	PaneID    string  `msgpack:"pane_id"`
	Ratio     float64 `msgpack:"ratio"`
}

type ResizePaneRequest struct {
	PaneID   string `msgpack:"pane_id"`
	ClientID string `msgpack:"client_id,omitempty"`
	Cols     uint16 `msgpack:"cols"`
	Rows     uint16 `msgpack:"rows"`
}

type AttachSessionRequest struct {
	SessionID        string   `msgpack:"session_id"`
	ClientID         string   `msgpack:"client_id,omitempty"`
	ClientKind       string   `msgpack:"client_kind,omitempty"`
	RendererFeatures []string `msgpack:"renderer_features,omitempty"`
	Cols             uint16   `msgpack:"cols"`
	Rows             uint16   `msgpack:"rows"`
	// Cell dimensions are advisory physical geometry from a graphical renderer.
	// They are needed to resolve Kitty PNG placements that omit a cell span;
	// TTY/xterm clients legitimately leave them zero.
	CellWidth  uint16 `msgpack:"cell_width,omitempty"`
	CellHeight uint16 `msgpack:"cell_height,omitempty"`
}

// DetachSessionRequest clears the current exclusive owner after a graceful
// Cockpit tab close or fallback-TTY detach. An ungraceful client loss remains
// recoverable because a later attach may still take ownership.
type DetachSessionRequest struct {
	SessionID string `msgpack:"session_id"`
	ClientID  string `msgpack:"client_id,omitempty"`
}

// AttachSessionResponse provides the stable M1A session identity together with
// the native shadow seed and the first raw-output sequence delivered after it.
type AttachSessionResponse struct {
	SessionID      string `msgpack:"session_id"`
	PaneID         string `msgpack:"pane_id"`
	Seed           []byte `msgpack:"seed,omitempty"`
	GraphicsSeed   []byte `msgpack:"graphics_seed,omitempty"`
	ResumeSequence uint64 `msgpack:"resume_sequence,omitempty"`
	Stole          bool   `msgpack:"stole,omitempty"`
}

// ReadPaneOutputRequest polls the M1A fixture stream at the inclusive sequence
// assigned by AttachSessionResponse.ResumeSequence.
type ReadPaneOutputRequest struct {
	PaneID       string `msgpack:"pane_id"`
	ClientID     string `msgpack:"client_id,omitempty"`
	FromSequence uint64 `msgpack:"from_sequence"`
}

type ReadPaneOutputResponse struct {
	Outputs []Output `msgpack:"outputs"`
	Exited  bool     `msgpack:"exited"`
}

// maxOutputResponseBytes leaves ample room for MessagePack envelopes beneath
// protocol.MaxFrameBytes while allowing a client to catch up efficiently.
const maxOutputResponseBytes = 8 << 20

// ScrollbackQueryRequest pages backward from the newest history line. The
// response carries style runs rather than formatted ANSI so a DOM copy surface
// can preserve attributes without reparsing terminal escape sequences.
type ScrollbackQueryRequest struct {
	PaneID   string `msgpack:"pane_id"`
	ClientID string `msgpack:"client_id,omitempty"`
	Before   uint   `msgpack:"before"`
	Count    uint   `msgpack:"count"`
}

type ScrollbackRun struct {
	Text string `msgpack:"text"`
	SGR  string `msgpack:"sgr"`
}

type ScrollbackLine struct {
	Line uint            `msgpack:"line"`
	Runs []ScrollbackRun `msgpack:"runs"`
}

type ScrollbackQueryResponse struct {
	Lines []ScrollbackLine `msgpack:"lines"`
}

// ConfigureMuxRequest changes the daemon-wide persistence policy. The setting
// is deliberately daemon-wide because one private mux home can own panes from
// more than one Cockpit project.
type ConfigureMuxRequest struct {
	PersistScrollback bool `msgpack:"persist_scrollback"`
	ScrollbackLines   uint `msgpack:"scrollback_lines"`
}

type ConfigureMuxResponse struct {
	PersistScrollback bool `msgpack:"persist_scrollback"`
	ScrollbackLines   uint `msgpack:"scrollback_lines"`
}

type DestroySessionRequest struct {
	SessionID string `msgpack:"session_id"`
}

type DestroySessionResponse struct {
	SessionID string `msgpack:"session_id"`
}

// DestroyWindowRequest is the daemon-atomic lifecycle operation for a mux
// window. It avoids exposing renderer timing between individual pane destroys.
type DestroyWindowRequest struct {
	SessionID string `msgpack:"session_id"`
	WindowID  string `msgpack:"window_id"`
}

type SessionListItem struct {
	SessionID          string `msgpack:"session_id"`
	PaneID             string `msgpack:"pane_id"`
	ProjectID          string `msgpack:"project_id"`
	Key                string `msgpack:"key"`
	Exited             bool   `msgpack:"exited"`
	Broadcast          bool   `msgpack:"broadcast"`
	Pinned             bool   `msgpack:"pinned"`
	AttachedKind       string `msgpack:"attached_kind,omitempty"`
	LogicalSessionID   string `msgpack:"logical_session_id,omitempty"`
	WindowID           string `msgpack:"window_id,omitempty"`
	BroadcastScope     string `msgpack:"broadcast_scope,omitempty"`
	RecoveryDiagnostic string `msgpack:"recovery_diagnostic,omitempty"`
}

type ListSessionsResponse struct {
	Sessions []SessionListItem `msgpack:"sessions"`
}

// TopologyPane is the client-safe identity and lifecycle view for one pane in
// a logical mux session. Terminal bytes remain on the existing pane.output
// path; this response deliberately carries no screen content.
type TopologyPane struct {
	SessionID  string `msgpack:"session_id"`
	PaneID     string `msgpack:"pane_id"`
	Key        string `msgpack:"key"`
	Exited     bool   `msgpack:"exited"`
	Cols       uint16 `msgpack:"cols"`
	Rows       uint16 `msgpack:"rows"`
	ActualCols uint16 `msgpack:"actual_cols"`
	ActualRows uint16 `msgpack:"actual_rows"`
}

// TopologyWindow groups a logical session's panes by their daemon-owned window
// identity. ActivePaneID and ZoomedPaneID are daemon-owned interaction state;
// topology is intentionally content-free so screen bytes remain on pane.output.
type TopologyWindow struct {
	WindowID     string              `msgpack:"window_id"`
	Panes        []TopologyPane      `msgpack:"panes"`
	ActivePaneID string              `msgpack:"active_pane_id,omitempty"`
	ZoomedPaneID string              `msgpack:"zoomed_pane_id,omitempty"`
	Layout       *TopologyLayoutNode `msgpack:"layout,omitempty"`
}

// TopologySession is one logical mux session, not the historical per-pane
// record exposed by session.list. It is the canonical grouping boundary for
// the Cockpit topology surface.
type TopologySession struct {
	SessionID      string           `msgpack:"session_id"`
	WindowOrder    []string         `msgpack:"window_order"`
	Windows        []TopologyWindow `msgpack:"windows"`
	ActiveWindowID string           `msgpack:"active_window_id,omitempty"`
}

type TopologyResponse struct {
	Epoch           string            `msgpack:"epoch"`
	Revision        uint64            `msgpack:"revision"`
	ActiveSessionID string            `msgpack:"active_session_id,omitempty"`
	Sessions        []TopologySession `msgpack:"sessions"`
}

func newTopologyEpoch() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic(fmt.Sprintf("generate mux topology epoch: %v", err))
	}
	return hex.EncodeToString(value[:])
}

func (operations *Operations) create(input CreateSessionRequest, projectID string) ([]byte, error) {
	if input.Command == "" {
		return nil, ErrCommandRequired
	}

	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	if operations.recoveryErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrRecoveryConflict, operations.recoveryErr)
	}
	if recovered := operations.sessions["recovered-session"]; recovered != nil {
		return nil, ErrSessionExists
	}
	input.ProjectID = projectID
	session, err := operations.createLocked(input, "", "")
	if err != nil {
		return nil, err
	}
	return encodeOperation(CreateSessionResponse{SessionID: session.id, PaneID: session.paneID})
}

// createLocked is the single PTY/shadow construction path for a root session,
// a split pane, and a new window. The caller holds operations.mu.
func (operations *Operations) createLocked(input CreateSessionRequest, logicalSessionID, windowID string) (*managedSession, error) {
	if input.Command == "" {
		return nil, ErrCommandRequired
	}
	operations.nextSession++
	sessionID := fmt.Sprintf("session-%d", operations.nextSession)
	paneID := fmt.Sprintf("pane-%d", operations.nextSession)
	if logicalSessionID == "" {
		logicalSessionID = sessionID
	}
	if windowID == "" {
		operations.nextWindow++
		windowID = fmt.Sprintf("window-%d", operations.nextWindow)
	}
	var pane *Pane
	var err error
	if input.Cwd == "" {
		pane, err = operations.starter(input.Command, input.Args...)
	} else {
		pane, err = StartPaneInDir(input.Command, input.Cwd, input.Args...)
	}
	if err != nil {
		return nil, err
	}
	session := &managedSession{
		id:               sessionID,
		paneID:           paneID,
		key:              input.Key,
		projectID:        input.ProjectID,
		broadcastGroup:   input.BroadcastGroup,
		logicalSessionID: logicalSessionID,
		windowID:         windowID,
		broadcastScope:   "window",
		pane:             pane,
		cwd:              input.Cwd,
		command:          input.Command,
		cols:             80,
		rows:             24,
	}
	if err := operations.persistTopologyLocked(session); err != nil {
		_ = pane.Terminate()
		return nil, err
	}
	// The primary pane mirrors to the accepted M1 recovery record while every
	// pane writes its own catalog record. Recovery remains deterministic during
	// this staged migration and multipane state is no longer silently discarded.
	attachment, err := newSessionAttachment(pane, operations.persistencePath, paneID, sessionID == "session-1", operations.persistScrollback, operations.scrollbackLines)
	if err != nil {
		_ = pane.Terminate()
		_ = operations.destroyPersistedPaneLocked(session)
		return nil, fmt.Errorf("start mux shadow: %w", err)
	}
	session.attachment = attachment
	session.outputHistory = attachment
	operations.sessions[session.id] = session
	operations.panes[session.paneID] = session
	operations.session = session
	operations.activeLogicalByProject[session.projectID] = session.logicalSessionID
	operations.observePaneTopologyLocked(session)
	if err := operations.persistActiveLogicalSessionLocked(session.logicalSessionID); err != nil {
		return nil, err
	}
	operations.watchPaneExit(session)
	return session, nil
}

func (operations *Operations) write(input WritePaneRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	session, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	if session.pane == nil {
		return nil, ErrPaneExited
	}
	written, err := session.pane.WriteInput(input.Data)
	if err != nil {
		return nil, err
	}
	if session.pane == nil {
		return nil, ErrPaneExited
	}
	if session.broadcast && session.clientKind != "tty" && (input.Kind == "" || input.Kind == "input") {
		for _, peer := range operations.panes {
			if peer == session || peer.broadcastGroup != session.broadcastGroup || peer.logicalSessionID != session.logicalSessionID || !peer.broadcast || peer.pane == nil {
				continue
			}
			if session.broadcastScope == "window" && peer.windowID != session.windowID {
				continue
			}
			if _, err := peer.pane.WriteInput(input.Data); err != nil {
				return nil, fmt.Errorf("broadcast mux pane %s: %w", peer.paneID, err)
			}
		}
	}
	return encodeOperation(WritePaneResponse{Written: written})
}

func (operations *Operations) setBroadcast(input SetPaneBroadcastRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	session, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	session.broadcast = input.Enabled
	return encodeOperation(struct{}{})
}

func (operations *Operations) pin(input PinSessionRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	session := operations.sessions[input.SessionID]
	if session == nil {
		return nil, ErrSessionNotFound
	}
	previous := session.pinned
	session.pinned = input.Pinned
	if err := operations.persistPinLocked(session); err != nil {
		session.pinned = previous
		return nil, err
	}
	return encodeOperation(struct{}{})
}

func (operations *Operations) setBroadcastScope(input SetBroadcastScopeRequest) ([]byte, error) {
	if input.Scope != "window" && input.Scope != "session" {
		return nil, fmt.Errorf("mux broadcast scope must be window or session")
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	for _, session := range operations.sessions {
		if session.logicalSessionID == root.logicalSessionID {
			session.broadcastScope = input.Scope
		}
	}
	return encodeOperation(struct{}{})
}

func (operations *Operations) split(input SplitPaneRequest) ([]byte, error) {
	if !isFiniteSplitRatio(input.Ratio) {
		return nil, fmt.Errorf("mux split ratio must be finite")
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	source, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	created, err := operations.createLocked(CreateSessionRequest{
		Command: input.Command, Args: input.Args, Cwd: input.Cwd, Key: input.Key, ProjectID: source.projectID, BroadcastGroup: source.broadcastGroup,
	}, source.logicalSessionID, source.windowID)
	if err != nil {
		return nil, err
	}
	created.broadcastScope = source.broadcastScope
	created.pinned = source.pinned
	state := operations.topologyStateLocked(source.logicalSessionID)
	base := removeLayoutPane(state.layoutByWindow[source.windowID], created.paneID)
	state.layoutByWindow[source.windowID] = splitLayoutPane(base, source.paneID, created.paneID, input.Direction, input.Ratio)
	state.activeWindowID = source.windowID
	state.activePaneByWindow[source.windowID] = created.paneID
	if err := operations.persistTopologyInteractionLocked(source.logicalSessionID); err != nil {
		return nil, err
	}
	if err := operations.persistPinLocked(created); err != nil {
		return nil, err
	}
	return encodeOperation(CreateSessionResponse{SessionID: created.id, PaneID: created.paneID})
}

func (operations *Operations) resizeSplit(input ResizeSplitRequest) ([]byte, error) {
	if !isFiniteSplitRatio(input.Ratio) {
		return nil, fmt.Errorf("mux split ratio must be finite")
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	logicalID := logicalSessionID(root)
	pane, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if logicalSessionID(pane) != logicalID || pane.windowID != input.WindowID {
		return nil, ErrPaneNotFound
	}
	state := operations.topologyStateLocked(logicalID)
	layout, changed := resizeLayoutPane(state.layoutByWindow[input.WindowID], input.PaneID, input.Ratio)
	if !changed {
		return nil, fmt.Errorf("mux pane %s has no resizable split", input.PaneID)
	}
	state.layoutByWindow[input.WindowID] = layout
	if err := operations.persistTopologyInteractionLocked(logicalID); err != nil {
		return nil, err
	}
	return encodeOperation(operations.topologyLocked(root.projectID))
}

func (operations *Operations) newWindow(input NewWindowRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	// Window creation is addressed to the logical session, just like selection.
	// The original root pane may have exited while sibling panes remain alive;
	// callers (including the standalone CLI) must not need to retain a transient
	// per-pane record merely to add a new logical window.
	source, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	created, err := operations.createLocked(CreateSessionRequest{
		Command: input.Command, Args: input.Args, Cwd: input.Cwd, Key: input.Key, ProjectID: source.projectID, BroadcastGroup: source.broadcastGroup,
	}, source.logicalSessionID, "")
	if err != nil {
		return nil, err
	}
	created.broadcastScope = source.broadcastScope
	created.pinned = source.pinned
	state := operations.topologyStateLocked(source.logicalSessionID)
	state.activeWindowID = created.windowID
	state.activePaneByWindow[created.windowID] = created.paneID
	if err := operations.persistTopologyInteractionLocked(source.logicalSessionID); err != nil {
		return nil, err
	}
	if err := operations.persistPinLocked(created); err != nil {
		return nil, err
	}
	return encodeOperation(CreateSessionResponse{SessionID: created.id, PaneID: created.paneID})
}

func (operations *Operations) resize(input ResizePaneRequest) ([]byte, error) {
	if input.Cols == 0 || input.Rows == 0 {
		return nil, ErrInvalidGeometry
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	session, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	if session.pane == nil {
		return nil, ErrPaneExited
	}
	if session.attachment != nil {
		if err := session.attachment.Resize(input.Cols, input.Rows); err != nil {
			return nil, fmt.Errorf("resize mux pane: %w", err)
		}
	} else if err := session.pane.Resize(input.Cols, input.Rows); err != nil {
		return nil, fmt.Errorf("resize mux pane: %w", err)
	}
	session.cols = input.Cols
	session.rows = input.Rows
	if err := operations.persistTopologyLocked(session); err != nil {
		return nil, err
	}
	return encodeOperation(struct{}{})
}

func (operations *Operations) attach(input AttachSessionRequest) ([]byte, error) {
	if input.Cols == 0 || input.Rows == 0 {
		return nil, ErrInvalidGeometry
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	if operations.recoveryErr != nil {
		return nil, operations.recoveryErr
	}
	session, err := operations.requireSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	response := AttachSessionResponse{SessionID: session.id, PaneID: session.paneID}
	if input.ClientID != "" {
		response.Stole = session.clientID != "" && session.clientID != input.ClientID
		session.clientID = input.ClientID
		session.clientKind = input.ClientKind
		// A real terminal may answer capability queries itself. write() gates
		// replication on clientKind, preserving the configured broadcast flag so a
		// later Cockpit attach resumes it without mutating session state.
	}
	if session.attachment != nil {
		seed, err := session.attachment.Attach(input.Cols, input.Rows, input.CellWidth, input.CellHeight)
		if err != nil {
			return nil, fmt.Errorf("seed mux pane: %w", err)
		}
		response.Seed = seed.Data
		if supportsDirectGraphics(input.RendererFeatures) {
			response.GraphicsSeed = seed.Graphics
		}
		response.ResumeSequence = seed.ResumeSequence
	} else if session.pane == nil {
		if session.recoveryDiagnostic != "" {
			return nil, fmt.Errorf("%w: %s", ErrPaneExited, session.recoveryDiagnostic)
		}
		return nil, ErrPaneExited
	} else if err := session.pane.Resize(input.Cols, input.Rows); err != nil {
		return nil, fmt.Errorf("resize mux pane before attach: %w", err)
	}
	session.cols = input.Cols
	session.rows = input.Rows
	if err := operations.persistTopologyLocked(session); err != nil {
		return nil, err
	}
	return encodeOperation(response)
}

func supportsDirectGraphics(features []string) bool {
	for _, feature := range features {
		if feature == "direct_graphics_v1" {
			return true
		}
	}
	return false
}

func (operations *Operations) detach(input DetachSessionRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	session, err := operations.requireSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	session.clientID = ""
	session.clientKind = ""
	return encodeOperation(struct{}{})
}

func (operations *Operations) output(input ReadPaneOutputRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	session, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	if session.outputHistory == nil {
		return encodeOperation(ReadPaneOutputResponse{Exited: session.pane == nil})
	}
	return encodeOperation(ReadPaneOutputResponse{
		Outputs: session.outputHistory.OutputsFromBounded(input.FromSequence, maxOutputResponseBytes),
		Exited:  session.pane == nil,
	})
}

func (operations *Operations) scrollback(input ScrollbackQueryRequest) ([]byte, error) {
	if input.Count == 0 || input.Count > 1_000 {
		return nil, fmt.Errorf("scrollback query count must be between 1 and 1000")
	}
	operations.mu.Lock()
	defer operations.mu.Unlock()
	session, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if err := requireClient(session, input.ClientID); err != nil {
		return nil, err
	}
	if session.attachment == nil {
		return encodeOperation(ScrollbackQueryResponse{})
	}
	lines, err := session.attachment.Scrollback(input.Before, input.Count)
	if err != nil {
		return nil, fmt.Errorf("query mux scrollback: %w", err)
	}
	return encodeOperation(ScrollbackQueryResponse{Lines: lines})
}

// configure changes the privacy policy for live attachments. Disabling
// persistence first erases every old recovery payload, then lets each live
// recorder write a blank, valid recovery point. That guarantees a preference
// change never leaves earlier terminal text in the private database.
func (operations *Operations) configure(input ConfigureMuxRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	if input.ScrollbackLines == 0 {
		input.ScrollbackLines = DefaultScrollbackLines
	}
	if input.ScrollbackLines > MaxScrollbackLines {
		return nil, fmt.Errorf("mux scrollback line target must be between 1 and %d", MaxScrollbackLines)
	}
	if operations.persistScrollback == input.PersistScrollback && operations.scrollbackLines == input.ScrollbackLines {
		return encodeOperation(ConfigureMuxResponse{PersistScrollback: input.PersistScrollback, ScrollbackLines: input.ScrollbackLines})
	}
	if !input.PersistScrollback && operations.persistencePath != "" {
		archive, err := history.Open(filepath.Join(filepath.Dir(operations.persistencePath), "history.db"))
		if err != nil {
			return nil, fmt.Errorf("open mux history archive for privacy change: %w", err)
		}
		if err := archive.Clear(); err != nil {
			_ = archive.Close()
			return nil, fmt.Errorf("erase mux history archive for privacy change: %w", err)
		}
		if err := archive.Close(); err != nil {
			return nil, fmt.Errorf("close mux history archive for privacy change: %w", err)
		}
		store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
		if err != nil {
			return nil, fmt.Errorf("open mux recovery record for privacy change: %w", err)
		}
		if err := store.ClearContent(); err != nil {
			_ = store.Close()
			return nil, fmt.Errorf("erase mux recovery content for privacy change: %w", err)
		}
		if err := store.Close(); err != nil {
			return nil, fmt.Errorf("close mux recovery record for privacy change: %w", err)
		}
		for _, session := range operations.sessions {
			if err := operations.persistTopologyLocked(session); err != nil {
				return nil, err
			}
		}
	}
	operations.persistScrollback = input.PersistScrollback
	operations.scrollbackLines = input.ScrollbackLines
	for _, session := range operations.sessions {
		if session.attachment == nil {
			continue
		}
		if err := session.attachment.SetPersistScrollback(input.PersistScrollback); err != nil {
			return nil, fmt.Errorf("apply mux persistence policy: %w", err)
		}
		if err := session.attachment.SetScrollbackLines(input.ScrollbackLines); err != nil {
			return nil, fmt.Errorf("apply mux scrollback line target: %w", err)
		}
	}
	return encodeOperation(ConfigureMuxResponse{PersistScrollback: operations.persistScrollback, ScrollbackLines: operations.scrollbackLines})
}

func (operations *Operations) destroy(input DestroySessionRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	// session.destroy is deliberately addressed to one runtime pane session.
	// The sole compatibility exception is an unambiguous recovered catalog
	// record, whose old durable logical ID has no runtime counterpart yet.
	// Never resolve a deleted live runtime ID through its logical ID: a retry
	// could otherwise destroy a healthy sibling.
	session, err := operations.requireDestroySession(input.SessionID)
	if err != nil {
		if len(operations.sessions) == 0 && operations.recoveryErr != nil && input.SessionID == "recovered-session" {
			if err := operations.clearRecoveryLocked(); err != nil {
				return nil, err
			}
			return encodeOperation(DestroySessionResponse{SessionID: input.SessionID})
		}
		return nil, err
	}
	logicalID := logicalSessionID(session)
	wasActive := operations.activeLogicalByProject[session.projectID] == logicalID
	if operations.windowPaneCountLocked(logicalID, session.windowID) == 1 {
		removeWindowPlacement(operations.topologyStateLocked(logicalID), session.windowID)
	}
	if err := operations.destroyManagedSessionLocked(session); err != nil {
		return nil, err
	}
	if operations.hasLogicalSessionLocked(logicalID) {
		operations.topologyStateLocked(logicalID)
		if wasActive {
			operations.selectLogicalSessionLocked(logicalID)
		}
		_ = operations.persistTopologyInteractionLocked(logicalID)
	} else {
		delete(operations.topologyState, logicalID)
		if wasActive {
			operations.selectRemainingSessionLocked(session.projectID)
			if replacement := operations.activeLogicalByProject[session.projectID]; replacement != "" {
				if err := operations.persistActiveLogicalSessionLocked(replacement); err != nil {
					return nil, err
				}
			}
		}
	}
	if logicalSessionID(session) == "session-1" || session.id == "recovered-session" {
		if err := operations.clearRecoveryLocked(); err != nil {
			return nil, err
		}
	}
	return encodeOperation(DestroySessionResponse{SessionID: session.id})
}

// destroyWindow removes every pane in one logical mux window while the daemon
// holds its lifecycle lock. The renderer can therefore never observe a partly
// destroyed window and accidentally address a survivor as a new active pane.
func (operations *Operations) destroyWindow(input DestroyWindowRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	logicalID := logicalSessionID(root)
	wasActive := operations.activeLogicalByProject[root.projectID] == logicalID
	var targets []*managedSession
	for _, candidate := range operations.sessions {
		if logicalSessionID(candidate) == logicalID && candidate.windowID == input.WindowID {
			targets = append(targets, candidate)
		}
	}
	if len(targets) == 0 {
		return nil, ErrSessionNotFound
	}
	removeWindowPlacement(operations.topologyStateLocked(logicalID), input.WindowID)
	for _, target := range targets {
		if err := operations.destroyManagedSessionLocked(target); err != nil {
			return nil, err
		}
	}
	if operations.hasLogicalSessionLocked(logicalID) {
		operations.topologyStateLocked(logicalID)
		if err := operations.persistTopologyInteractionLocked(logicalID); err != nil {
			return nil, err
		}
		if wasActive {
			operations.selectLogicalSessionLocked(logicalID)
		}
	} else {
		delete(operations.topologyState, logicalID)
		if wasActive {
			operations.selectRemainingSessionLocked(root.projectID)
			if replacement := operations.activeLogicalByProject[root.projectID]; replacement != "" {
				if err := operations.persistActiveLogicalSessionLocked(replacement); err != nil {
					return nil, err
				}
			}
		}
	}
	return encodeOperation(operations.topologyLocked(root.projectID))
}

func (operations *Operations) destroyManagedSessionLocked(session *managedSession) error {
	if session.pane != nil {
		if err := session.pane.Terminate(); err != nil {
			return err
		}
	}
	if session.attachment != nil {
		// A renderer may have already drained and closed its attachment while
		// this explicit destroy is in flight. Attachment teardown is best effort:
		// it must never retain the daemon pane/catalog record after the PTY has
		// been stopped.
		_ = session.attachment.Close()
	}
	if err := operations.destroyPersistedPaneLocked(session); err != nil {
		return err
	}
	if session.pane != nil {
		go func() { _ = session.pane.Wait() }()
	}
	delete(operations.sessions, session.id)
	delete(operations.panes, session.paneID)
	return nil
}

func (operations *Operations) selectRemainingSessionLocked(projectID ...string) {
	project := ""
	if len(projectID) > 0 {
		project = projectID[0]
	}
	if operations.session != nil && (project == "" || operations.session.projectID == project) {
		operations.session = nil
	}
	var candidates []*managedSession
	for _, remaining := range operations.sessions {
		if project != "" && remaining.projectID != project {
			continue
		}
		candidates = append(candidates, remaining)
	}
	// Map iteration is deliberately randomized by Go. A recovery fallback is
	// user-visible selection state, so choose a stable logical session instead
	// of allowing an unrelated surviving session to win by chance.
	slices.SortFunc(candidates, func(left, right *managedSession) int {
		return strings.Compare(logicalSessionID(left), logicalSessionID(right))
	})
	selected := len(candidates) > 0
	if selected {
		operations.session = candidates[0]
		operations.activeLogicalByProject[candidates[0].projectID] = logicalSessionID(candidates[0])
	}
	if project != "" && !selected {
		delete(operations.activeLogicalByProject, project)
	}
}

// selectLogicalSessionLocked preserves the selected logical session when one
// of its windows closes. `operations.session` is the daemon-owned focus source
// used by a renderer reload; falling back to an arbitrary map entry here could
// visibly switch the user into an unrelated logical session.
func (operations *Operations) selectLogicalSessionLocked(logicalID string) {
	for _, candidate := range operations.sessions {
		if logicalSessionID(candidate) == logicalID {
			operations.session = candidate
			operations.activeLogicalByProject[candidate.projectID] = logicalID
			return
		}
	}
	operations.selectRemainingSessionLocked()
}

// observeRecoveredIdentifiers prevents a post-restart create from reusing an
// existing catalog identity. The runtime recovery ID is intentionally new, so
// inspect the durable pane and logical-session IDs as well.
func (operations *Operations) observeRecoveredIdentifiers(session *managedSession) {
	operations.nextSession = maxMuxIdentifierSuffix(operations.nextSession, session.id, "session-")
	operations.nextSession = maxMuxIdentifierSuffix(operations.nextSession, session.paneID, "pane-")
	operations.nextSession = maxMuxIdentifierSuffix(operations.nextSession, logicalSessionID(session), "session-")
	operations.nextWindow = maxMuxIdentifierSuffix(operations.nextWindow, session.windowID, "window-")
}

func maxMuxIdentifierSuffix(current uint64, value, prefix string) uint64 {
	if !strings.HasPrefix(value, prefix) {
		return current
	}
	parsed, err := strconv.ParseUint(strings.TrimPrefix(value, prefix), 10, 64)
	if err != nil || parsed < current {
		return current
	}
	return parsed
}

func (operations *Operations) list(projectID string) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	items := make([]SessionListItem, 0, len(operations.sessions))
	for _, session := range operations.sessions {
		if projectID != "" && session.projectID != projectID {
			continue
		}
		items = append(items, SessionListItem{
			SessionID:          session.id,
			PaneID:             session.paneID,
			ProjectID:          session.projectID,
			Key:                session.key,
			Exited:             session.pane == nil,
			Broadcast:          session.broadcast,
			Pinned:             session.pinned,
			AttachedKind:       session.clientKind,
			LogicalSessionID:   session.logicalSessionID,
			WindowID:           session.windowID,
			BroadcastScope:     session.broadcastScope,
			RecoveryDiagnostic: session.recoveryDiagnostic,
		})
	}
	slices.SortFunc(items, func(left, right SessionListItem) int {
		return strings.Compare(left.SessionID, right.SessionID)
	})
	return encodeOperation(ListSessionsResponse{Sessions: items})
}

// selectWindow records the active window for a logical session. Selection is
// daemon-owned so a local or remote Cockpit client can reconnect to the same
// topology without guessing which tab should be foregrounded.
func (operations *Operations) selectWindow(input SelectWindowRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	logicalID := logicalSessionID(root)
	if !operations.windowBelongsToLogicalSessionLocked(logicalID, input.WindowID) {
		return nil, ErrSessionNotFound
	}
	operations.session = root
	operations.activeLogicalByProject[root.projectID] = logicalID
	operations.topologyStateLocked(logicalID).activeWindowID = input.WindowID
	if err := operations.persistTopologyInteractionLocked(logicalID); err != nil {
		return nil, err
	}
	return encodeOperation(operations.topologyLocked(root.projectID))
}

// selectPane records a focused pane and makes its containing window active.
func (operations *Operations) selectPane(input SelectPaneRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	logicalID := logicalSessionID(root)
	pane, err := operations.requirePane(input.PaneID)
	if err != nil {
		return nil, err
	}
	if logicalSessionID(pane) != logicalID || pane.windowID != input.WindowID {
		return nil, ErrPaneNotFound
	}
	state := operations.topologyStateLocked(logicalID)
	operations.session = pane
	operations.activeLogicalByProject[pane.projectID] = logicalID
	state.activeWindowID = input.WindowID
	state.activePaneByWindow[input.WindowID] = input.PaneID
	if err := operations.persistTopologyInteractionLocked(logicalID); err != nil {
		return nil, err
	}
	return encodeOperation(operations.topologyLocked(root.projectID))
}

// zoomPane records an explicit zoom state. An empty PaneID clears the zoom for
// the window, which keeps retrying the operation safe after a reconnect.
func (operations *Operations) zoomPane(input ZoomPaneRequest) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	if err := operations.requireMutableLocked(); err != nil {
		return nil, err
	}
	root, err := operations.requireLogicalSession(input.SessionID)
	if err != nil {
		return nil, err
	}
	logicalID := logicalSessionID(root)
	if !operations.windowBelongsToLogicalSessionLocked(logicalID, input.WindowID) {
		return nil, ErrSessionNotFound
	}
	if input.PaneID != "" {
		pane, err := operations.requirePane(input.PaneID)
		if err != nil {
			return nil, err
		}
		if logicalSessionID(pane) != logicalID || pane.windowID != input.WindowID {
			return nil, ErrPaneNotFound
		}
	}
	state := operations.topologyStateLocked(logicalID)
	state.activeWindowID = input.WindowID
	if input.PaneID != "" {
		state.activePaneByWindow[input.WindowID] = input.PaneID
	}
	state.zoomedPaneByWindow[input.WindowID] = input.PaneID
	if err := operations.persistTopologyInteractionLocked(logicalID); err != nil {
		return nil, err
	}
	return encodeOperation(operations.topologyLocked(root.projectID))
}

// topology returns a stable, content-free grouping of the daemon's existing
// per-pane records. It intentionally derives ordering from durable IDs rather
// than map iteration, so local and remote clients receive equivalent snapshots.
func (operations *Operations) topology(projectID string) ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	return encodeOperation(operations.topologyLocked(projectID))
}

func (operations *Operations) topologyLocked(projectID string) TopologyResponse {
	operations.topologyRevision++
	byLogicalSession := make(map[string]map[string][]TopologyPane)
	for _, session := range operations.sessions {
		if session.projectID != projectID {
			continue
		}
		logicalID := logicalSessionID(session)
		windowID := session.windowID
		if windowID == "" {
			windowID = session.paneID
		}
		byWindow := byLogicalSession[logicalID]
		if byWindow == nil {
			byWindow = make(map[string][]TopologyPane)
			byLogicalSession[logicalID] = byWindow
		}
		actualCols, actualRows := session.cols, session.rows
		if session.pane != nil {
			if cols, rows, err := session.pane.Geometry(); err == nil {
				actualCols, actualRows = cols, rows
			}
		}
		byWindow[windowID] = append(byWindow[windowID], TopologyPane{
			SessionID:  session.id,
			PaneID:     session.paneID,
			Key:        session.key,
			Exited:     session.pane == nil,
			Cols:       session.cols,
			Rows:       session.rows,
			ActualCols: actualCols,
			ActualRows: actualRows,
		})
	}

	logicalIDs := make([]string, 0, len(byLogicalSession))
	for logicalID := range byLogicalSession {
		logicalIDs = append(logicalIDs, logicalID)
	}
	slices.Sort(logicalIDs)
	result := TopologyResponse{Epoch: operations.topologyEpoch, Revision: operations.topologyRevision, Sessions: make([]TopologySession, 0, len(logicalIDs))}
	result.ActiveSessionID = operations.activeLogicalByProject[projectID]
	if _, exists := byLogicalSession[result.ActiveSessionID]; !exists {
		result.ActiveSessionID = firstString(logicalIDs)
	}
	for _, logicalID := range logicalIDs {
		byWindow := byLogicalSession[logicalID]
		state := operations.topologyStateLocked(logicalID)
		windowIDs := state.windowOrder
		topologySession := TopologySession{
			SessionID:      logicalID,
			WindowOrder:    append([]string(nil), windowIDs...),
			Windows:        make([]TopologyWindow, 0, len(windowIDs)),
			ActiveWindowID: state.activeWindowID,
		}
		for _, windowID := range windowIDs {
			panes := byWindow[windowID]
			slices.SortFunc(panes, func(left, right TopologyPane) int {
				return strings.Compare(left.PaneID, right.PaneID)
			})
			topologySession.Windows = append(topologySession.Windows, TopologyWindow{
				WindowID:     windowID,
				Panes:        panes,
				ActivePaneID: state.activePaneByWindow[windowID],
				ZoomedPaneID: state.zoomedPaneByWindow[windowID],
				Layout:       state.layoutByWindow[windowID],
			})
		}
		result.Sessions = append(result.Sessions, topologySession)
	}
	return result
}

func logicalSessionID(session *managedSession) string {
	if session.logicalSessionID != "" {
		return session.logicalSessionID
	}
	return session.id
}

func (operations *Operations) rebuildTopologyLocked() {
	operations.topologyState = make(map[string]*topologyState)
	logicalIDs := make(map[string]struct{})
	for _, session := range operations.sessions {
		// Catalogs created before project scoping are standalone by definition;
		// never reinterpret them as belonging to whichever Cockpit project opens
		// the shared daemon first.
		if session.projectID == "" {
			session.projectID = "standalone"
		}
		logicalIDs[logicalSessionID(session)] = struct{}{}
	}
	for logicalID := range logicalIDs {
		operations.topologyStateLocked(logicalID)
	}
}

func (operations *Operations) loadPersistedTopologyLocked() {
	if operations.persistencePath == "" {
		return
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return
	}
	defer store.Close()
	windows, err := store.CatalogWindows()
	if err != nil {
		return
	}
	loadedOrder := make(map[string]bool)
	for _, window := range windows {
		if !operations.hasLogicalSessionLocked(window.SessionID) {
			continue
		}
		var saved persistedWindowTopology
		if err := json.Unmarshal([]byte(window.LayoutJSON), &saved); err != nil {
			continue
		}
		// CatalogWindows is ordered by the persisted placement index. Do not
		// normalize while consuming individual rows: normalization sees every
		// recovered live window and would insert not-yet-loaded IDs lexically
		// before their indexed rows arrive.
		state := operations.topologyStateRecordLocked(window.SessionID)
		if !loadedOrder[window.SessionID] {
			state.windowOrder = nil
			loadedOrder[window.SessionID] = true
		}
		state.windowOrder = append(state.windowOrder, window.WindowID)
		if saved.ActiveWindow {
			state.activeWindowID = window.WindowID
		}
		if saved.ActivePaneID != "" {
			state.activePaneByWindow[window.WindowID] = saved.ActivePaneID
		}
		if saved.ZoomedPaneID != "" {
			state.zoomedPaneByWindow[window.WindowID] = saved.ZoomedPaneID
		}
		state.layoutByWindow[window.WindowID] = saved.Layout
	}
	for logicalID := range operations.topologyState {
		operations.topologyStateLocked(logicalID)
	}
}

func (operations *Operations) loadActiveLogicalSessionsLocked() {
	if operations.persistencePath == "" {
		return
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return
	}
	defer store.Close()
	selections, err := store.ActiveLogicalSessions()
	if err != nil {
		return
	}
	for projectID, logicalID := range selections {
		if operations.hasLogicalSessionLocked(logicalID) {
			operations.activeLogicalByProject[projectID] = logicalID
			operations.selectLogicalSessionLocked(logicalID)
		}
	}
}

func (operations *Operations) persistActiveLogicalSessionLocked(logicalID string) error {
	if operations.persistencePath == "" || operations.session == nil || logicalSessionID(operations.session) != logicalID {
		return nil
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux active-session catalog: %w", err)
	}
	defer store.Close()
	if err := store.SetActiveLogicalSession(operations.session.projectID, logicalID); err != nil {
		return fmt.Errorf("persist mux active logical session: %w", err)
	}
	return nil
}

func (operations *Operations) persistTopologyInteractionLocked(logicalID string) error {
	if operations.persistencePath == "" {
		return nil
	}
	state := operations.topologyStateLocked(logicalID)
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux topology catalog: %w", err)
	}
	defer store.Close()
	for index, windowID := range state.windowOrder {
		layout, err := json.Marshal(persistedWindowTopology{
			ActiveWindow: state.activeWindowID == windowID,
			ActivePaneID: state.activePaneByWindow[windowID],
			ZoomedPaneID: state.zoomedPaneByWindow[windowID],
			Layout:       state.layoutByWindow[windowID],
		})
		if err != nil {
			return fmt.Errorf("encode mux window topology: %w", err)
		}
		if err := store.UpsertWindow(persistence.WindowRecord{
			ID: windowID, SessionID: logicalID, Name: windowID, Index: index, LayoutJSON: string(layout),
		}); err != nil {
			return fmt.Errorf("persist mux window topology: %w", err)
		}
	}
	return operations.persistActiveLogicalSessionLocked(logicalID)
}

func (operations *Operations) observePaneTopologyLocked(session *managedSession) {
	state := operations.topologyStateLocked(logicalSessionID(session))
	state.activeWindowID = session.windowID
	state.activePaneByWindow[session.windowID] = session.paneID
	if !layoutHasPane(state.layoutByWindow[session.windowID], session.paneID) {
		state.layoutByWindow[session.windowID] = appendLayoutPane(state.layoutByWindow[session.windowID], session.paneID)
	}
	// The pane catalog has already been written by the caller. Persist the
	// interaction snapshot as well so an immediately-created window is still
	// selected after a later clean restart; the creation path must remain live
	// even if this redundant metadata update encounters transient I/O trouble.
	_ = operations.persistTopologyInteractionLocked(logicalSessionID(session))
}

func appendLayoutPane(layout *TopologyLayoutNode, paneID string) *TopologyLayoutNode {
	if layout == nil {
		return &TopologyLayoutNode{PaneID: paneID}
	}
	return &TopologyLayoutNode{Direction: "horizontal", Ratio: 0.5, First: layout, Second: &TopologyLayoutNode{PaneID: paneID}}
}

func layoutHasPane(layout *TopologyLayoutNode, paneID string) bool {
	return layout != nil && (layout.PaneID == paneID || layoutHasPane(layout.First, paneID) || layoutHasPane(layout.Second, paneID))
}

func removeLayoutPane(layout *TopologyLayoutNode, paneID string) *TopologyLayoutNode {
	if layout == nil {
		return nil
	}
	if layout.PaneID == paneID {
		return nil
	}
	if layout.PaneID != "" {
		return &TopologyLayoutNode{PaneID: layout.PaneID}
	}
	first := removeLayoutPane(layout.First, paneID)
	second := removeLayoutPane(layout.Second, paneID)
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	return &TopologyLayoutNode{Direction: layout.Direction, Ratio: layout.Ratio, First: first, Second: second}
}

func splitLayoutPane(layout *TopologyLayoutNode, sourcePaneID, createdPaneID, direction string, ratio float64) *TopologyLayoutNode {
	if layout == nil {
		return &TopologyLayoutNode{PaneID: createdPaneID}
	}
	if layout.PaneID == sourcePaneID {
		if direction != "horizontal" && direction != "vertical" {
			direction = "horizontal"
		}
		return &TopologyLayoutNode{Direction: direction, Ratio: validSplitRatio(ratio), First: &TopologyLayoutNode{PaneID: sourcePaneID}, Second: &TopologyLayoutNode{PaneID: createdPaneID}}
	}
	if layout.PaneID != "" {
		return &TopologyLayoutNode{PaneID: layout.PaneID}
	}
	return &TopologyLayoutNode{Direction: layout.Direction, Ratio: layout.Ratio, First: splitLayoutPane(layout.First, sourcePaneID, createdPaneID, direction, ratio), Second: splitLayoutPane(layout.Second, sourcePaneID, createdPaneID, direction, ratio)}
}

func resizeLayoutPane(layout *TopologyLayoutNode, paneID string, ratio float64) (*TopologyLayoutNode, bool) {
	if layout == nil || layout.PaneID != "" {
		return layout, false
	}
	if layoutHasPane(layout.First, paneID) || layoutHasPane(layout.Second, paneID) {
		return &TopologyLayoutNode{Direction: layout.Direction, Ratio: validSplitRatio(ratio), First: layout.First, Second: layout.Second}, true
	}
	first, changed := resizeLayoutPane(layout.First, paneID, ratio)
	if changed {
		return &TopologyLayoutNode{Direction: layout.Direction, Ratio: layout.Ratio, First: first, Second: layout.Second}, true
	}
	second, changed := resizeLayoutPane(layout.Second, paneID, ratio)
	return &TopologyLayoutNode{Direction: layout.Direction, Ratio: layout.Ratio, First: layout.First, Second: second}, changed
}

func validSplitRatio(ratio float64) float64 {
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < 0.1 || ratio > 0.9 {
		return 0.5
	}
	return ratio
}

func isFiniteSplitRatio(ratio float64) bool {
	return !math.IsNaN(ratio) && !math.IsInf(ratio, 0)
}

func normalizeLayout(layout *TopologyLayoutNode, panes map[string]struct{}) *TopologyLayoutNode {
	layout = pruneLayout(layout, panes)
	for _, paneID := range sortedMapKeys(panes) {
		if !layoutHasPane(layout, paneID) {
			layout = appendLayoutPane(layout, paneID)
		}
	}
	return layout
}

func pruneLayout(layout *TopologyLayoutNode, panes map[string]struct{}) *TopologyLayoutNode {
	if layout == nil {
		return nil
	}
	if layout.PaneID != "" {
		if _, exists := panes[layout.PaneID]; exists {
			return &TopologyLayoutNode{PaneID: layout.PaneID}
		}
		return nil
	}
	first := pruneLayout(layout.First, panes)
	second := pruneLayout(layout.Second, panes)
	if first == nil {
		return second
	}
	if second == nil {
		return first
	}
	return &TopologyLayoutNode{Direction: layout.Direction, Ratio: validSplitRatio(layout.Ratio), First: first, Second: second}
}

func (operations *Operations) topologyStateLocked(logicalID string) *topologyState {
	state := operations.topologyStateRecordLocked(logicalID)
	byWindow := make(map[string]map[string]struct{})
	for _, session := range operations.sessions {
		if logicalSessionID(session) != logicalID {
			continue
		}
		windowID := session.windowID
		if windowID == "" {
			windowID = session.paneID
		}
		panes := byWindow[windowID]
		if panes == nil {
			panes = make(map[string]struct{})
			byWindow[windowID] = panes
		}
		panes[session.paneID] = struct{}{}
	}
	windowIDs := make(map[string]struct{}, len(byWindow))
	for windowID := range byWindow {
		windowIDs[windowID] = struct{}{}
	}
	state.windowOrder = normalizeWindowOrder(state.windowOrder, windowIDs)
	if _, exists := byWindow[state.activeWindowID]; !exists {
		state.activeWindowID = firstString(state.windowOrder)
	}
	for windowID := range state.activePaneByWindow {
		if _, exists := byWindow[windowID]; !exists {
			delete(state.activePaneByWindow, windowID)
		}
	}
	for windowID := range state.zoomedPaneByWindow {
		if _, exists := byWindow[windowID]; !exists {
			delete(state.zoomedPaneByWindow, windowID)
		}
	}
	for windowID := range state.layoutByWindow {
		if _, exists := byWindow[windowID]; !exists {
			delete(state.layoutByWindow, windowID)
		}
	}
	for _, windowID := range state.windowOrder {
		panes := byWindow[windowID]
		if _, exists := panes[state.activePaneByWindow[windowID]]; !exists {
			state.activePaneByWindow[windowID] = firstString(sortedMapKeys(panes))
		}
		if zoomedPaneID := state.zoomedPaneByWindow[windowID]; zoomedPaneID != "" {
			if _, exists := panes[zoomedPaneID]; !exists {
				state.zoomedPaneByWindow[windowID] = ""
			}
		}
		state.layoutByWindow[windowID] = normalizeLayout(state.layoutByWindow[windowID], panes)
	}
	return state
}

// topologyStateRecordLocked returns the durable interaction record without
// reconciling it against live panes. Catalog recovery uses this narrow form to
// restore every persisted window placement before one final normalization.
func (operations *Operations) topologyStateRecordLocked(logicalID string) *topologyState {
	state := operations.topologyState[logicalID]
	if state != nil {
		return state
	}
	state = &topologyState{
		activePaneByWindow: make(map[string]string),
		zoomedPaneByWindow: make(map[string]string),
		layoutByWindow:     make(map[string]*TopologyLayoutNode),
	}
	operations.topologyState[logicalID] = state
	return state
}

// windowPlacementIndexLocked returns the durable, session-local position for a
// window being persisted before its new managed session joins the live maps.
// A new window therefore appends after the existing placement rather than
// temporarily claiming index zero and relying on a later reconciliation write.
func (operations *Operations) windowPlacementIndexLocked(session *managedSession) int {
	state := operations.topologyStateLocked(logicalSessionID(session))
	for index, windowID := range state.windowOrder {
		if windowID == session.windowID {
			return index
		}
	}
	return len(state.windowOrder)
}

// normalizeWindowOrder preserves known session-local placement, removes retired
// or duplicate IDs, and appends identities that predate this relation in a
// deterministic order. The final clause is the one-time compatibility rule for
// legacy/incomplete catalogs; ordinary create and close paths never sort live
// window placement by ID.
func normalizeWindowOrder(order []string, windows map[string]struct{}) []string {
	normalized := make([]string, 0, len(windows))
	seen := make(map[string]struct{}, len(windows))
	for _, windowID := range order {
		if _, exists := windows[windowID]; !exists {
			continue
		}
		if _, duplicate := seen[windowID]; duplicate {
			continue
		}
		seen[windowID] = struct{}{}
		normalized = append(normalized, windowID)
	}
	missing := make([]string, 0, len(windows)-len(normalized))
	for windowID := range windows {
		if _, exists := seen[windowID]; !exists {
			missing = append(missing, windowID)
		}
	}
	slices.Sort(missing)
	return append(normalized, missing...)
}

// removeWindowPlacement keeps selection deterministic when its window closes:
// choose the successor at the former index, falling back to the preceding final
// entry. Per-window interaction state is retired with the same placement.
func removeWindowPlacement(state *topologyState, windowID string) {
	index := slices.Index(state.windowOrder, windowID)
	if index >= 0 {
		state.windowOrder = append(state.windowOrder[:index], state.windowOrder[index+1:]...)
	}
	if state.activeWindowID == windowID {
		if index >= 0 && index < len(state.windowOrder) {
			state.activeWindowID = state.windowOrder[index]
		} else if len(state.windowOrder) > 0 {
			// The final placement has no successor. Keep focus in the
			// immediately preceding placement rather than jumping to the first
			// tab in the session.
			state.activeWindowID = state.windowOrder[len(state.windowOrder)-1]
		} else {
			state.activeWindowID = ""
		}
	}
	delete(state.activePaneByWindow, windowID)
	delete(state.zoomedPaneByWindow, windowID)
	delete(state.layoutByWindow, windowID)
}

func (operations *Operations) windowBelongsToLogicalSessionLocked(logicalID, windowID string) bool {
	for _, session := range operations.sessions {
		if logicalSessionID(session) == logicalID && session.windowID == windowID {
			return true
		}
	}
	return false
}

func (operations *Operations) windowPaneCountLocked(logicalID, windowID string) int {
	count := 0
	for _, session := range operations.sessions {
		if logicalSessionID(session) == logicalID && session.windowID == windowID {
			count++
		}
	}
	return count
}

func (operations *Operations) hasLogicalSessionLocked(logicalID string) bool {
	for _, session := range operations.sessions {
		if logicalSessionID(session) == logicalID {
			return true
		}
	}
	return false
}

func sortedMapKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for value := range values {
		keys = append(keys, value)
	}
	slices.Sort(keys)
	return keys
}

func firstString(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func firstTopologyPaneID(panes []TopologyPane) string {
	if len(panes) == 0 {
		return ""
	}
	return panes[0].PaneID
}

// shutdown is the safe cold-restart gate. The process-level handler stops the
// server only after this acknowledgement has been sent; running panes must be
// explicitly destroyed first so a Preferences click cannot kill user work.
func (operations *Operations) shutdown() ([]byte, error) {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	for _, session := range operations.sessions {
		if session.pane != nil {
			return nil, ErrLiveSessions
		}
	}
	return encodeOperation(struct{}{})
}

// Close is the explicit daemon shutdown boundary. It stops and reaps live
// processes, finalizes attachments, and reaps their session/history records;
// daemon-restart session resurrection is intentionally not supported.
func (operations *Operations) Close() error {
	operations.mu.Lock()
	defer operations.mu.Unlock()
	defer operations.stopCleanup()
	if len(operations.sessions) == 0 {
		return nil
	}
	var closeErr error
	type paneStop struct {
		pane *Pane
	}
	stopping := make([]paneStop, 0, len(operations.sessions))
	for _, session := range operations.sessions {
		if session.pane != nil {
			stopping = append(stopping, paneStop{pane: session.pane})
			session.pane = nil
		}
	}
	stopErrors := make(chan error, len(stopping))
	for _, pane := range stopping {
		go func(pane *Pane) { stopErrors <- pane.Terminate() }(pane.pane)
	}
	for range stopping {
		if err := <-stopErrors; err != nil && closeErr == nil {
			closeErr = fmt.Errorf("stop mux pane for shutdown: %w", err)
		}
	}
	for _, session := range operations.sessions {
		if session.attachment != nil {
			if err := session.attachment.Finalize(); err != nil && closeErr == nil {
				closeErr = fmt.Errorf("finalize mux recovery: %w", err)
			}
			if err := session.attachment.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
		session.attachment = nil
	}
	// Finalize every pane in a logical session before reaping any catalog rows.
	// DestroySession cascades to sibling panes, so interleaving it with the loop
	// above invalidated later attachments' recorder foreign keys.
	closedLogicalSessions := make(map[string]struct{})
	for _, session := range operations.sessions {
		logicalID := logicalSessionID(session)
		if logicalID == "" {
			continue
		}
		if _, alreadyClosed := closedLogicalSessions[logicalID]; alreadyClosed {
			continue
		}
		closedLogicalSessions[logicalID] = struct{}{}
		if err := operations.markLogicalSessionDeadLocked(logicalID); err != nil && closeErr == nil {
			closeErr = err
		}
	}
	operations.session = nil
	operations.sessions = make(map[string]*managedSession)
	operations.panes = make(map[string]*managedSession)
	operations.topologyState = make(map[string]*topologyState)
	return closeErr
}

// AbandonHandoff rolls back an adopted-but-unacknowledged replacement daemon.
// It drops only duplicated descriptors and in-memory state; the original
// daemon remains responsible for PTY processes and persistence.
func (operations *Operations) AbandonHandoff() error {
	operations.mu.Lock()
	sessions := make([]*managedSession, 0, len(operations.sessions))
	for _, session := range operations.sessions {
		sessions = append(sessions, session)
	}
	operations.sessions = make(map[string]*managedSession)
	operations.panes = make(map[string]*managedSession)
	operations.session = nil
	operations.topologyState = make(map[string]*topologyState)
	operations.activeLogicalByProject = make(map[string]string)
	operations.mu.Unlock()

	operations.stopCleanup()
	var abandonErr error
	for _, session := range sessions {
		if session.attachment != nil {
			if abandonable, ok := session.attachment.(interface{ AbandonUnstarted() error }); ok {
				if err := abandonable.AbandonUnstarted(); err != nil {
					abandonErr = errors.Join(abandonErr, err)
				}
			} else {
				abandonErr = errors.Join(abandonErr, fmt.Errorf("attachment for pane %s cannot be safely abandoned", session.paneID))
			}
		}
		if session.pane != nil {
			if err := session.pane.Close(); err != nil {
				abandonErr = errors.Join(abandonErr, err)
			}
		}
	}
	return abandonErr
}

func (operations *Operations) clearRecoveryLocked() error {
	if operations.persistencePath == "" {
		operations.recoveryErr = nil
		return nil
	}
	store, err := persistence.Open(operations.persistencePath, persistence.DefaultTailCap*4)
	if err != nil {
		return fmt.Errorf("open mux recovery record for explicit destruction: %w", err)
	}
	defer store.Close()
	if err := store.Clear(); err != nil {
		return fmt.Errorf("clear mux recovery record: %w", err)
	}
	operations.recoveryErr = nil
	return nil
}

func (operations *Operations) requireSession(sessionID string) (*managedSession, error) {
	session := operations.sessions[sessionID]
	if session == nil {
		return nil, ErrSessionNotFound
	}
	return session, nil
}

func (operations *Operations) requireDestroySession(sessionID string) (*managedSession, error) {
	if session, err := operations.requireSession(sessionID); err == nil {
		return session, nil
	}
	var recovered *managedSession
	for _, session := range operations.sessions {
		if session.pane != nil || !strings.HasPrefix(session.id, "recovered-") || logicalSessionID(session) != sessionID {
			continue
		}
		// Multiple recovered panes share a logical ID. A logical destroy request
		// cannot prove which one was intended, so require its runtime recovered
		// ID rather than silently deleting an arbitrary sibling.
		if recovered != nil {
			return nil, ErrSessionNotFound
		}
		recovered = session
	}
	if recovered != nil {
		return recovered, nil
	}
	return nil, ErrSessionNotFound
}

func (operations *Operations) requireLogicalSession(sessionID string) (*managedSession, error) {
	if session := operations.logicalSessionLocked(sessionID); session != nil {
		return session, nil
	}
	return nil, ErrSessionNotFound
}

func (operations *Operations) requirePane(paneID string) (*managedSession, error) {
	session := operations.panes[paneID]
	if session == nil {
		return nil, ErrPaneNotFound
	}
	return session, nil
}

// requireClient preserves compatibility for fixture clients that omit an
// identity, while enforcing exclusive ownership for Cockpit and tty clients.
func requireClient(session *managedSession, clientID string) error {
	if clientID != "" && session.clientID != "" && clientID != session.clientID {
		return ErrSessionStolen
	}
	return nil
}

func decodeOperation(data []byte, destination any) error {
	if err := msgpack.Unmarshal(data, destination); err != nil {
		return fmt.Errorf("decode mux operation: %w", err)
	}
	return nil
}

func encodeOperation(value any) ([]byte, error) {
	data, err := msgpack.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode mux operation: %w", err)
	}
	return data, nil
}
