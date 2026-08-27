/**
 * Main-process cache of `getDiffBundle` results, keyed per project by
 * (worktreePath, path, baseline). A cache hit serves a re-opened file or a
 * diff↔raw↔rendered mode toggle with ZERO provider round trips (the bundle is
 * the same until the file or the baseline changes).
 *
 * Invalidation is precise and driven by the existing filesystem watch:
 * - a watch batch touching a file path drops only that path's entries;
 * - a batch touching a git-state signal (HEAD / packed-refs / refs/* / a
 *   linked worktree add-remove under .git/worktrees) means the
 *   branch/baseline may have changed, so the whole project's cache is cleared
 *   (every file's diff is relative to that baseline).
 *
 * Never serves stale: any unobserved change still arrives via the watch before
 * the next read, and a miss just costs the one round trip it would have anyway.
 * Per-project entries are bounded (insertion-order eviction) so memory can't grow
 * without bound on a long session.
 */
import { classifyWatchPath } from '@shared/watch/policy';
import type { DiffBundle } from '@shared/providers/types';

/** Max cached bundles per project (oldest evicted first). */
const MAX_ENTRIES_PER_PROJECT = 64;

const SEP = '\x1f'; // unit separator: never appears in a path or ref

interface Entry {
  /** Repo-relative (or, for a `worktreePath`-set entry, worktree-relative)
   *  file path, kept so path-precise invalidation can match it. */
  path: string;
  /** The worktree this entry was read from (mirrors the `worktreePath` arg
   *  `set()` was called with) — used by a `worktreePath`-TAGGED watch batch
   *  (`onWatch`) to match only entries belonging to that same worktree. */
  worktreePath: string;
  bundle: DiffBundle;
}

/** True when a watched path is a git-state signal (branch switch / commit / ref
 *  update, or a linked worktree being added/removed) — i.e. a baseline change
 *  that invalidates every file's diff. Delegates to the canonical classifier
 *  (`src/shared/watch/policy.ts`) instead of hand-copying its signal list, so
 *  this can never drift from — and exactly matches the depth-gating of — the
 *  single source of "what counts as git-state" (e.g. `.git/worktrees` itself
 *  or a `<name>` entry counts, but churn nested inside a worktree's own
 *  metadata dir does not). */
export function isGitStateSignal(rel: string): boolean {
  return classifyWatchPath(rel) === 'git-state';
}

export class DiffBundleCache {
  private byProject = new Map<string, Map<string, Entry>>();

  private static key(worktreePath: string, path: string, baseline: string | undefined): string {
    return `${worktreePath}${SEP}${path}${SEP}${baseline ?? ''}`;
  }

  get(
    projectId: string,
    worktreePath: string,
    path: string,
    baseline: string | undefined,
  ): DiffBundle | undefined {
    return this.byProject.get(projectId)?.get(DiffBundleCache.key(worktreePath, path, baseline))
      ?.bundle;
  }

  set(
    projectId: string,
    worktreePath: string,
    path: string,
    baseline: string | undefined,
    bundle: DiffBundle,
  ): void {
    let m = this.byProject.get(projectId);
    if (!m) {
      m = new Map<string, Entry>();
      this.byProject.set(projectId, m);
    }
    const k = DiffBundleCache.key(worktreePath, path, baseline);
    // Re-insert at the end for insertion-order LRU behavior.
    m.delete(k);
    m.set(k, { path, worktreePath, bundle });
    while (m.size > MAX_ENTRIES_PER_PROJECT) {
      const oldest = m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  /**
   * Apply a watch batch to the project's cache.
   *
   * `worktreePath` set (a batch from the EXTRA active-external-worktree watch,
   * local_repo_explorer-g1je): `paths` are relative to THAT worktree, not the
   * project root, so this only ever matches entries whose OWN stored
   * `worktreePath` equals the tag (string equality) AND whose `path` is in the
   * changed set — an entry for a DIFFERENT worktree (including the project
   * root) is never dropped by a sibling worktree's own edits, since their
   * paths live in a completely different namespace. A tagged batch never
   * clears the whole project on a git-state signal — the active-external-
   * worktree watch never emits git-state signals at all (see
   * `WorkspaceProvider.subscribeWorktreeWatch`'s doc comment), so this branch
   * is never reached with one.
   *
   * `worktreePath` absent (undefined — the PRIMARY root-rooted watch): keeps
   * the EXISTING behavior byte-for-byte — a git-state signal clears the whole
   * project (a baseline change affects every worktree's diff); otherwise only
   * entries whose stored `path` is in the changed set are dropped, regardless
   * of THEIR stored `worktreePath`.
   *
   * KNOWN PRE-EXISTING GAP (not introduced by, and not fixed by, this bead):
   * for a NESTED linked worktree (checked out inside the project root, so it
   * has no extra watch of its own — the primary watch already covers it), an
   * untagged event's path is project-ROOT-relative while that worktree's own
   * cache entries store a WORKTREE-relative `path` — the two shapes can
   * mismatch, so an untagged batch can silently fail to invalidate a nested
   * worktree's cached bundle. A follow-up bead should precompute the
   * root-relative form at `set()` time (mirroring FoldingView's own
   * root-relative conversion, local_repo_explorer-w5x0) rather than storing
   * only the worktree-relative path.
   */
  onWatch(projectId: string, paths: readonly string[], worktreePath?: string): void {
    const m = this.byProject.get(projectId);
    if (!m || paths.length === 0) return;
    if (worktreePath !== undefined) {
      const changed = new Set(paths);
      for (const [k, entry] of m) {
        if (entry.worktreePath === worktreePath && changed.has(entry.path)) m.delete(k);
      }
      return;
    }
    if (paths.some(isGitStateSignal)) {
      m.clear();
      return;
    }
    const changed = new Set(paths);
    for (const [k, entry] of m) {
      if (changed.has(entry.path)) m.delete(k);
    }
  }

  /** Drop a project's entire cache (disconnect / eviction). */
  evictProject(projectId: string): void {
    this.byProject.delete(projectId);
  }

  /** Test/teardown helper. */
  clear(): void {
    this.byProject.clear();
  }
}

/** Process-wide singleton used by the IPC layer. */
export const diffCache = new DiffBundleCache();
