// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CodeTokens } from './CodeTokens';
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
