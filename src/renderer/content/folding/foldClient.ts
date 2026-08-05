/**
 * Public fold-model entrypoint for the Content panel: a content-addressed
 * model cache in front of a Web-Worker fold computation (with an inline
 * fallback). Callers use `computeFoldModel` (via the `useFoldModel` hook).
 * Mirrors highlight/highlighter.ts's cache + worker-client pattern exactly,
 * so there is one recognizable worker-offload shape in this codebase.
 *
 * - The actual parse work lives in {@link computeFoldModelSync} (foldCore.ts)
 *   and runs in {@link foldWorker} so the main thread never blocks on it for
 *   a large file. If the worker can't start (or under test), it
 *   transparently falls back to inline computation — identical output,
 *   since both call `computeFoldModelSync`.
 * - Folding is pure in (text, format), so re-selecting the same file/format
 *   hits the cache instead of re-parsing. Bounded by entry count (oldest
 *   evicted first).
 */
import { computeFoldModelSync } from './foldCore';
import type { FoldFormat, FoldModel } from './foldModel';

// Fold cache entries are dominated by the cache KEY, which embeds the full
// source text (same content-addressing shape as highlighter.ts's token
// cache). Ordinary source files rarely approach highlighter.ts's cap of
// MAX_TOKEN_CACHE_ENTRIES = 32 at any notable size, but this folding view
// specifically targets JSON/YAML files up to a near-threshold size (~10MB —
// see .4's size-threshold setting and this issue's Validation timing
// fixtures), and a user realistically has several such files open/recently
// viewed in one session. At 32 entries, a worst case of 32 * ~10MB ≈ 320MB of
// retained source text alone is an unreasonable budget for a convenience
// cache. 8 entries bounds the worst case to ~80MB — still enough hit
// behavior across tab/reselect churn for the handful of large structured
// files a user actually juggles at once — while staying a small, clearly
// intentional fraction of the sibling cache's cap.
const MAX_FOLD_CACHE_ENTRIES = 8;
const foldCache = new Map<string, FoldModel>();

// Worker lifecycle. `workerDisabled` latches true under test (no functional
// Worker in the vitest environment) or if the worker ever fails to start/run,
// so we permanently fall back to inline compute rather than hang.
let worker: Worker | null = null;
let workerDisabled = import.meta.env?.MODE === 'test';
let seq = 0;
const pending = new Map<number, (m: FoldModel | null) => void>();

// Test-only seam (see `__setWorkerFactoryForTest` below): lets
// foldClient.test.ts simulate worker construction failure / postMessage
// throw / onerror / an error reply deterministically. `ensureWorker` only
// reaches the dynamic import below when this is unset, and it is unset for
// the whole suite unless a test explicitly opts in — so vitest never
// evaluates the `?worker` virtual module.
let workerFactoryOverride: (() => Worker) | null = null;

async function ensureWorker(): Promise<Worker | null> {
  if (workerDisabled) return null;
  if (worker) return worker;
  try {
    // Dynamic import so the `?worker` virtual module is never evaluated under
    // test (where vite's worker transform isn't wired up) — mirrors
    // highlighter.ts's `ensureWorker` exactly.
    const w = workerFactoryOverride
      ? workerFactoryOverride()
      : new (await import('./foldWorker?worker')).default();
    w.onmessage = (e: MessageEvent<{ id: number; model?: FoldModel; error?: string }>): void => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      resolve(e.data.error != null ? null : (e.data.model ?? null));
    };
    w.onerror = (): void => {
      // Worker crashed: disable it, and unblock anything waiting (null → inline).
      workerDisabled = true;
      worker = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    workerDisabled = true;
    return null;
  }
}

/** Computes via the worker; resolves null on any worker-side failure so the
 *  caller can fall back to inline. */
function computeViaWorker(w: Worker, text: string, format: FoldFormat): Promise<FoldModel | null> {
  return new Promise<FoldModel | null>((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    try {
      w.postMessage({ id, text, format });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Computes the fold model for `text`/`format`. Served from the content-
 * addressed cache when possible; otherwise computed in the worker (falling
 * back to inline if the worker is unavailable or errors). Never rejects: the
 * inline path only throws on a genuinely unexpected failure in .1's
 * extractors, which are themselves documented to not throw for malformed
 * input.
 */
export async function computeFoldModel(text: string, format: FoldFormat): Promise<FoldModel> {
  const cacheKey = `${format}\x1f${text.length}\x1f${text}`;
  const cached = foldCache.get(cacheKey);
  if (cached) return cached;

  const w = await ensureWorker();
  const fromWorker = w ? await computeViaWorker(w, text, format) : null;
  const out = fromWorker ?? computeFoldModelSync(text, format);

  // Re-insert at the end for insertion-order eviction of the oldest entry.
  foldCache.delete(cacheKey);
  foldCache.set(cacheKey, out);
  while (foldCache.size > MAX_FOLD_CACHE_ENTRIES) {
    const oldest = foldCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    foldCache.delete(oldest);
  }
  return out;
}

/** Test-only reset of the fold model cache. */
export function __resetFoldClientForTest(): void {
  foldCache.clear();
}

/**
 * Test-only: overrides how `ensureWorker` obtains a `Worker` instance, and
 * un-latches `workerDisabled` for the duration of the override so a test can
 * drive the worker branch deterministically without ever letting vitest
 * evaluate the `./foldWorker?worker` virtual module. Pass `null` to restore
 * the default (test-latched, no worker) state. Always drops any cached
 * worker/pending callbacks so the next `computeFoldModel` call re-attempts
 * construction cleanly via the new factory (or the production dynamic-import
 * path once cleared).
 */
export function __setWorkerFactoryForTest(factory: (() => Worker) | null): void {
  workerFactoryOverride = factory;
  workerDisabled = factory ? false : import.meta.env?.MODE === 'test';
  worker = null;
  pending.clear();
}
