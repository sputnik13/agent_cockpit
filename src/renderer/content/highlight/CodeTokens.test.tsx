// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CodeTokens, splitTokenLineAt } from './CodeTokens';
import type { TokenLine } from './highlighter';

describe('CodeTokens', () => {
  const lines: TokenLine[] = [
    [
      { content: 'const', color: '#268bd2' },
      { content: ' x = 1', color: '#839496' },
    ],
    [],
    [{ content: 'foo()', color: '#b58900' }],
  ];

  it('renders one colored span per token', () => {
    const { container } = render(<CodeTokens lines={lines} />);
    const colored = container.querySelectorAll('code > span span[style]');
    expect(colored).toHaveLength(3);
    expect((colored[0] as HTMLElement).style.color).toBe('rgb(38, 139, 210)');
  });

  it('preserves exact source text including blank lines (find-compatible)', () => {
    const { container } = render(<CodeTokens lines={lines} />);
    const code = container.querySelector('code')!;
    // Token contents joined per line, lines joined by newline — round-trips source.
    expect(code.textContent).toBe('const x = 1\n\nfoo()');
  });
});

describe('splitTokenLineAt', () => {
  /** Concatenated text of every token in order — the invariant every case
   *  below checks is never altered by a split. */
  function text(line: TokenLine): string {
    return line.map((t) => t.content).join('');
  }

  const line: TokenLine = [
    { content: 'const', color: '#268bd2' },
    { content: ' x = ', color: '#839496' },
    { content: '1', color: '#2aa198' },
  ];
  const FULL_TEXT = text(line); // 'const x = 1' (11 chars)

  it('splits at a column inside a token, dividing that token into two same-colored halves', () => {
    // Column 2 falls inside 'const' (index 0..5): 'co' | 'nst'.
    const [before, after] = splitTokenLineAt(line, 2);
    expect(text(before)).toBe('co');
    expect(text(after)).toBe('nst x = 1');
    // The split token keeps its original color on both halves.
    expect(before[before.length - 1]).toEqual({ content: 'co', color: '#268bd2' });
    expect(after[0]).toEqual({ content: 'nst', color: '#268bd2' });
    // Untouched trailing tokens are passed through as the SAME objects
    // (not rebuilt), proving no token's text was rewritten.
    expect(after[1]).toBe(line[1]);
    expect(after[2]).toBe(line[2]);
  });

  it('splits cleanly at a token boundary — no synthetic empty/partial token on either side', () => {
    // Column 5 is exactly the boundary between 'const' and ' x = '.
    const col = line[0].content.length;
    const [before, after] = splitTokenLineAt(line, col);
    expect(before).toEqual([line[0]]);
    expect(before[0]).toBe(line[0]); // same object, not a rebuilt copy
    expect(after).toEqual([line[1], line[2]]);
    expect(after[0]).toBe(line[1]);
  });

  it('splits at column 0: everything goes to the after half, before is empty', () => {
    const [before, after] = splitTokenLineAt(line, 0);
    expect(before).toEqual([]);
    expect(text(after)).toBe(FULL_TEXT);
  });

  it('splits at end-of-line: everything goes to the before half, after is empty', () => {
    const [before, after] = splitTokenLineAt(line, FULL_TEXT.length);
    expect(text(before)).toBe(FULL_TEXT);
    expect(after).toEqual([]);
  });

  it('splits beyond end-of-line: clamps to the same result as end-of-line (nothing thrown, nothing lost)', () => {
    const [before, after] = splitTokenLineAt(line, FULL_TEXT.length + 50);
    expect(text(before)).toBe(FULL_TEXT);
    expect(after).toEqual([]);
  });

  it('never alters the concatenated text across a sweep of every possible column, including negative', () => {
    for (let col = -3; col <= FULL_TEXT.length + 3; col++) {
      const [before, after] = splitTokenLineAt(line, col);
      expect(text(before) + text(after)).toBe(FULL_TEXT);
    }
  });

  it('handles an empty line: both halves are empty at any column', () => {
    expect(splitTokenLineAt([], 0)).toEqual([[], []]);
    expect(splitTokenLineAt([], 3)).toEqual([[], []]);
  });

  it('preserves colorless tokens (no `color` key) on either side of a split', () => {
    const plain: TokenLine = [{ content: 'abcdef' }];
    const [before, after] = splitTokenLineAt(plain, 3);
    expect(before).toEqual([{ content: 'abc' }]);
    expect(after).toEqual([{ content: 'def' }]);
    expect('color' in before[0]).toBe(false);
    expect('color' in after[0]).toBe(false);
  });
});
