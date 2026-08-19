import { describe, expect, it } from 'vitest';
import {
  MAX_WORD_DIFF_TOKENS,
  computeWordDiff,
  tokenizeWords,
  wordDiff,
  type WordDiffSegment,
} from './wordDiff';

function reconstructNew(segments: WordDiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== 'del')
    .map((s) => s.text)
    .join('');
}

function reconstructOld(segments: WordDiffSegment[]): string {
  return segments
    .filter((s) => s.kind !== 'add')
    .map((s) => s.text)
    .join('');
}

describe('tokenizeWords', () => {
  it('splits into alternating word / non-word runs, reproducing the input via join', () => {
    const tokens = tokenizeWords('Buy whole wheat bread');
    expect(tokens).toEqual(['Buy', ' ', 'whole', ' ', 'wheat', ' ', 'bread']);
    expect(tokens.join('')).toBe('Buy whole wheat bread');
  });

  it('collapses a multi-space run into one token, not several', () => {
    const tokens = tokenizeWords('a   b');
    expect(tokens).toEqual(['a', '   ', 'b']);
    expect(tokens.join('')).toBe('a   b');
  });

  it('returns an empty array for an empty string', () => {
    expect(tokenizeWords('')).toEqual([]);
  });

  it('treats unicode letters as word characters and reproduces the input exactly', () => {
    const text = 'café naïve — 你好 world';
    const tokens = tokenizeWords(text);
    expect(tokens.join('')).toBe(text);
    expect(tokens).toContain('café');
    expect(tokens).toContain('naïve');
    expect(tokens).toContain('你好');
  });

  it('keeps punctuation as its own run distinct from surrounding words', () => {
    const tokens = tokenizeWords('hello, world!');
    expect(tokens).toEqual(['hello', ', ', 'world', '!']);
  });
});

describe('wordDiff — round-trip property', () => {
  const cases: Array<[string, string]> = [
    ['Buy whole wheat bread', 'Buy sourdough bread'],
    ['a b c', 'a b c'],
    ['', 'brand new text'],
    ['old text gone', ''],
    ['café naïve', 'café bold'],
    ['a   b    c', 'a b c'],
    ['one two three four', 'zero one two three four five'],
  ];

  it.each(cases)(
    'reassembling segments reproduces both sides exactly: %j -> %j',
    (oldText, newText) => {
      const segments = wordDiff(oldText, newText);
      expect(reconstructNew(segments)).toBe(newText);
      expect(reconstructOld(segments)).toBe(oldText);
    },
  );

  it('equal segments never contain text absent from either side', () => {
    const segments = wordDiff('Buy whole wheat bread', 'Buy sourdough bread');
    for (const seg of segments) {
      if (seg.kind !== 'equal') continue;
      expect('Buy whole wheat bread').toContain(seg.text);
      expect('Buy sourdough bread').toContain(seg.text);
    }
  });
});

describe('wordDiff — shape of common edits', () => {
  it('pure insert: new-only content becomes a single add segment amid equal context', () => {
    const segments = wordDiff('Buy bread', 'Buy fresh bread');
    expect(segments.map((s) => s.kind)).toEqual(['equal', 'add', 'equal']);
    expect(segments.find((s) => s.kind === 'add')?.text).toBe('fresh ');
  });

  it('pure delete: old-only content becomes a single del segment amid equal context', () => {
    const segments = wordDiff('Buy fresh bread', 'Buy bread');
    expect(segments.map((s) => s.kind)).toEqual(['equal', 'del', 'equal']);
    expect(segments.find((s) => s.kind === 'del')?.text).toBe('fresh ');
  });

  it('replace: a del immediately followed by an add for the substituted phrase', () => {
    const segments = wordDiff('Buy whole wheat bread', 'Buy sourdough bread');
    const kinds = segments.map((s) => s.kind);
    expect(kinds[0]).toBe('equal');
    expect(kinds).toContain('del');
    expect(kinds).toContain('add');
    expect(kinds[kinds.length - 1]).toBe('equal');
    expect(segments.find((s) => s.kind === 'del')?.text).toContain('whole');
    expect(segments.find((s) => s.kind === 'del')?.text).toContain('wheat');
    expect(segments.find((s) => s.kind === 'add')?.text).toBe('sourdough');
  });

  it('no-change: a single equal segment, no del/add', () => {
    const segments = wordDiff('identical text', 'identical text');
    expect(segments).toEqual([{ kind: 'equal', text: 'identical text' }]);
  });

  it('handles multiple separate edits within one item independently', () => {
    const segments = wordDiff('The quick brown fox jumps', 'The slow brown fox leaps');
    expect(reconstructNew(segments)).toBe('The slow brown fox leaps');
    expect(reconstructOld(segments)).toBe('The quick brown fox jumps');
    const kinds = segments.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'del').length).toBe(2);
    expect(kinds.filter((k) => k === 'add').length).toBe(2);
  });
});

describe('computeWordDiff — clean/not-clean gate', () => {
  it('reports clean:true with segments for an ordinary word-level edit', () => {
    const result = computeWordDiff('Buy whole wheat bread', 'Buy sourdough bread');
    expect(result.clean).toBe(true);
    if (result.clean) {
      expect(reconstructNew(result.segments)).toBe('Buy sourdough bread');
    }
  });

  it('short-circuits to clean:false at the token-count bound without diffing', () => {
    const overBound = Array.from({ length: MAX_WORD_DIFF_TOKENS + 1 }, (_, i) => `w${i}`).join(' ');
    const result = computeWordDiff(overBound, 'short new text');
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.reason.length).toBeGreaterThan(0);
  });

  it('stays clean:true at (not just comfortably under) the token-count bound', () => {
    // wordCount words joined by single spaces = exactly 2*wordCount - 1
    // tokens; pick the largest wordCount that still fits under the bound on
    // BOTH sides (old and the edited new, which changes content, not length).
    const wordCount = Math.floor((MAX_WORD_DIFF_TOKENS + 1) / 2);
    const words = Array.from({ length: wordCount }, (_, i) => `w${i}`);
    const atBound = words.join(' ');
    const editedAtBound = [...words.slice(0, -1), 'CHANGED'].join(' ');
    expect(tokenizeWords(atBound).length).toBeLessThanOrEqual(MAX_WORD_DIFF_TOKENS);
    expect(tokenizeWords(editedAtBound).length).toBeLessThanOrEqual(MAX_WORD_DIFF_TOKENS);
    const result = computeWordDiff(atBound, editedAtBound);
    expect(result.clean).toBe(true);
  });

  it('resolves a pathological large input quickly (the LCS is genuinely skipped, not just slow)', () => {
    const huge = Array.from({ length: 20000 }, (_, i) => `token${i}`).join(' ');
    const otherHuge = Array.from({ length: 20000 }, (_, i) => `other${i}`).join(' ');
    const start = Date.now();
    const result = computeWordDiff(huge, otherHuge);
    const elapsedMs = Date.now() - start;
    expect(result.clean).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('reports clean:false for a degenerate all-equal diff (formatting-only edit, no del/add)', () => {
    // Flattened text identical on both sides — e.g. *em* -> **em** collapses
    // to the same plain text "em" once markup is stripped.
    const result = computeWordDiff('em', 'em');
    expect(result.clean).toBe(false);
    if (!result.clean) expect(result.reason.length).toBeGreaterThan(0);
  });

  it('reports clean:false for an empty-to-empty (no-op) diff', () => {
    const result = computeWordDiff('', '');
    expect(result.clean).toBe(false);
  });
});
