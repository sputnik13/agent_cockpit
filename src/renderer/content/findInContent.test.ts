// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { collectMatches } from './findInContent';

function fixture(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('collectMatches', () => {
  it('finds case-insensitive matches across text nodes', () => {
    const root = fixture('<p>Foo bar foo</p><pre>FOObar</pre>');
    const m = collectMatches(root, 'foo');
    // "Foo", "foo" in the <p>, "FOO" in the <pre> = 3
    expect(m).toHaveLength(3);
  });

  it('returns the correct offsets within a text node', () => {
    const root = fixture('<p>abcXYabc</p>');
    const m = collectMatches(root, 'abc');
    expect(m.map((x) => [x.start, x.end])).toEqual([
      [0, 3],
      [5, 8],
    ]);
  });

  it('is empty for an empty query or no match', () => {
    const root = fixture('<p>hello</p>');
    expect(collectMatches(root, '')).toEqual([]);
    expect(collectMatches(root, 'zzz')).toEqual([]);
  });

  it('skips element boundaries (within-text-node only)', () => {
    // "ab" spans the boundary between two text nodes -> not matched.
    const root = fixture('<span>a</span><span>b</span>');
    expect(collectMatches(root, 'ab')).toEqual([]);
    // but a match fully inside one node is found
    expect(collectMatches(fixture('<span>ab</span>'), 'ab')).toHaveLength(1);
  });
});
