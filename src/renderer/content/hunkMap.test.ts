import { describe, it, expect } from 'vitest';
import { changedLinesFromPatch } from './hunkMap';
import { parsePatch } from './parsePatch';
import type { ParsedPatch, PatchHunk } from './parsePatch';

/**
 * Coverage for `nearestNewContext` (internal to hunkMap.ts, exercised only
 * through the exported `changedLinesFromPatch`). The function's job: for a
 * deleted (`del`) line, find the *old-file* nearest surrounding `context`
 * line and report that context line's *new-file* line number, so the
 * deletion can be visually attributed to the closest surviving line.
 *
 * The historical bug: the tie-break compared an old-file distance
 * (`Math.abs(ln.oldLine - oldLine)`) against a running "best" that was
 * stored as a *new-file* line number (`Math.abs((best ?? 0) - oldLine)`).
 * Old and new line numbers only coincide while no add/del has shifted the
 * hunk's old/new offset; once a hunk contains an uneven number of
 * preceding adds vs. dels, old and new diverge and the comparison silently
 * mixes coordinate spaces, picking the wrong "nearest" context line.
 */

function patchOf(hunk: PatchHunk): ParsedPatch {
  return { file: { from: 'a.txt', to: 'a.txt' }, hunks: [hunk], meta: [], binary: false };
}

describe('changedLinesFromPatch / nearestNewContext tie-break', () => {
  it('compares old-file distances consistently even once old/new diverge (coordinate-mixing bug)', () => {
    // Hunk shape (old -> new line numbers):
    //   ctx  old=1 new=1  "alpha"
    //   ctx  old=2 new=2  "bravo"
    //   add       new=3  "inserted"      <- shifts the old/new offset from here on
    //   ctx  old=3 new=4  "charlie"
    //   ctx  old=4 new=5  "delta"
    //   del  old=5        "echo"          <- nearest-context lookup target
    //
    // True old-file nearest to old=5 is "delta" (old=4, distance 1) -> new=5.
    // The buggy tie-break instead settles on "charlie": once "best" holds
    // charlie's *new* line (4, stored while comparing bravo/charlie), the
    // next comparison checks |delta.old(4) - 5| = 1 against
    // |best(4) - 5| = 1 -- a false tie (1 < 1 is false) that only arises
    // because "best" is a new-file number pretending to be an old-file one.
    // A correct old-to-old comparison finds delta strictly closer
    // (1 < |charlie.old(3) - 5| = 2) and updates to it.
    const hunk: PatchHunk = {
      header: '@@ -1,5 +1,5 @@',
      oldStart: 1,
      oldCount: 5,
      newStart: 1,
      newCount: 5,
      lines: [
        { kind: 'context', text: 'alpha', oldLine: 1, newLine: 1 },
        { kind: 'context', text: 'bravo', oldLine: 2, newLine: 2 },
        { kind: 'add', text: 'inserted', oldLine: null, newLine: 3 },
        { kind: 'context', text: 'charlie', oldLine: 3, newLine: 4 },
        { kind: 'context', text: 'delta', oldLine: 4, newLine: 5 },
        { kind: 'del', text: 'echo', oldLine: 5, newLine: null },
      ],
    };

    const result = changedLinesFromPatch(patchOf(hunk));

    // Correct: the add (new=3) plus the true nearest context, delta (new=5).
    // The pre-fix implementation instead produces new Set([3, 4]) here,
    // wrongly attributing the deletion to "charlie" (new=4).
    expect(result).toEqual(new Set([3, 5]));
  });

  it('leaves old==new (no offset shift) cases exactly as before -- correct-by-coincidence stays correct', () => {
    // A plain 1-for-1 line replacement never shifts the old/new offset, so
    // old and new line numbers coincide for every context line in the
    // hunk. Old-to-old and the buggy old-to-"new-labeled-best" comparisons
    // are numerically identical here -- this case cannot distinguish
    // buggy from fixed, which is exactly why it must keep the same result.
    const hunk: PatchHunk = {
      header: '@@ -1,5 +1,5 @@',
      oldStart: 1,
      oldCount: 5,
      newStart: 1,
      newCount: 5,
      lines: [
        { kind: 'context', text: 'one', oldLine: 1, newLine: 1 },
        { kind: 'context', text: 'two', oldLine: 2, newLine: 2 },
        { kind: 'del', text: 'three-old', oldLine: 3, newLine: null },
        { kind: 'add', text: 'three-new', oldLine: null, newLine: 3 },
        { kind: 'context', text: 'four', oldLine: 4, newLine: 4 },
        { kind: 'context', text: 'five', oldLine: 5, newLine: 5 },
      ],
    };

    const result = changedLinesFromPatch(patchOf(hunk));

    // "two" (new=2) and "four" (new=4) are equidistant (old-distance 1) from
    // the deletion at old=3; the loop's strict `<` keeps the
    // first-encountered candidate on a tie, so "two" wins. Plus the
    // genuine addition at new=3.
    expect(result).toEqual(new Set([2, 3]));
  });

  it('returns nothing for a del with no context lines in its hunk', () => {
    const hunk: PatchHunk = {
      header: '@@ -1,1 +1,0 @@',
      oldStart: 1,
      oldCount: 1,
      newStart: 1,
      newCount: 0,
      lines: [{ kind: 'del', text: 'only', oldLine: 1, newLine: null }],
    };

    expect(changedLinesFromPatch(patchOf(hunk))).toEqual(new Set());
  });

  it('false-positive reproduction: an edit inside a list no longer sweeps an unrelated sibling into changedLineSet', () => {
    // Real-shaped git diff: a heading line is inserted early (shifting the
    // hunk's old/new offset), then a later, unrelated line is deleted
    // outright. "Buy coffee" is the genuine nearest surviving sibling to
    // the deleted "Buy bread" line; "Buy stamps" is a *different* sibling,
    // two old-file lines away, that the coordinate-mixing bug wrongly
    // swept into changedLineSet instead.
    const patchText = [
      '--- a/list.txt',
      '+++ b/list.txt',
      '@@ -1,5 +1,5 @@',
      ' Intro',
      ' Buy milk',
      '+Shopping:',
      ' Buy stamps',
      ' Buy coffee',
      '-Buy bread',
    ].join('\n');

    const result = changedLinesFromPatch(parsePatch(patchText));

    // "Shopping:" (new=3) is a genuine addition -- expected to be flagged.
    expect(result.has(3)).toBe(true);
    // "Buy coffee" (new=5) is the true nearest surviving line to the
    // deleted "Buy bread" -- expected to be flagged.
    expect(result.has(5)).toBe(true);
    // "Buy stamps" (new=4) is an unrelated sibling two old-lines away from
    // the deletion. The bug swept it in; the fix must not.
    expect(result.has(4)).toBe(false);
    expect(result).toEqual(new Set([3, 5]));
  });
});
