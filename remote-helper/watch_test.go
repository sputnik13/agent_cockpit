package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// eventCollector captures emitted events for assertions.
type eventCollector struct {
	mu     sync.Mutex
	events []Event
}

func (c *eventCollector) emit(ev Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, ev)
}

func (c *eventCollector) snapshot() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Event, len(c.events))
	copy(out, c.events)
	return out
}

func TestWatchSubscribeEmitsDebouncedEvent(t *testing.T) {
	dir := t.TempDir()
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"t1"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Touch several files rapidly; expect a single coalesced "watch" event.
	for i := 0; i < 3; i++ {
		p := filepath.Join(dir, "file"+string(rune('a'+i))+".txt")
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if !waitForEvent(c, "watch", 2*time.Second) {
		t.Fatalf("expected watch event, got %+v", c.snapshot())
	}

	// Verify the event carries the token.
	for _, ev := range c.snapshot() {
		if ev.Event == "watch" {
			data := ev.Data.(map[string]any)
			if data["token"] != "t1" {
				t.Fatalf("expected token t1, got %v", data["token"])
			}
			return
		}
	}
}

func TestWatchExcludesNoiseDirs(t *testing.T) {
	dir := t.TempDir()
	// Pre-create the excluded dirs so they exist at subscribe time and are
	// pruned from the recursive add.
	for _, d := range []string{".git", ".beads", "node_modules"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"t3"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Churn inside excluded subtrees (git internals + beads SQLite WAL): must
	// NOT produce any watch event — this is the remote analogue of the Changes/
	// Workgraph cycling regression.
	for _, p := range []string{
		filepath.Join(dir, ".beads", "beads.db-wal"),
		filepath.Join(dir, ".git", "index"),
		filepath.Join(dir, "node_modules", "pkg.js"),
	} {
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	if waitForEvent(c, "watch", 600*time.Millisecond) {
		t.Fatalf("expected NO watch event from excluded dirs, got %+v", c.snapshot())
	}

	// A real source-file change still fires.
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitForEvent(c, "watch", 2*time.Second) {
		t.Fatalf("expected watch event for a real file change, got %+v", c.snapshot())
	}
}

func TestShouldEmit(t *testing.T) {
	w := &watcher{root: "/home/u/proj", spec: defaultWatchSpec()}
	// want = whether the path is forwarded to the host.
	cases := map[string]bool{
		// Dropped: never-recurse, and non-signal .git/.beads churn.
		"/home/u/proj/.beads/beads.db-wal": false,
		"/home/u/proj/.beads/beads.db-shm": false,
		"/home/u/proj/.git/index":          false,
		"/home/u/proj/.git/COMMIT_EDITMSG": false,
		"/home/u/proj/node_modules/a/b.js": false,
		// Emitted: working-tree files.
		"/home/u/proj/src/main.go": true,
		"/home/u/proj/beads.txt":   true,
		// Emitted: git-state + beads signals (the remote auto-refresh fix).
		"/home/u/proj/.git/HEAD":            true,
		"/home/u/proj/.git/packed-refs":     true,
		"/home/u/proj/.git/refs/heads/main": true,
		"/home/u/proj/.beads/beads.db":      true,
		"/home/u/proj/.beads/issues.jsonl":  true,
		// Emitted: a linked worktree being added/removed (local_repo_explorer-rc9n).
		// NOTE: shouldEmit's own signal matching is depth-UNBOUNDED (matchesSignal
		// is a prefix match), same as .git/refs — the depth bound that keeps
		// per-commit churn INSIDE an existing worktree's metadata dir (e.g.
		// .git/worktrees/<name>/HEAD) from ever reaching shouldEmit at all is
		// enforced upstream, by addWatchesWithSpec's SkipDir at ".git/worktrees"
		// (see TestWatchExcludesWorktreeInternalChurn) — fsnotify never adds a
		// watch that deep, so shouldEmit is never actually called with such a
		// path in the real pipeline.
		"/home/u/proj/.git/worktrees":         true,
		"/home/u/proj/.git/worktrees/feature": true,
	}
	for p, want := range cases {
		if got := w.shouldEmit(p); got != want {
			t.Fatalf("shouldEmit(%q)=%v want %v", p, got, want)
		}
	}
}

// TestWatchEmitsGitAndBeadsSignals is the regression guard for the reported bug:
// on remote, beads writes and git-state changes previously produced NO event
// (the helper hard-excluded .git/.beads). They must now fire watch events.
func TestWatchEmitsGitAndBeadsSignals(t *testing.T) {
	dir := t.TempDir()
	for _, d := range []string{".git", filepath.Join(".git", "refs"), ".beads"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"tsig"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// A beads committed-write (issues.jsonl on `br` flush) must fire.
	if err := os.WriteFile(filepath.Join(dir, ".beads", "issues.jsonl"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitForEvent(c, "watch", 2*time.Second) {
		t.Fatalf("expected watch event for .beads/issues.jsonl, got %+v", c.snapshot())
	}
}

// TestWatchDetectsWorktreeAdd is the regression guard for local_repo_explorer-rc9n:
// `git worktree add` writes only under .git/worktrees/<name>/..., which
// previously matched no signal AND was never watched at all (addWatchesWithSpec
// hit the generic ".git/*" SkipDir with no Add). Both the very first worktree
// ever added to a repo (which creates the .git/worktrees dir itself — a new
// entry in .git's own listing) and a second worktree added afterward in the
// SAME session (exercising the dedicated .git/worktrees watch, self-healed onto
// the tree the moment .git/worktrees was created by the first) must fire.
func TestWatchDetectsWorktreeAdd(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"twt"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// MkdirAll creates ".git/worktrees" and ".git/worktrees/wt1" back-to-back
	// (mirroring how `git worktree add` lays out the first-ever worktree). The
	// PARENT directory's own creation is the guaranteed-observed signal here:
	// fsnotify sees it via the pre-existing top-level ".git" watch, and only
	// AFTER processing that event does the retroactive addWatchesWithSpec (Layer
	// 2's newly-created-dir rescan) attach a watch onto ".git/worktrees" itself
	// — so asserting on "wt1" specifically would race the rescan. What actually
	// matters for correctness (loadWorktrees() re-lists ALL worktrees from git,
	// not just the one named in the event) is that classification fires at all.
	if err := os.MkdirAll(filepath.Join(dir, ".git", "worktrees", "wt1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !waitForPath(c, ".git/worktrees", 2*time.Second) {
		t.Fatalf("expected watch event for first worktree (.git/worktrees created), got %+v", c.snapshot())
	}

	// By now the event above has been fully processed (the retroactive watch-add
	// runs synchronously before the event is queued for emission — see Layer 2's
	// run loop), so .git/worktrees is a genuinely fsnotify-watched directory: a
	// second worktree added afterward in the SAME session is a clean, non-racy
	// direct-child create on that dedicated watch.
	if err := os.MkdirAll(filepath.Join(dir, ".git", "worktrees", "wt2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if !waitForPath(c, "wt2", 2*time.Second) {
		t.Fatalf("expected watch event for second worktree, got %+v", c.snapshot())
	}
}

// TestWatchExcludesWorktreeInternalChurn ensures per-commit writes inside an
// ALREADY-KNOWN worktree's own metadata dir (.git/worktrees/<name>/HEAD — what a
// real commit made inside that worktree rewrites) do NOT produce a watch event:
// only the worktrees directory's own listing (add/remove) is signal. Without
// this, routine work in a linked worktree would spam a worktreeStore refresh on
// every commit (local_repo_explorer-rc9n's explicit guardrail).
func TestWatchExcludesWorktreeInternalChurn(t *testing.T) {
	dir := t.TempDir()
	wtDir := filepath.Join(dir, ".git", "worktrees", "existing-wt")
	if err := os.MkdirAll(wtDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wtDir, "HEAD"), []byte("ref: refs/heads/x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"twtnoise"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Rewrite the worktree's own HEAD — what a commit made inside it does.
	if err := os.WriteFile(filepath.Join(wtDir, "HEAD"), []byte("ref: refs/heads/y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if waitForEvent(c, "watch", 600*time.Millisecond) {
		t.Fatalf("expected NO watch event from worktree-internal churn, got %+v", c.snapshot())
	}

	// A real source-file change still fires — proves the watcher is alive and
	// this isn't a false negative from a dead subscription.
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitForEvent(c, "watch", 2*time.Second) {
		t.Fatalf("expected watch event for a real file change, got %+v", c.snapshot())
	}
}

// TestWatchSubscribeAcceptsSpec verifies a pushed spec is accepted and applied:
// with .git removed from directoryGranularity, .git/HEAD becomes an ordinary
// (emitted) working-tree path rather than a filtered signal.
func TestWatchSubscribeAcceptsSpec(t *testing.T) {
	w := &watcher{
		root: "/home/u/proj",
		spec: watchSpec{
			NeverRecurse:         []string{"node_modules"},
			DirectoryGranularity: []string{".beads"},
			GitStateSignals:      []string{},
			BeadsSignals:         []string{".beads/beads.db", ".beads/issues.jsonl"},
			DebounceMs:           50,
		},
	}
	if !w.shouldEmit("/home/u/proj/.git/HEAD") {
		t.Fatal("with .git not in directoryGranularity, .git/HEAD should be emitted as a normal path")
	}
	if w.shouldEmit("/home/u/proj/.beads/beads.db-wal") {
		t.Fatal(".beads/beads.db-wal must remain filtered under the pushed spec")
	}
	if got := w.spec.debounce(); got != 50*time.Millisecond {
		t.Fatalf("debounce()=%v want 50ms", got)
	}
}

func TestWatchUnsubscribeStopsEvents(t *testing.T) {
	dir := t.TempDir()
	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"t2"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if _, err := m.unsubscribe(json.RawMessage(`{"token":"t2"}`)); err != nil {
		t.Fatalf("unsubscribe: %v", err)
	}

	// Allow the run loop to fully exit.
	time.Sleep(100 * time.Millisecond)
	before := len(c.snapshot())

	if err := os.WriteFile(filepath.Join(dir, "after.txt"), []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)

	if got := len(c.snapshot()); got != before {
		t.Fatalf("expected no new events after unsubscribe: before=%d after=%d", before, got)
	}
}

func TestWatchSubscribeValidatesParams(t *testing.T) {
	m := newWatchManager(func(Event) {})
	if _, err := m.subscribe(json.RawMessage(`{"cwd":"","token":"t"}`)); err == nil {
		t.Fatal("expected error for empty cwd")
	}
	if _, err := m.subscribe(json.RawMessage(`{"cwd":"/tmp","token":""}`)); err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestWatchHonorsGitignore(t *testing.T) {
	dir := t.TempDir()

	// Write a .gitignore that ignores build/ and *.log files.
	gitignoreContent := "build/\n*.log\n"
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte(gitignoreContent), 0o644); err != nil {
		t.Fatal(err)
	}

	// Pre-create a gitignored directory so it already exists at subscribe time.
	buildDir := filepath.Join(dir, "build")
	if err := os.MkdirAll(buildDir, 0o755); err != nil {
		t.Fatal(err)
	}

	c := &eventCollector{}
	m := newWatchManager(c.emit)
	t.Cleanup(m.closeAll)

	if _, err := m.subscribe(json.RawMessage(`{"cwd":` + jstr(dir) + `,"token":"tgi"}`)); err != nil {
		t.Fatalf("subscribe: %v", err)
	}

	// Write into a gitignored directory — must NOT produce a watch event.
	if err := os.WriteFile(filepath.Join(buildDir, "output.bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Write a gitignored *.log file — must NOT produce a watch event.
	if err := os.WriteFile(filepath.Join(dir, "debug.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	if waitForEvent(c, "watch", 600*time.Millisecond) {
		t.Fatalf("expected NO watch events from gitignored paths, got %+v", c.snapshot())
	}

	// A real non-ignored file change MUST produce a watch event.
	if err := os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !waitForEvent(c, "watch", 2*time.Second) {
		t.Fatalf("expected watch event for non-ignored file, got %+v", c.snapshot())
	}
}

func TestIsGitignored(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("target/\n*.o\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gi := loadGitignore(dir)
	if gi == nil {
		t.Fatal("expected non-nil GitIgnore")
	}

	cases := []struct {
		abs  string
		want bool
	}{
		{filepath.Join(dir, "target", "debug", "foo"), true},
		{filepath.Join(dir, "src", "main.rs"), false},
		{filepath.Join(dir, "lib.o"), true},
		{filepath.Join(dir, "Cargo.toml"), false},
	}
	for _, tc := range cases {
		if got := isGitignored(gi, dir, tc.abs); got != tc.want {
			t.Errorf("isGitignored(%q)=%v want %v", tc.abs, got, tc.want)
		}
	}
}

func TestLoadGitignoreReturnNilOnMissing(t *testing.T) {
	dir := t.TempDir()
	// No .gitignore in dir
	gi := loadGitignore(dir)
	if gi != nil {
		t.Fatal("expected nil for missing .gitignore")
	}
	// isGitignored with nil gi must return false (not panic)
	if isGitignored(nil, dir, filepath.Join(dir, "anything")) {
		t.Fatal("expected false for nil gitignore")
	}
}

func waitForEvent(c *eventCollector, name string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, ev := range c.snapshot() {
			if ev.Event == name {
				return true
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// waitForPath polls until some emitted "watch" event's paths contains an entry
// with want as a substring, or the timeout elapses. More precise than
// waitForEvent for asserting a SPECIFIC change was observed (e.g. distinguishing
// a second, later mutation from an already-satisfied earlier one).
func waitForPath(c *eventCollector, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, ev := range c.snapshot() {
			if ev.Event != "watch" {
				continue
			}
			data, ok := ev.Data.(map[string]any)
			if !ok {
				continue
			}
			paths, ok := data["paths"].([]string)
			if !ok {
				continue
			}
			for _, p := range paths {
				if strings.Contains(p, want) {
					return true
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}
