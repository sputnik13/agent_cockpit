/**
 * Main-process cache of `getDiffBundle` results, keyed per project by
 * (worktreePath, path, baseline). A cache hit serves a re-opened file or a
 * diff↔raw↔rendered mode toggle with ZERO provider round trips (the bundle is
 * the same until the file or the baseline changes).
 *
 * Invalidation is precise and driven by the existing filesystem watch:
 * - a watch batch touching a file path drops only that path's entries;
 * - a batch touching a git-state signal (HEAD / packed-refs / refs/*) means the
 *   branch/baseline may have changed, so the whole project's cache is cleared
 *   (every file's diff is relative to that baseline).
 *
 * Never serves stale: any unobserved change still arrives via the watch before
 * the next read, and a miss just costs the one round trip it would have anyway.
 * Per-project entries are bounded (insertion-order eviction) so memory can't grow
 * without bound on a long session.
 */
import type { DiffBundle } from '@shared/providers/types';

/** Max cached bundles per project (oldest evicted first). */
const MAX_ENTRIES_PER_PROJECT = 64;

const SEP = '\x1f'; // unit separator: never appears in a path or ref

interface Entry {
  /** Repo-relative file path, kept so path-precise invalidation can match it. */
  path: string;
  bundle: DiffBundle;
}

/** True when a watched path is a git-state signal (branch switch / commit / ref
 *  update) — i.e. a baseline change that invalidates every file's diff. */
export function isGitStateSignal(rel: string): boolean {
  return rel === '.git/HEAD' || rel === '.git/packed-refs' || rel.startsWith('.git/refs');
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
    m.set(k, { path, bundle });
    while (m.size > MAX_ENTRIES_PER_PROJECT) {
      const oldest = m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }

  /**
   * Apply a watch batch (repo-relative paths) to the project's cache: a git-state
   * signal clears everything (baseline changed); otherwise only entries for the
   * changed file paths are dropped.
   */
  onWatch(projectId: string, paths: readonly string[]): void {
    const m = this.byProject.get(projectId);
    if (!m || paths.length === 0) return;
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
