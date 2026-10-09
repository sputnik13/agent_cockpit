// Package history owns the optional, unbounded terminal-history archive.
//
// It intentionally uses a distinct private database from the bounded recovery
// catalog: recovery snapshots have a size/retention policy, whereas this store
// retains only immutable terminal rows until their logical mux session closes.
package history

import (
	"bytes"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"
)

// TargetBatchBytes is deliberately large enough that archive writes cannot be
// one SQLite transaction per terminal line. An idle/clean-close flush may be
// smaller so already-evicted history is not stranded in memory.
const TargetBatchBytes = 1 << 20

type Record struct {
	SessionID string
	PaneID    string
	FirstLine uint64
	LastLine  uint64
	Data      []byte
}

type Store struct {
	mu       sync.Mutex
	database *sql.DB
	encode   *zstd.Encoder
	decode   *zstd.Decoder
}

func Open(path string) (*Store, error) {
	if path == "" {
		return nil, fmt.Errorf("mux history path is required")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create mux history directory: %w", err)
	}
	uri := url.URL{Scheme: "file", Path: path}
	query := uri.Query()
	query.Set("_busy_timeout", "5000")
	uri.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, fmt.Errorf("open mux history database: %w", err)
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	encode, err := zstd.NewWriter(nil)
	if err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("create mux history encoder: %w", err)
	}
	decode, err := zstd.NewReader(nil)
	if err != nil {
		encode.Close()
		_ = database.Close()
		return nil, fmt.Errorf("create mux history decoder: %w", err)
	}
	store := &Store{database: database, encode: encode, decode: decode}
	if err := store.migrate(); err != nil {
		_ = store.Close()
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("protect mux history database: %w", err)
	}
	return store, nil
}

func (store *Store) migrate() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, err := store.database.Exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		CREATE TABLE IF NOT EXISTS pane_history_batches (
			session_id TEXT NOT NULL,
			pane_id TEXT NOT NULL,
			first_line INTEGER NOT NULL,
			last_line INTEGER NOT NULL,
			data BLOB NOT NULL,
			written_at INTEGER NOT NULL,
			PRIMARY KEY (pane_id, first_line),
			CHECK (last_line >= first_line)
		);
		CREATE INDEX IF NOT EXISTS pane_history_batches_session ON pane_history_batches(session_id);
		PRAGMA user_version = 1;`); err != nil {
		return fmt.Errorf("migrate mux history database: %w", err)
	}
	return nil
}

func (store *Store) Close() error {
	store.encode.Close()
	store.decode.Close()
	return store.database.Close()
}

// Append persists one already-batched, immutable line range. Each pane's
// ranges must be contiguous; this prevents a failed retry from creating a gap
// or a duplicate long-history page.
func (store *Store) Append(record Record) error {
	if record.SessionID == "" || record.PaneID == "" || len(record.Data) == 0 || record.LastLine < record.FirstLine {
		return fmt.Errorf("invalid mux history batch")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	var last sql.NullInt64
	if err := store.database.QueryRow(`SELECT last_line FROM pane_history_batches WHERE pane_id=? ORDER BY first_line DESC LIMIT 1`, record.PaneID).Scan(&last); err != nil && err != sql.ErrNoRows {
		return err
	}
	if last.Valid && record.FirstLine != uint64(last.Int64)+1 {
		return fmt.Errorf("mux history batch starts at %d after committed line %d", record.FirstLine, last.Int64)
	}
	compressed := store.encode.EncodeAll(record.Data, nil)
	_, err := store.database.Exec(`INSERT INTO pane_history_batches (session_id, pane_id, first_line, last_line, data, written_at)
		VALUES (?, ?, ?, ?, ?, ?)`, record.SessionID, record.PaneID, record.FirstLine, record.LastLine, compressed, time.Now().UnixMilli())
	return err
}

// Load returns ordered immutable records in the requested line interval.
func (store *Store) Load(paneID string, firstLine, lastLine uint64) ([]Record, error) {
	if paneID == "" || lastLine < firstLine {
		return nil, fmt.Errorf("invalid mux history range")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	rows, err := store.database.Query(`SELECT session_id, first_line, last_line, data FROM pane_history_batches
		WHERE pane_id=? AND last_line >= ? AND first_line <= ? ORDER BY first_line`, paneID, firstLine, lastLine)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var records []Record
	for rows.Next() {
		var record Record
		var compressed []byte
		record.PaneID = paneID
		if err := rows.Scan(&record.SessionID, &record.FirstLine, &record.LastLine, &compressed); err != nil {
			return nil, err
		}
		data, err := store.decode.DecodeAll(compressed, nil)
		if err != nil {
			return nil, fmt.Errorf("decode mux history batch: %w", err)
		}
		record.Data = bytes.Clone(data)
		records = append(records, record)
	}
	return records, rows.Err()
}

// NextLine returns the exclusive end of the committed range for a pane.
func (store *Store) NextLine(paneID string) (uint64, error) {
	if paneID == "" {
		return 0, fmt.Errorf("mux history pane ID is required")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	var last sql.NullInt64
	if err := store.database.QueryRow(`SELECT last_line FROM pane_history_batches WHERE pane_id=? ORDER BY first_line DESC LIMIT 1`, paneID).Scan(&last); err != nil && err != sql.ErrNoRows {
		return 0, err
	}
	if !last.Valid {
		return 0, nil
	}
	return uint64(last.Int64) + 1, nil
}

// ReapSession removes all archived text for a closed logical session. This is
// intentionally separate from retention cleanup: closed sessions leave no
// archive tombstone behind.
func (store *Store) ReapSession(sessionID string) error {
	if sessionID == "" {
		return fmt.Errorf("mux history session ID is required")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`DELETE FROM pane_history_batches WHERE session_id=?`, sessionID)
	return err
}

// ReapPane removes the archive for one closed pane. A logical-session destroy
// invokes this for every pane, while a split close reaps only that split's
// history and leaves its siblings intact.
func (store *Store) ReapPane(paneID string) error {
	if paneID == "" {
		return fmt.Errorf("mux history pane ID is required")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`DELETE FROM pane_history_batches WHERE pane_id=?`, paneID)
	return err
}

func (store *Store) Clear() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	_, err := store.database.Exec(`DELETE FROM pane_history_batches`)
	return err
}
