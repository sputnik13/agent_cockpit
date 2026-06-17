/**
 * The working-tree watch *mechanism* — the part that observes every file in the
 * worktree (tracked AND untracked, so newly-created files are caught) and feeds
 * raw paths into the shared ingest. Split from {@link LocalWatchManager} so the
 * platform choice below is isolated and unit-testable.
 *
 * Why two mechanisms:
 *
 * - **macOS / Windows** have a true single-handle recursive FS watch
 *   (`fs.watch(root, {recursive:true})` → FSEvents / ReadDirectoryChangesW). It
 *   watches the whole subtree with ONE handle, no upfront tree walk, and holds no
 *   per-file descriptor. This is the path that fixes large-repo load: chokidar v4
 *   dropped its FSEvents backend and recurses by walking the tree and opening an
 *   `fs.watch` per directory, so a big repo costs a full walk + thousands of
 *   handles. The whole-tree *coverage* is required (untracked-change detection);
 *   the per-FD cost was only chokidar's implementation, not a requirement.
 *
 * - **Linux** has no recursive inotify; `fs.watch({recursive:true})` is *emulated*
 *   by adding a watch per directory — the same per-dir cost as chokidar, but it
 *   cannot prune `node_modules` before adding watches (the EMFILE risk
 *   `NEVER_RECURSE` exists to avoid) and is documented experimental. chokidar's
 *   `ignored` stops it descending into excluded/gitignored trees, so it adds
 *   FEWER inotify watches. So on Linux chokidar is the better choice and we keep
 *   it.
 *
 * Both paths apply the same ignore predicate. The native path filters in the
 * event callback (there is no walk to prune); chokidar filters via `ignored`
 * (which also prunes the descent). `.git`/`.beads` signal watching stays in
 * {@link LocalWatchManager}'s dedicated `fs.watch` watchers on both platforms.
 */
import chokidar from 'chokidar';
import { watch as fsWatch } from 'node:fs';

export interface WorkingTreeWatcher {
  close(): Promise<void>;
}

export interface WorkingTreeWatcherOptions {
  rootPath: string;
  /** Drop predicate. Returns true when the raw path (gitignored or an excluded
   *  segment like `.git`/`.beads`/`node_modules`) should NOT produce an event.
   *  Accepts the path as the mechanism reports it (absolute or root-relative),
   *  matching `createGitignoreFilter`'s contract. */
  shouldIgnore: (path: string) => boolean;
  /** Receives a raw repo-relative path for a working-tree change; the caller
   *  normalizes + classifies it via the ingest layer. */
  onPath: (path: string) => void;
  /** Overridable for tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
  /** Injectable for tests; defaults to `node:fs` watch. */
  fsWatchFn?: typeof fsWatch;
  /** Injectable for tests; defaults to `chokidar.watch`. */
  chokidarWatchFn?: typeof chokidar.watch;
}

/** Whether the platform provides a single-handle recursive FS watch (FSEvents on
 *  macOS, ReadDirectoryChangesW on Windows). Linux's recursive watch is emulated
 *  per-directory, so it does not qualify. */
export function hasNativeRecursiveWatch(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function createWorkingTreeWatcher(opts: WorkingTreeWatcherOptions): WorkingTreeWatcher {
  const platform = opts.platform ?? process.platform;
  const fsWatchFn = opts.fsWatchFn ?? fsWatch;
  const chokidarWatchFn = opts.chokidarWatchFn ?? chokidar.watch;

  if (hasNativeRecursiveWatch(platform)) {
    // One OS-level recursive handle. `filename` is root-relative; events for
    // excluded/gitignored paths still arrive (we cannot prune what we never
    // walk), so we drop them here — cheap, and no FD is held per file.
    const w = fsWatchFn(opts.rootPath, { persistent: true, recursive: true }, (_event, filename) => {
      // `filename` is root-relative (string under the default utf8 encoding) or
      // null when the OS could not supply it; drop the latter and ignored paths.
      const rel = typeof filename === 'string' ? filename : '';
      if (!rel || opts.shouldIgnore(rel)) return;
      opts.onPath(rel);
    });
    w.on('error', () => {
      /* root removed / watcher closed; ignore */
    });
    return {
      close: async () => {
        try {
          w.close();
        } catch {
          /* already closed */
        }
      },
    };
  }

  // Linux fallback: chokidar prunes the descent via `ignored`, adding fewer
  // inotify watches than an emulated recursive fs.watch would.
  const w = chokidarWatchFn(['.'], {
    cwd: opts.rootPath,
    ignoreInitial: true,
    ignored: (p: string) => opts.shouldIgnore(p),
  });
  w.on('all', (_event, p) => {
    if (typeof p === 'string') opts.onPath(p);
  });
  return {
    close: async () => {
      await w.close();
    },
  };
}
