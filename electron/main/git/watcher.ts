import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'node:path';
import { createGitignoreFilter } from './gitignoreFilter';

interface WatcherEntry {
  worktreePath: string;
  baseline?: string;
  fs: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  onChange: () => void;
}

const watchers = new Map<string, WatcherEntry>();

const DEBOUNCE_MS = 250;
// .git is watched selectively (HEAD/index/refs are kept; everything else under
// .git is noise) plus build-output and OS cruft. Large gitignored data trees are
// pruned separately via the per-worktree .gitignore filter below, so they never
// get a per-file watch (the EMFILE cause on big projects).
const IGNORE_PATTERNS = [
  /[/\\]\.git[/\\](?!HEAD$|index$|refs[/\\])/,
  /\bdist\b/,
  /\bout\b/,
  /\.DS_Store$/,
];

export interface StartWatchOptions {
  worktreePath: string;
  baseline?: string;
  onChange: () => void;
}

export function startWatch(token: string, opts: StartWatchOptions): void {
  stopWatch(token);
  const gitignored = createGitignoreFilter(opts.worktreePath);
  const fs = chokidar.watch(opts.worktreePath, {
    ignoreInitial: true,
    ignored: (p: string) => gitignored(p) || IGNORE_PATTERNS.some((re) => re.test(p)),
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  // Also watch .git/HEAD and .git/index for branch/staging changes.
  fs.add(join(opts.worktreePath, '.git', 'HEAD'));
  fs.add(join(opts.worktreePath, '.git', 'index'));

  const entry: WatcherEntry = {
    worktreePath: opts.worktreePath,
    ...(opts.baseline !== undefined ? { baseline: opts.baseline } : {}),
    fs,
    timer: null,
    onChange: opts.onChange,
  };

  const debounced = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      try {
        entry.onChange();
      } catch {
        // swallow handler errors so the watcher stays alive
      }
    }, DEBOUNCE_MS);
  };

  fs.on('add', debounced);
  fs.on('change', debounced);
  fs.on('unlink', debounced);
  fs.on('addDir', debounced);
  fs.on('unlinkDir', debounced);

  watchers.set(token, entry);
}

export function stopWatch(token: string): void {
  const entry = watchers.get(token);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  void entry.fs.close();
  watchers.delete(token);
}

export function stopAllWatches(): void {
  for (const token of Array.from(watchers.keys())) stopWatch(token);
}
