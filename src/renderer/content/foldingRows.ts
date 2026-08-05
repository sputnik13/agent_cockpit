/**
 * Pure visible-row projection for the folding view (local_repo_explorer-jp2f.5):
 * turns a fold model's `regions` plus a set of user-collapsed region starts
 * into the ordered list of rows FoldingView.tsx actually renders. This module
 * owns ONLY that projection — no React, no DOM, no knowledge of tokens,
 * notes, or gutter markup (see FoldingView.tsx for all of that).
 *
 * Folding never mutates or renumbers source lines (see foldModel.ts's own
 * doc comment: every offset here is a literal position in the original
 * source string) — this function only decides which ORIGINAL 0-based lines
 * are individually visible and which are replaced by a single folded
 * placeholder row. `line` on both row kinds is therefore a 0-based index
 * into `lineStartOffsets`/`content.split('\n')` — the SAME convention
 * `offsetToLine` already uses — never a 1-based display number; callers add
 * 1 when talking to `LineNoteGutter`/`lineNotesByLine` or building an
 * aria-label.
 *
 * Hiding rule (parent issue local_repo_explorer-jp2f.5's Contract): a
 * collapsed region hides every line strictly after the line containing
 * `headerEnd` up to and including the line containing `end`, EXCEPT that the
 * trailing source on the `end` line (after the region's closing delimiter)
 * is re-attached to the folded row as a suffix — see {@link FoldedRow}.
 * A region nested inside a collapsed ancestor produces NO row of its own,
 * but nothing in `collapsed` is read or written by this function, so its own
 * collapsed-state membership is simply preserved by the CALLER for whenever
 * the ancestor reopens.
 */
import { offsetToLine, type FoldDocument, type FoldRegion } from './folding/foldModel';

/** An ordinary, fully-visible original source line. */
export interface LineRow {
  kind: 'line';
  /** 0-based original source line index — see the module doc comment. */
  line: number;
}

/**
 * A single collapsed region's placeholder row, anchored at the region's
 * header line (`line` is 0-based, same convention as {@link LineRow}).
 * `prefixEnd` (always `region.headerEnd`) and `suffixStart` (always
 * `region.end`) are copied onto the row so a renderer never needs to
 * re-derive them from `region` — but `suffixStart` typically falls on a
 * DIFFERENT original line than `line` (the region's closing line, not its
 * header line) whenever the region spans more than two lines, so a renderer
 * slicing the suffix must resolve ITS OWN line end, not `line`'s.
 */
export interface FoldedRow {
  kind: 'folded';
  line: number;
  region: FoldRegion;
  prefixEnd: number;
  suffixStart: number;
}

export type FoldRow = LineRow | FoldedRow;

/**
 * The 0-based line containing the LAST character truly included in an
 * exclusive-end span, i.e. the line containing `exclusiveEnd - 1` — clamped
 * so the result never resolves to before the line containing `minOffset`
 * (guards a zero-length/degenerate span, where `exclusiveEnd <= minOffset`).
 *
 * NOT the same as `offsetToLine(starts, exclusiveEnd)` whenever
 * `exclusiveEnd` lands EXACTLY on a line-start offset (`starts[k]` for some
 * k). For a JSON region this never happens — `jsonc-parser`'s offsets
 * always point at a delimiter character strictly inside its own line — so
 * `visibleFoldRows` shipped in local_repo_explorer-jp2f.5 (JSON-only) never
 * exercised the distinction. A YAML region routinely lands exactly there:
 * the `yaml` package's own node ranges for a block collection or block
 * scalar commonly extend THROUGH that line's trailing `\n` (see
 * yamlFold.test.ts — a block region's `end` includes it, e.g.
 * `'b: 1\n  c: 2\n'`; a block scalar's `headerEnd` likewise, e.g. `'|\n'`).
 * Resolving such an offset with `offsetToLine` directly lands ONE LINE TOO
 * FAR — the line the region's content does not touch at all. Found and
 * fixed by local_repo_explorer-jp2f.6 (the first leaf to run real YAML
 * models through this function), empirically confirmed via the real
 * `yamlFoldModel` output before this fix:
 *  - `region.end` landing on a following DOCUMENT's own boundary over-hid
 *    that document's `---` marker line entirely (it never appeared in
 *    `rows` at all — fatal for this leaf's multi-document requirement that
 *    marker lines always stay rendered on their own line number).
 *  - a block scalar's `region.headerEnd` mis-anchored its folded row one
 *    line below the `|`/`>` indicator line, leaving the indicator line as an
 *    ordinary row with no chevron and the folded row's prefix empty.
 * `exclusiveEnd - 1` is always the correct, unambiguous answer: the actual
 * last character position the span includes. Verified to change nothing for
 * any JSON offset shape (every existing case in this file's tests resolves
 * identically with or without the `-1`, since a JSON region's `headerEnd`/
 * `end` is never exactly a line-start).
 */
export function lastTouchedLine(starts: number[], exclusiveEnd: number, minOffset: number): number {
  return offsetToLine(starts, Math.max(minOffset, exclusiveEnd - 1));
}

/**
 * Projects `regions` (collapsed per `collapsed`, a set of region `start`
 * offsets) onto the ordered list of visible rows for a file whose line
 * starts are `lineStartOffsets`. Pure and synchronous; output is always in
 * ascending line order by construction (the final pass below walks lines
 * 0..N, never region order), so a caller's `regions` order can never surface
 * as an out-of-order row.
 *
 * Defensive against a malformed/partial model: `regions` is re-sorted
 * locally (start ascending, then end descending — outer before inner, the
 * same order foldModel.ts documents its own output in) rather than trusting
 * the caller's order. A region whose header line falls at or before the
 * furthest line already hidden by a preceding collapsed region is treated as
 * contained by it (no row of its own) even when the two are not cleanly
 * nested (a genuine partial-overlap, not proper containment) — and if THAT
 * region is itself collapsed, its own hidden span is still folded into the
 * running hidden set, so a non-nested overlap can never leave a gap of
 * stray visible lines in the middle of what the user just collapsed. This is
 * what keeps a degenerate/overlapping pair from producing duplicated or
 * out-of-order rows.
 */
export function visibleFoldRows(
  // Plain (not `readonly`) to match foldModel.ts's own `offsetToLine`
  // signature, which this function calls directly — foldModel.ts is a
  // read-only dependency of this leaf (see local_repo_explorer-jp2f.1).
  lineStartOffsets: number[],
  regions: readonly FoldRegion[],
  collapsed: ReadonlySet<number>,
): FoldRow[] {
  const totalLines = lineStartOffsets.length;
  const sorted = [...regions].sort((a, b) => a.start - b.start || b.end - a.end);

  const hidden = new Array<boolean>(totalLines).fill(false);
  const foldedAt = new Map<number, FoldedRow>();
  // Furthest line hidden by any collapsed region processed so far (outer
  // regions are processed before their descendants — see the sort above).
  let hiddenUntil = -1;

  for (const region of sorted) {
    const headerLine = lastTouchedLine(lineStartOffsets, region.headerEnd, region.start);
    const endLine = Math.max(
      headerLine,
      lastTouchedLine(lineStartOffsets, region.end, region.headerEnd),
    );
    const isCollapsed = collapsed.has(region.start);

    if (headerLine <= hiddenUntil) {
      // Nested inside (or, for a malformed model, merely overlapping) an
      // already-hidden span: this region gets no row of its own. If it is
      // ALSO collapsed, still fold its span into the hidden set (see the
      // doc comment above) — harmless where it's already covered by a
      // proper ancestor, load-bearing where it merely overlaps one.
      if (isCollapsed) {
        for (let l = headerLine + 1; l <= endLine && l < totalLines; l++) hidden[l] = true;
        hiddenUntil = Math.max(hiddenUntil, endLine);
      }
      continue;
    }

    if (!isCollapsed) continue; // expanded: its header line keeps its ordinary 'line' row.

    foldedAt.set(headerLine, {
      kind: 'folded',
      line: headerLine,
      region,
      prefixEnd: region.headerEnd,
      suffixStart: region.end,
    });
    for (let l = headerLine + 1; l <= endLine && l < totalLines; l++) hidden[l] = true;
    hiddenUntil = Math.max(hiddenUntil, endLine);
  }

  const rows: FoldRow[] = [];
  for (let line = 0; line < totalLines; line++) {
    const folded = foldedAt.get(line);
    if (folded) {
      rows.push(folded);
      continue;
    }
    if (!hidden[line]) rows.push({ kind: 'line', line });
  }
  return rows;
}

/**
 * One source document's slice of an already-projected `rows` list: every
 * row whose line falls within `document`'s `[start, end)` offset span, in
 * the same ascending-line order `rows` already had them.
 * local_repo_explorer-jp2f.6 (parent issue's second comment: render ALL
 * documents of a multi-document YAML stream, stacked, each in its own
 * labelled region) — see {@link groupRowsByDocument}.
 */
export interface DocumentRowGroup {
  document: FoldDocument;
  rows: FoldRow[];
}

/**
 * Buckets an already-projected `rows` list (as returned by
 * {@link visibleFoldRows}) into per-document groups, so FoldingView.tsx can
 * render each document in its own labelled region with a separator between
 * consecutive ones. Deliberately a SEPARATE function rather than a change
 * to `visibleFoldRows`'s own return shape: this reuses `visibleFoldRows`'s
 * projection completely UNCHANGED and adds a grouping pass on top of its
 * output, rather than forking a second, parallel projection implementation
 * ("extend, do not fork" — the issue's Guardrails). It also means
 * `visibleFoldRows`'s existing tests — several of which pin an EXACT
 * `toEqual` shape for a `FoldRow`/`FoldedRow` object — stay valid with zero
 * changes; adding a field to `FoldRow` itself would have broken every one
 * of them.
 *
 * `documents` MUST already be sorted and contiguous (`documents[i].start
 * === documents[i-1].end`, `documents[0].start === 0`,
 * `documents[last].end === ` the source length) — exactly what
 * `jsonFold.ts`/`yamlFold.ts` guarantee (see `FoldDocument`'s doc comment on
 * foldModel.ts, and yamlFold.test.ts's "renders ALL documents..." case,
 * which asserts this same contiguity). A single fold region can never
 * straddle two documents — `yamlFold.ts` walks each `yaml` `Document` AST
 * independently, so every region's `[start, end)` is entirely contained in
 * exactly one document's span — meaning a collapsed region's folded
 * placeholder row is always unambiguously owned by exactly one document,
 * including one anchored on a header line immediately before/after a
 * document boundary, and a document with zero regions of its own (every
 * row an ordinary `line` row) groups with no special-casing at all.
 *
 * Pure and synchronous; never throws, never drops a row. A two-pointer walk
 * over `rows` (already ascending-line-ordered — see `visibleFoldRows`'s own
 * doc comment) and `documents` (ascending-offset-ordered) — O(rows +
 * documents), no per-row search. Robust to a malformed/non-contiguous
 * `documents` list too: a row whose offset lands past every remaining
 * document boundary is attributed to the LAST document rather than thrown
 * away or crashing.
 */
export function groupRowsByDocument(
  rows: readonly FoldRow[],
  documents: readonly FoldDocument[],
  // Plain (not `readonly`) to match `visibleFoldRows`'s own parameter type,
  // and `foldModel.ts`'s `offsetToLine`, which this module already depends on.
  starts: number[],
): DocumentRowGroup[] {
  if (documents.length === 0) return [];
  const groups: DocumentRowGroup[] = documents.map((document) => ({ document, rows: [] }));

  let docIdx = 0;
  for (const row of rows) {
    const offset = starts[row.line] ?? 0;
    while (docIdx < documents.length - 1 && offset >= documents[docIdx].end) docIdx++;
    groups[docIdx].rows.push(row);
  }
  return groups;
}
