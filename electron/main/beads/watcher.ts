import chokidar, { type FSWatcher } from 'chokidar';
import { dirname } from 'node:path';

interface Entry {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  onChange: () => void;
}

const entries = new Map<string, Entry>();
const DEBOUNCE_MS = 350;

export function startBeadsWatch(
  token: string,
  sourcePath: string,
  onChange: () => void,
): void {
  stopBeadsWatch(token);
  const watcher = chokidar.watch(dirname(sourcePath), {
    ignoreInitial: true,
    persistent: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 60 },
  });
  const entry: Entry = { watcher, timer: null, onChange };
  const debounced = () => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      try {
        entry.onChange();
      } catch {
        // swallow
      }
    }, DEBOUNCE_MS);
  };
  watcher.on('all', debounced);
  entries.set(token, entry);
}

export function stopBeadsWatch(token: string): void {
  const e = entries.get(token);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  void e.watcher.close();
  entries.delete(token);
}

export function stopAllBeadsWatches(): void {
  for (const k of Array.from(entries.keys())) stopBeadsWatch(k);
}
