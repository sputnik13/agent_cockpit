/**
 * Layer 2 (local) — the local filesystem watch *mechanism*. Policy-driven: what
 * to watch/exclude and which paths are signals come from the shared watch
 * policy (`deriveWatchSpec`), never from inline literals here. Raw paths are fed
 * into the shared ingest (Layer 3), which normalizes, classifies, and debounces
 * into canonical events. This manager adapts the canonical event back to the
 * current `WatchEvent` contract (rel paths) for the provider handler; T5 carries
 * categories through to the renderer.
 *
 * A live session owns exactly one watch (started on connect, stopped when the
 * session ends), so there is no warm/hot pause state: a watch either runs or is
 * torn down. The previous `setPaused` gating was removed with `suspend()`.
 */
import { watch as fsWatch, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { join } from 'node:path';
import { deriveWatchSpec } from '@shared/watch/policy';
import { createGitignoreFilter } from '../../git/gitignoreFilter';
import { createWatchIngest, type WatchIngest } from '../../watch/ingest';
import { createWorkingTreeWatcher, type WorkingTreeWatcher } from './workingTreeWatcher';
import type { WatchEvent, WatchHandler, WatchSubscription } from '../types';

let counter = 0;

interface ActiveWatch {
  workingTree: WorkingTreeWatcher;
  gitWatchers: NodeFSWatcher[];
  ingest: WatchIngest;
}

export class LocalWatchManager {
  private watches = new Map<string, ActiveWatch>();

  constructor(private readonly rootPath: string) {}

  /**
   * Shared scaffolding for both `subscribe()` (project-root-rooted, plus the
   * dedicated git/beads signal watchers below) and `subscribeWorktree()`
   * (a specific worktree root, working-tree-only — no signal watchers): the
   * ingest wiring, the `excludedSegments` derivation, and the working-tree
   * mechanism itself. Registers the entry in `this.watches` keyed by the
   * returned token so both callers' `unsubscribe` shares one teardown path
   * (`unsubscribeOf`).
   */
  private createBase(
    rootPath: string,
    tokenPrefix: string,
    handler: WatchHandler,
  ): { token: string; active: ActiveWatch; feed: (path: string) => void } {
    const token = `${tokenPrefix}-${++counter}`;
    const spec = deriveWatchSpec();
    const gitignored = createGitignoreFilter(rootPath);

    // Ingest owns debounce + classification. We adapt the canonical event back
    // to the WatchEvent contract (rel path strings) the provider handler expects.
    const ingest = createWatchIngest((canonical) => {
      const event: WatchEvent = {
        token,
        paths: canonical.paths.map((p) => p.rel),
        at: canonical.at,
      };
      handler(event);
    });

    const feed = (path: string): void => {
      ingest.feed([path]);
    };

    // Directory-granularity (`.git`, `.beads`) and never-recurse (`node_modules`)
    // segments are dropped from the working-tree mechanism anywhere they appear.
    // For `.beads` this is load-bearing: it must not pin an open FD on `beads.db`
    // (+ -wal/-shm) — blocking `br doctor --repair`'s exclusive lock and
    // contributing to index corruption (local_repo_explorer-fg5z). For `.git` the
    // ref signals need atomic temp+rename detection. Both are watched at directory
    // granularity via the native fs.watch watchers below instead. (The
    // single-handle native recursive path holds no per-file FD, but we keep this
    // exclusion so behavior is identical to the chokidar/Linux path and the
    // dedicated watchers remain the single source of git-state/beads signals.)
    const excludedSegments = new Set<string>([...spec.directoryGranularity, ...spec.neverRecurse]);
    const isExcludedPath = (p: string): boolean =>
      p
        .replace(/\\/g, '/')
        .split('/')
        .some((seg) => excludedSegments.has(seg));

    // Working-tree mechanism: one native recursive fs.watch on macOS/Windows, a
    // chokidar instance on Linux (see workingTreeWatcher.ts). globs is no longer
    // honored — chokidar v4 dropped glob support and callers only ever pass `['.']`.
    const workingTree = createWorkingTreeWatcher({
      rootPath,
      shouldIgnore: (p: string) => gitignored(p) || isExcludedPath(p),
      onPath: feed,
    });

    const active: ActiveWatch = { workingTree, gitWatchers: [], ingest };
    this.watches.set(token, active);
    return { token, active, feed };
  }

  /** Shared teardown for a token registered via `createBase`, regardless of
   *  whether it also picked up dedicated git/beads signal watchers. */
  private unsubscribeOf(token: string): () => Promise<void> {
    return async () => {
      const w = this.watches.get(token);
      if (!w) return;
      this.watches.delete(token);
      w.ingest.dispose();
      for (const gw of w.gitWatchers) {
        try {
          gw.close();
        } catch {
          /* already closed */
        }
      }
      await w.workingTree.close();
    };
  }

  subscribe(_globs: string[], handler: WatchHandler): WatchSubscription {
    const { token, active, feed } = this.createBase(this.rootPath, 'local-watch', handler);

    // `.git` non-recursive: top-level rewrites (HEAD on branch switch, packed-refs
    // on `git pack-refs`). We forward every filename and let the shared policy
    // keep only the git-state signals (HEAD/packed-refs) and drop the rest
    // (index, FETCH_HEAD, lockfiles), so the "what" stays in one place.
    try {
      const w = fsWatch(join(this.rootPath, '.git'), { persistent: true }, (_event, filename) => {
        if (filename) feed(`.git/${filename}`);
      });
      w.on('error', () => {
        /* directory removed / watcher closed; ignore */
      });
      active.gitWatchers.push(w);
    } catch {
      // Non-git workspace or .git/ does not exist; that's fine.
    }

    // `.git/refs` recursive: every ref change (branch/tag/remote, including nested
    // branches). On macOS libuv backs recursive dir watches with FSEvents (path,
    // not inode), so atomic ref renames are detected reliably. Degrades silently
    // where recursive fs.watch is unsupported.
    try {
      const w = fsWatch(
        join(this.rootPath, '.git', 'refs'),
        { persistent: true, recursive: true },
        (_event, filename) => {
          feed(filename ? `.git/refs/${filename}` : '.git/refs');
        },
      );
      w.on('error', () => {
        /* directory removed / watcher closed; ignore */
      });
      active.gitWatchers.push(w);
    } catch {
      // No .git/refs or platform without recursive support; degrade silently.
    }

    // `.beads` non-recursive directory watch. We deliberately do NOT let chokidar
    // descend into `.beads/` (FD-pin hazard above). A directory-level fs.watch
    // reports changes by path without keeping a read handle on the DB file. We
    // forward every filename and let the policy keep only the committed-write
    // signals (`beads.db`, `issues.jsonl`) and drop `-wal`/`-shm` — the latter is
    // critical: a WAL-mode read bumps their mtime and would feed the workgraph's
    // next read in a self-sustaining loop (local_repo_explorer-fg5z).
    try {
      const w = fsWatch(join(this.rootPath, '.beads'), { persistent: true }, (_event, filename) => {
        if (filename) feed(`.beads/${filename}`);
      });
      w.on('error', () => {
        /* .beads/ removed / watcher closed; ignore */
      });
      active.gitWatchers.push(w);
    } catch {
      // No `.beads/` directory; non-beads workspace. That's fine.
    }

    // `.git/worktrees` non-recursive directory watch: a linked worktree being
    // added or removed (`git worktree add`/`remove`) changes this directory's
    // own listing (a `<name>` entry appearing/disappearing). Deliberately NOT
    // recursive — descending into each `<name>/` subdirectory would re-fire on
    // every commit made INSIDE an already-known worktree (its own HEAD/index/
    // logs churn), which is exactly the noise the shared policy's
    // directory-level classification (`classifyWatchPath`) is built to reject.
    // `.git/worktrees` usually does not exist until the first-ever worktree is
    // added, so this watch commonly fails to attach at subscribe time (caught
    // below) — the top-level `.git` watch above already covers that first
    // creation (it's a new entry in `.git`'s own listing); this dedicated watch
    // takes over for every worktree added/removed afterward within the same
    // live session (local_repo_explorer-rc9n).
    try {
      const w = fsWatch(
        join(this.rootPath, '.git', 'worktrees'),
        { persistent: true },
        (_event, filename) => {
          feed(filename ? `.git/worktrees/${filename}` : '.git/worktrees');
        },
      );
      w.on('error', () => {
        /* .git/worktrees/ removed / watcher closed; ignore */
      });
      active.gitWatchers.push(w);
    } catch {
      // No `.git/worktrees/` yet (repo has never had a linked worktree).
    }

    return { token, unsubscribe: this.unsubscribeOf(token) };
  }

  /**
   * Subscribe to filesystem changes rooted at a SPECIFIC worktree path,
   * independent of `subscribe()`'s project-root-rooted watch — the mechanism
   * behind `WorkspaceProvider.subscribeWorktreeWatch` (see that method's doc
   * comment in `../types.ts` for the full working-tree-only contract).
   * Emits paths relative to `worktreePath`, NOT `this.rootPath`. Deliberately
   * does NOT add the dedicated `.git`/`.git/refs`/`.beads`/`.git/worktrees`
   * signal watchers `subscribe()` adds above: a linked worktree's own `.git`
   * is a plain FILE (a `gitdir:` pointer into the primary worktree's
   * `.git/worktrees/<name>`, not a directory), so those git-state/beads
   * signal watches are meaningless here — the project's PRIMARY `subscribe()`
   * watch (shared repo state) already covers them. Still excludes
   * `.git`/`.beads`/`node_modules` SEGMENTS from the working-tree mechanism
   * itself (the same `excludedSegments` derivation `createBase` always
   * applies), so an edit under the worktree's own `.git`-pointer-adjacent
   * paths or a `node_modules` tree is not walked.
   */
  subscribeWorktree(worktreePath: string, handler: WatchHandler): WatchSubscription {
    const { token } = this.createBase(worktreePath, 'local-watch-wt', handler);
    return { token, unsubscribe: this.unsubscribeOf(token) };
  }

  async closeAll(): Promise<void> {
    const all = [...this.watches.values()];
    this.watches.clear();
    for (const w of all) {
      w.ingest.dispose();
      for (const gw of w.gitWatchers) {
        try {
          gw.close();
        } catch {
          /* already closed */
        }
      }
      await w.workingTree.close();
    }
  }
}
