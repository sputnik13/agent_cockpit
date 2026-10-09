//go:build libghostty

package daemon

import (
	"fmt"
	"sync"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
)

// Recorder is M1B's shadow-adjacent durability boundary. Call Record for every
// raw chunk after the authoritative shadow has become the sole state owner.
type Recorder struct {
	mu             sync.Mutex
	store          *persistence.Store
	legacy         bool
	catalogPane    string
	shadow         *Shadow
	primary        *Shadow
	metadata       func() ([]byte, error)
	version        string
	persistContent bool
	cap            int
	hardCap        int
	tailSize       int
	pending        []persistence.TailChunk
	pendingSize    int
}

// SetRecoverySources supplies the M1C state that lives outside the active
// libghostty snapshot. It is configured before the PTY pump starts.
func (recorder *Recorder) SetRecoverySources(primary *Shadow, metadata func() ([]byte, error)) {
	recorder.primary = primary
	recorder.metadata = metadata
}

func NewRecorder(store *persistence.Store, shadow *Shadow, cap int) (*Recorder, error) {
	return NewRecorderWithPersistence(store, shadow, cap, true)
}

func NewRecorderWithPersistence(store *persistence.Store, shadow *Shadow, cap int, persistScrollback bool) (*Recorder, error) {
	return newRecorder(store, shadow, cap, true, "", persistScrollback)
}

// NewCatalogRecorder persists one pane under the M3 catalog. Set mirrorLegacy
// only for the primary M1 recovery pane while compatibility restore remains.
func NewCatalogRecorder(store *persistence.Store, shadow *Shadow, cap int, paneID string, mirrorLegacy bool) (*Recorder, error) {
	return NewCatalogRecorderWithPersistence(store, shadow, cap, paneID, mirrorLegacy, true)
}

func NewCatalogRecorderWithPersistence(store *persistence.Store, shadow *Shadow, cap int, paneID string, mirrorLegacy, persistScrollback bool) (*Recorder, error) {
	if paneID == "" {
		return nil, fmt.Errorf("mux catalog recorder requires pane ID")
	}
	return newRecorder(store, shadow, cap, mirrorLegacy, paneID, persistScrollback)
}

func newRecorder(store *persistence.Store, shadow *Shadow, cap int, legacy bool, catalogPane string, persistScrollback bool) (*Recorder, error) {
	if cap <= 0 {
		cap = persistence.DefaultTailCap
	}
	version, err := EngineVersion()
	if err != nil {
		return nil, err
	}
	return &Recorder{store: store, shadow: shadow, legacy: legacy, catalogPane: catalogPane, version: version, persistContent: persistScrollback, cap: cap, hardCap: cap * 4}, nil
}

func (recorder *Recorder) Initialize() error { return recorder.keyframe("grounded") }

// SetPersistScrollback changes what is durable without changing the live
// Ghostty shadow. Turning it off immediately replaces the stored state with a
// blank valid keyframe and discards any unflushed tail; turning it on records a
// fresh baseline from the current live terminal.
func (recorder *Recorder) SetPersistScrollback(enabled bool) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if recorder.persistContent == enabled {
		return nil
	}
	recorder.persistContent = enabled
	return recorder.keyframe("grounded")
}

func (recorder *Recorder) Record(sequence uint64, data []byte) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(data) == 0 {
		return nil
	}
	recorder.shadow.Feed(data)
	return recorder.recordFedLocked(sequence, data)
}

// RecordFed records data after the caller has fed the same bytes to the
// authoritative shadow. Pipeline uses this to preserve one state-owner path.
func (recorder *Recorder) RecordFed(sequence uint64, data []byte) error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if len(data) == 0 {
		return nil
	}
	return recorder.recordFedLocked(sequence, data)
}

func (recorder *Recorder) recordFedLocked(sequence uint64, data []byte) error {
	if !recorder.persistContent {
		return nil
	}
	ground, err := recorder.shadow.Ground()
	if err != nil {
		return err
	}
	nextSize := recorder.tailSize + recorder.pendingSize + len(data)
	if nextSize >= recorder.cap && ground {
		return recorder.keyframe("grounded")
	}
	if nextSize >= recorder.hardCap {
		return recorder.keyframe("forced")
	}
	recorder.pending = append(recorder.pending, persistence.TailChunk{Sequence: sequence, Data: append([]byte(nil), data...)})
	recorder.pendingSize += len(data)
	if recorder.pendingSize >= 64<<10 {
		return recorder.flushLocked()
	}
	return nil
}

// Flush establishes a durable raw-tail boundary. Data recorded after a Flush
// but before a subsequent Flush is intentionally absent after a crash.
func (recorder *Recorder) Flush() error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.flushLocked()
}

// Finalize establishes a clean-shutdown recovery point. A parser that remains
// mid-sequence is retained as a diagnostic-only forced boundary rather than
// being mislabeled as safely restorable.
func (recorder *Recorder) Finalize() error {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if err := recorder.flushLocked(); err != nil {
		return err
	}
	ground, err := recorder.shadow.Ground()
	if err != nil {
		return err
	}
	boundary := "grounded"
	if !ground {
		boundary = "forced"
	}
	return recorder.keyframe(boundary)
}

func (recorder *Recorder) flushLocked() error {
	if len(recorder.pending) == 0 {
		return nil
	}
	if recorder.legacy {
		if err := recorder.store.AppendBatch(recorder.pending); err != nil {
			return fmt.Errorf("append mux recovery tail batch: %w", err)
		}
	}
	if recorder.catalogPane != "" {
		if err := recorder.store.AppendPaneBatch(recorder.catalogPane, recorder.pending); err != nil {
			return fmt.Errorf("append mux catalog tail batch: %w", err)
		}
	}
	recorder.tailSize += recorder.pendingSize
	recorder.pending = nil
	recorder.pendingSize = 0
	return nil
}

func (recorder *Recorder) keyframe(boundary string) error {
	snapshot, err := recorder.snapshotForPersistence()
	if err != nil {
		return err
	}
	var primarySnapshot, metadata []byte
	if recorder.primary != nil {
		if recorder.persistContent {
			primarySnapshot, err = recorder.primary.Snapshot()
		} else {
			primarySnapshot = append([]byte(nil), snapshot...)
		}
		if err != nil {
			return err
		}
	}
	if recorder.metadata != nil && recorder.persistContent {
		metadata, err = recorder.metadata()
		if err != nil {
			return err
		}
	} else if !recorder.persistContent {
		metadata, err = marshalRecoveryMetadata(ModeState{}, false, 80, 24)
		if err != nil {
			return err
		}
	}
	keyframe := persistence.Keyframe{
		EngineVersion:   recorder.version,
		Boundary:        boundary,
		Snapshot:        snapshot,
		PrimarySnapshot: primarySnapshot,
		Metadata:        metadata,
	}
	if recorder.legacy {
		if err := recorder.store.SaveKeyframe(keyframe); err != nil {
			return fmt.Errorf("save mux recovery keyframe: %w", err)
		}
	}
	if recorder.catalogPane != "" {
		if err := recorder.store.SavePaneKeyframe(recorder.catalogPane, keyframe); err != nil {
			return fmt.Errorf("save mux catalog keyframe: %w", err)
		}
	}
	recorder.tailSize = 0
	recorder.pending = nil
	recorder.pendingSize = 0
	return nil
}

// snapshotForPersistence returns a blank but valid Ghostty Snapshot v1 when
// content persistence is disabled. Session topology remains recoverable, while
// neither screen text nor scrollback/tail bytes are written to SQLite.
func (recorder *Recorder) snapshotForPersistence() ([]byte, error) {
	if recorder.persistContent {
		return recorder.shadow.Snapshot()
	}
	blank, err := NewShadow(80, 24)
	if err != nil {
		return nil, err
	}
	defer blank.Close()
	return blank.Snapshot()
}
