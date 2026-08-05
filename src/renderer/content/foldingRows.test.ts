import { describe, expect, it } from 'vitest';
import { lineStartOffsets } from './folding/foldModel';
import type { FoldDocument, FoldRegion } from './folding/foldModel';
import { yamlFoldModel } from './folding/yamlFold';
import {
  groupRowsByDocument,
  lastTouchedLine,
  visibleFoldRows,
  type DocumentRowGroup,
  type FoldedRow,
  type FoldRow,
} from './foldingRows';

/** Strip a row down to its `{kind, line}` shape for compact list assertions;
 *  tests that care about `region`/`prefixEnd`/`suffixStart` assert those
 *  fields separately. */
function shape(rows: FoldRow[]): Array<{ kind: FoldRow['kind']; line: number }> {
  return rows.map((r) => ({ kind: r.kind, line: r.line }));
}

describe('visibleFoldRows', () => {
  it('no regions: every line renders as an ordinary line row', () => {
    const starts = lineStartOffsets(['a', 'b', 'c'].join('\n'));
    const rows = visibleFoldRows(starts, [], new Set());
    expect(shape(rows)).toEqual([
      { kind: 'line', line: 0 },
      { kind: 'line', line: 1 },
      { kind: 'line', line: 2 },
    ]);
  });

  describe('one region', () => {
    // Line 0: '{'
    // Line 1: '  "a": {'      <- region opens ('{' is the last char)
    // Line 2: '    "b": 1'
    // Line 3: '  },'          <- region closes ('}'), trailing ',' after it
    // Line 4: '}'
    const lines = ['{', '  "a": {', '    "b": 1', '  },', '}'];
    const text = lines.join('\n');
    const starts = lineStartOffsets(text);
    const openOffset = text.indexOf('{', starts[1]);
    const closeOffset = text.indexOf('}', starts[3]);
    const region: FoldRegion = {
      kind: 'object',
      start: openOffset,
      end: closeOffset + 1,
      headerEnd: openOffset + 1,
      itemCount: 1,
      depth: 1,
    };

    it('expanded: renders exactly like no regions at all', () => {
      const rows = visibleFoldRows(starts, [region], new Set());
      expect(shape(rows)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'line', line: 1 },
        { kind: 'line', line: 2 },
        { kind: 'line', line: 3 },
        { kind: 'line', line: 4 },
      ]);
    });

    it('collapsed: hides (headerLine, endLine] and folds the header line into one placeholder row', () => {
      const rows = visibleFoldRows(starts, [region], new Set([region.start]));
      expect(shape(rows)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'folded', line: 1 },
        { kind: 'line', line: 4 },
      ]);
      const folded = rows[1] as FoldedRow;
      expect(folded.region).toBe(region);
      expect(folded.prefixEnd).toBe(region.headerEnd);
      expect(folded.suffixStart).toBe(region.end);
    });

    it('trailing-source-on-close-line suffix: the text after the closing delimiter is addressable via suffixStart, never swallowed', () => {
      const rows = visibleFoldRows(starts, [region], new Set([region.start]));
      const folded = rows.find((r) => r.kind === 'folded') as FoldedRow;
      // Line 3 ends right before line 4's start; the char at suffixStart is
      // the ',' immediately after the region's closing '}'.
      const line3End = starts[4] - 1;
      expect(text.slice(folded.suffixStart, line3End)).toBe(',');
      // And the prefix is exactly the source from the header line's start
      // through headerEnd (the opening '{' inclusive).
      expect(text.slice(starts[1], folded.prefixEnd)).toBe('  "a": {');
    });
  });

  describe('nested regions', () => {
    // Line 0: '{'
    // Line 1: '  "a": {'      <- outer opens
    // Line 2: '    "b": {'    <- inner opens
    // Line 3: '      "c": 1'
    // Line 4: '    },'        <- inner closes
    // Line 5: '  },'          <- outer closes
    // Line 6: '}'
    const lines = ['{', '  "a": {', '    "b": {', '      "c": 1', '    },', '  },', '}'];
    const text = lines.join('\n');
    const starts = lineStartOffsets(text);
    const outerOpen = text.indexOf('{', starts[1]);
    const innerOpen = text.indexOf('{', starts[2]);
    const innerClose = text.indexOf('}', starts[4]);
    const outerClose = text.indexOf('}', starts[5]);
    const outer: FoldRegion = {
      kind: 'object',
      start: outerOpen,
      end: outerClose + 1,
      headerEnd: outerOpen + 1,
      itemCount: 1,
      depth: 1,
    };
    const inner: FoldRegion = {
      kind: 'object',
      start: innerOpen,
      end: innerClose + 1,
      headerEnd: innerOpen + 1,
      itemCount: 1,
      depth: 2,
    };

    it('only the outer collapsed: the inner region produces no row of its own', () => {
      const rows = visibleFoldRows(starts, [outer, inner], new Set([outer.start]));
      expect(shape(rows)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'folded', line: 1 },
        { kind: 'line', line: 6 },
      ]);
    });

    it('both collapsed: the inner still produces no row (collapsed outer hiding collapsed inner) — no duplicate row at the inner header line', () => {
      const rows = visibleFoldRows(starts, [outer, inner], new Set([outer.start, inner.start]));
      expect(shape(rows)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'folded', line: 1 },
        { kind: 'line', line: 6 },
      ]);
      expect(rows.filter((r) => r.kind === 'folded')).toHaveLength(1);
    });

    it('only the inner collapsed (outer expanded): the inner folds independently, the outer stays a plain line', () => {
      const rows = visibleFoldRows(starts, [outer, inner], new Set([inner.start]));
      expect(shape(rows)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'line', line: 1 },
        { kind: 'folded', line: 2 },
        { kind: 'line', line: 5 },
        { kind: 'line', line: 6 },
      ]);
    });

    it("collapsing the outer and re-expanding it preserves the inner's own collapsed-state membership (caller-owned set, untouched by this function)", () => {
      // Step 1: both collapsed.
      const bothCollapsed = new Set([outer.start, inner.start]);
      const rows1 = visibleFoldRows(starts, [outer, inner], bothCollapsed);
      expect(rows1.filter((r) => r.kind === 'folded')).toHaveLength(1); // inner absorbed

      // Step 2: simulate "the user reopened only the outer" — the caller
      // removes outer.start from its OWN set; inner.start is untouched by
      // this function the whole time, so it is still present.
      const outerReopened = new Set([inner.start]);
      const rows2 = visibleFoldRows(starts, [outer, inner], outerReopened);
      expect(shape(rows2)).toEqual([
        { kind: 'line', line: 0 },
        { kind: 'line', line: 1 },
        { kind: 'folded', line: 2 },
        { kind: 'line', line: 5 },
        { kind: 'line', line: 6 },
      ]);
    });
  });

  it('a region ending at EOF with no trailing newline hides through the last line with no out-of-bounds row', () => {
    const text = ['{', '  "a": 1', '}'].join('\n'); // no trailing '\n'
    const starts = lineStartOffsets(text);
    expect(starts).toHaveLength(3);
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    const region: FoldRegion = {
      kind: 'object',
      start: open,
      end: close + 1,
      headerEnd: open + 1,
      itemCount: 1,
      depth: 0,
    };
    expect(region.end).toBe(text.length);

    const rows = visibleFoldRows(starts, [region], new Set([region.start]));
    expect(rows).toEqual([
      { kind: 'folded', line: 0, region, prefixEnd: region.headerEnd, suffixStart: region.end },
    ]);
  });

  it('a degenerate, non-nested overlapping region pair does not produce duplicated or out-of-order rows, and folds the union of both spans', () => {
    // Six synthetic, evenly-spaced line starts (content is irrelevant for a
    // purely offset-driven test): P spans lines 0-3, Q spans lines 2-5 — Q's
    // header falls INSIDE P's span, but Q's end falls AFTER P's end, so this
    // is a genuine partial overlap, not clean nesting (which a real parser
    // should never emit, but a partial/recovered model might).
    const starts = [0, 10, 20, 30, 40, 50];
    const p: FoldRegion = {
      kind: 'object',
      start: 0,
      end: 35,
      headerEnd: 1,
      itemCount: 1,
      depth: 0,
    };
    const q: FoldRegion = {
      kind: 'object',
      start: 22,
      end: 55,
      headerEnd: 23,
      itemCount: 1,
      depth: 0,
    };

    const rows = visibleFoldRows(starts, [p, q], new Set([p.start, q.start]));

    const lineNumbers = rows.map((r) => r.line);
    for (let i = 1; i < lineNumbers.length; i++) {
      expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]);
    }
    expect(new Set(lineNumbers).size).toBe(lineNumbers.length); // no duplicates
    expect(rows.filter((r) => r.kind === 'folded')).toHaveLength(1); // Q absorbed by P
    // The union of both spans (lines 1-5) is fully hidden -- no stray
    // visible line left in the gap between P's own end and Q's.
    expect(shape(rows)).toEqual([{ kind: 'folded', line: 0 }]);
  });

  it('is robust to caller-supplied region order (re-sorts internally): scrambled input produces the same output as sorted input', () => {
    const lines = ['{', '  "a": {', '    "b": {', '      "c": 1', '    },', '  },', '}'];
    const text = lines.join('\n');
    const starts = lineStartOffsets(text);
    const outerOpen = text.indexOf('{', starts[1]);
    const innerOpen = text.indexOf('{', starts[2]);
    const innerClose = text.indexOf('}', starts[4]);
    const outerClose = text.indexOf('}', starts[5]);
    const outer: FoldRegion = {
      kind: 'object',
      start: outerOpen,
      end: outerClose + 1,
      headerEnd: outerOpen + 1,
      itemCount: 1,
      depth: 1,
    };
    const inner: FoldRegion = {
      kind: 'object',
      start: innerOpen,
      end: innerClose + 1,
      headerEnd: innerOpen + 1,
      itemCount: 1,
      depth: 2,
    };

    const collapsed = new Set([outer.start]);
    const sortedOrder = visibleFoldRows(starts, [outer, inner], collapsed);
    const scrambledOrder = visibleFoldRows(starts, [inner, outer], collapsed);
    expect(scrambledOrder).toEqual(sortedOrder);
  });

  it('an empty file (single empty line, no regions) renders one plain line row', () => {
    const starts = lineStartOffsets('');
    expect(starts).toEqual([0]);
    const rows = visibleFoldRows(starts, [], new Set());
    expect(rows).toEqual([{ kind: 'line', line: 0 }]);
  });
});

// local_repo_explorer-jp2f.6: real YAML models (unlike .5's JSON-only
// coverage) exercise a `FoldRegion.headerEnd`/`.end` shape that JSON never
// produces — one landing EXACTLY on a subsequent line's start offset (see
// `lastTouchedLine`'s doc comment in foldingRows.ts). This surfaced two
// real, previously-unexercised defects in `visibleFoldRows` itself, fixed by
// this leaf: over-hiding a line that a collapsed region never actually
// touched, and mis-anchoring a block scalar's folded row one line below its
// `|`/`>` indicator. Both are regression-pinned here against the REAL
// `yamlFoldModel` output (not hand-built FoldRegion literals) so a future
// change to either the extractor's offset conventions or this function
// re-exercises the exact shape that exposed the bug.
describe('visibleFoldRows against real YAML regions (offset shapes JSON never produces)', () => {
  it('a document-ending collapsed region does not swallow a FOLLOWING document’s own boundary line', () => {
    // Document 1's only region ("b: {c: 2, d: 3}") ends exactly where
    // Document 2 begins (`region.end === ` the offset of the second `---`)
    // — confirmed via yamlFold.test.ts's own "renders ALL documents..."
    // case, which asserts every document's range butts up against the
    // next's with no gap. Collapsing it must NOT remove document 2's `---`
    // line from `rows`.
    const text = 'a: 1\n---\nb:\n  c: 2\n  d: 3\n---\ne: 3\n';
    const model = yamlFoldModel(text);
    const starts = lineStartOffsets(text);
    const region = model.regions.find((r) => r.kind === 'map' && r.depth === 1)!;
    expect(text.slice(region.start, region.end)).toBe('c: 2\n  d: 3\n');
    // The region's end really does land exactly on line 5's ('---') own
    // start offset — the precondition this test exists to exercise.
    expect(region.end).toBe(starts[5]);

    const rows = visibleFoldRows(starts, model.regions, new Set([region.start]));

    // Line 5 ('---', document 2's own marker) is still present as an
    // ordinary visible row — not folded away, not silently dropped.
    expect(rows.some((r) => r.line === 5)).toBe(true);
    const line5 = rows.find((r) => r.line === 5)!;
    expect(line5.kind).toBe('line');

    // And it's genuinely readable as a live source line (line 6, the '---'
    // marker on the SAME offset the model itself reports as document 2's
    // start) — not absorbed into the folded row's suffix.
    const folded = rows.find((r) => r.kind === 'folded') as FoldedRow;
    expect(text.slice(folded.suffixStart, starts[folded.line + 2] - 1)).toBe(''); // nothing trails on the header's own closing line
  });

  it('a block scalar’s folded row anchors on the |/> indicator line, not one line below it', () => {
    const text = 'lit: |\n  line one\n  line two\n';
    const model = yamlFoldModel(text);
    const starts = lineStartOffsets(text);
    const region = model.regions.find((r) => r.kind === 'block-scalar')!;
    // The precondition: headerEnd really does land exactly on line 1's own
    // start offset (right after the indicator line's trailing '\n').
    expect(region.headerEnd).toBe(starts[1]);

    const rows = visibleFoldRows(starts, model.regions, new Set([region.start]));
    const folded = rows.find((r) => r.kind === 'folded' && r.region.kind === 'block-scalar');
    expect(folded?.line).toBe(0); // anchored on 'lit: |', not '  line one'
  });

  it('lastTouchedLine: exclusive end landing exactly on a line start resolves to the PRECEDING line', () => {
    const starts = lineStartOffsets('aaa\nbbb\nccc\n'); // starts = [0, 4, 8, 12]
    // 8 is exactly line 2's ('ccc') own start offset.
    expect(lastTouchedLine(starts, 8, 0)).toBe(1); // 'bbb', not 'ccc'
    // A mid-line offset behaves exactly like offsetToLine (no boundary to
    // disambiguate).
    expect(lastTouchedLine(starts, 5, 0)).toBe(1); // 'bbb'
    // Clamped: never resolves before the line containing minOffset, even
    // for a zero-length/degenerate span.
    expect(lastTouchedLine(starts, 4, 4)).toBe(1); // 'bbb', not 'aaa'
  });
});

describe('groupRowsByDocument', () => {
  function docShape(groups: DocumentRowGroup[]): Array<{ index: number; lines: number[] }> {
    return groups.map((g) => ({
      index: g.document.index,
      lines: g.rows.map((r) => r.line),
    }));
  }

  it('a single document: one group containing every row, in order', () => {
    const text = ['a: 1', 'b: 2', 'c: 3'].join('\n'); // no trailing newline
    const starts = lineStartOffsets(text);
    const documents: FoldDocument[] = [{ start: 0, end: text.length, index: 0 }];
    const rows = visibleFoldRows(starts, [], new Set());

    const groups = groupRowsByDocument(rows, documents, starts);
    expect(groups).toHaveLength(1);
    expect(docShape(groups)).toEqual([{ index: 0, lines: [0, 1, 2] }]);
  });

  it('three documents: every row attributed to exactly the document whose offset range contains it, in source order', () => {
    const text = 'a: 1\n---\nb:\n  c: 2\n  d: 3\n---\ne: |\n  x\n  y\n';
    const model = yamlFoldModel(text);
    const starts = lineStartOffsets(text);
    expect(model.documents).toHaveLength(3);

    const rows = visibleFoldRows(starts, model.regions, new Set()); // everything expanded
    const groups = groupRowsByDocument(rows, model.documents, starts);

    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.document.index)).toEqual([0, 1, 2]);
    // Every row appears in EXACTLY one group (no duplication, no loss).
    const allGroupedLines = groups.flatMap((g) => g.rows.map((r) => r.line));
    expect(allGroupedLines).toEqual(rows.map((r) => r.line)); // same rows, same order, flattened
    expect(new Set(allGroupedLines).size).toBe(allGroupedLines.length);

    // Document 0 is just 'a: 1' (line 0). Document 1 starts at its own
    // '---' (line 1) through 'd: 3' (line 4). Document 2 starts at its own
    // '---' (line 5) through the block scalar's lines.
    expect(docShape(groups)[0]).toEqual({ index: 0, lines: [0] });
    expect(docShape(groups)[1].lines[0]).toBe(1); // doc 1's OWN '---' line
    expect(docShape(groups)[2].lines[0]).toBe(5); // doc 2's OWN '---' line
  });

  it('a fold region spanning to a document boundary: the folded row groups with the document it belongs to, and the next document’s own boundary row groups separately', () => {
    const text = 'a: 1\n---\nb:\n  c: 2\n  d: 3\n---\ne: 3\n';
    const model = yamlFoldModel(text);
    const starts = lineStartOffsets(text);
    const region = model.regions.find((r) => r.kind === 'map' && r.depth === 1)!;
    // Same document-boundary-touching region as the dedicated
    // `visibleFoldRows` regression test above.
    expect(region.end).toBe(model.documents[2].start);

    const rows = visibleFoldRows(starts, model.regions, new Set([region.start]));
    const groups = groupRowsByDocument(rows, model.documents, starts);

    expect(groups).toHaveLength(3);
    // The folded placeholder (anchored on document 1's header line) groups
    // into document 1, NOT document 2 — even though the region's raw `end`
    // offset touches document 2's own start.
    const doc1 = groups.find((g) => g.document.index === 1)!;
    expect(doc1.rows.some((r) => r.kind === 'folded')).toBe(true);
    // doc1's own '---' line, its 'b:' line, then the folded region
    // (absorbing '  c: 2'/'  d: 3') — three rows, none swallowed forward.
    expect(doc1.rows.map((r) => r.kind)).toEqual(['line', 'line', 'folded']);
    expect(doc1.rows.map((r) => r.line)).toEqual([1, 2, 3]);
    // Document 2's own '---' row is present (line 5), and lives in document
    // 2's group, not swallowed into document 1's.
    const doc2 = groups.find((g) => g.document.index === 2)!;
    expect(doc2.rows[0]).toEqual({ kind: 'line', line: 5 });
    expect(doc2.rows.every((r) => r.line >= 5)).toBe(true); // nothing from doc1 leaked in
  });

  it('a document with no foldable regions groups all of its ordinary line rows correctly', () => {
    // Document 0 is a bare scalar (no YAMLMap/YAMLSeq node at all, so it
    // produces NO FoldRegion — a block MAP's region would still extend
    // through its own trailing newline and satisfy the multi-line check
    // even for a single key, per the same YAML end-offset convention
    // `lastTouchedLine` exists for above), sitting next to a document that
    // DOES have a foldable region, so this isn't trivially true just
    // because nothing anywhere had a region.
    const text = '42\n---\nb:\n  c: 2\n  d: 3';
    const model = yamlFoldModel(text);
    const starts = lineStartOffsets(text);
    expect(model.documents).toHaveLength(2);
    const doc0Regions = model.regions.filter(
      (r) => r.start >= model.documents[0].start && r.start < model.documents[0].end,
    );
    expect(doc0Regions).toEqual([]);
    const doc1Regions = model.regions.filter(
      (r) => r.start >= model.documents[1].start && r.start < model.documents[1].end,
    );
    expect(doc1Regions.length).toBeGreaterThan(0);

    const rows = visibleFoldRows(starts, model.regions, new Set()); // everything expanded
    const groups = groupRowsByDocument(rows, model.documents, starts);

    expect(groups).toHaveLength(2);
    // Document 0: just its one line, correctly its own group.
    expect(docShape(groups)[0]).toEqual({ index: 0, lines: [0] });
    // Document 1: every remaining line, none dropped or misattributed.
    expect(docShape(groups)[1]).toEqual({ index: 1, lines: [1, 2, 3, 4] });
  });

  it('zero documents (empty file): returns no groups rather than throwing', () => {
    const rows = visibleFoldRows([0], [], new Set());
    expect(groupRowsByDocument(rows, [], [0])).toEqual([]);
  });

  it('preserves each group’s row order and object identity (no rebuilding of FoldRow objects)', () => {
    const starts = lineStartOffsets('a: 1\n---\nb: 2\n');
    const documents: FoldDocument[] = [
      { start: 0, end: 5, index: 0 },
      { start: 5, end: 14, index: 1 },
    ];
    const rows: FoldRow[] = visibleFoldRows(starts, [], new Set());
    const groups = groupRowsByDocument(rows, documents, starts);
    // Same row objects, not copies.
    expect(groups[0].rows[0]).toBe(rows[0]);
  });
});
