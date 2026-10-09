//go:build libghostty

package daemon

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/local-repo-explorer/cockpit-mux/persistence"
	"github.com/local-repo-explorer/cockpit-mux/persistence/history"
)

func TestNaturalExitKeepsFinalOutputReadableWithoutClosedAttachment(t *testing.T) {
	operations := NewOperations()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "printf 'final-output-before-exit'; exit 0"}, Key: "final-output",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	t.Cleanup(func() { _ = operations.Close() })

	deadline := time.Now().Add(5 * time.Second)
	finalized := false
	for time.Now().Before(deadline) {
		operations.mu.Lock()
		session := operations.sessions[created.SessionID]
		exited := session != nil && session.pane == nil
		attachmentCleared := session != nil && session.attachment == nil
		operations.mu.Unlock()
		if exited && attachmentCleared {
			finalized = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !finalized {
		t.Fatal("natural pane exit did not close and clear its native attachment")
	}

	outputData := requestOperation(t, operations, 2, methodPaneOutput, ReadPaneOutputRequest{PaneID: created.PaneID})
	var output ReadPaneOutputResponse
	decodeResponse(t, outputData, &output)
	var finalOutput []byte
	for _, chunk := range output.Outputs {
		finalOutput = append(finalOutput, chunk.Data...)
	}
	if !output.Exited || !bytes.Contains(finalOutput, []byte("final-output-before-exit")) {
		t.Fatalf("pane.output after natural exit = %#v, want exited=true and final PTY bytes", output)
	}

	_, err := operations.Handle(context.Background(), operationRequest(t, 3, methodSessionAttach, AttachSessionRequest{
		SessionID: created.SessionID, ClientID: "after-exit", Cols: 80, Rows: 24,
	}))
	if !errors.Is(err, ErrPaneExited) {
		t.Fatalf("session.attach after natural exit error = %v, want %v", err, ErrPaneExited)
	}
}

func TestPersistentAttachmentFlushesPTYOutputOnExit(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf 'recorded-by-pty'; sleep 2")
	if err != nil {
		t.Fatal(err)
	}
	defer pane.Close()
	created, err := newSessionAttachment(pane, filepath.Join(t.TempDir(), "state.db"), "", false, true)
	if err != nil {
		t.Fatal(err)
	}
	attachment := created.(*shadowAttachment)
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	// The 100 ms flush timer gets a deliberately generous scheduler allowance;
	// a one-second deadline would not prove the documented durability bound.
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		_, tail, err := attachment.store.Load(version)
		if err != nil {
			t.Fatal(err)
		}
		if got := bytes.Join(tail, nil); bytes.Contains(got, []byte("recorded-by-pty")) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted PTY tail did not flush within timer tolerance: %q", bytes.Join(tail, nil))
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := pane.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-attachment.done:
	case <-time.After(2 * time.Second):
		t.Fatal("persistent attachment did not finish after PTY close")
	}
	if err := attachment.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestCatalogAttachmentPersistsPerPaneKeyframeAndTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	store, err := persistence.Open(path, persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(persistence.SessionRecord{ID: "session", Name: "session", ProjectID: "project", Kind: "local", Status: "live"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.UpsertWindow(persistence.WindowRecord{ID: "window", SessionID: "session", Name: "main", LayoutJSON: "{}"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.UpsertPane(persistence.PaneRecord{ID: "pane", WindowID: "window", SessionID: "session"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	pane, err := StartPane("/bin/sh", "-c", "printf catalog-output; sleep 2")
	if err != nil {
		t.Fatal(err)
	}
	created, err := newSessionAttachment(pane, path, "pane", false, true)
	if err != nil {
		_ = pane.Close()
		t.Fatal(err)
	}
	attachment := created.(*shadowAttachment)
	defer attachment.Close()
	defer pane.Close()
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		_, tail, err := attachment.store.LoadPane("pane", version)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(bytes.Join(tail, nil), []byte("catalog-output")) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("catalog tail did not flush: %q", bytes.Join(tail, nil))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestDestroySessionReapsItsOptionalHistoryArchive(t *testing.T) {
	homePath := t.TempDir()
	if err := os.Chmod(homePath, 0o700); err != nil {
		t.Fatal(err)
	}
	home, err := OpenHome(homePath)
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "archive-reap",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	archive, err := history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := archive.Append(history.Record{SessionID: created.SessionID, PaneID: created.PaneID, FirstLine: 0, LastLine: 0, Data: []byte("archive-row")}); err != nil {
		_ = archive.Close()
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	requestOperation(t, operations, 2, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})
	archive, err = history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	records, err := archive.Load(created.PaneID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("closed pane retained optional history archive: %#v", records)
	}
}

func TestExitedLogicalSessionReapsItsOptionalHistoryArchive(t *testing.T) {
	homePath := t.TempDir()
	if err := os.Chmod(homePath, 0o700); err != nil {
		t.Fatal(err)
	}
	home, err := OpenHome(homePath)
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 1"}, Key: "archive-exit-reap",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	archive, err := history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := archive.Append(history.Record{SessionID: created.SessionID, PaneID: created.PaneID, FirstLine: 0, LastLine: 0, Data: []byte("archive-row")}); err != nil {
		_ = archive.Close()
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		operations.mu.Lock()
		exited := operations.sessions[created.SessionID] != nil && operations.sessions[created.SessionID].pane == nil
		operations.mu.Unlock()
		if exited {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("mux did not observe terminal exit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	archive, err = history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	records, err := archive.Load(created.PaneID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("exited logical session retained optional history archive: %#v", records)
	}
	store, err := persistence.Open(filepath.Join(home.Path, "state.db"), persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	panes, err := store.CatalogPanes()
	if err != nil {
		t.Fatal(err)
	}
	if len(panes) != 0 {
		t.Fatalf("exited logical session retained recovery catalog panes: %#v", panes)
	}
}

func TestPrivacyDisableClearsEveryOptionalHistoryArchive(t *testing.T) {
	homePath := t.TempDir()
	if err := os.Chmod(homePath, 0o700); err != nil {
		t.Fatal(err)
	}
	home, err := OpenHome(homePath)
	if err != nil {
		t.Fatal(err)
	}
	operations := NewPersistentOperationsWithOptions(home, PersistentOptions{PersistScrollback: true})
	defer operations.Close()
	createdData := requestOperation(t, operations, 1, methodSessionCreate, CreateSessionRequest{
		Command: "/bin/sh", Args: []string{"-c", "sleep 30"}, Key: "archive-privacy",
	})
	var created CreateSessionResponse
	decodeResponse(t, createdData, &created)
	archive, err := history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := archive.Append(history.Record{SessionID: created.SessionID, PaneID: created.PaneID, FirstLine: 0, LastLine: 0, Data: []byte("private-row")}); err != nil {
		_ = archive.Close()
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	requestOperation(t, operations, 2, methodMuxConfigure, ConfigureMuxRequest{PersistScrollback: false, ScrollbackLines: DefaultScrollbackLines})
	archive, err = history.Open(filepath.Join(home.Path, "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	records, err := archive.Load(created.PaneID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 0 {
		t.Fatalf("privacy disable retained optional history archive: %#v", records)
	}
	requestOperation(t, operations, 3, methodSessionDestroy, DestroySessionRequest{SessionID: created.SessionID})
}

func TestCatalogAttachmentPrivacyToggleReplacesStoredScreenWithBlankState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.db")
	store, err := persistence.Open(path, persistence.DefaultTailCap*4)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSession(persistence.SessionRecord{ID: "session", Name: "session", ProjectID: "project", Kind: "local", Status: "live"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.UpsertWindow(persistence.WindowRecord{ID: "window", SessionID: "session", Name: "main", LayoutJSON: "{}"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.UpsertPane(persistence.PaneRecord{ID: "pane", WindowID: "window", SessionID: "session"}); err != nil {
		store.Close()
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	pane, err := StartPane("/bin/sh", "-c", "printf secret-before-privacy-toggle; sleep 2")
	if err != nil {
		t.Fatal(err)
	}
	created, err := newSessionAttachment(pane, path, "pane", false, true)
	if err != nil {
		_ = pane.Close()
		t.Fatal(err)
	}
	attachment := created.(*shadowAttachment)
	defer attachment.Close()
	defer pane.Close()
	version, err := EngineVersion()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		_, tail, err := attachment.store.LoadPane("pane", version)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(bytes.Join(tail, nil), []byte("secret-before-privacy-toggle")) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("fixture did not persist its secret before the privacy change")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := attachment.SetPersistScrollback(false); err != nil {
		t.Fatal(err)
	}
	keyframe, tail, err := attachment.store.LoadPane("pane", version)
	if err != nil {
		t.Fatal(err)
	}
	if len(tail) != 0 || bytes.Contains(keyframe.Snapshot, []byte("secret-before-privacy-toggle")) || bytes.Contains(keyframe.Metadata, []byte("secret-before-privacy-toggle")) {
		t.Fatal("catalog privacy toggle retained persisted terminal content")
	}
}

func TestAttachmentPrepareHandoffPausesGroundedReaderUntilReleased(t *testing.T) {
	pane, err := StartPane("/bin/sh", "-c", "printf ready; IFS= read -r _; printf later; sleep 30")
	if err != nil {
		t.Fatal(err)
	}
	created, err := newSessionAttachment(pane, "", "", false, true)
	if err != nil {
		_ = pane.Close()
		t.Fatal(err)
	}
	attachment := created.(*shadowAttachment)
	defer func() {
		_ = pane.Close()
		_ = attachment.Close()
	}()
	awaitAttachmentOutput(t, attachment, []byte("ready"))
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	state, master, release, err := attachment.PrepareHandoff(ctx)
	if err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			release()
		}
	}()
	if master != pane.master || state.Boundary != "grounded" || len(state.Snapshot) == 0 || len(state.PrimarySnapshot) == 0 || len(state.Metadata) == 0 {
		t.Fatalf("handoff state = %#v master=%v", state, master)
	}
	if _, err := pane.WriteInput([]byte("continue\r")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if output := attachmentOutputs(attachment); bytes.Contains(output, []byte("later")) {
		t.Fatalf("paused attachment consumed later output: %q", output)
	}
	release()
	released = true
	awaitAttachmentOutput(t, attachment, []byte("later"))
}

func awaitAttachmentOutput(t *testing.T, attachment *shadowAttachment, needle []byte) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if output := attachmentOutputs(attachment); bytes.Contains(output, needle) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for attachment output %q", needle)
}

func attachmentOutputs(attachment *shadowAttachment) []byte {
	var joined []byte
	for _, output := range attachment.OutputsFrom(1) {
		joined = append(joined, output.Data...)
	}
	return joined
}
