import { describe, expect, it } from 'vitest';
import {
  blockquoteChildKeyOf,
  classifyItems,
  classifyUnits,
  extractBlockquoteChildren,
  extractListItems,
  extractProseUnits,
  extractTableRows,
  pairListItems,
  pairUnits,
  proseKeyOf,
  resolveGhostAnchors,
  resolveGhostAnchorsForUnits,
  tableRowKeyOf,
  type MdListItem,
  type MdTableRow,
} from './markdownItemDiff';

function textsOf(items: MdListItem[]): string[] {
  return items.map((i) => i.text);
}

function cellsOf(rows: MdTableRow[]): string[][] {
  return rows.map((r) => r.cells);
}

describe('extractListItems', () => {
  it('extracts an unordered list', () => {
    const items = extractListItems('- one\n- two\n- three\n');
    expect(textsOf(items)).toEqual(['one', 'two', 'three']);
    expect(items.every((i) => i.depth === 0)).toBe(true);
    expect(items.map((i) => i.startLine)).toEqual([1, 2, 3]);
    expect(items.every((i) => i.listStartLine === 1)).toBe(true);
  });

  it('extracts an ordered list identically to an unordered one (no branching on list type)', () => {
    const items = extractListItems('1. one\n2. two\n');
    expect(textsOf(items)).toEqual(['one', 'two']);
    expect(items.map((i) => i.startLine)).toEqual([1, 2]);
    expect(items.every((i) => i.depth === 0)).toBe(true);
  });

  it("excludes a nested sub-list from its parent item's text, line range, and list identity", () => {
    const items = extractListItems('- parent\n  - child one\n  - child two\n- second\n');
    expect(items).toHaveLength(4);
    const [parent, child1, child2, second] = items;

    // Parent's own text/end line never include the nested children.
    expect(parent.text).toBe('parent');
    expect(parent.startLine).toBe(1);
    expect(parent.endLine).toBe(1);
    expect(parent.depth).toBe(0);
    expect(parent.listStartLine).toBe(1);

    // Nested items are independent entries, one depth deeper, in their OWN
    // list (a different listStartLine than the parent's).
    expect(child1.text).toBe('child one');
    expect(child1.startLine).toBe(2);
    expect(child1.depth).toBe(1);
    expect(child2.text).toBe('child two');
    expect(child2.startLine).toBe(3);
    expect(child2.depth).toBe(1);
    expect(child1.listStartLine).toBe(child2.listStartLine);
    expect(child1.listStartLine).not.toBe(parent.listStartLine);

    // Back at the top-level list: unaffected by the nested list in between.
    expect(second.text).toBe('second');
    expect(second.startLine).toBe(4);
    expect(second.depth).toBe(0);
    expect(second.listStartLine).toBe(parent.listStartLine);
  });

  it('extracts GFM task-list items with the checkbox marker excluded from text', () => {
    const items = extractListItems('- [ ] todo\n- [x] done\n');
    expect(textsOf(items)).toEqual(['todo', 'done']);
  });

  it("captures a multi-line item's full text and end line", () => {
    const items = extractListItems('- first line\n  second line\n- next item\n');
    expect(items).toHaveLength(2);
    expect(items[0].text).toBe('first line second line');
    expect(items[0].startLine).toBe(1);
    expect(items[0].endLine).toBe(2);
    expect(items[1].text).toBe('next item');
    expect(items[1].startLine).toBe(3);
  });

  it('returns an empty array for a document with no lists', () => {
    expect(extractListItems('# Just a heading\n\nA paragraph.\n')).toEqual([]);
  });
});

describe('pairListItems', () => {
  it('pure insert: a new item with no old counterpart is unmatched', () => {
    const oldItems = extractListItems('- A\n- B\n');
    const newItems = extractListItems('- A\n- X\n- B\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);
    const byText = (t: string) => newItems[textsOf(newItems).indexOf(t)];

    expect(matches[newItems.indexOf(byText('A'))]?.text).toBe('A');
    expect(matches[newItems.indexOf(byText('X'))]).toBeNull();
    expect(matches[newItems.indexOf(byText('B'))]?.text).toBe('B');
    expect(unmatchedOld.size).toBe(0);
  });

  it('pure delete: an old item with no new counterpart ends up unmatchedOld', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- A\n- C\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);

    expect(matches.every((m) => m !== null)).toBe(true);
    expect([...unmatchedOld].map((i) => i.text)).toEqual(['B']);
  });

  it('edit-in-place: a changed item still pairs with its old counterpart (not treated as delete+insert)', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- A\n- B revised\n- C\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);

    const revisedIdx = textsOf(newItems).indexOf('B revised');
    expect(matches[revisedIdx]?.text).toBe('B');
    // B was consumed by the edit pairing, not left as a deletion.
    expect(unmatchedOld.size).toBe(0);
  });

  it('reorder: LCS anchors the longest stable run; the displaced item pairs as delete+insert, not a move', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- C\n- A\n- B\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);

    // "A, B" is the longest common subsequence (length 2) vs "C" alone
    // (length 1), so A and B anchor the alignment and C is left as an
    // unmatched new item, with old-C left as an unmatched old item — a
    // deterministic, well-defined (if not move-aware) result.
    expect(matches[textsOf(newItems).indexOf('A')]?.text).toBe('A');
    expect(matches[textsOf(newItems).indexOf('B')]?.text).toBe('B');
    expect(matches[textsOf(newItems).indexOf('C')]).toBeNull();
    expect([...unmatchedOld].map((i) => i.text)).toEqual(['C']);
  });

  it('duplicate identical items: aligns positionally, leaving only the true surplus unmatched', () => {
    const oldItems = extractListItems('- X\n- X\n');
    const newItems = extractListItems('- X\n- X\n- X\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);

    expect(matches).toHaveLength(3);
    expect(matches[0]).not.toBeNull();
    expect(matches[1]).not.toBeNull();
    expect(matches[2]).toBeNull(); // the third, surplus X has no old counterpart
    expect(unmatchedOld.size).toBe(0); // both old X's were consumed
  });

  it('does not pair items across unrelated lists even when doing so would extend the match', () => {
    // Two separate top-level lists (split by the intervening paragraph).
    // "X" moves from the first list to the second between old and new;
    // its text is unchanged, so an UNSCOPED whole-document LCS could pair
    // old-X (first list) with new-X (second list) — pairing is required to
    // stay anchored within each list, so it must NOT happen here: new-X
    // stays unmatched, and old-X stays unmatchedOld.
    const oldItems = extractListItems('- P\n- X\n\npara\n\n- Q\n');
    const newItems = extractListItems('- P\n\npara\n\n- Q\n- X\n');
    const { matches, unmatchedOld } = pairListItems(oldItems, newItems);

    expect(matches[textsOf(newItems).indexOf('P')]?.text).toBe('P');
    expect(matches[textsOf(newItems).indexOf('Q')]?.text).toBe('Q');
    expect(matches[textsOf(newItems).indexOf('X')]).toBeNull();
    expect([...unmatchedOld].map((i) => i.text)).toEqual(['X']);
  });
});

describe('classifyItems', () => {
  it('classifies unchanged, added, and edited correctly in one pass', () => {
    const oldItems = extractListItems('- keep\n- old text\n');
    const newItems = extractListItems('- keep\n- new text\n- brand new\n');
    // Lines 2 (edited) and 3 (added) changed; line 1 (kept) did not.
    const changedLineSet = new Set([2, 3]);
    const classes = classifyItems({ newItems, oldItems, changedLineSet });

    expect(classes[textsOf(newItems).indexOf('keep')]).toBe('unchanged');
    expect(classes[textsOf(newItems).indexOf('new text')]).toBe('edited');
    expect(classes[textsOf(newItems).indexOf('brand new')]).toBe('added');
  });

  it('classifies every item unchanged when changedLineSet is undefined', () => {
    const oldItems = extractListItems('- a\n- b\n');
    const newItems = extractListItems('- a\n- b2\n');
    const classes = classifyItems({ newItems, oldItems, changedLineSet: undefined });
    expect(classes).toEqual(['unchanged', 'unchanged']);
  });

  it("classifies every item unchanged when changedLineSet overlaps the list but no item's own range", () => {
    // Line 3 is a blank separator inside a loose list — not part of any
    // item's own [startLine, endLine] range.
    const oldItems = extractListItems('- one\n\n- two\n');
    const newItems = extractListItems('- one\n\n- two\n');
    const classes = classifyItems({ newItems, oldItems, changedLineSet: new Set([2]) });
    expect(classes).toEqual(['unchanged', 'unchanged']);
  });

  it('does not mark a parent item edited when only its nested child changed', () => {
    const oldItems = extractListItems('- parent\n  - child\n');
    const newItems = extractListItems('- parent\n  - child revised\n');
    // Only line 2 (the nested child) changed.
    const classes = classifyItems({ newItems, oldItems, changedLineSet: new Set([2]) });
    const parentIdx = newItems.findIndex((i) => i.depth === 0);
    const childIdx = newItems.findIndex((i) => i.depth === 1);
    expect(classes[parentIdx]).toBe('unchanged');
    expect(classes[childIdx]).toBe('edited');
  });
});

describe('resolveGhostAnchors', () => {
  it('anchors a middle deletion immediately after its preceding surviving sibling', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- A\n- C\n');
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe('B');
    const aNew = newItems[textsOf(newItems).indexOf('A')];
    expect(anchors[0].insertAfterStartLine).toBe(aNew.startLine);
    expect(anchors[0].hostItemStartLine).toBe(aNew.startLine);
  });

  it('anchors a FIRST-item deletion at the list start boundary (insertAfterStartLine null)', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- B\n- C\n');
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe('A');
    expect(anchors[0].insertAfterStartLine).toBeNull();
    // hostItemStartLine identifies the corresponding new list via ANY
    // surviving sibling — here, B (the bucket's first survivor) — purely to
    // locate the list, never as an insertion point.
    const bNew = newItems[textsOf(newItems).indexOf('B')];
    expect(anchors[0].hostItemStartLine).toBe(bNew.startLine);
  });

  it('anchors a LAST-item deletion after the preceding survivor (i.e. effectively at the end)', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- A\n- B\n');
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe('C');
    const bNew = newItems[textsOf(newItems).indexOf('B')];
    expect(anchors[0].insertAfterStartLine).toBe(bNew.startLine);
  });

  it('preserves relative order for adjacent multi-item deletions, chaining off the same preceding survivor', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n- D\n');
    const newItems = extractListItems('- A\n- D\n');
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors.map((a) => a.text)).toEqual(['B', 'C']);
    const aNew = newItems[textsOf(newItems).indexOf('A')];
    // Both anchor to the SAME preceding survivor (A) in old-document order —
    // the caller (markdown.tsx's insertGhostRows) is responsible for
    // chaining B then C so they end up in order, rather than both landing
    // "right after A" and ending up reversed.
    expect(anchors[0].insertAfterStartLine).toBe(aNew.startLine);
    expect(anchors[1].insertAfterStartLine).toBe(aNew.startLine);
  });

  it('preserves relative order for a leading run of deletions (both anchor to the list start)', () => {
    const oldItems = extractListItems('- A\n- B\n- C\n');
    const newItems = extractListItems('- C\n');
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors.map((a) => a.text)).toEqual(['A', 'B']);
    expect(anchors[0].insertAfterStartLine).toBeNull();
    expect(anchors[1].insertAfterStartLine).toBeNull();
    const cNew = newItems[textsOf(newItems).indexOf('C')];
    expect(anchors[0].hostItemStartLine).toBe(cNew.startLine);
    expect(anchors[1].hostItemStartLine).toBe(cNew.startLine);
  });

  it('produces no anchors when the entire list is deleted (no surviving sibling anywhere)', () => {
    const oldItems = extractListItems('- A\n- B\n');
    const newItems: MdListItem[] = [];
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);
    expect(anchors).toEqual([]);
  });

  it('skips a wholly-deleted list while still anchoring a deletion in a DIFFERENT, partially-surviving list', () => {
    // The wholly-deleted list is placed LAST: pairListItems pairs lists by
    // ordinal (Nth list encountered in each document's own pre-order
    // traversal — see its own doc comment), so removing a list BEFORE a
    // surviving one would shift the surviving list's ordinal and pair it
    // against the wrong old list — a known, out-of-scope-here pairing
    // characteristic. Removing the LAST list leaves every earlier list's
    // ordinal (and thus this test's own anchor) unaffected.
    const oldSrc = [
      '- keep1',
      '- removed',
      '- keep2',
      '',
      'para',
      '',
      '- gone1',
      '- gone2',
      '',
    ].join('\n');
    const newSrc = ['- keep1', '- keep2', '', 'para', ''].join('\n');
    const oldItems = extractListItems(oldSrc);
    const newItems = extractListItems(newSrc);
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe('removed');
    const keep1New = newItems[textsOf(newItems).indexOf('keep1')];
    expect(anchors[0].insertAfterStartLine).toBe(keep1New.startLine);
  });

  it('anchors a deletion inside a NESTED list to its nested surviving sibling, not the top-level list', () => {
    const oldSrc = ['- parent', '  - nA', '  - nB', '  - nC', ''].join('\n');
    const newSrc = ['- parent', '  - nA', '  - nC', ''].join('\n');
    const oldItems = extractListItems(oldSrc);
    const newItems = extractListItems(newSrc);
    const pairing = pairListItems(oldItems, newItems);
    const anchors = resolveGhostAnchors(oldItems, newItems, pairing);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].text).toBe('nB');
    const nANew = newItems[textsOf(newItems).indexOf('nA')];
    expect(anchors[0].insertAfterStartLine).toBe(nANew.startLine);
  });

  it('returns an empty array when nothing was deleted', () => {
    const oldItems = extractListItems('- A\n- B\n');
    const newItems = extractListItems('- A\n- B\n');
    const pairing = pairListItems(oldItems, newItems);
    expect(resolveGhostAnchors(oldItems, newItems, pairing)).toEqual([]);
  });
});

describe('extractProseUnits (local_repo_explorer-rendered-md-nonlist-diff-ek7c.1)', () => {
  it('extracts top-level paragraphs and headings, in document order, with the right kind', () => {
    const src = [
      '# Title',
      '',
      'First paragraph.',
      '',
      '## Section',
      '',
      'Second paragraph.',
      '',
    ].join('\n');
    const units = extractProseUnits(src);
    expect(units.map((u) => u.kind)).toEqual(['h1', 'p', 'h2', 'p']);
    expect(units.map((u) => u.text)).toEqual([
      'Title',
      'First paragraph.',
      'Section',
      'Second paragraph.',
    ]);
    expect(units.map((u) => u.startLine)).toEqual([1, 3, 5, 7]);
  });

  it('assigns h1..h6 kinds by heading depth', () => {
    const src = ['# a', '## b', '### c', '#### d', '##### e', '###### f', ''].join('\n');
    const units = extractProseUnits(src);
    expect(units.map((u) => u.kind)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  });

  it('ignores non-paragraph/heading top-level blocks (list, fenced code)', () => {
    const src = [
      '# Title',
      '',
      '- item one',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'A paragraph.',
      '',
    ].join('\n');
    const units = extractProseUnits(src);
    expect(units.map((u) => u.kind)).toEqual(['h1', 'p']);
    expect(units.map((u) => u.text)).toEqual(['Title', 'A paragraph.']);
  });

  it('normalizes whitespace and flattens inline markup the same way list items do', () => {
    const units = extractProseUnits('A **bold** word and  extra   spaces.\n');
    expect(units).toHaveLength(1);
    expect(units[0].kind).toBe('p');
    expect(units[0].text).toBe('A bold word and extra spaces.');
  });

  it('returns an empty array for a document with no top-level paragraph or heading', () => {
    expect(extractProseUnits('- one\n- two\n')).toEqual([]);
  });
});

describe('prose pairing/classification — generalized pairUnits/classifyUnits core via proseKeyOf (local_repo_explorer-rendered-md-nonlist-diff-ek7c.1)', () => {
  it('pairs a paragraph with its old counterpart across a shifted line position (an inserted paragraph ahead of it)', () => {
    const oldSrc = ['First paragraph.', '', 'Second paragraph.', ''].join('\n');
    const newSrc = [
      'Inserted paragraph.',
      '',
      'First paragraph.',
      '',
      'Second paragraph revised.',
      '',
    ].join('\n');
    const oldUnits = extractProseUnits(oldSrc);
    const newUnits = extractProseUnits(newSrc);
    const { matches, unmatchedOld } = pairUnits(oldUnits, newUnits, proseKeyOf);

    // "First paragraph." anchors the LCS despite the inserted paragraph
    // shifting its line number (1 -> 3); "Second paragraph revised." then
    // pairs with "Second paragraph." via the gap-substitution edit rule —
    // proving pairing survives a position shift, unlike list pairing, which
    // additionally depends on a per-side ordinal remap for its own
    // structural anchor (the enclosing list) that prose has no analogue of.
    const revisedIdx = newUnits.findIndex((u) => u.text === 'Second paragraph revised.');
    expect(matches[revisedIdx]?.text).toBe('Second paragraph.');
    expect(unmatchedOld.size).toBe(0);

    const classes = classifyUnits({
      newUnits,
      oldUnits,
      changedLineSet: new Set([5]), // "Second paragraph revised." own line
      keyOf: proseKeyOf,
    });
    const insertedIdx = newUnits.findIndex((u) => u.text === 'Inserted paragraph.');
    expect(classes[insertedIdx]).toBe('unchanged'); // its line isn't in changedLineSet
    expect(classes[revisedIdx]).toBe('edited');
  });

  it('a heading and a paragraph with identical text never pair with each other', () => {
    const oldUnits = extractProseUnits('Same text\n'); // a plain paragraph
    const newUnits = extractProseUnits('# Same text\n'); // a heading, same flattened text
    expect(oldUnits[0].kind).toBe('p');
    expect(newUnits[0].kind).toBe('h1');

    const { matches, unmatchedOld } = pairUnits(oldUnits, newUnits, proseKeyOf);
    expect(matches[0]).toBeNull(); // the new heading has no match
    expect(unmatchedOld.has(oldUnits[0])).toBe(true); // the old paragraph stays unmatched
  });

  it('two same-depth headings pair via their own bucket even with an unrelated paragraph between them in document order', () => {
    const oldSrc = ['## Section one', '', 'Some text.', ''].join('\n');
    const newSrc = ['## Section one revised', '', 'Some other text.', ''].join('\n');
    const oldUnits = extractProseUnits(oldSrc);
    const newUnits = extractProseUnits(newSrc);
    const { matches } = pairUnits(oldUnits, newUnits, proseKeyOf);

    const headingIdx = newUnits.findIndex((u) => u.kind === 'h2');
    expect(matches[headingIdx]?.text).toBe('Section one');
    const paragraphIdx = newUnits.findIndex((u) => u.kind === 'p');
    expect(matches[paragraphIdx]?.text).toBe('Some text.');
  });

  it('a heading level promote/demote does not pair with its own prior self (documented lossy-but-safe degradation)', () => {
    const oldUnits = extractProseUnits('## Section\n');
    const newUnits = extractProseUnits('### Section\n'); // ## -> ### : different kind bucket
    const { matches, unmatchedOld } = pairUnits(oldUnits, newUnits, proseKeyOf);

    // The new h3 has no match (classifies as 'added', not 'edited'); the old
    // h2 is left unmatched, contributing nothing (no ghost mechanism for
    // prose) — exactly the tradeoff `proseKeyOf`'s doc comment documents.
    expect(matches[0]).toBeNull();
    expect(unmatchedOld.has(oldUnits[0])).toBe(true);
  });
});

describe('extractTableRows (local_repo_explorer-rendered-md-nonlist-diff-ek7c.3)', () => {
  const src = ['| Action | Shortcut |', '|---|---|', '| New tab | Cmd+T |', '| Close tab | Cmd+W |', ''].join(
    '\n',
  );

  it('extracts the header row (isHeader: true) and every body row (isHeader: false), in document order', () => {
    const rows = extractTableRows(src);
    expect(rows.map((r) => r.isHeader)).toEqual([true, false, false]);
    expect(cellsOf(rows)).toEqual([
      ['Action', 'Shortcut'],
      ['New tab', 'Cmd+T'],
      ['Close tab', 'Cmd+W'],
    ]);
  });

  it('assigns source line numbers matching the rendered <tr> data-start-line (header, then body — the delimiter row consumes no line of its own)', () => {
    const rows = extractTableRows(src);
    expect(rows.map((r) => r.startLine)).toEqual([1, 3, 4]);
    expect(rows.every((r) => r.startLine === r.endLine)).toBe(true);
  });

  it('shares one tableStartLine across every row of the same table', () => {
    const rows = extractTableRows(src);
    expect(rows.every((r) => r.tableStartLine === 1)).toBe(true);
  });

  it("joins a row's cells with a NUL separator for its identity text (never confuses a cell-boundary shift with an unrelated equal row)", () => {
    const rows = extractTableRows(src);
    expect(rows[1].text).toBe('New tab\u0000Cmd+T');
    // Cross-boundary false-equality this separator rules out: a plain-space
    // join would make these two DIFFERENT rows compare equal.
    const a = { cells: ['a', 'b c'] };
    const b = { cells: ['a b', 'c'] };
    expect(a.cells.join(' ')).toBe(b.cells.join(' ')); // space join: false positive
    expect(a.cells.join('\u0000')).not.toBe(b.cells.join('\u0000')); // NUL join: correctly distinct
  });

  it('extracts rows across multiple top-level tables independently', () => {
    const multi = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'para',
      '',
      '| X | Y |',
      '|---|---|',
      '| 9 | 8 |',
      '',
    ].join('\n');
    const rows = extractTableRows(multi);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tableStartLine)).toEqual([1, 1, 7, 7]);
  });

  it('returns an empty array for a document with no table', () => {
    expect(extractTableRows('# Just a heading\n\nA paragraph.\n')).toEqual([]);
  });
});

describe('table-row pairing via tableRowKeyOf (local_repo_explorer-rendered-md-nonlist-diff-ek7c.3)', () => {
  it('pairs a body row with its old counterpart by row text', () => {
    const oldSrc = ['| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', ''].join('\n');
    const newSrc = ['| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | revised |', ''].join('\n');
    const oldRows = extractTableRows(oldSrc);
    const newRows = extractTableRows(newSrc);
    const { matches, unmatchedOld } = pairUnits(oldRows, newRows, tableRowKeyOf(oldRows, newRows));

    const revisedIdx = newRows.findIndex((r) => r.cells[1] === 'revised');
    expect(matches[revisedIdx]?.cells).toEqual(['3', '4']);
    expect(unmatchedOld.size).toBe(0);
  });

  it('never pairs a header row with a body row, even when a body row happens to share exact text with the header', () => {
    const oldSrc = ['| X | Y |', '|---|---|', '| a | b |', ''].join('\n');
    // The new header's own text now equals the OLD body row's cell text —
    // if buckets did not separate header/body, LCS's exact-text-match
    // anchor would incorrectly pair the new header with the unrelated old
    // body row (whose text is an exact match) instead of the old header.
    const newSrc = ['| a | b |', '|---|---|', '| c | d |', ''].join('\n');
    const oldRows = extractTableRows(oldSrc);
    const newRows = extractTableRows(newSrc);
    const { matches } = pairUnits(oldRows, newRows, tableRowKeyOf(oldRows, newRows));

    const newHeaderIdx = newRows.findIndex((r) => r.isHeader);
    const oldHeader = oldRows.find((r) => r.isHeader)!;
    // Paired with the OLD HEADER (positional substitution within the
    // header-only ':h' bucket) despite its now-completely-different text —
    // proving the exact-text match available in the OLD BODY row's bucket
    // was never even visible to this pairing.
    expect(matches[newHeaderIdx]).toBe(oldHeader);
    expect(matches[newHeaderIdx]?.cells).toEqual(['X', 'Y']);
  });

  it('does not pair rows across two unrelated tables even when content moves between them', () => {
    const oldSrc = [
      '| A |',
      '|---|',
      '| keep1 |',
      '| shared |',
      '',
      'para',
      '',
      '| B |',
      '|---|',
      '| keep2 |',
      '',
    ].join('\n');
    const newSrc = [
      '| A |',
      '|---|',
      '| keep1 |',
      '',
      'para',
      '',
      '| B |',
      '|---|',
      '| keep2 |',
      '| shared |',
      '',
    ].join('\n');
    const oldRows = extractTableRows(oldSrc);
    const newRows = extractTableRows(newSrc);
    const { matches, unmatchedOld } = pairUnits(oldRows, newRows, tableRowKeyOf(oldRows, newRows));

    // "shared" left table1 (old) and appears in table2 (new) — despite
    // being the identical text on both sides, it must NOT pair across the
    // table boundary: the new one classifies as unmatched (added to table2)
    // and the old one stays unmatchedOld (removed from table1).
    const newShared = newRows.find((r) => r.cells[0] === 'shared')!;
    expect(matches[newRows.indexOf(newShared)]).toBeNull();
    const oldShared = oldRows.find((r) => r.cells[0] === 'shared')!;
    expect(unmatchedOld.has(oldShared)).toBe(true);
    // Sanity: the stable anchor row in each table still pairs normally.
    const keep1New = newRows.find((r) => r.cells[0] === 'keep1')!;
    expect(matches[newRows.indexOf(keep1New)]?.cells).toEqual(['keep1']);
  });
});

describe('resolveGhostAnchorsForUnits via table rows (local_repo_explorer-rendered-md-nonlist-diff-ek7c.3)', () => {
  function anchorsFor(oldSrc: string, newSrc: string) {
    const oldRows = extractTableRows(oldSrc);
    const newRows = extractTableRows(newSrc);
    const keyOf = tableRowKeyOf(oldRows, newRows);
    const pairing = pairUnits(oldRows, newRows, keyOf);
    return resolveGhostAnchorsForUnits(oldRows, newRows, pairing, keyOf);
  }

  it('anchors a removed middle body row immediately after its preceding surviving sibling', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', '| three |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| one |', '| three |', ''].join('\n');
    const anchors = anchorsFor(oldSrc, newSrc);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].unit.cells).toEqual(['two']);
    const oneNew = extractTableRows(newSrc).find((r) => r.cells[0] === 'one')!;
    expect(anchors[0].insertAfterStartLine).toBe(oneNew.startLine);
    expect(anchors[0].hostStartLine).toBe(oneNew.startLine);
  });

  it('anchors a removed FIRST body row at the body start boundary (insertAfterStartLine null)', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| two |', ''].join('\n');
    const anchors = anchorsFor(oldSrc, newSrc);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].unit.cells).toEqual(['one']);
    expect(anchors[0].insertAfterStartLine).toBeNull();
  });

  it('anchors a removed LAST body row after the preceding survivor', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| one |', ''].join('\n');
    const anchors = anchorsFor(oldSrc, newSrc);

    expect(anchors).toHaveLength(1);
    expect(anchors[0].unit.cells).toEqual(['two']);
    const oneNew = extractTableRows(newSrc).find((r) => r.cells[0] === 'one')!;
    expect(anchors[0].insertAfterStartLine).toBe(oneNew.startLine);
  });

  it('produces no anchors when the WHOLE table (header included) has no new counterpart', () => {
    const oldSrc = ['before', '', '| A |', '|---|', '| one |', ''].join('\n');
    const newSrc = ['before', ''].join('\n');
    expect(anchorsFor(oldSrc, newSrc)).toEqual([]);
  });

  it('produces no anchors when every BODY row of a table is deleted but its header survives (table analogue of the wholly-deleted-list rule)', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', ''].join('\n');
    const newSrc = ['| A |', '|---|', ''].join('\n'); // header stays, both body rows gone
    // The header DOES survive (it pairs via its own :h bucket) — but that
    // survivor must NOT be usable as a host for the deleted BODY rows: the
    // :h/:b bucket split keeps them in a separate, survivor-less :b bucket,
    // so this must produce NO ghosts (not 2 ghosts anchored after the
    // header, which is what a naive raw-tableStartLine bucketing — merging
    // header and body into one bucket — would incorrectly produce).
    expect(anchorsFor(oldSrc, newSrc)).toEqual([]);
  });

  it('preserves relative order for adjacent deletions, chaining off the same preceding survivor', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', '| three |', '| four |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| one |', '| four |', ''].join('\n');
    const anchors = anchorsFor(oldSrc, newSrc);

    expect(anchors.map((a) => a.unit.cells[0])).toEqual(['two', 'three']);
    const oneNew = extractTableRows(newSrc).find((r) => r.cells[0] === 'one')!;
    expect(anchors[0].insertAfterStartLine).toBe(oneNew.startLine);
    expect(anchors[1].insertAfterStartLine).toBe(oneNew.startLine);
  });

  it('preserves relative order for a leading run of deletions (both anchor to the body start)', () => {
    const oldSrc = ['| A |', '|---|', '| one |', '| two |', '| three |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| three |', ''].join('\n');
    const anchors = anchorsFor(oldSrc, newSrc);

    expect(anchors.map((a) => a.unit.cells[0])).toEqual(['one', 'two']);
    expect(anchors[0].insertAfterStartLine).toBeNull();
    expect(anchors[1].insertAfterStartLine).toBeNull();
  });

  it('returns an empty array when nothing was deleted', () => {
    const oldSrc = ['| A |', '|---|', '| one |', ''].join('\n');
    const newSrc = ['| A |', '|---|', '| one |', ''].join('\n');
    expect(anchorsFor(oldSrc, newSrc)).toEqual([]);
  });
});

describe('extractBlockquoteChildren (local_repo_explorer-rendered-md-nonlist-diff-ek7c.4)', () => {
  it('extracts each direct child paragraph, in document order', () => {
    const src = ['> First quoted line.', '>', '> Second quoted line.', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children.map((c) => c.text)).toEqual(['First quoted line.', 'Second quoted line.']);
  });

  it('assigns source line numbers matching the rendered child element data-start-line/data-end-line', () => {
    const src = ['> First quoted line.', '>', '> Second quoted line.', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children.map((c) => [c.startLine, c.endLine])).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it('shares one blockquoteStartLine across every child of the same blockquote', () => {
    const src = ['> First quoted line.', '>', '> Second quoted line.', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children.every((c) => c.blockquoteStartLine === 1)).toBe(true);
  });

  it('extracts a heading child alongside a paragraph child', () => {
    const src = ['> ## Quoted heading', '>', '> A quoted paragraph.', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children.map((c) => c.text)).toEqual(['Quoted heading', 'A quoted paragraph.']);
  });

  it('excludes a nested list child entirely — it never appears as an extracted unit (Guardrail: compose with existing nesting, do not extend it)', () => {
    const src = ['> Intro paragraph.', '>', '> - nested one', '> - nested two', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children).toHaveLength(1);
    expect(children[0].text).toBe('Intro paragraph.');
  });

  it('excludes a nested blockquote child entirely — its own children are never extracted by this leaf', () => {
    const src = ['> Intro paragraph.', '>', '> > nested quote', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children).toHaveLength(1);
    expect(children[0].text).toBe('Intro paragraph.');
  });

  it('extracts children across multiple top-level blockquotes independently', () => {
    const src = ['> A one', '>', '> A two', '', 'para', '', '> B one', ''].join('\n');
    const children = extractBlockquoteChildren(src);
    expect(children).toHaveLength(3);
    expect(children.map((c) => c.blockquoteStartLine)).toEqual([1, 1, 7]);
  });

  it('returns an empty array for a document with no blockquote', () => {
    expect(extractBlockquoteChildren('# Just a heading\n\nA paragraph.\n')).toEqual([]);
  });
});

describe('blockquote-child pairing/classification via blockquoteChildKeyOf (local_repo_explorer-rendered-md-nonlist-diff-ek7c.4)', () => {
  it('pairs a child paragraph with its old counterpart across a shifted line position (an inserted child ahead of it)', () => {
    const oldSrc = ['> First.', '>', '> Second.', ''].join('\n');
    const newSrc = ['> Inserted first.', '>', '> First.', '>', '> Second revised.', ''].join('\n');
    const oldChildren = extractBlockquoteChildren(oldSrc);
    const newChildren = extractBlockquoteChildren(newSrc);
    const keyOf = blockquoteChildKeyOf(oldChildren, newChildren);
    const { matches, unmatchedOld } = pairUnits(oldChildren, newChildren, keyOf);

    const revisedIdx = newChildren.findIndex((c) => c.text === 'Second revised.');
    expect(matches[revisedIdx]?.text).toBe('Second.');
    expect(unmatchedOld.size).toBe(0);
  });

  it('does not pair children across two unrelated blockquotes even when content moves between them', () => {
    const oldSrc = ['> keep1', '>', '> shared', '', 'para', '', '> keep2', ''].join('\n');
    const newSrc = ['> keep1', '', 'para', '', '> keep2', '>', '> shared', ''].join('\n');
    const oldChildren = extractBlockquoteChildren(oldSrc);
    const newChildren = extractBlockquoteChildren(newSrc);
    const keyOf = blockquoteChildKeyOf(oldChildren, newChildren);
    const { matches, unmatchedOld } = pairUnits(oldChildren, newChildren, keyOf);

    // "shared" left blockquote1 (old) and appears in blockquote2 (new) —
    // despite being identical text on both sides, it must NOT pair across
    // the blockquote boundary.
    const newShared = newChildren.find((c) => c.text === 'shared')!;
    expect(matches[newChildren.indexOf(newShared)]).toBeNull();
    const oldShared = oldChildren.find((c) => c.text === 'shared')!;
    expect(unmatchedOld.has(oldShared)).toBe(true);
    // Sanity: the stable anchor child in each blockquote still pairs normally.
    const keep1New = newChildren.find((c) => c.text === 'keep1')!;
    expect(matches[newChildren.indexOf(keep1New)]?.text).toBe('keep1');
  });

  it('classifies an added child with no old counterpart', () => {
    const oldSrc = ['> Keep.', ''].join('\n');
    const newSrc = ['> Keep.', '>', '> Brand new.', ''].join('\n');
    const oldChildren = extractBlockquoteChildren(oldSrc);
    const newChildren = extractBlockquoteChildren(newSrc);
    const keyOf = blockquoteChildKeyOf(oldChildren, newChildren);
    const classes = classifyUnits({
      newUnits: newChildren,
      oldUnits: oldChildren,
      changedLineSet: new Set([3]),
      keyOf,
    });

    const addedIdx = newChildren.findIndex((c) => c.text === 'Brand new.');
    expect(classes[addedIdx]).toBe('added');
    const keepIdx = newChildren.findIndex((c) => c.text === 'Keep.');
    expect(classes[keepIdx]).toBe('unchanged'); // its own line isn't in changedLineSet
  });

  it('a removed child is tracked as unmatchedOld and contributes no unit to the NEW-side extraction (no anchor, no output — this leaf has no ghost mechanism for blockquote children)', () => {
    const oldSrc = ['> Keep.', '>', '> Removed line.', ''].join('\n');
    const newSrc = ['> Keep.', ''].join('\n');
    const oldChildren = extractBlockquoteChildren(oldSrc);
    const newChildren = extractBlockquoteChildren(newSrc);

    // No unit at all on the new side for the removed child — there is
    // nothing to anchor a ghost against, and (unlike lists/tables) this
    // leaf defines no anchor-resolution function for blockquote children.
    expect(newChildren.map((c) => c.text)).toEqual(['Keep.']);

    const keyOf = blockquoteChildKeyOf(oldChildren, newChildren);
    const { unmatchedOld } = pairUnits(oldChildren, newChildren, keyOf);
    const removedChild = oldChildren.find((c) => c.text === 'Removed line.')!;
    expect(unmatchedOld.has(removedChild)).toBe(true);
  });
});
