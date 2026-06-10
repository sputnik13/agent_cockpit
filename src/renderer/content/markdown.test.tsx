// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RenderedMarkdown } from './markdown';

/**
 * Corpus exercising the markdown constructs the content viewer must render.
 * Shared across the markdown-completeness tests; line numbers matter for the
 * changed-block callout assertions, so keep edits intentional.
 */
export const CORPUS = [
  '# H1 Title', // 1
  '## H2 Section', // 2
  '### H3', // 3
  '#### H4', // 4
  '##### H5', // 5
  '###### H6', // 6
  '', // 7
  'Para with **bold**, *em*, ~~strike~~, `inline`, and an autolink https://example.com.', // 8
  '', // 9
  '- top', // 10
  '  - nested', // 11
  '- second', // 12
  '', // 13
  '1. one', // 14
  '2. two', // 15
  '', // 16
  '- [ ] todo', // 17
  '- [x] done', // 18
  '', // 19
  '> a blockquote', // 20
  '', // 21
  '---', // 22
  '', // 23
  '| A | B |', // 24
  '|---|---|', // 25
  '| 1 | 2 |', // 26
  '', // 27
  'A reference link: [the ref][r1].', // 28
  '', // 29
  '[r1]: https://ref.example.com', // 30
  '', // 31
  '```js', // 32
  'const x = 1;', // 33
  '```', // 34
  '', // 35
  '    indented code line', // 36
  '', // 37
  '![alt text](https://img.example.com/x.png)', // 38
  '', // 39
  '<script>alert(1)</script>', // 40
  '',
].join('\n');

function setup(source: string, props: Record<string, unknown> = {}) {
  return render(<RenderedMarkdown source={source} {...props} />);
}

afterEach(() => cleanup());

describe('RenderedMarkdown — structure (regression net)', () => {
  it('renders all six heading levels as distinct heading tags', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(container.querySelector(tag)).not.toBeNull();
    }
  });

  it('renders ordered, unordered, and nested lists', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());
    expect(container.querySelector('ol')).not.toBeNull();
    // nested list -> a ul/ol inside an li
    expect(container.querySelector('li ul, li ol')).not.toBeNull();
  });

  it('renders GFM task lists as checkboxes', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('input[type="checkbox"]')).not.toBeNull());
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(2);
    expect(Array.from(boxes).some((b) => (b as HTMLInputElement).checked)).toBe(true);
  });

  it('renders tables, blockquotes, hr, strikethrough, and inline code', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(container.querySelector('th')).not.toBeNull();
    expect(container.querySelector('td')).not.toBeNull();
    expect(container.querySelector('blockquote')).not.toBeNull();
    expect(container.querySelector('hr')).not.toBeNull();
    expect(container.querySelector('del')).not.toBeNull();
    expect(container.querySelector('code')).not.toBeNull();
  });

  it('renders fenced and indented code as preformatted blocks', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
    expect(container.querySelectorAll('pre').length).toBeGreaterThanOrEqual(2);
  });

  it('strips dangerous HTML (no script survives sanitization)', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(container.querySelector('script')).toBeNull();
  });

  it('flags changed blocks with a callout', async () => {
    const { container } = setup(CORPUS, { changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(container.textContent).toContain('changed');
  });

  it('resolves reference-style links across blocks (single-pass)', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    const ref = Array.from(container.querySelectorAll('a')).find(
      (a) => a.textContent === 'the ref',
    );
    expect(ref).toBeTruthy();
    expect(ref?.getAttribute('href')).toBe('https://ref.example.com');
  });

  it('annotates top-level elements with source line ranges', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    const h1 = container.querySelector('h1');
    expect(h1?.getAttribute('data-start-line')).toBe('1');
    expect(h1?.getAttribute('data-end-line')).toBe('1');
  });

  it('syntax-highlights fenced code (rehype-highlight emits hljs tokens)', async () => {
    const { container } = setup(CORPUS);
    await waitFor(() => expect(container.querySelector('pre code.hljs')).not.toBeNull());
    const code = container.querySelector('pre code.language-js');
    expect(code).not.toBeNull();
    // At least one hljs token span (e.g. hljs-keyword for `const`).
    expect(code?.querySelector('span[class*="hljs-"]')).not.toBeNull();
  });

  it('survives sanitization for inline event handlers and javascript: links', async () => {
    const evil = [
      '[click](javascript:alert(1))',
      '',
      '<a href="https://ok.example.com" onclick="alert(1)">ok</a>',
    ].join('\n');
    const { container } = setup(evil);
    await waitFor(() => expect(container.querySelector('p')).not.toBeNull());
    const anchors = container.querySelectorAll('a');
    for (const a of anchors) {
      expect(a.getAttribute('onclick')).toBeNull();
      const href = a.getAttribute('href') ?? '';
      expect(href.toLowerCase().startsWith('javascript:')).toBe(false);
    }
  });

  it('marks external anchors data-external, local paths data-localpath, fragments inert', async () => {
    const src = [
      '[ext](https://example.com)',
      '',
      '[rel](./README.md)',
      '',
      '[frag](#section)',
    ].join('\n');
    const { container } = setup(src);
    await waitFor(() => expect(container.querySelectorAll('a').length).toBeGreaterThanOrEqual(3));
    const [ext, rel, frag] = Array.from(container.querySelectorAll('a'));
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer');
    expect(ext.getAttribute('data-external')).toBe('true');
    // A relative path is now an actionable local-path link (routed by the link
    // router), not inert; an in-page fragment stays inert.
    expect(rel.getAttribute('data-localpath')).toBe('true');
    expect(frag.getAttribute('data-inert')).toBe('true');
  });

  it('blocks unsafe image src (only http(s)/data:image allowed)', async () => {
    const src = [
      '![ok](https://img.example.com/x.png)',
      '',
      '![evil](javascript:alert(1))',
      '',
      '![weird](file:///etc/passwd)',
    ].join('\n');
    const { container } = setup(src);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toBe('https://img.example.com/x.png');
    expect(container.querySelectorAll('span[data-image-blocked="true"]').length).toBe(2);
  });
});
