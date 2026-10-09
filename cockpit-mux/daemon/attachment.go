//go:build libghostty

package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
	"github.com/local-repo-explorer/cockpit-mux/persistence/history"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/sys/unix"
)

// shadowAttachment continuously consumes one PTY into the exact raw-output and
// Ghostty-shadow paths. It owns no socket state, so client disconnects cannot
// affect the child process or the authoritative terminal state.
type shadowAttachment struct {
	pipeline  *Pipeline
	recorder  *Recorder
	store     *persistence.Store
	archive   *HistoryArchive
	history   *history.Store
	done      chan struct{}
	poll      *os.File
	stop      chan struct{}
	once      sync.Once
	startOnce sync.Once
	startMu   sync.Mutex
	started   bool
	abandoned bool
	stopOnce  sync.Once
	closeErr  error
	pumpErr   error

	handoffMu      sync.Mutex
	handoffRequest *handoffPause
}

type handoffPause struct {
	ready   chan struct{}
	release chan struct{}
	paused  bool
	aborted bool
	once    sync.Once
}

func newSessionAttachment(pane *Pane, persistencePath, paneID string, mirrorLegacy, persistScrollback bool, scrollbackLines ...uint) (sessionAttachment, error) {
	lines := DefaultScrollbackLines
	if len(scrollbackLines) > 0 && scrollbackLines[0] != 0 {
		lines = scrollbackLines[0]
	}
	shadow, err := NewShadowWithScrollback(80, 24, lines)
	if err != nil {
		return nil, err
	}
	primary, err := NewShadowWithScrollback(80, 24, lines)
	if err != nil {
		shadow.Close()
		return nil, err
	}
	pipeline := &Pipeline{Pane: pane, Shadow: shadow, Primary: primary, cols: 80, rows: 24}
	poll, err := duplicatePollFile(pane.master)
	if err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	attachment := &shadowAttachment{pipeline: pipeline, done: make(chan struct{}), poll: poll, stop: make(chan struct{})}
	closeUnstarted := func() {
		_ = poll.Close()
		shadow.Close()
		primary.Close()
	}
	if persistencePath != "" {
		store, err := persistence.Open(persistencePath, persistence.DefaultTailCap*4)
		if err != nil {
			closeUnstarted()
			return nil, err
		}
		var recorder *Recorder
		if paneID == "" {
			recorder, err = NewRecorderWithPersistence(store, shadow, persistence.DefaultTailCap, persistScrollback)
		} else {
			recorder, err = NewCatalogRecorderWithPersistence(store, shadow, persistence.DefaultTailCap, paneID, mirrorLegacy, persistScrollback)
		}
		if err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		recorder.SetRecoverySources(primary, func() ([]byte, error) {
			return marshalRecoveryMetadata(pipeline.Modes, pipeline.primaryMirror.savedCursor, pipeline.cols, pipeline.rows)
		})
		if err := recorder.Initialize(); err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		historyStore, err := history.Open(filepath.Join(filepath.Dir(persistencePath), "history.db"))
		if err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		archivePaneID := paneID
		if archivePaneID == "" {
			// Legacy single-pane recovery has no catalog pane ID. Keep its
			// optional history isolated under a stable private compatibility key.
			archivePaneID = "legacy"
		}
		archive, err := NewHistoryArchive(historyStore, primary, archivePaneID, archivePaneID, persistScrollback)
		if err != nil {
			_ = historyStore.Close()
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		attachment.recorder = recorder
		attachment.store = store
		attachment.archive = archive
		attachment.history = historyStore
		pipeline.OnPrimaryFeed = archive.Record
		pipeline.OnOutput = func(output Output) error {
			return recorder.RecordFed(output.Sequence, output.Data)
		}
	}
	if err := attachment.Start(); err != nil {
		closeUnstarted()
		return nil, err
	}
	if attachment.recorder != nil {
		go attachment.flushLoop()
	}
	return attachment, nil
}

// newAdoptedSessionAttachment reconstructs the native state captured at the
// grounded handoff boundary, then resumes the sole PTY reader from the received
// master descriptor. It is deliberately separate from recovery: a handoff pane
// is live and must continue producing raw output immediately after ACK.
func newAdoptedSessionAttachment(pane *Pane, state HandoffPane, persistencePath string, mirrorLegacy, persistScrollback bool, scrollbackLines ...uint) (sessionAttachment, error) {
	shadow, err := RestoreShadow(state.Snapshot)
	if err != nil {
		return nil, fmt.Errorf("restore mux handoff shadow: %w", err)
	}
	primary, err := RestoreShadow(state.PrimarySnapshot)
	if err != nil {
		shadow.Close()
		return nil, fmt.Errorf("restore mux handoff primary shadow: %w", err)
	}
	var metadata recoveryMetadata
	if err := msgpack.Unmarshal(state.Metadata, &metadata); err != nil {
		shadow.Close()
		primary.Close()
		return nil, fmt.Errorf("decode mux handoff metadata: %w", err)
	}
	modes, err := RestoreModeState(metadata.Modes)
	if err != nil {
		shadow.Close()
		primary.Close()
		return nil, fmt.Errorf("restore mux handoff modes: %w", err)
	}
	if metadata.Cols == 0 || metadata.Rows == 0 {
		shadow.Close()
		primary.Close()
		return nil, fmt.Errorf("mux handoff has invalid pane geometry")
	}
	lines := DefaultScrollbackLines
	if len(scrollbackLines) > 0 && scrollbackLines[0] != 0 {
		lines = scrollbackLines[0]
	}
	if err := shadow.SetScrollbackLines(lines); err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	if err := primary.SetScrollbackLines(lines); err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	pipeline := &Pipeline{
		Pane: pane, Shadow: shadow, Primary: primary, Modes: modes,
		primaryMirror: primaryMirror{alternate: modes.AlternateScreen, savedCursor: metadata.PrimarySavedCursor},
		cols:          metadata.Cols, rows: metadata.Rows,
	}
	poll, err := duplicatePollFile(pane.master)
	if err != nil {
		shadow.Close()
		primary.Close()
		return nil, err
	}
	attachment := &shadowAttachment{pipeline: pipeline, done: make(chan struct{}), poll: poll, stop: make(chan struct{})}
	closeUnstarted := func() {
		_ = poll.Close()
		shadow.Close()
		primary.Close()
	}
	if persistencePath != "" {
		store, err := persistence.Open(persistencePath, persistence.DefaultTailCap*4)
		if err != nil {
			closeUnstarted()
			return nil, err
		}
		recorder, err := NewCatalogRecorderWithPersistence(store, shadow, persistence.DefaultTailCap, state.PaneID, mirrorLegacy, persistScrollback)
		if err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		recorder.SetRecoverySources(primary, func() ([]byte, error) {
			return marshalRecoveryMetadata(pipeline.Modes, pipeline.primaryMirror.savedCursor, pipeline.cols, pipeline.rows)
		})
		if err := recorder.Initialize(); err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		historyStore, err := history.Open(filepath.Join(filepath.Dir(persistencePath), "history.db"))
		if err != nil {
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		archive, err := NewHistoryArchive(historyStore, primary, state.PaneID, state.PaneID, persistScrollback)
		if err != nil {
			_ = historyStore.Close()
			_ = store.Close()
			closeUnstarted()
			return nil, err
		}
		attachment.recorder = recorder
		attachment.store = store
		attachment.archive = archive
		attachment.history = historyStore
		pipeline.OnPrimaryFeed = archive.Record
		pipeline.OnOutput = func(output Output) error {
			return recorder.RecordFed(output.Sequence, output.Data)
		}
	}
	if attachment.recorder != nil {
		go attachment.flushLoop()
	}
	return attachment, nil
}

// Start begins the sole PTY reader. Regular sessions start immediately; an
// adopted handoff defers this until its ACK is safely delivered, so a child
// that is rejected or loses its control connection can never consume bytes the
// parent must resume reading.
func (attachment *shadowAttachment) Start() error {
	attachment.startMu.Lock()
	defer attachment.startMu.Unlock()
	if attachment.abandoned {
		return fmt.Errorf("cannot start an abandoned PTY attachment")
	}
	attachment.startOnce.Do(func() {
		attachment.started = true
		go attachment.pump()
	})
	return nil
}

// AbandonUnstarted closes only descriptors and in-memory parser state for a
// handoff child that has not ACKed ownership. It must never read the shared
// PTY, terminate its process, or flush state while the old daemon is still
// authoritative.
func (attachment *shadowAttachment) AbandonUnstarted() error {
	attachment.startMu.Lock()
	defer attachment.startMu.Unlock()
	if attachment.started {
		return fmt.Errorf("cannot abandon a started PTY attachment")
	}
	attachment.started = true
	attachment.abandoned = true // Prevent any later caller from starting the pump.
	var abandonErr error
	if err := attachment.poll.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		abandonErr = err
	}
	attachment.pipeline.Shadow.Close()
	attachment.pipeline.Primary.Close()
	close(attachment.done)
	return abandonErr
}

func (attachment *shadowAttachment) flushLoop() {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-attachment.done:
			return
		case <-ticker.C:
			_ = attachment.recorder.Flush()
			if attachment.archive != nil {
				_ = attachment.archive.FlushIdle(2 * time.Second)
			}
		}
	}
}

func (attachment *shadowAttachment) pump() {
	defer close(attachment.done)
	defer attachment.poll.Close()
	defer func() {
		if attachment.recorder != nil {
			_ = attachment.recorder.Flush()
		}
		if attachment.archive != nil {
			_ = attachment.archive.Flush()
		}
	}()
	buffer := make([]byte, 32*1024)
	for {
		if attachment.pauseIfGrounded() {
			continue
		}
		ready, err := waitPaneReadable(attachment.poll)
		if err != nil {
			attachment.pumpErr = fmt.Errorf("wait mux pane readability: %w", err)
			return
		}
		if !ready {
			select {
			case <-attachment.stop:
				return
			default:
			}
			continue
		}
		select {
		case <-attachment.stop:
			return
		default:
		}
		_, err = attachment.pipeline.Pump(buffer)
		if err != nil {
			attachment.pumpErr = fmt.Errorf("pump mux pane: %w", err)
			return
		}
	}
}

// duplicatePollFile isolates the bounded readiness wait from the master owned by
// Pane. Operations may close that master during destroy/shutdown while the pump
// is sleeping; polling a distinct duplicate makes the close/read lifecycle
// race-free without ever consuming PTY bytes from the duplicate.
func duplicatePollFile(master *os.File) (*os.File, error) {
	raw, err := master.SyscallConn()
	if err != nil {
		return nil, fmt.Errorf("access mux pane for readiness poll: %w", err)
	}
	var duplicated int
	if err := raw.Control(func(descriptor uintptr) { duplicated, err = unix.Dup(int(descriptor)) }); err != nil {
		return nil, fmt.Errorf("duplicate mux pane readiness descriptor: %w", err)
	}
	if err != nil {
		return nil, fmt.Errorf("duplicate mux pane readiness descriptor: %w", err)
	}
	return os.NewFile(uintptr(duplicated), "mux-pane-readiness"), nil
}

// PrepareHandoff stops this attachment's reader only once its parser is
// grounded, returns a consistent Snapshot v1 state, and supplies a release
// function. The caller must invoke the release on every ACK/NACK/timeout path
// unless it has transferred ownership and is exiting the old daemon.
func (attachment *shadowAttachment) PrepareHandoff(ctx context.Context) (HandoffState, *os.File, func(), error) {
	request := &handoffPause{ready: make(chan struct{}), release: make(chan struct{})}
	attachment.handoffMu.Lock()
	if attachment.handoffRequest != nil {
		attachment.handoffMu.Unlock()
		return HandoffState{}, nil, nil, fmt.Errorf("mux handoff already in progress")
	}
	attachment.handoffRequest = request
	attachment.handoffMu.Unlock()

	resume := func() {
		request.once.Do(func() { close(request.release) })
	}
	select {
	case <-request.ready:
	case <-ctx.Done():
		attachment.abortHandoffRequest(request)
		return HandoffState{}, nil, nil, fmt.Errorf("pause mux handoff reader: %w", ctx.Err())
	}

	state, err := attachment.handoffState()
	if err != nil {
		resume()
		return HandoffState{}, nil, nil, err
	}
	return state, attachment.pipeline.Pane.master, resume, nil
}

func (attachment *shadowAttachment) pauseIfGrounded() bool {
	attachment.handoffMu.Lock()
	request := attachment.handoffRequest
	attachment.handoffMu.Unlock()
	if request == nil {
		return false
	}
	attachment.pipeline.mu.Lock()
	ground, err := attachment.pipeline.Shadow.Ground()
	attachment.pipeline.mu.Unlock()
	if err != nil || !ground {
		return false
	}
	attachment.handoffMu.Lock()
	if attachment.handoffRequest != request || request.aborted {
		attachment.handoffMu.Unlock()
		return false
	}
	request.paused = true
	close(request.ready)
	attachment.handoffMu.Unlock()
	<-request.release
	attachment.handoffMu.Lock()
	if attachment.handoffRequest == request {
		attachment.handoffRequest = nil
	}
	attachment.handoffMu.Unlock()
	return true
}

func (attachment *shadowAttachment) abortHandoffRequest(request *handoffPause) {
	attachment.handoffMu.Lock()
	if attachment.handoffRequest == request {
		request.aborted = true
		if request.paused {
			request.once.Do(func() { close(request.release) })
		}
		attachment.handoffRequest = nil
	}
	attachment.handoffMu.Unlock()
}

func (attachment *shadowAttachment) handoffState() (HandoffState, error) {
	attachment.pipeline.mu.Lock()
	defer attachment.pipeline.mu.Unlock()
	ground, err := attachment.pipeline.Shadow.Ground()
	if err != nil {
		return HandoffState{}, err
	}
	if !ground {
		return HandoffState{}, fmt.Errorf("mux handoff parser is not grounded")
	}
	snapshot, err := attachment.pipeline.Shadow.Snapshot()
	if err != nil {
		return HandoffState{}, err
	}
	primarySnapshot, err := attachment.pipeline.Primary.Snapshot()
	if err != nil {
		return HandoffState{}, err
	}
	metadata, err := marshalRecoveryMetadata(
		attachment.pipeline.Modes,
		attachment.pipeline.primaryMirror.savedCursor,
		attachment.pipeline.cols,
		attachment.pipeline.rows,
	)
	if err != nil {
		return HandoffState{}, err
	}
	return HandoffState{Boundary: "grounded", Snapshot: snapshot, PrimarySnapshot: primarySnapshot, Metadata: metadata}, nil
}

// waitPaneReadable bounds a pump iteration so a handoff request can be observed
// even while an otherwise-idle PTY is already grounded. It never consumes bytes;
// Pipeline.Pump remains the sole raw-reader and state-owner.
func waitPaneReadable(master *os.File) (bool, error) {
	for {
		ready, err := unix.Poll([]unix.PollFd{{Fd: int32(master.Fd()), Events: unix.POLLIN | unix.POLLHUP}}, 50)
		if err == unix.EINTR {
			// Child exits deliver SIGCHLD while other panes may be idle. EINTR is
			// not a PTY failure and must never stop their sole output reader.
			continue
		}
		if err != nil {
			return false, fmt.Errorf("poll mux pane: %w", err)
		}
		return ready > 0, nil
	}
}

func (attachment *shadowAttachment) Attach(cols, rows, cellWidth, cellHeight uint16) (Seed, error) {
	seed, err := attachment.pipeline.Attach(cols, rows, cellWidth, cellHeight)
	if err != nil || attachment.archive == nil {
		return seed, err
	}
	if err := attachment.archive.Record(); err != nil {
		return Seed{}, err
	}
	return seed, nil
}

func (attachment *shadowAttachment) Resize(cols, rows uint16) error {
	if err := attachment.pipeline.Resize(cols, rows); err != nil {
		return err
	}
	if attachment.archive != nil {
		return attachment.archive.Record()
	}
	return nil
}

func (attachment *shadowAttachment) OutputsFrom(sequence uint64) []Output {
	return attachment.pipeline.Stream.OutputsFrom(sequence)
}

func (attachment *shadowAttachment) OutputsFromBounded(sequence uint64, maximumBytes int) []Output {
	return attachment.pipeline.Stream.OutputsFromBounded(sequence, maximumBytes)
}

func (attachment *shadowAttachment) Scrollback(before, count uint) ([]ScrollbackLine, error) {
	if attachment.archive == nil {
		return attachment.pipeline.Scrollback(before, count)
	}
	liveCount, err := attachment.pipeline.ScrollbackCount()
	if err != nil {
		return nil, err
	}
	archiveCount := attachment.archive.LineCount()
	total := archiveCount + uint64(liveCount)
	if uint64(before) >= total {
		return nil, nil
	}
	end := total - uint64(before)
	start := uint64(0)
	if uint64(count) < end {
		start = end - uint64(count)
	}
	lines := make([]ScrollbackLine, 0, count)
	if start < archiveCount {
		archiveEnd := end
		if archiveEnd > archiveCount {
			archiveEnd = archiveCount
		}
		archived, err := attachment.archive.Lines(start, archiveEnd-1)
		if err != nil {
			return nil, err
		}
		lines = append(lines, archived...)
	}
	if end > archiveCount {
		liveStart := uint64(0)
		if start > archiveCount {
			liveStart = start - archiveCount
		}
		liveEnd := end - archiveCount
		live, err := attachment.pipeline.Scrollback(uint(liveCount)-uint(liveEnd), uint(liveEnd-liveStart))
		if err != nil {
			return nil, err
		}
		for index := range live {
			live[index].Line += uint(archiveCount)
		}
		lines = append(lines, live...)
	}
	return lines, nil
}

func (attachment *shadowAttachment) SetPersistScrollback(enabled bool) error {
	if attachment.recorder == nil {
		return nil
	}
	if err := attachment.recorder.SetPersistScrollback(enabled); err != nil {
		return err
	}
	if attachment.archive != nil {
		return attachment.archive.SetEnabled(enabled)
	}
	return nil
}

func (attachment *shadowAttachment) SetScrollbackLines(lines uint) error {
	attachment.pipeline.mu.Lock()
	defer attachment.pipeline.mu.Unlock()
	if err := attachment.pipeline.Shadow.SetScrollbackLines(lines); err != nil {
		return err
	}
	if attachment.pipeline.Primary != nil {
		if err := attachment.pipeline.Primary.SetScrollbackLines(lines); err != nil {
			return err
		}
	}
	if attachment.archive != nil {
		return attachment.archive.Record()
	}
	return nil
}

func (attachment *shadowAttachment) EnablePersistence(path, paneID string, mirrorLegacy, persistScrollback bool) error {
	if path == "" || attachment.recorder != nil {
		return nil
	}
	store, err := persistence.Open(path, persistence.DefaultTailCap*4)
	if err != nil {
		return err
	}
	attachment.pipeline.mu.Lock()
	defer attachment.pipeline.mu.Unlock()
	if attachment.recorder != nil {
		_ = store.Close()
		return nil
	}
	recorder, err := NewCatalogRecorderWithPersistence(store, attachment.pipeline.Shadow, persistence.DefaultTailCap, paneID, mirrorLegacy, persistScrollback)
	if err != nil {
		_ = store.Close()
		return err
	}
	recorder.SetRecoverySources(attachment.pipeline.Primary, func() ([]byte, error) {
		return marshalRecoveryMetadata(attachment.pipeline.Modes, attachment.pipeline.primaryMirror.savedCursor, attachment.pipeline.cols, attachment.pipeline.rows)
	})
	if err := recorder.Initialize(); err != nil {
		_ = store.Close()
		return err
	}
	historyStore, err := history.Open(filepath.Join(filepath.Dir(path), "history.db"))
	if err != nil {
		_ = store.Close()
		return err
	}
	archive, err := NewHistoryArchive(historyStore, attachment.pipeline.Primary, paneID, paneID, persistScrollback)
	if err != nil {
		_ = historyStore.Close()
		_ = store.Close()
		return err
	}
	attachment.recorder = recorder
	attachment.store = store
	attachment.archive = archive
	attachment.history = historyStore
	attachment.pipeline.OnPrimaryFeed = archive.Record
	attachment.pipeline.OnOutput = func(output Output) error {
		return recorder.RecordFed(output.Sequence, output.Data)
	}
	go attachment.flushLoop()
	return nil
}

func (attachment *shadowAttachment) Done() <-chan struct{} { return attachment.done }

func (attachment *shadowAttachment) Close() error {
	attachment.stopPump()
	attachment.once.Do(func() {
		_ = attachment.Start()
		<-attachment.done
		if attachment.recorder != nil {
			attachment.closeErr = attachment.recorder.Flush()
		}
		if attachment.archive != nil {
			if err := attachment.archive.Close(); err != nil && attachment.closeErr == nil {
				attachment.closeErr = err
			}
		}
		if attachment.store != nil {
			if err := attachment.store.Close(); err != nil && attachment.closeErr == nil {
				attachment.closeErr = err
			}
		}
		if attachment.history != nil {
			if err := attachment.history.Close(); err != nil && attachment.closeErr == nil {
				attachment.closeErr = err
			}
		}
		attachment.pipeline.Shadow.Close()
		attachment.pipeline.Primary.Close()
	})
	return attachment.closeErr
}

func (attachment *shadowAttachment) Finalize() error {
	// Operations finalizes before it closes the store. Stop the reader first so
	// this cannot wait forever for an otherwise-idle inherited PTY.
	attachment.stopPump()
	_ = attachment.Start()
	<-attachment.done
	if attachment.recorder == nil {
		return nil
	}
	return attachment.recorder.Finalize()
}

func (attachment *shadowAttachment) stopPump() {
	attachment.stopOnce.Do(func() { close(attachment.stop) })
}
