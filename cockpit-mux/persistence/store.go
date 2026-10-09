// Package persistence owns M1B's private Snapshot v1 keyframe and raw-tail store.
package persistence

import (
	"bytes"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"
)

const (
	DefaultTailCap       = 1 << 20
	DefaultRetentionDays = 7
	DefaultDatabaseCap   = 500 << 20
	// Multiple live mux panes keep independent recovery recorders open against
	// the same catalog. A short SQLite writer overlap must wait for its peer,
	// not turn a pane/window creation into a user-visible SQLITE_BUSY failure.
	busyTimeoutMillis = 5_000
)

type Store struct {
	mu       sync.Mutex
	database *sql.DB
	encode   *zstd.Encoder
	decode   *zstd.Decoder
	tailCap  int
}

type Keyframe struct {
	EngineVersion   string
	Snapshot        []byte
	PrimarySnapshot []byte
	Metadata        []byte
	Boundary        string
}

// TailChunk is one ordered raw-output fragment. A batch is committed in one
// SQLite transaction, giving recovery an unambiguous durability boundary.
type TailChunk struct {
	Sequence uint64
	Data     []byte
}

// SessionRecord is the durable lifecycle record for a logical mux session.
// It intentionally stores no terminal content; that remains owned by the
// pane-level keyframe/tail records below.
type SessionRecord struct {
	ID             string
	Name           string
	ProjectID      string
	Kind           string
	Status         string
	Pinned         bool
	CreatedAt      time.Time
	LastAttachedAt time.Time
}

type WindowRecord struct {
	ID         string
	SessionID  string
	Name       string
	Index      int
	LayoutJSON string
}

type PaneRecord struct {
	ID        string
	WindowID  string
	SessionID string
	Cwd       string
	Command   string
	Cols      int
	Rows      int
	Broadcast bool
	Title     string
}

// CatalogPane identifies a pane that has a recoverable per-pane keyframe.
type CatalogPane struct {
	PaneID    string
	SessionID string
	ProjectID string
	WindowID  string
	Key       string
	Broadcast bool
	Pinned    bool
}

// CatalogWindow is the non-content layout metadata needed to restore a mux
// topology after the daemon has recovered its pane snapshots.
type CatalogWindow struct {
	WindowID   string
	SessionID  string
	Index      int
	LayoutJSON string
}

func Open(path string, tailCap int) (*Store, error) {
	if tailCap <= 0 {
		tailCap = DefaultTailCap
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create mux persistence directory: %w", err)
	}
	uri := url.URL{Scheme: "file", Path: path}
	query := uri.Query()
	query.Set("_busy_timeout", strconv.Itoa(busyTimeoutMillis))
	uri.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, fmt.Errorf("open mux persistence: %w", err)
	}
	// SQLite pragmas such as synchronous are connection-scoped. Persistence is
	// serialized by Store, so one connection keeps the declared WAL/NORMAL policy
	// stable without reducing useful parallelism.
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		database.Close()
		return nil, fmt.Errorf("create snapshot encoder: %w", err)
	}
	decoder, err := zstd.NewReader(nil)
	if err != nil {
		encoder.Close()
		database.Close()
		return nil, fmt.Errorf("create snapshot decoder: %w", err)
	}
	store := &Store{database: database, encode: encoder, decode: decoder, tailCap: tailCap}
	if err := store.migrate(); err != nil {
		store.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		store.Close()
		return nil, fmt.Errorf("protect mux persistence: %w", err)
	}
	return store, nil
}

func (store *Store) Close() error {
	store.encode.Close()
	store.decode.Close()
	return store.database.Close()
}

func (store *Store) migrate() error {
	var schemaVersion int
	if err := store.database.QueryRow(`PRAGMA user_version`).Scan(&schemaVersion); err != nil {
		return fmt.Errorf("read mux schema version: %w", err)
	}
	if schemaVersion > 6 {
		return fmt.Errorf("mux persistence schema %d is newer than supported schema 6", schemaVersion)
	}
	// Journal mode is durable database state. Repeating it for every short-lived
	// catalog handle takes an unnecessary writer lock, while normal mux activity
	// already has one recorder connection per live pane. A current schema only
	// needs its connection-scoped safety settings.
	if schemaVersion == 6 {
		if _, err := store.database.Exec(`PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`); err != nil {
			return fmt.Errorf("configure mux persistence connection: %w", err)
		}
		return nil
	}
	if _, err := store.database.Exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;`); err != nil {
		return fmt.Errorf("configure mux persistence: %w", err)
	}
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`
		CREATE TABLE IF NOT EXISTS keyframes (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			engine_version TEXT NOT NULL,
			boundary TEXT NOT NULL CHECK (boundary IN ('grounded', 'forced')),
			snapshot BLOB NOT NULL,
			primary_snapshot BLOB NOT NULL DEFAULT X'',
			metadata BLOB NOT NULL DEFAULT X''
		);
		CREATE TABLE IF NOT EXISTS tail_batches (
			batch INTEGER PRIMARY KEY AUTOINCREMENT,
			first_sequence INTEGER NOT NULL,
			last_sequence INTEGER NOT NULL,
			data BLOB NOT NULL
		);`); err != nil {
		return fmt.Errorf("migrate mux persistence: %w", err)
	}
	if schemaVersion < 2 {
		var oldTail string
		err = transaction.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name='tail'`).Scan(&oldTail)
		if err == nil {
			if _, err := transaction.Exec(`INSERT INTO tail_batches (first_sequence, last_sequence, data)
				SELECT sequence, sequence, data FROM tail ORDER BY sequence`); err != nil {
				return fmt.Errorf("migrate legacy mux tail: %w", err)
			}
		} else if err != sql.ErrNoRows {
			return fmt.Errorf("inspect legacy mux tail: %w", err)
		}
	}
	if schemaVersion > 0 && schemaVersion < 3 {
		if _, err := transaction.Exec(`ALTER TABLE keyframes ADD COLUMN primary_snapshot BLOB NOT NULL DEFAULT X''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add primary snapshot column: %w", err)
		}
		if _, err := transaction.Exec(`ALTER TABLE keyframes ADD COLUMN metadata BLOB NOT NULL DEFAULT X''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add mux metadata column: %w", err)
		}
	}
	// The M3 catalog is deliberately additive to the M1 recovery tables. Older
	// databases keep their single-pane recovery record intact while new session
	// topology gains real cascade and eviction semantics.
	if _, err := transaction.Exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			project_id TEXT NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
			status TEXT NOT NULL CHECK (status IN ('live', 'dead')),
			pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
			created_at INTEGER NOT NULL,
			last_attached_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS windows (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			idx INTEGER NOT NULL,
			layout_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS panes (
			id TEXT PRIMARY KEY,
			window_id TEXT NOT NULL REFERENCES windows(id) ON DELETE CASCADE,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			cwd TEXT, command TEXT, cols INTEGER, rows INTEGER,
			broadcast INTEGER NOT NULL DEFAULT 0 CHECK (broadcast IN (0, 1)),
			title TEXT
		);
		CREATE TABLE IF NOT EXISTS session_keyframes (
			pane_id TEXT PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
			written_at INTEGER NOT NULL,
			snapshot_format TEXT NOT NULL,
			boundary TEXT NOT NULL CHECK (boundary IN ('grounded', 'forced')),
			state BLOB NOT NULL,
			primary_state BLOB NOT NULL DEFAULT X'',
			metadata BLOB NOT NULL DEFAULT X''
		);
		CREATE TABLE IF NOT EXISTS session_tails (
			pane_id TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
			seq INTEGER NOT NULL,
			data BLOB NOT NULL,
			PRIMARY KEY (pane_id, seq)
		);
		CREATE INDEX IF NOT EXISTS sessions_dead_eviction ON sessions(status, pinned, last_attached_at);
	`); err != nil {
		return fmt.Errorf("migrate mux lifecycle catalog: %w", err)
	}
	if schemaVersion > 0 && schemaVersion < 5 {
		if _, err := transaction.Exec(`ALTER TABLE session_keyframes ADD COLUMN primary_state BLOB NOT NULL DEFAULT X''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add mux catalog primary snapshot column: %w", err)
		}
		if _, err := transaction.Exec(`ALTER TABLE session_keyframes ADD COLUMN metadata BLOB NOT NULL DEFAULT X''`); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add mux catalog metadata column: %w", err)
		}
	}
	if _, err := transaction.Exec(`
		CREATE TABLE IF NOT EXISTS active_logical_sessions (
			project_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
		);`); err != nil {
		return fmt.Errorf("migrate mux active logical session: %w", err)
	}
	if _, err := transaction.Exec(`PRAGMA user_version = 6`); err != nil {
		return fmt.Errorf("set mux schema version: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit mux migration: %w", err)
	}
	return nil
}

// SetActiveLogicalSession persists the selected mux session independently for
// each project; terminals contain no content in this relation.
func (store *Store) SetActiveLogicalSession(projectID, sessionID string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`INSERT INTO active_logical_sessions (project_id, session_id) VALUES (?, ?)
		ON CONFLICT(project_id) DO UPDATE SET session_id=excluded.session_id`, projectID, sessionID)
	return err
}

// ActiveLogicalSessions returns the durable project → selected-session map.
func (store *Store) ActiveLogicalSessions() (map[string]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	rows, err := store.database.Query(`SELECT project_id, session_id FROM active_logical_sessions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var projectID, sessionID string
		if err := rows.Scan(&projectID, &sessionID); err != nil {
			return nil, err
		}
		result[projectID] = sessionID
	}
	return result, rows.Err()
}

func (store *Store) SaveKeyframe(keyframe Keyframe) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if keyframe.EngineVersion == "" || len(keyframe.Snapshot) == 0 || (keyframe.Boundary != "grounded" && keyframe.Boundary != "forced") {
		return fmt.Errorf("invalid mux keyframe")
	}
	compressed := store.encode.EncodeAll(keyframe.Snapshot, nil)
	primaryCompressed := store.encode.EncodeAll(keyframe.PrimarySnapshot, nil)
	metadata := keyframe.Metadata
	if metadata == nil {
		metadata = []byte{}
	}
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`INSERT INTO keyframes (id, engine_version, boundary, snapshot, primary_snapshot, metadata)
		VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET engine_version=excluded.engine_version,
		boundary=excluded.boundary, snapshot=excluded.snapshot, primary_snapshot=excluded.primary_snapshot,
		metadata=excluded.metadata`, keyframe.EngineVersion, keyframe.Boundary, compressed, primaryCompressed, metadata); err != nil {
		return err
	}
	if _, err := transaction.Exec(`DELETE FROM tail_batches`); err != nil {
		return err
	}
	return transaction.Commit()
}

func (store *Store) Append(sequence uint64, data []byte) error {
	return store.AppendBatch([]TailChunk{{Sequence: sequence, Data: data}})
}

// Clear removes the recoverable record without removing the private database.
// Callers use it only after an explicit session.destroy, so a newly created
// session can never silently overwrite a recovered or diagnostic record.
func (store *Store) Clear() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`DELETE FROM tail_batches; DELETE FROM keyframes;`); err != nil {
		return err
	}
	return transaction.Commit()
}

// ClearContent removes all screen snapshots and raw terminal tails while
// deliberately retaining the catalog's non-content session/window/pane
// topology. It is the privacy boundary used when a user disables Cockpit-mux
// scrollback persistence after the daemon has already written recovery data.
func (store *Store) ClearContent() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`DELETE FROM tail_batches; DELETE FROM keyframes; DELETE FROM session_tails; DELETE FROM session_keyframes;`); err != nil {
		return err
	}
	return transaction.Commit()
}

// AppendBatch makes all supplied chunks durable together. Callers retain
// ownership of the input buffers after this method returns.
func (store *Store) AppendBatch(chunks []TailChunk) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(chunks) == 0 {
		return nil
	}
	batchSize := 0
	for _, chunk := range chunks {
		if len(chunk.Data) == 0 {
			return fmt.Errorf("empty mux tail chunk")
		}
		batchSize += len(chunk.Data)
	}
	var total int
	if err := store.database.QueryRow(`SELECT COALESCE(SUM(length(data)), 0) FROM tail_batches`).Scan(&total); err != nil {
		return err
	}
	if total+batchSize > store.tailCap {
		return fmt.Errorf("mux tail cap reached: %d bytes", store.tailCap)
	}
	for index := 1; index < len(chunks); index++ {
		if chunks[index].Sequence <= chunks[index-1].Sequence {
			return fmt.Errorf("mux tail sequences must increase within a batch")
		}
	}
	var lastSequence uint64
	err := store.database.QueryRow(`SELECT last_sequence FROM tail_batches ORDER BY batch DESC LIMIT 1`).Scan(&lastSequence)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil && chunks[0].Sequence <= lastSequence {
		return fmt.Errorf("mux tail sequence %d is not after committed sequence %d", chunks[0].Sequence, lastSequence)
	}
	batch := make([]byte, 0, batchSize)
	for _, chunk := range chunks {
		batch = append(batch, chunk.Data...)
	}
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`INSERT INTO tail_batches (first_sequence, last_sequence, data) VALUES (?, ?, ?)`, chunks[0].Sequence, chunks[len(chunks)-1].Sequence, batch); err != nil {
		return err
	}
	return transaction.Commit()
}

func (store *Store) Load(engineVersion string) (Keyframe, [][]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	var keyframe Keyframe
	var compressed, primaryCompressed []byte
	if err := store.database.QueryRow(`SELECT engine_version, boundary, snapshot, primary_snapshot, metadata FROM keyframes WHERE id=1`).Scan(&keyframe.EngineVersion, &keyframe.Boundary, &compressed, &primaryCompressed, &keyframe.Metadata); err != nil {
		return Keyframe{}, nil, err
	}
	if keyframe.EngineVersion != engineVersion {
		return Keyframe{}, nil, fmt.Errorf("incompatible mux snapshot engine %q (expected %q)", keyframe.EngineVersion, engineVersion)
	}
	decoded, err := store.decode.DecodeAll(compressed, nil)
	if err != nil {
		return Keyframe{}, nil, fmt.Errorf("decode mux snapshot: %w", err)
	}
	keyframe.Snapshot = decoded
	if len(primaryCompressed) > 0 {
		primary, err := store.decode.DecodeAll(primaryCompressed, nil)
		if err != nil {
			return Keyframe{}, nil, fmt.Errorf("decode mux primary snapshot: %w", err)
		}
		keyframe.PrimarySnapshot = primary
	}
	rows, err := store.database.Query(`SELECT data FROM tail_batches ORDER BY batch`)
	if err != nil {
		return Keyframe{}, nil, err
	}
	defer rows.Close()
	var tail [][]byte
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return Keyframe{}, nil, err
		}
		tail = append(tail, bytes.Clone(data))
	}
	return keyframe, tail, rows.Err()
}

// SavePaneKeyframe atomically replaces one catalog pane's tail with a new
// keyframe. It is independent of the legacy single-pane recovery record.
func (store *Store) SavePaneKeyframe(paneID string, keyframe Keyframe) error {
	if paneID == "" || keyframe.EngineVersion == "" || len(keyframe.Snapshot) == 0 || (keyframe.Boundary != "grounded" && keyframe.Boundary != "forced") {
		return fmt.Errorf("invalid mux pane keyframe")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`INSERT INTO session_keyframes (pane_id, written_at, snapshot_format, boundary, state, primary_state, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pane_id) DO UPDATE SET written_at=excluded.written_at,
		snapshot_format=excluded.snapshot_format, boundary=excluded.boundary, state=excluded.state,
		primary_state=excluded.primary_state, metadata=excluded.metadata`,
		paneID, time.Now().UnixMilli(), keyframe.EngineVersion, keyframe.Boundary, store.encode.EncodeAll(keyframe.Snapshot, nil), store.encode.EncodeAll(keyframe.PrimarySnapshot, nil), keyframe.Metadata); err != nil {
		return err
	}
	if _, err := transaction.Exec(`DELETE FROM session_tails WHERE pane_id=?`, paneID); err != nil {
		return err
	}
	return transaction.Commit()
}

func (store *Store) AppendPaneBatch(paneID string, chunks []TailChunk) error {
	if paneID == "" {
		return fmt.Errorf("mux pane ID is required")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(chunks) == 0 {
		return nil
	}
	batchSize := 0
	for index, chunk := range chunks {
		if len(chunk.Data) == 0 {
			return fmt.Errorf("empty mux tail chunk")
		}
		if index > 0 && chunk.Sequence <= chunks[index-1].Sequence {
			return fmt.Errorf("mux tail sequences must increase within a batch")
		}
		batchSize += len(chunk.Data)
	}
	var total int
	if err := store.database.QueryRow(`SELECT COALESCE(SUM(length(data)), 0) FROM session_tails WHERE pane_id=?`, paneID).Scan(&total); err != nil {
		return err
	}
	if total+batchSize > store.tailCap {
		return fmt.Errorf("mux tail cap reached: %d bytes", store.tailCap)
	}
	var last uint64
	err := store.database.QueryRow(`SELECT seq FROM session_tails WHERE pane_id=? ORDER BY seq DESC LIMIT 1`, paneID).Scan(&last)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil && chunks[0].Sequence <= last {
		return fmt.Errorf("mux tail sequence %d is not after committed sequence %d", chunks[0].Sequence, last)
	}
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	for _, chunk := range chunks {
		if _, err := transaction.Exec(`INSERT INTO session_tails (pane_id, seq, data) VALUES (?, ?, ?)`, paneID, chunk.Sequence, chunk.Data); err != nil {
			return err
		}
	}
	return transaction.Commit()
}

func (store *Store) LoadPane(paneID, engineVersion string) (Keyframe, [][]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	var keyframe Keyframe
	var compressed, primaryCompressed []byte
	if err := store.database.QueryRow(`SELECT snapshot_format, boundary, state, primary_state, metadata FROM session_keyframes WHERE pane_id=?`, paneID).Scan(&keyframe.EngineVersion, &keyframe.Boundary, &compressed, &primaryCompressed, &keyframe.Metadata); err != nil {
		return Keyframe{}, nil, err
	}
	if keyframe.EngineVersion != engineVersion {
		return Keyframe{}, nil, fmt.Errorf("incompatible mux snapshot engine %q (expected %q)", keyframe.EngineVersion, engineVersion)
	}
	snapshot, err := store.decode.DecodeAll(compressed, nil)
	if err != nil {
		return Keyframe{}, nil, fmt.Errorf("decode mux pane snapshot: %w", err)
	}
	keyframe.Snapshot = snapshot
	if len(primaryCompressed) > 0 {
		primary, err := store.decode.DecodeAll(primaryCompressed, nil)
		if err != nil {
			return Keyframe{}, nil, fmt.Errorf("decode mux pane primary snapshot: %w", err)
		}
		keyframe.PrimarySnapshot = primary
	}
	rows, err := store.database.Query(`SELECT data FROM session_tails WHERE pane_id=? ORDER BY seq`, paneID)
	if err != nil {
		return Keyframe{}, nil, err
	}
	defer rows.Close()
	var tail [][]byte
	for rows.Next() {
		var data []byte
		if err := rows.Scan(&data); err != nil {
			return Keyframe{}, nil, err
		}
		tail = append(tail, bytes.Clone(data))
	}
	return keyframe, tail, rows.Err()
}

func (store *Store) CatalogPanes() ([]CatalogPane, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	rows, err := store.database.Query(`SELECT panes.id, panes.session_id, sessions.project_id, panes.window_id, sessions.name, panes.broadcast, sessions.pinned
		FROM panes JOIN sessions ON sessions.id=panes.session_id
		JOIN session_keyframes ON session_keyframes.pane_id=panes.id
		ORDER BY panes.session_id, panes.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var panes []CatalogPane
	for rows.Next() {
		var pane CatalogPane
		if err := rows.Scan(&pane.PaneID, &pane.SessionID, &pane.ProjectID, &pane.WindowID, &pane.Key, &pane.Broadcast, &pane.Pinned); err != nil {
			return nil, err
		}
		panes = append(panes, pane)
	}
	return panes, rows.Err()
}

func (store *Store) CatalogWindows() ([]CatalogWindow, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	rows, err := store.database.Query(`SELECT id, session_id, idx, layout_json FROM windows ORDER BY session_id, idx, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var windows []CatalogWindow
	for rows.Next() {
		var window CatalogWindow
		if err := rows.Scan(&window.WindowID, &window.SessionID, &window.Index, &window.LayoutJSON); err != nil {
			return nil, err
		}
		windows = append(windows, window)
	}
	return windows, rows.Err()
}

// UpsertSession records a logical session without changing its pin state unless
// the caller supplies it. All timestamps are stored as Unix milliseconds so the
// cleanup policy is independent of the daemon process lifetime.
func (store *Store) UpsertSession(record SessionRecord) error {
	if record.ID == "" || record.Name == "" || record.ProjectID == "" || (record.Kind != "local" && record.Kind != "remote") || (record.Status != "live" && record.Status != "dead") {
		return fmt.Errorf("invalid mux session record")
	}
	if record.CreatedAt.IsZero() {
		record.CreatedAt = time.Now()
	}
	if record.LastAttachedAt.IsZero() {
		record.LastAttachedAt = record.CreatedAt
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`INSERT INTO sessions (id, name, project_id, kind, status, pinned, created_at, last_attached_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name=excluded.name, project_id=excluded.project_id,
		kind=excluded.kind, status=excluded.status, pinned=excluded.pinned,
		last_attached_at=excluded.last_attached_at`, record.ID, record.Name, record.ProjectID, record.Kind,
		record.Status, record.Pinned, record.CreatedAt.UnixMilli(), record.LastAttachedAt.UnixMilli())
	return err
}

func (store *Store) UpsertWindow(record WindowRecord) error {
	if record.ID == "" || record.SessionID == "" || record.Name == "" || record.LayoutJSON == "" {
		return fmt.Errorf("invalid mux window record")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`INSERT INTO windows (id, session_id, name, idx, layout_json) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, name=excluded.name, idx=excluded.idx, layout_json=excluded.layout_json`,
		record.ID, record.SessionID, record.Name, record.Index, record.LayoutJSON)
	return err
}

func (store *Store) UpsertPane(record PaneRecord) error {
	if record.ID == "" || record.WindowID == "" || record.SessionID == "" {
		return fmt.Errorf("invalid mux pane record")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`INSERT INTO panes (id, window_id, session_id, cwd, command, cols, rows, broadcast, title)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET window_id=excluded.window_id, session_id=excluded.session_id,
		cwd=excluded.cwd, command=excluded.command, cols=excluded.cols, rows=excluded.rows,
		broadcast=excluded.broadcast, title=excluded.title`, record.ID, record.WindowID, record.SessionID,
		record.Cwd, record.Command, record.Cols, record.Rows, record.Broadcast, record.Title)
	return err
}

func (store *Store) SetSessionPinned(id string, pinned bool) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	result, err := store.database.Exec(`UPDATE sessions SET pinned=? WHERE id=?`, pinned, id)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return fmt.Errorf("mux session %q not found", id)
	}
	return nil
}

func (store *Store) MarkSessionDead(id string, at time.Time) error {
	if at.IsZero() {
		at = time.Now()
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	result, err := store.database.Exec(`UPDATE sessions SET status='dead', last_attached_at=? WHERE id=?`, at.UnixMilli(), id)
	if err != nil {
		return err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return fmt.Errorf("mux session %q not found", id)
	}
	return nil
}

// DestroySession is the explicit destructive lifecycle operation. Unlike age
// and size cleanup it deliberately removes a pinned session too.
func (store *Store) DestroySession(id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`DELETE FROM sessions WHERE id=?`, id)
	return err
}

// DestroyPane removes one pane and its terminal content immediately. Empty
// windows and sessions are then removed in the same transaction; this lets the
// daemon's existing per-pane session.destroy operation retain its current wire
// semantics without leaving catalog tombstones behind.
func (store *Store) DestroyPane(id string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, err := store.database.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(`DELETE FROM panes WHERE id=?`, id); err != nil {
		return err
	}
	if _, err := transaction.Exec(`DELETE FROM windows WHERE NOT EXISTS (SELECT 1 FROM panes WHERE panes.window_id=windows.id)`); err != nil {
		return err
	}
	if _, err := transaction.Exec(`DELETE FROM sessions WHERE NOT EXISTS (SELECT 1 FROM panes WHERE panes.session_id=sessions.id)`); err != nil {
		return err
	}
	return transaction.Commit()
}

// Evict removes only unpinned dead sessions. It first honors retention, then
// applies the database cap from oldest dead record forward. Live records are
// never candidates. The returned IDs make cleanup observable to callers.
func (store *Store) Evict(now time.Time, retentionDays int, databaseCap int64) ([]string, error) {
	if retentionDays <= 0 {
		retentionDays = DefaultRetentionDays
	}
	if databaseCap <= 0 {
		databaseCap = DefaultDatabaseCap
	}
	cutoff := now.AddDate(0, 0, -retentionDays).UnixMilli()
	store.mu.Lock()
	defer store.mu.Unlock()
	transaction, err := store.database.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	var evicted []string
	remove := func(query string, arguments ...any) error {
		rows, err := transaction.Query(query, arguments...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			if _, err := transaction.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
				return err
			}
			evicted = append(evicted, id)
		}
		return rows.Err()
	}
	if err := remove(`SELECT id FROM sessions WHERE status='dead' AND pinned=0 AND last_attached_at < ? ORDER BY last_attached_at`, cutoff); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	// SQLite does not return freed pages to the file automatically. Compacting
	// after the retention pass and after each size-driven eviction makes the
	// advertised cap apply to actual database bytes, not logical row usage.
	if err := store.compactLocked(); err != nil {
		return nil, err
	}
	for {
		size, err := store.databaseSizeLocked()
		if err != nil {
			return nil, err
		}
		if size <= databaseCap {
			break
		}
		var id string
		err = store.database.QueryRow(`SELECT id FROM sessions WHERE status='dead' AND pinned=0 ORDER BY last_attached_at LIMIT 1`).Scan(&id)
		if err == sql.ErrNoRows {
			break
		}
		if err != nil {
			return nil, err
		}
		if _, err := store.database.Exec(`DELETE FROM sessions WHERE id=?`, id); err != nil {
			return nil, err
		}
		evicted = append(evicted, id)
		if err := store.compactLocked(); err != nil {
			return nil, err
		}
	}
	return evicted, nil
}

func (store *Store) databaseSizeLocked() (int64, error) {
	var pageCount, pageSize int64
	if err := store.database.QueryRow(`PRAGMA page_count`).Scan(&pageCount); err != nil {
		return 0, err
	}
	if err := store.database.QueryRow(`PRAGMA page_size`).Scan(&pageSize); err != nil {
		return 0, err
	}
	return pageCount * pageSize, nil
}

func (store *Store) compactLocked() error {
	if _, err := store.database.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return fmt.Errorf("checkpoint mux persistence before eviction: %w", err)
	}
	if _, err := store.database.Exec(`VACUUM`); err != nil {
		return fmt.Errorf("compact mux persistence after eviction: %w", err)
	}
	return nil
}
