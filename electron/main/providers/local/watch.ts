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
import chokidar, { type FSWatcher } from 'chokidar';
import { watch as fsWatch, type FSWatcher as NodeFSWatcher } from 'node:fs';
import { join } from 'node:path';
import { deriveWatchSpec } from '@shared/watch/policy';
import { createGitignoreFilter } from '../../git/gitignoreFilter';
import { createWatchIngest, type WatchIngest } from '../../watch/ingest';
import type { WatchEvent, WatchHandler, WatchSubscription } from '../types';

let counter = 0;

interface ActiveWatch {
  watcher: FSWatcher;
  gitWatchers: NodeFSWatcher[];
  ingest: WatchIngest;
}

export class LocalWatchManager {
  private watches = new Map<string, ActiveWatch>();

  constructor(private readonly rootPath: string) {}

  subscribe(globs: string[], handler: WatchHandler): WatchSubscription {
    const token = `local-watch-${++counter}`;
    const spec = deriveWatchSpec();
    const gitignored = createGitignoreFilter(this.rootPath);

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
    // segments are excluded from the chokidar per-file walk anywhere they appear.
    // For `.beads` this is load-bearing: chokidar v4 holds a per-file read handle
    // on every entry it walks, so descending into `.beads/` pins an open FD on
    // `beads.db` (+ -wal/-shm) for the life of the app — blocking
    // `br doctor --repair`'s exclusive lock and contributing to index corruption
    // (local_repo_explorer-fg5z). For `.git` the per-file kqueue watches lose the
    // inode on atomic ref renames. Both are watched at directory granularity via
    // the native fs.watch watchers below instead.
    const excludedSegments = new Set<string>([...spec.directoryGranularity, ...spec.neverRecurse]);
    const isExcludedPath = (p: string): boolean =>
      p
        .replace(/\\/g, '/')
        .split('/')
        .some((seg) => excludedSegments.has(seg));

    const watcher = chokidar.watch(globs.length ? globs : ['.'], {
      cwd: this.rootPath,
      ignoreInitial: true,
      ignored: (p: string) => gitignored(p) || isExcludedPath(p),
    });

    const active: ActiveWatch = { watcher, gitWatchers: [], ingest };
    this.watches.set(token, active);

    watcher.on('all', (_event, path) => feed(path));

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

    return {
      token,
      unsubscribe: async () => {
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
        await w.watcher.close();
      },
    };
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
      await w.watcher.close();
    }
  }
}
