/**
 * Shared, pure, source-range fold model for structured text formats (JSON,
 * YAML). `jsonFold.ts` and `yamlFold.ts` turn source text into fold regions,
 * document boundaries, and anchor/alias linkage — all expressed as offsets
 * into the ORIGINAL text, never as a re-serialized value graph. A fold is
 * always a literal slice of the source: nothing in this module (or its
 * extractors) ever calls `.toJS()`, `JSON.parse`, `yaml.parse`, or any other
 * resolve-to-value API. See parent issue local_repo_explorer-jp2f decisions
 * #3 (source-mapped folding) and #5 (rejected object-explorer approach).
 *
 * No React, no IPC, no worker: this module and its extractors are pure data
 * + pure functions only. The model MUST stay structured-clone-safe plain
 * data — numbers, strings, booleans, plain objects and arrays only; no class
 * instances, no library node references, no functions, no cycles. This is
 * load-bearing: a later task (.3) sends a `FoldModel` across a Web Worker
 * `postMessage` boundary, and structured clone throws on cycles (YAML alias
 * resolution is exactly how a cycle would appear — the range-only approach
 * here is what avoids ever constructing one; see parent decision #6).
 *
 * Every offset in this module is a UTF-16 code unit index (a plain JS
 * string index) into the exact source string passed to the extractor, NOT a
 * byte offset. Both `jsonc-parser` and `yaml` already produce these.
 */

/** The two structured text formats this module folds. */
export type FoldFormat = 'json' | 'yaml';

/**
 * One collapsible region of source text.
 *
 * `[start, end)` is the full collapsible span: `text.slice(start, end)` is
 * exactly the container's original source. `[headerEnd, end)` is the part a
 * folded view REPLACES with a placeholder, so whatever precedes it —
 * the opening `{`/`[` (JSON, or YAML flow collections), the first item's
 * `-` marker (a YAML block sequence), or the `|`/`>` indicator line (a YAML
 * block scalar) — stays visible when collapsed. A YAML block MAP has no
 * marker character of its own at `start` (its opening "mapping key" line
 * belongs to the parent Pair, already outside `[start, end)`), so its
 * `headerEnd === start`: nothing needs to be carved out of the region
 * itself for the surrounding key line to stay visible.
 *
 * `itemCount` is the direct-child count used for an "N items" placeholder
 * (0 for `block-scalar`, which is a leaf with no children — a future view
 * wanting a line count can derive one from `[headerEnd, end)` via
 * `lineStartOffsets`/`offsetToLine` below). `depth` is 0 at the top level of
 * the region's own document (see `FoldDocument`), incrementing once per
 * container-nesting level below that.
 */
export interface FoldRegion {
  start: number;
  end: number;
  headerEnd: number;
  kind: 'object' | 'array' | 'map' | 'seq' | 'block-scalar';
  itemCount: number;
  depth: number;
}

/**
 * One source document. A JSON file always has exactly one, spanning the
 * whole file. A YAML file has one per `---`-separated document in the
 * stream (parent issue's second comment: multi-document YAML files render
 * ALL documents, not just the first).
 */
export interface FoldDocument {
  start: number;
  end: number;
  index: number;
}

/**
 * Structural linkage between a YAML `&name` anchor definition and every
 * `*name` alias that references it. Scoped to the single document both the
 * definition and its aliases appear in — YAML anchor scope resets per
 * document, so the same name in two different documents produces two
 * independent `AnchorLink` entries (see yamlFold.ts). Always `[]` for JSON
 * (JSON has no anchors).
 */
export interface AnchorLink {
  name: string;
  definition: { start: number; end: number };
  aliases: { start: number; end: number }[];
}

/**
 * The full fold model for one source text. `regions` is sorted by `start`
 * ascending, then `end` descending (outer container before its inner
 * children), so a consumer can walk it in document order while maintaining
 * a simple containment stack.
 */
export interface FoldModel {
  format: FoldFormat;
  documents: FoldDocument[];
  regions: FoldRegion[];
  anchors: AnchorLink[];
  errors: { offset: number; message: string }[];
}

/**
 * Offsets (UTF-16 code units, matching every other offset in this module)
 * of the start of each line in `text`. `starts[0]` is always `0`, and
 * `starts.length` is the number of lines (one more than the number of `\n`
 * characters in `text`). Pair with {@link offsetToLine} to project a
 * fold-model offset onto a 0-based source line without re-splitting the
 * whole file on every lookup.
 */
export function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * The 0-based source line containing `offset`, given the `starts` array
 * from {@link lineStartOffsets}. Agrees with the naive
 * `text.slice(0, offset).split('\n').length - 1` for every offset in
 * `text`, via a binary search (O(log n)) instead of re-scanning the file
 * per lookup.
 */
export function offsetToLine(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
