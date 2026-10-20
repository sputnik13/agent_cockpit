/**
 * Memory budget for the CSV/TSV table view — the single definition of "how big
 * a file may we parse into a sortable/filterable table".
 *
 * Parsing a delimited file into per-cell JS strings costs several times the
 * file's byte size (string headers, 2-byte chars, array slots), so the cap is
 * derived from the renderer's REAL remaining V8 heap rather than a fixed MB:
 *
 *   cap = clamp( heapHeadroom * HEAP_FRACTION / EXPANSION, FLOOR, CEILING )
 *
 * A memory-pressured renderer therefore accepts less; a roomy one is still
 * bounded by CEILING so sort/filter latency stays interactive. FLOOR keeps
 * ordinary small files working even under pressure. Where heap stats are
 * unavailable (non-Chromium / tests) a conservative FALLBACK applies.
 *
 * The cap is evaluated ONCE per opened file (not live), so the read cap that
 * depends on it is stable for that file's lifetime.
 */
export interface HeapStats {
  /** V8 heap size limit, bytes. */
  limit: number;
  /** Currently used JS heap, bytes. */
  used: number;
}

const MiB = 1024 * 1024;
/** Hard ceiling regardless of free memory — keeps sort/filter interactive. */
export const TABULAR_CEILING_BYTES = 32 * MiB;
/** Always allow at least this much, even under heap pressure. */
export const TABULAR_FLOOR_BYTES = 1 * MiB;
/** Used when heap stats are unavailable. */
export const TABULAR_FALLBACK_BYTES = 8 * MiB;
/** Share of the remaining heap this view may claim. */
const HEAP_FRACTION = 0.25;
/** Conservative bytes-of-heap per byte-of-file once parsed into cell strings. */
const EXPANSION = 8;

/** Max file size (bytes) the table view will load, for the given heap state. */
export function tabularMaxBytes(heap: HeapStats | null): number {
  if (heap === null) return TABULAR_FALLBACK_BYTES;
  const headroom = Math.max(0, heap.limit - heap.used);
  const raw = Math.floor((headroom * HEAP_FRACTION) / EXPANSION);
  return Math.min(TABULAR_CEILING_BYTES, Math.max(TABULAR_FLOOR_BYTES, raw));
}

/** Reads Chromium's non-standard `performance.memory`; `null` when absent. */
export function readHeapStats(): HeapStats | null {
  const mem = (
    globalThis.performance as unknown as {
      memory?: { jsHeapSizeLimit?: number; usedJSHeapSize?: number };
    }
  ).memory;
  if (!mem || typeof mem.jsHeapSizeLimit !== 'number' || typeof mem.usedJSHeapSize !== 'number') {
    return null;
  }
  return { limit: mem.jsHeapSizeLimit, used: mem.usedJSHeapSize };
}
