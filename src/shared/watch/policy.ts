/**
 * Layer 1 — the single source of "what to watch."
 *
 * Every other layer (local + remote mechanisms, ingest, dispatch, the Changes
 * surface filter) consumes this module. No layer may define its own
 * watch/exclusion/interest set. The Go remote helper, which cannot import TS,
 * receives `deriveWatchSpec()` over the `watch.subscribe` RPC.
 *
 * Pure TS, no Node dependencies, so it loads in both main and renderer.
 *
 * Contract: path inputs to `classifyWatchPath`/`isHiddenFromChanges` are
 * **repo-relative POSIX** paths (the ingest layer normalizes before calling).
 */
import type { WatchCategory, WatchSpec } from './types';

/**
 * The one debounce/coalesce window. Replaces the previously divergent values
 * (Go helper 150ms, local watcher 200ms). 200ms keeps rapid bursts (editors
 * writing temp+rename, multi-file saves) collapsed into a single refresh.
 */
export const WATCH_DEBOUNCE_MS = 200;

/**
 * Directory names never recursively walked. `node_modules` is large enough that
 * a recursive watch add would exhaust inotify watches (EMFILE).
 */
export const NEVER_RECURSE = ['node_modules'] as const;

/**
 * Directories watched at directory granularity only — never per-file walked.
 * `.git`: per-file kqueue watches lose the inode when git atomically renames
 * `refs/heads/<branch>.lock` over the live ref. `.beads`: a per-file walk pins
 * an open read FD on `beads.db` for the life of the app, blocking
 * `br doctor --repair`'s exclusive lock and contributing to index corruption
 * under concurrent `br` writers (local_repo_explorer-fg5z).
 */
export const DIRECTORY_GRANULARITY = ['.git', '.beads'] as const;

/**
 * `git-state` signal paths: branch switch / commit / ref updates, plus a linked
 * worktree being added or removed (`git worktree add`/`remove` writes only
 * under `.git/worktrees/<name>/...`). `.git/refs` is an UNBOUNDED prefix
 * (covers `refs/heads/*`, `refs/tags/*`, nested branches — every depth is real
 * signal). `.git/worktrees` is deliberately NOT unbounded: `classifyWatchPath`
 * treats only the directory itself and its immediate `<name>` entries as
 * signal, never paths nested inside a worktree's own metadata dir
 * (`.git/worktrees/<name>/HEAD`, `/index`, `/logs/HEAD`, … churn on every
 * commit made INSIDE that worktree — routine activity, not a worktree-set
 * change; see DIRECTORY_GRANULARITY-style gating below). All other `.git`
 * churn (index, FETCH_HEAD, lockfiles, COMMIT_EDITMSG) is noise.
 */
export const GIT_STATE_SIGNALS = [
  '.git/HEAD',
  '.git/packed-refs',
  '.git/refs',
  '.git/worktrees',
] as const;

/**
 * `beads` signal paths: committed-write markers only. `beads.db` changes on
 * checkpoint, `issues.jsonl` on `br` flush. Deliberately NOT `-wal`/`-shm`: a
 * WAL-mode read bumps their mtime, which would feed the workgraph's next read
 * in a self-sustaining refresh loop (local_repo_explorer-fg5z).
 */
export const BEADS_SIGNALS = ['.beads/beads.db', '.beads/issues.jsonl'] as const;

/**
 * Changes-panel surface policy: top-level entries hidden from the Changes list
 * by default. This is a **display** concern, explicitly distinct from watch
 * exclusion — `.git` and `.beads` are still watched (so their changes drive
 * refreshes); they are only hidden from the changeset rows unless the global
 * "show all changes" toggle is on.
 */
export const CHANGES_HIDDEN_PREFIXES = ['.git', '.beads'] as const;

/**
 * Normalize to a repo-relative POSIX path: backslashes → `/`, drop leading `./`
 * and `/`. The single normalizer shared by classification and the ingest layer,
 * so paths are canonicalized exactly one way.
 */
export function normalizeWatchPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

const includes = (list: readonly string[], value: string): boolean => list.includes(value);

/**
 * Map a repo-relative POSIX path to its watch category, or `null` when the path
 * is excluded / not of interest. This is the only place path → category logic
 * lives.
 */
export function classifyWatchPath(relPath: string): WatchCategory | null {
  const rel = normalizeWatchPath(relPath);
  if (rel === '') return null;
  const segments = rel.split('/');
  // Never-recurse trees (e.g. node_modules) are not of interest at any depth.
  if (segments.some((s) => includes(NEVER_RECURSE, s))) return null;

  const top = segments[0];

  if (top === '.git') {
    if (rel === '.git/HEAD' || rel === '.git/packed-refs' || rel.startsWith('.git/refs')) {
      return 'git-state';
    }
    // `.git/worktrees` itself (a worktree being added/removed changes this
    // directory's own listing), or exactly one entry below it. Gated at
    // directory level via segment count, NOT `.startsWith`, so per-commit
    // churn inside an already-known worktree's own metadata dir
    // (`.git/worktrees/<name>/HEAD`, two segments deeper) stays noise.
    if (segments[1] === 'worktrees' && segments.length <= 3) {
      return 'git-state';
    }
    return null; // all other .git churn is noise
  }

  if (top === '.beads') {
    return includes(BEADS_SIGNALS, rel) ? 'beads' : null; // -wal/-shm/backups dropped
  }

  return 'working-tree';
}

/**
 * Whether a changeset row should be hidden from the Changes list. Display-only:
 * the path is still watched. With `showAll`, nothing is hidden.
 */
export function isHiddenFromChanges(relPath: string, opts: { showAll: boolean }): boolean {
  if (opts.showAll) return false;
  const top = normalizeWatchPath(relPath).split('/')[0];
  return includes(CHANGES_HIDDEN_PREFIXES, top);
}

/**
 * The serializable spec handed to transports that cannot import this module
 * (the Go remote helper, over RPC). Derived from the constants above so there
 * is exactly one authoring site.
 */
export function deriveWatchSpec(): WatchSpec {
  return {
    neverRecurse: [...NEVER_RECURSE],
    directoryGranularity: [...DIRECTORY_GRANULARITY],
    gitStateSignals: [...GIT_STATE_SIGNALS],
    beadsSignals: [...BEADS_SIGNALS],
    debounceMs: WATCH_DEBOUNCE_MS,
  };
}
