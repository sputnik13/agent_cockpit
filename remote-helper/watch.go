package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	gitignore "github.com/sabhiram/go-gitignore"
)

// fallbackDebounce coalesces rapid filesystem events when the spec carries no
// debounce window. The authoritative debounce lives in the TS ingest layer; the
// helper coalesces only to limit RPC chatter over the wire.
const fallbackDebounce = 150 * time.Millisecond

// watchSpec is the serializable "what to watch" policy pushed by the host over
// the watch.subscribe RPC. It is DERIVED from the single TS policy
// (src/shared/watch/policy.ts via deriveWatchSpec); the helper holds no policy
// of its own. defaultWatchSpec() is a fallback used only when a client omits the
// spec (older client / tests); production always sends the derived spec.
type watchSpec struct {
	NeverRecurse         []string `json:"neverRecurse"`
	DirectoryGranularity []string `json:"directoryGranularity"`
	GitStateSignals      []string `json:"gitStateSignals"`
	BeadsSignals         []string `json:"beadsSignals"`
	DebounceMs           int      `json:"debounceMs"`
}

// defaultWatchSpec mirrors src/shared/watch/policy.ts. Fallback only — keep in
// sync with the TS policy, which is canonical. The real client always pushes the
// derived spec, so production behavior is sourced from TS.
func defaultWatchSpec() watchSpec {
	return watchSpec{
		NeverRecurse:         []string{"node_modules"},
		DirectoryGranularity: []string{".git", ".beads"},
		GitStateSignals:      []string{".git/HEAD", ".git/packed-refs", ".git/refs", ".git/worktrees"},
		BeadsSignals:         []string{".beads/beads.db", ".beads/issues.jsonl"},
		DebounceMs:           200,
	}
}

func (s watchSpec) debounce() time.Duration {
	if s.DebounceMs > 0 {
		return time.Duration(s.DebounceMs) * time.Millisecond
	}
	return fallbackDebounce
}

func toSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, v := range values {
		set[v] = struct{}{}
	}
	return set
}

// relPosix returns the root-relative forward-slash path for abs, plus ok=false
// when abs is outside root.
func relPosix(root, abs string) (string, bool) {
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// gitWorktreesSignal is GIT_STATE_SIGNALS' ".git/worktrees" entry
// (src/shared/watch/policy.ts). Unlike ".git/refs" -- an intentionally
// UNBOUNDED-depth signal, since every nested ref path is real signal -- a
// worktree being added or removed only ever changes ".git/worktrees" itself
// or its immediate "<name>" child. Anything nested deeper
// (".git/worktrees/<name>/HEAD", "/index", "/logs/HEAD", ...) is per-commit
// churn made INSIDE that worktree's own metadata dir, not a worktree-set
// change, and must stay noise -- see GIT_STATE_SIGNALS's doc comment in
// policy.ts for the full rationale.
const gitWorktreesSignal = ".git/worktrees"

// gitWorktreesMaxSegments bounds how many "/"-separated segments a path may
// have and still count as the gitWorktreesSignal: the signal itself
// (".git/worktrees", 2 segments) or exactly one child ("<name>", 3
// segments) -- mirrors policy.ts's classifyWatchPath segment-count gate
// (`segments[1] === 'worktrees' && segments.length <= 3`).
const gitWorktreesMaxSegments = 3

// matchesSignal reports whether rel is one of the signal paths, treating each
// signal as an exact path OR a directory prefix (so ".git/refs" matches
// ".git/refs/heads/main"). gitWorktreesSignal is the one exception: it is
// depth-BOUNDED (see gitWorktreesMaxSegments) rather than an unbounded
// prefix, matching policy.ts's classifyWatchPath segment-count gate.
//
// This bound is Go-side defense-in-depth, independent of
// addWatchesWithSpec's directory-walk `filepath.SkipDir` at ".git/worktrees"
// (which is what actually prevents fsnotify from ever watching deep enough
// to produce these paths in production today). Without this guard, this
// function alone would incorrectly treat a deep per-worktree-metadata path
// as a git-state signal -- currently unreachable dead-code-in-practice, but
// a future unrelated change to the directory walk (e.g. removing that
// SkipDir to watch worktree subdirs for some other feature) could silently
// reintroduce the per-commit noise bug remote-only, with nothing to catch it
// (local_repo_explorer-wkxb).
func matchesSignal(rel string, signals []string) bool {
	for _, sig := range signals {
		if rel == sig {
			return true
		}
		if !strings.HasPrefix(rel, sig+"/") {
			continue
		}
		if sig == gitWorktreesSignal && len(strings.Split(rel, "/")) > gitWorktreesMaxSegments {
			continue // per-worktree metadata churn -- noise, not a signal
		}
		return true
	}
	return false
}

// loadGitignore attempts to compile the root-level .gitignore for the project.
// On any error (missing file, parse error) it returns nil so the watcher
// degrades gracefully.
func loadGitignore(root string) *gitignore.GitIgnore {
	gi, err := gitignore.CompileIgnoreFile(filepath.Join(root, ".gitignore"))
	if err != nil {
		return nil
	}
	return gi
}

// isGitignored reports whether absPath is ignored by gi. Returns false when gi
// is nil (no .gitignore loaded).
func isGitignored(gi *gitignore.GitIgnore, root, absPath string) bool {
	if gi == nil {
		return false
	}
	rel, ok := relPosix(root, absPath)
	if !ok {
		return false
	}
	return gi.MatchesPath(rel)
}

// watcher tracks a single active subscription rooted at a directory.
type watcher struct {
	token  string
	root   string
	gi     *gitignore.GitIgnore // nil when no .gitignore is present
	spec   watchSpec
	fsw    *fsnotify.Watcher
	done   chan struct{}
	closed bool
}

// shouldEmit decides whether a raw filesystem event path is forwarded to the
// host. Emission is driven entirely by the spec, mirroring the TS policy's
// classifyWatchPath:
//   - never-recurse segments (node_modules) are dropped;
//   - paths under a directory-granularity dir (.git/.beads) are emitted only
//     when they match a git-state or beads signal (so .git/index,
//     .beads/beads.db-wal, etc. are dropped — wire churn + self-feed avoidance);
//   - all other paths are emitted unless gitignored.
func (w *watcher) shouldEmit(abs string) bool {
	rel, ok := relPosix(w.root, abs)
	if !ok {
		return false
	}
	segments := strings.Split(rel, "/")
	neverRecurse := toSet(w.spec.NeverRecurse)
	for _, seg := range segments {
		if _, skip := neverRecurse[seg]; skip {
			return false
		}
	}
	dg := toSet(w.spec.DirectoryGranularity)
	if _, isDG := dg[segments[0]]; isDG {
		return matchesSignal(rel, w.spec.GitStateSignals) || matchesSignal(rel, w.spec.BeadsSignals)
	}
	return !isGitignored(w.gi, w.root, abs)
}

// watchManager owns all active watchers and serializes event emission.
type watchManager struct {
	mu        sync.Mutex
	watchers  map[string]*watcher
	emitEvent func(Event)
}

func newWatchManager(emit func(Event)) *watchManager {
	return &watchManager{
		watchers:  make(map[string]*watcher),
		emitEvent: emit,
	}
}

type watchSubscribeParams struct {
	Cwd   string     `json:"cwd"`
	Token string     `json:"token"`
	Spec  *watchSpec `json:"spec,omitempty"`
}

type watchUnsubscribeParams struct {
	Token string `json:"token"`
}

// subscribe begins a watch on cwd, keyed by token. A token already in use is
// replaced. Loads the root .gitignore and applies the pushed watch spec (or the
// default when none is sent).
func (m *watchManager) subscribe(raw json.RawMessage) (interface{}, error) {
	var p watchSubscribeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("watch.subscribe: decode params: %w", err)
	}
	if p.Cwd == "" {
		return nil, fmt.Errorf("watch.subscribe: cwd must not be empty")
	}
	if p.Token == "" {
		return nil, fmt.Errorf("watch.subscribe: token must not be empty")
	}
	spec := defaultWatchSpec()
	if p.Spec != nil {
		spec = *p.Spec
	}

	m.mu.Lock()
	if existing, ok := m.watchers[p.Token]; ok {
		existing.stop()
		delete(m.watchers, p.Token)
	}
	m.mu.Unlock()

	gi := loadGitignore(p.Cwd)

	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("watch.subscribe: create watcher: %w", err)
	}

	if err := addWatchesWithSpec(fsw, p.Cwd, p.Cwd, spec, gi); err != nil {
		fsw.Close()
		return nil, fmt.Errorf("watch.subscribe: add %q: %w", p.Cwd, err)
	}

	w := &watcher{
		token: p.Token,
		root:  p.Cwd,
		gi:    gi,
		spec:  spec,
		fsw:   fsw,
		done:  make(chan struct{}),
	}

	m.mu.Lock()
	m.watchers[p.Token] = w
	m.mu.Unlock()

	go m.run(w)

	return map[string]any{"token": p.Token}, nil
}

// unsubscribe stops and removes the watcher for token. Unknown tokens are a
// no-op success.
func (m *watchManager) unsubscribe(raw json.RawMessage) (interface{}, error) {
	var p watchUnsubscribeParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("watch.unsubscribe: decode params: %w", err)
	}
	if p.Token == "" {
		return nil, fmt.Errorf("watch.unsubscribe: token must not be empty")
	}

	m.mu.Lock()
	w, ok := m.watchers[p.Token]
	if ok {
		delete(m.watchers, p.Token)
	}
	m.mu.Unlock()

	if ok {
		w.stop()
	}
	return map[string]any{"token": p.Token}, nil
}

// closeAll stops every active watcher; used on shutdown.
func (m *watchManager) closeAll() {
	m.mu.Lock()
	all := make([]*watcher, 0, len(m.watchers))
	for _, w := range m.watchers {
		all = append(all, w)
	}
	m.watchers = make(map[string]*watcher)
	m.mu.Unlock()
	for _, w := range all {
		w.stop()
	}
}

// run consumes raw fsnotify events for a watcher, debounces them, and emits
// coalesced "watch" events. Errors become "watchError" events.
func (m *watchManager) run(w *watcher) {
	pending := make(map[string]struct{})
	var timer *time.Timer
	var timerC <-chan time.Time
	debounce := w.spec.debounce()

	flush := func() {
		if len(pending) == 0 {
			return
		}
		paths := make([]string, 0, len(pending))
		for p := range pending {
			paths = append(paths, p)
		}
		pending = make(map[string]struct{})
		m.emitEvent(Event{
			Event: "watch",
			Data:  map[string]any{"token": w.token, "paths": paths},
		})
	}

	for {
		select {
		case <-w.done:
			return
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			if !w.shouldEmit(ev.Name) {
				// Keep the recursive watch current even for non-emitted dirs (e.g.
				// a new .git/refs/<branch> directory) so its children are caught.
				if ev.Op&fsnotify.Create != 0 {
					if info, statErr := os.Stat(ev.Name); statErr == nil && info.IsDir() {
						_ = addWatchesWithSpec(w.fsw, ev.Name, w.root, w.spec, w.gi)
					}
				}
				continue
			}
			// Emit repo-relative POSIX paths for parity with the local mechanism,
			// so the shared ingest/policy classify both transports identically.
			rel, ok := relPosix(w.root, ev.Name)
			if !ok {
				rel = filepath.ToSlash(ev.Name)
			}
			pending[rel] = struct{}{}
			if ev.Op&fsnotify.Create != 0 {
				if info, statErr := os.Stat(ev.Name); statErr == nil && info.IsDir() {
					_ = addWatchesWithSpec(w.fsw, ev.Name, w.root, w.spec, w.gi)
				}
			}
			if timer == nil {
				timer = time.NewTimer(debounce)
				timerC = timer.C
			} else {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(debounce)
			}
		case <-timerC:
			flush()
			timer = nil
			timerC = nil
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			m.emitEvent(Event{
				Event: "watchError",
				Data:  map[string]any{"token": w.token, "error": err.Error()},
			})
		}
	}
}

// stop closes the watcher and signals its run loop to exit. Safe to call once.
func (w *watcher) stop() {
	if w.closed {
		return
	}
	w.closed = true
	close(w.done)
	_ = w.fsw.Close()
}

// addWatchesWithSpec registers root and the non-excluded subdirectories with the
// watcher, driven by the spec. Directory-granularity dirs (.git/.beads) are
// watched at the directory level (so signal files like .git/HEAD and
// .beads/issues.jsonl are seen) without descending into their heavy/churny
// subtrees — except .git/refs, which is watched recursively for branch/tag
// changes, and .git/worktrees, which is watched at ITS OWN directory level
// only (a linked worktree being added/removed changes that directory's own
// listing) without descending into any individual worktree's metadata dir —
// otherwise a routine commit made inside an already-known worktree (which
// rewrites its own .git/worktrees/<name>/HEAD, /index, /logs/HEAD, …) would
// spam a watch event on every commit, not just on add/remove
// (local_repo_explorer-rc9n). node_modules and gitignored subtrees are pruned
// (EMFILE avoidance). projectRoot is the repository root used for
// gitignore-relative paths.
func addWatchesWithSpec(fsw *fsnotify.Watcher, root, projectRoot string, spec watchSpec, gi *gitignore.GitIgnore) error {
	neverRecurse := toSet(spec.NeverRecurse)
	dg := toSet(spec.DirectoryGranularity)
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // tolerate transient per-entry errors
		}
		if !d.IsDir() {
			return nil
		}
		if _, skip := neverRecurse[d.Name()]; skip {
			return filepath.SkipDir
		}
		if isGitignored(gi, projectRoot, path) {
			return filepath.SkipDir
		}
		rel, ok := relPosix(projectRoot, path)
		if !ok {
			// path == projectRoot itself: watch it and descend.
			if addErr := fsw.Add(path); addErr != nil {
				return fmt.Errorf("add watch %q: %w", path, addErr)
			}
			return nil
		}
		top := strings.Split(rel, "/")[0]
		if _, isDG := dg[top]; isDG {
			// Watch the .git dir itself and descend only into refs; watch the
			// .beads dir itself and skip its subtrees (signals are direct children).
			if rel == ".git" {
				_ = fsw.Add(path)
				return nil // descend to reach .git/refs
			}
			if strings.HasPrefix(rel, ".git/") {
				if rel == ".git/refs" || strings.HasPrefix(rel, ".git/refs/") {
					_ = fsw.Add(path)
					return nil
				}
				if rel == ".git/worktrees" {
					_ = fsw.Add(path)
					return filepath.SkipDir // per-worktree metadata (HEAD/index/logs) excluded
				}
				return filepath.SkipDir // objects, logs, hooks, info, …
			}
			if rel == ".beads" {
				_ = fsw.Add(path)
				return filepath.SkipDir // .br_history/.br_recovery churn excluded
			}
			if strings.HasPrefix(rel, ".beads/") {
				return filepath.SkipDir
			}
			// Any other directory-granularity dir: watch shallow.
			_ = fsw.Add(path)
			return filepath.SkipDir
		}
		if addErr := fsw.Add(path); addErr != nil {
			return fmt.Errorf("add watch %q: %w", path, addErr)
		}
		return nil
	})
}
