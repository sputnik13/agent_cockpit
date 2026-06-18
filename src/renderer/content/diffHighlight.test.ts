import { describe, it, expect } from 'vitest';
import { pickTokenLine } from './diffTokens';
import type { TokenLine } from './highlight/highlighter';

const LINE_A: TokenLine = [{ content: 'const a = 1;', color: '#268bd2' }];
const LINE_B: TokenLine = [{ content: 'const b = 2;', color: '#268bd2' }];
const LINE_C: TokenLine = [{ content: 'const c = 3;', color: '#268bd2' }];

// Three-line token arrays (1-based line numbers → 0-based indices).
const OLD_TOKENS: TokenLine[] = [LINE_A, LINE_B, LINE_C];
const NEW_TOKENS: TokenLine[] = [LINE_A, LINE_C];

describe('pickTokenLine', () => {
  it('returns null when tokenLines is null', () => {
    expect(pickTokenLine(1, null)).toBeNull();
  });

  it('returns null when lineNumber is null', () => {
    expect(pickTokenLine(null, OLD_TOKENS)).toBeNull();
  });

  it('maps 1-based line number to 0-based array index', () => {
    expect(pickTokenLine(1, OLD_TOKENS)).toBe(LINE_A);
    expect(pickTokenLine(2, OLD_TOKENS)).toBe(LINE_B);
    expect(pickTokenLine(3, OLD_TOKENS)).toBe(LINE_C);
  });

  it('returns null for an out-of-range line number', () => {
    expect(pickTokenLine(0, OLD_TOKENS)).toBeNull();
    expect(pickTokenLine(4, OLD_TOKENS)).toBeNull();
    expect(pickTokenLine(-1, OLD_TOKENS)).toBeNull();
  });

  // Add-only file: old side is null (no old content to tokenize).
  it('add-only: old tokens null — new-side lines resolve, old side returns null', () => {
    expect(pickTokenLine(1, null)).toBeNull(); // old side unavailable
    expect(pickTokenLine(1, NEW_TOKENS)).toBe(LINE_A);
    expect(pickTokenLine(2, NEW_TOKENS)).toBe(LINE_C);
  });

  // Delete-only file: new side is null.
  it('delete-only: new tokens null — old-side lines resolve, new side returns null', () => {
    expect(pickTokenLine(1, OLD_TOKENS)).toBe(LINE_A);
    expect(pickTokenLine(2, OLD_TOKENS)).toBe(LINE_B);
    expect(pickTokenLine(1, null)).toBeNull(); // new side unavailable
  });

  // Context lines: try new side first, fall back to old side.
  it('context line resolves from new side when available', () => {
    // New side has line 2 as LINE_C (after deletion of LINE_B).
    expect(pickTokenLine(2, NEW_TOKENS)).toBe(LINE_C);
  });

  it('handles empty token array', () => {
    expect(pickTokenLine(1, [])).toBeNull();
  });
});
