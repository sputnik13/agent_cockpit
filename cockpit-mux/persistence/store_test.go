package persistence

import (
	"bytes"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestKeyframeTailRoundTripAndReset(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mux.db")
	store, err := Open(path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("persistence mode = %#o, want 0600", info.Mode().Perm())
	}
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "grounded", Snapshot: []byte("snapshot-one"), PrimarySnapshot: []byte("primary-one"), Metadata: []byte("metadata-one")}); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(1, []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(2, []byte("second")); err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := store.Load("vt-1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(keyframe.Snapshot, []byte("snapshot-one")) || !bytes.Equal(keyframe.PrimarySnapshot, []byte("primary-one")) || !bytes.Equal(keyframe.Metadata, []byte("metadata-one")) || keyframe.Boundary != "grounded" {
		t.Fatalf("keyframe = %#v", keyframe)
	}
	if got := bytes.Join(tail, nil); !bytes.Equal(got, []byte("firstsecond")) {
		t.Fatalf("tail = %q", got)
	}
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "forced", Snapshot: []byte("snapshot-two")}); err != nil {
		t.Fatal(err)
	}
	_, tail, err = store.Load("vt-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("tail after keyframe = %#v, want empty", tail)
	}
}

func TestCatalogWriteWaitsForAnotherCatalogWriter(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mux.db")
	first, err := Open(path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(path, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	locked, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer locked.Close()
	if _, err := locked.Exec(`BEGIN IMMEDIATE`); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		result <- second.UpsertSession(SessionRecord{
			ID: "second", Name: "second", ProjectID: "project", Kind: "local", Status: "live",
		})
	}()

	// Give the second store a chance to enter its write while this connection
	// owns the write lock. It must wait rather than fail SQLITE_BUSY.
	time.Sleep(25 * time.Millisecond)
	if _, err := locked.Exec(`COMMIT`); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("catalog write under a transient catalog lock: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("catalog write did not finish after the other writer released its lock")
	}
}

func TestClearContentErasesRecoveryPayloadButRetainsTopology(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertSession(SessionRecord{ID: "session", Name: "session", ProjectID: "project", Kind: "local", Status: "live"}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertWindow(WindowRecord{ID: "window", SessionID: "session", Name: "main", LayoutJSON: "{}"}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertPane(PaneRecord{ID: "pane", WindowID: "window", SessionID: "session", Command: "sh", Cols: 80, Rows: 24}); err != nil {
		t.Fatal(err)
	}
	keyframe := Keyframe{EngineVersion: "vt-1", Boundary: "grounded", Snapshot: []byte("secret"), Metadata: []byte{}}
	if err := store.SaveKeyframe(keyframe); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(1, []byte("secret-tail")); err != nil {
		t.Fatal(err)
	}
	if err := store.SavePaneKeyframe("pane", keyframe); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendPaneBatch("pane", []TailChunk{{Sequence: 1, Data: []byte("secret-pane-tail")}}); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearContent(); err != nil {
		t.Fatal(err)
	}
	var sessions, windows, panes, legacyKeyframes, legacyTails, paneKeyframes, paneTails int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM windows`).Scan(&windows); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM panes`).Scan(&panes); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM keyframes`).Scan(&legacyKeyframes); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM tail_batches`).Scan(&legacyTails); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM session_keyframes`).Scan(&paneKeyframes); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM session_tails`).Scan(&paneTails); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || windows != 1 || panes != 1 || legacyKeyframes != 0 || legacyTails != 0 || paneKeyframes != 0 || paneTails != 0 {
		t.Fatalf("privacy clear counts sessions/windows/panes=%d/%d/%d payload=%d/%d/%d/%d", sessions, windows, panes, legacyKeyframes, legacyTails, paneKeyframes, paneTails)
	}
}

func TestRejectsVersionMismatchAndTailCap(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "grounded", Snapshot: []byte("snapshot")}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Load("vt-2"); err == nil {
		t.Fatal("Load accepted incompatible engine")
	}
	if err := store.Append(1, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := store.Append(2, []byte("de")); err == nil {
		t.Fatal("Append accepted data beyond tail cap")
	}
	if err := store.Append(1, []byte("x")); err == nil {
		// Duplicate sequence must not silently overwrite durable tail data.
		t.Fatal("Append accepted duplicate sequence")
	}
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "unknown", Snapshot: []byte("snapshot")}); err == nil {
		t.Fatal("SaveKeyframe accepted an unknown boundary")
	}
}

func TestAppendBatchIsAtomic(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "grounded", Snapshot: []byte("snapshot")}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendBatch([]TailChunk{{Sequence: 1, Data: []byte("one")}, {Sequence: 1, Data: []byte("duplicate")}}); err == nil {
		t.Fatal("AppendBatch accepted duplicate sequence")
	}
	_, tail, err := store.Load("vt-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 {
		t.Fatalf("failed batch left durable tail: %q", tail)
	}
}

func TestAppendBatchStoresOneOrderedTailRecord(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SaveKeyframe(Keyframe{EngineVersion: "vt-1", Boundary: "grounded", Snapshot: []byte("snapshot")}); err != nil {
		t.Fatal(err)
	}
	if err := store.AppendBatch([]TailChunk{{Sequence: 1, Data: []byte("first")}, {Sequence: 2, Data: []byte("second")}}); err != nil {
		t.Fatal(err)
	}
	_, tail, err := store.Load("vt-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 1 || !bytes.Equal(tail[0], []byte("firstsecond")) {
		t.Fatalf("tail batches = %q, want one ordered batch", tail)
	}
}

func TestMigratesLegacyChunkTailToBatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mux.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(`CREATE TABLE tail (sequence INTEGER PRIMARY KEY, data BLOB NOT NULL); INSERT INTO tail VALUES (1, x'61'), (2, x'62');`); err != nil {
		legacy.Close()
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	store, err := Open(path, 32)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	migrated, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	var count, version int
	if err := migrated.QueryRow(`SELECT COUNT(*) FROM tail_batches`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := migrated.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if count != 2 || version != 6 {
		t.Fatalf("migrated batches=%d version=%d, want 2 and 6", count, version)
	}
}

func TestRejectsNewerSchemaWithoutDowngrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mux.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`PRAGMA user_version = 7`); err != nil {
		database.Close()
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path, 32); err == nil {
		t.Fatal("Open accepted a newer persistence schema")
	}
	database, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var version int
	if err := database.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 7 {
		t.Fatalf("schema version = %d, want 7", version)
	}
}

func TestLifecycleCatalogCascadesAndEvictsOnlyUnpinnedDeadSessions(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	insert := func(id string, status string, pinned bool, attached time.Time) {
		t.Helper()
		if err := store.UpsertSession(SessionRecord{ID: id, Name: id, ProjectID: "project", Kind: "local", Status: status, Pinned: pinned, CreatedAt: now, LastAttachedAt: attached}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertWindow(WindowRecord{ID: "window-" + id, SessionID: id, Name: "main", LayoutJSON: "{}"}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertPane(PaneRecord{ID: "pane-" + id, WindowID: "window-" + id, SessionID: id, Command: "sh", Cols: 80, Rows: 24}); err != nil {
			t.Fatal(err)
		}
	}
	insert("expired", "dead", false, now.AddDate(0, 0, -8))
	insert("pinned", "dead", true, now.AddDate(0, 0, -8))
	insert("live", "live", false, now.AddDate(0, 0, -8))
	// Child rows make the foreign-key cascade observable rather than assumed.
	if _, err := store.database.Exec(`INSERT INTO session_tails (pane_id, seq, data) VALUES ('pane-expired', 1, X'61')`); err != nil {
		t.Fatal(err)
	}
	evicted, err := store.Evict(now, 7, DefaultDatabaseCap)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(evicted, []string{"expired"}) {
		t.Fatalf("evicted = %q, want expired only", evicted)
	}
	var remaining int
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM session_tails WHERE pane_id='pane-expired'`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("cascade left %d tail rows", remaining)
	}
	if err := store.DestroySession("pinned"); err != nil {
		t.Fatal(err)
	}
	if err := store.database.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id='pinned'`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatal("explicit destroy retained pinned session")
	}
}

func TestLifecycleSizeCapEvictsOldestDeadSessionFirst(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "mux.db"), 32)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)
	insert := func(id string, attached time.Time, pinned bool, status string) {
		t.Helper()
		if err := store.UpsertSession(SessionRecord{ID: id, Name: id, ProjectID: "project", Kind: "local", Status: status, Pinned: pinned, CreatedAt: now, LastAttachedAt: attached}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertWindow(WindowRecord{ID: "window-" + id, SessionID: id, Name: "main", LayoutJSON: "{}"}); err != nil {
			t.Fatal(err)
		}
		if err := store.UpsertPane(PaneRecord{ID: "pane-" + id, WindowID: "window-" + id, SessionID: id}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.database.Exec(`INSERT INTO session_tails (pane_id, seq, data) VALUES (?, 1, ?)`, "pane-"+id, bytes.Repeat([]byte(id), 16<<10)); err != nil {
			t.Fatal(err)
		}
	}
	insert("oldest", now.Add(-3*time.Hour), false, "dead")
	insert("newer", now.Add(-2*time.Hour), false, "dead")
	insert("pinned", now.Add(-4*time.Hour), true, "dead")
	insert("live", now.Add(-5*time.Hour), false, "live")
	size, err := store.databaseSizeLocked()
	if err != nil {
		t.Fatal(err)
	}
	evicted, err := store.Evict(now, 999, size-1)
	if err != nil {
		t.Fatal(err)
	}
	if len(evicted) == 0 || evicted[0] != "oldest" {
		t.Fatalf("size eviction = %q, want oldest dead session first", evicted)
	}
	for _, protected := range []string{"pinned", "live"} {
		var count int
		if err := store.database.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id=?`, protected).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("size eviction removed protected %s session", protected)
		}
	}
}
