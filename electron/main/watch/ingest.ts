/**
 * Layer 3 — ingest. Turns the raw `(path)` events any watch mechanism emits
 * into one canonical, classified, debounced stream. This is the single place
 * debounce/coalesce, path normalization, and category classification happen, so
 * both transports (local chokidar/fs.watch and the remote Go helper) converge
 * to identical `CanonicalWatchEvent`s before dispatch.
 *
 * The mechanism layer (Layer 2) feeds raw repo-relative paths via `feed()`;
 * `emit` fires once per coalesced batch. Classification and normalization come
 * from the shared policy (Layer 1) — ingest defines none of its own.
 */
import { WATCH_DEBOUNCE_MS, classifyWatchPath, normalizeWatchPath } from '@shared/watch/policy';
import type { CanonicalWatchEvent, ClassifiedPath, WatchCategory } from '@shared/watch/types';

export interface WatchIngestOptions {
  /** Debounce/coalesce window; defaults to the shared `WATCH_DEBOUNCE_MS`. */
  debounceMs?: number;
  /** Injectable clock for the event timestamp (tests pass a fixed value). */
  clock?: () => string;
}

export interface WatchIngest {
  /**
   * Feed raw paths from a mechanism. Paths are normalized + classified;
   * unclassifiable paths (excluded dirs, `.git`/`.beads` non-signals,
   * `-wal`/`-shm`) are dropped. Schedules a coalesced emit.
   */
  feed(paths: readonly string[]): void;
  /** Emit any pending batch immediately (e.g. on teardown / flush-before-close). */
  flush(): void;
  /** Cancel any pending batch and drop accumulated paths without emitting. */
  dispose(): void;
}

/**
 * Create an ingest pipeline. Uses a fixed (leading-window) debounce: the first
 * accepted path arms a timer; subsequent paths within the window join the same
 * batch without resetting it, bounding emit latency to `debounceMs`.
 */
export function createWatchIngest(
  emit: (event: CanonicalWatchEvent) => void,
  opts: WatchIngestOptions = {},
): WatchIngest {
  const debounceMs = opts.debounceMs ?? WATCH_DEBOUNCE_MS;
  const clock = opts.clock ?? ((): string => new Date().toISOString());

  // rel path -> category. Deduplicates repeated paths within a batch.
  const pending = new Map<string, WatchCategory>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const paths: ClassifiedPath[] = [];
    const categories = new Set<WatchCategory>();
    for (const [rel, category] of pending) {
      paths.push({ rel, category });
      categories.add(category);
    }
    pending.clear();
    emit({ categories: [...categories], paths, at: clock() });
  };

  const feed = (paths: readonly string[]): void => {
    let added = false;
    for (const raw of paths) {
      const category = classifyWatchPath(raw);
      if (category === null) continue;
      pending.set(normalizeWatchPath(raw), category);
      added = true;
    }
    // Fixed window: arm only if not already armed.
    if (added && timer === null) {
      timer = setTimeout(flush, debounceMs);
    }
  };

  const dispose = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };

  return { feed, flush, dispose };
}
