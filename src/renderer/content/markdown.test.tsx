// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RenderedMarkdown } from './markdown';
import { useNotesStore } from '../notes';
import {
  extractBlockquoteChildren,
  extractCodeUnits,
  extractProseUnits,
  extractTableRows,
} from './markdownItemDiff';

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

/** The BlockView wrapper div two levels up from a top-level element's own
 *  rendered node — see markdown.tsx's BlockView JSX: wrapper > content-div >
 *  (the element itself). Used to assert the OLD whole-block ChangedTag (a
 *  direct-child <span>, unclassed) is present/absent, distinct from the new
 *  per-item mini-tag <span>s nested deep inside the list markup. */
function blockWrapperOf(el: Element): HTMLElement {
  return el.parentElement!.parentElement as HTMLElement;
}

function hasBlockChangedTag(el: Element): boolean {
  return blockWrapperOf(el).querySelector(':scope > span') != null;
}

describe('RenderedMarkdown — per-item list diff (local_repo_explorer-rendered-md-per-item-diff-bibv.1)', () => {
  const oldSrc = ['# List demo', '', '- item one', '- item two', '- item three', ''].join('\n');
  const newSrcEdited = [
    '# List demo',
    '',
    '- item one',
    '- item two revised',
    '- item three',
    '',
  ].join('\n');

  it('decorates only the edited <li>; siblings and the enclosing list stay undecorated', async () => {
    const { container } = setup(newSrcEdited, { oldSource: oldSrc, changedLineSet: new Set([4]) });
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

    const items = Array.from(container.querySelectorAll('li'));
    expect(items).toHaveLength(3);
    const edited = items.find((li) => li.textContent?.includes('item two revised'));
    const untouched = items.filter((li) => li !== edited);
    expect(untouched).toHaveLength(2);

    expect(edited?.classList.contains('ac-item-edited')).toBe(true);
    // "item two" -> "item two revised" is a plain-text pure insertion — a
    // CLEAN word-level diff (local_repo_explorer-rendered-md-per-item-diff-bibv.2),
    // so it gets an intraline add span instead of the whole-item mini-tag.
    expect(edited?.querySelector('.ac-mini-tag-changed')).toBeNull();
    const addSpan = edited?.querySelector('.ac-add-span');
    expect(addSpan?.textContent).toContain('revised');
    // data-start-line/data-end-line survive decoration — BlockView's note
    // hover affordance depends on them to resolve the right source line.
    expect(edited?.getAttribute('data-start-line')).toBe('4');
    expect(edited?.getAttribute('data-end-line')).toBe('4');

    for (const li of untouched) {
      expect(li.classList.contains('ac-item-edited')).toBe(false);
      expect(li.classList.contains('ac-item-added')).toBe(false);
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
    }

    // The enclosing <ul> no longer gets the whole-block rail/wash/tag.
    const ul = container.querySelector('ul')!;
    expect(hasBlockChangedTag(ul)).toBe(false);
  });

  it('decorates an added item in the added role, distinct from an edited item', async () => {
    const oldTwoItems = ['# List demo', '', '- item one', '- item two', ''].join('\n');
    const newThreeItems = ['# List demo', '', '- item one', '- item two', '- item three', ''].join(
      '\n',
    );
    const { container } = setup(newThreeItems, {
      oldSource: oldTwoItems,
      changedLineSet: new Set([5]),
    });
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

    const items = Array.from(container.querySelectorAll('li'));
    const added = items.find((li) => li.textContent?.includes('item three'));
    expect(added?.classList.contains('ac-item-added')).toBe(true);
    expect(added?.classList.contains('ac-item-edited')).toBe(false);
    const tag = added?.querySelector('.ac-mini-tag-added');
    expect(tag?.textContent).toBe('new');

    // Untouched siblings carry neither role.
    const untouched = items.filter((li) => li !== added);
    for (const li of untouched) {
      expect(li.className).not.toMatch(/ac-item-/);
    }
  });

  it('behaves identically for an ordered list, preserving item ordinals', async () => {
    const oldOrdered = ['1. first', '2. second', '3. third', ''].join('\n');
    const newOrdered = ['1. first', '2. second revised', '3. third', ''].join('\n');
    const { container } = setup(newOrdered, {
      oldSource: oldOrdered,
      changedLineSet: new Set([2]),
    });
    await waitFor(() => expect(container.querySelector('ol')).not.toBeNull());

    const items = Array.from(container.querySelectorAll('ol > li'));
    expect(items).toHaveLength(3);
    expect(items[0].classList.contains('ac-item-edited')).toBe(false);
    expect(items[1].classList.contains('ac-item-edited')).toBe(true);
    expect(items[2].classList.contains('ac-item-edited')).toBe(false);
    // No item/list-type branching: the ordered list's own block-level tag
    // is suppressed exactly like the unordered case.
    expect(hasBlockChangedTag(container.querySelector('ol')!)).toBe(false);
  });

  it('does not mark a parent item edited when only its nested child changed', async () => {
    const oldNested = ['- parent', '  - child', ''].join('\n');
    const newNested = ['- parent', '  - child revised', ''].join('\n');
    const { container } = setup(newNested, { oldSource: oldNested, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('li ul, li ol')).not.toBeNull());

    // Document order: the outer (parent) <li> is encountered before its
    // nested <li> in a pre-order DOM traversal.
    const [topLevelItem, childItem] = Array.from(container.querySelectorAll('li'));
    expect(topLevelItem.classList.contains('ac-item-edited')).toBe(false);
    expect(childItem.classList.contains('ac-item-edited')).toBe(true);
  });

  it('falls back to the whole-block treatment when oldSource is absent (undefined or null)', async () => {
    for (const oldSource of [undefined, null] as const) {
      const { container, unmount } = setup(newSrcEdited, {
        oldSource,
        changedLineSet: new Set([4]),
      });
      await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

      for (const li of container.querySelectorAll('li')) {
        expect(li.className).not.toMatch(/ac-item-/);
      }
      expect(hasBlockChangedTag(container.querySelector('ul')!)).toBe(true);
      unmount();
    }
  });

  it('falls back to the whole-block treatment when changedLineSet is absent, even with oldSource', async () => {
    const { container } = setup(newSrcEdited, { oldSource: oldSrc });
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

    for (const li of container.querySelectorAll('li')) {
      expect(li.className).not.toMatch(/ac-item-/);
    }
    // No changedLineSet at all means nothing is flagged as changed, so the
    // legacy path shows no decoration either — consistent zero-signal state.
    expect(hasBlockChangedTag(container.querySelector('ul')!)).toBe(false);
  });

  it('zero-decoration safety net: a changed line outside every item range keeps the whole-block treatment', async () => {
    // A loose list; line 2 is the blank separator between items, inside the
    // list's own block range but outside every item's own [start,end].
    const looseSrc = ['- one', '', '- two', ''].join('\n');
    const { container } = setup(looseSrc, { oldSource: looseSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

    for (const li of container.querySelectorAll('li')) {
      expect(li.className).not.toMatch(/ac-item-/);
    }
    expect(hasBlockChangedTag(container.querySelector('ul')!)).toBe(true);
  });

  it('non-list blocks (heading/table/code) keep the exact legacy whole-block treatment regardless of oldSource', async () => {
    const oldDoc = CORPUS;
    const { container } = setup(CORPUS, { oldSource: oldDoc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(hasBlockChangedTag(container.querySelector('h1')!)).toBe(true);
  });

  it('re-rendering (e.g. a notes-store style update) does not compound decorations', async () => {
    const { container, rerender } = setup(newSrcEdited, {
      oldSource: oldSrc,
      changedLineSet: new Set([4]),
    });
    await waitFor(() => expect(container.querySelector('ul')).not.toBeNull());

    // "item two" -> "item two revised" is a clean word-level diff (no mini
    // tag — see the previous test); count the intraline add span instead.
    const countAddSpans = () => container.querySelectorAll('.ac-add-span').length;
    expect(countAddSpans()).toBe(1);
    expect(container.querySelectorAll('.ac-mini-tag').length).toBe(0);

    // Re-render with the SAME props (as an unrelated state change elsewhere
    // in the tree would do) several times; a pure derivation must not
    // accumulate extra tags/spans/classes on each pass.
    for (let i = 0; i < 3; i++) {
      rerender(
        <RenderedMarkdown source={newSrcEdited} oldSource={oldSrc} changedLineSet={new Set([4])} />,
      );
    }
    await waitFor(() => expect(countAddSpans()).toBe(1));
    expect(container.querySelectorAll('.ac-mini-tag').length).toBe(0);
    const edited = Array.from(container.querySelectorAll('li')).find((li) =>
      li.textContent?.includes('item two revised'),
    );
    expect(edited?.classList.length).toBe(1); // exactly one class: ac-item-edited
  });
});

describe('RenderedMarkdown — intraline word-diff (local_repo_explorer-rendered-md-per-item-diff-bibv.2)', () => {
  function setupItem(oldLine: string, newLine: string, props: Record<string, unknown> = {}) {
    return setup(`${newLine}\n`, {
      oldSource: `${oldLine}\n`,
      changedLineSet: new Set([1]),
      ...props,
    });
  }

  // Full-reconstruction helpers (local_repo_explorer-rendered-md-per-item-diff-bibv.2's
  // 2nd-pass REJECT, REQUIRED FIX #3): a prior task-list test asserted only
  // one span's OWN textContent, which PASSED even though the surrounding
  // text was corrupted (dropped/duplicated characters). Every clean-splice
  // test must instead verify the item's FULL text reconstructs exactly —
  // stripping `.ac-del-span` content must reproduce the new source, and
  // stripping `.ac-add-span` content must reproduce the old source.
  //
  // Ground truth is derived from an INDEPENDENT render of the corresponding
  // old/new source (never hand-computed), so a test can't silently encode
  // the same whitespace-regime assumption the splicing code itself must get
  // right. This also sidesteps needing to hand-predict structural DOM
  // artifacts (a task-list checkbox's leading space, a loose item's <p>
  // wrapper, rehype-stringify's pretty-print fringe around a nested list) —
  // whatever an independent render of that exact markdown produces IS the
  // correct expectation, by construction.

  /** "This item's own text" for reconstruction purposes: `li`'s textContent
   *  with every nested `<ul>/<ol>` removed — a nested list is a
   *  structurally distinct, independently classified item (see markdown.tsx's
   *  `Slot` 'skip' case), never part of THIS item's own diffable text. */
  function ownText(li: Element): string {
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('ul, ol').forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  /** `ownText`, additionally stripping every element matching `selector`. */
  function ownTextWithout(li: Element, selector: string): string {
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('ul, ol').forEach((el) => el.remove());
    clone.querySelectorAll(selector).forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  /** Renders `source` on its own (no diffing at all) and returns the
   *  `itemIndex`-th `<li>`'s own text — the ground truth for a
   *  full-reconstruction assertion. */
  async function renderOwnItemText(source: string, itemIndex = 0): Promise<string> {
    const { container, unmount } = setup(source);
    await waitFor(() => expect(container.querySelectorAll('li').length).toBeGreaterThan(itemIndex));
    const text = ownText(container.querySelectorAll('li')[itemIndex]);
    unmount();
    return text;
  }

  /** Asserts FULL reconstruction: `li` (already spliced) with `.ac-del-span`
   *  content removed must equal an independent render of `newSource`, and
   *  with `.ac-add-span` content removed must equal an independent render
   *  of `oldSource` — proving no character was dropped or duplicated
   *  anywhere in the item, not just around one span. */
  async function expectFullReconstruction(
    li: Element,
    oldSource: string,
    newSource: string,
    itemIndex = 0,
  ): Promise<void> {
    const [oldGroundTruth, newGroundTruth] = await Promise.all([
      renderOwnItemText(oldSource, itemIndex),
      renderOwnItemText(newSource, itemIndex),
    ]);
    expect(ownTextWithout(li, '.ac-del-span')).toBe(newGroundTruth);
    expect(ownTextWithout(li, '.ac-add-span')).toBe(oldGroundTruth);
  }

  it('renders a clean word-level replace as del/add spans, keeps the amber rail, drops the mini-tag', async () => {
    const { container } = setupItem('- Buy whole wheat bread', '- Buy sourdough bread');
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.classList.contains('ac-item-edited')).toBe(true);
    expect(li.querySelector('.ac-mini-tag')).toBeNull();
    expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);

    const del = li.querySelector('.ac-del-span');
    const add = li.querySelector('.ac-add-span');
    expect(del?.textContent).toContain('whole');
    expect(del?.textContent).toContain('wheat');
    expect(add?.textContent).toBe('sourdough');
    // Both old and new words are visible simultaneously, inline in prose,
    // reconstructing to EXACTLY "equal + del + add + equal" with no
    // duplicated or dropped text around the splice point.
    expect(li.textContent).toBe('Buy whole wheatsourdough bread');
    await expectFullReconstruction(li, '- Buy whole wheat bread\n', '- Buy sourdough bread\n');
  });

  it('renders a pure single-word insertion as one add span with no del', async () => {
    const { container } = setupItem('- Ship the release', '- Ship the final release');
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.querySelector('.ac-mini-tag')).toBeNull();
    expect(li.querySelector('.ac-del-span')).toBeNull();
    expect(li.querySelector('.ac-add-span')?.textContent).toContain('final');
    // A pure insertion has no del, so the reconstruction equals the new
    // text exactly.
    expect(li.textContent).toBe('Ship the final release');
    await expectFullReconstruction(li, '- Ship the release\n', '- Ship the final release\n');
  });

  it('handles multiple separate word edits within one item independently', async () => {
    const { container } = setupItem('- The quick brown fox jumps', '- The slow brown fox leaps');
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.querySelectorAll('.ac-del-span').length).toBe(2);
    expect(li.querySelectorAll('.ac-add-span').length).toBe(2);
    expect(li.querySelector('.ac-mini-tag')).toBeNull();
    // Exact reconstruction: both edit points spliced independently, the
    // unchanged "brown fox" in between left completely untouched.
    expect(li.textContent).toBe('The quickslow brown fox jumpsleaps');
    await expectFullReconstruction(
      li,
      '- The quick brown fox jumps\n',
      '- The slow brown fox leaps\n',
    );
  });

  it("falls back to the whole-item treatment (no spans) when the edit is inside a link's text", async () => {
    const { container } = setupItem(
      '- Order the [report](https://example.com/doc) today',
      '- Order the [file](https://example.com/doc) today',
    );
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.classList.contains('ac-item-edited')).toBe(true);
    expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(li.querySelector('.ac-del-span')).toBeNull();
    expect(li.querySelector('.ac-add-span')).toBeNull();
    // The link itself survives completely intact — not partially spliced.
    const a = li.querySelector('a')!;
    expect(a.textContent).toBe('file');
    expect(a.getAttribute('href')).toBe('https://example.com/doc');
    // The clean:false signal leaf .4 depends on is actually surfaced, not
    // just used-and-discarded internally.
    expect(li.getAttribute('data-diff-fallback-reason')).toBeTruthy();
  });

  it('falls back to the whole-item treatment when the edit is inside **bold**/*em*/`code`', async () => {
    const cases: Array<[string, string, string]> = [
      ['- Buy **quarterly** report', '- Buy **annual** report', 'strong'],
      ['- Buy *quarterly* report', '- Buy *annual* report', 'em'],
      ['- Run `build.sh` now', '- Run `deploy.sh` now', 'code'],
    ];
    for (const [oldLine, newLine, tag] of cases) {
      const { container, unmount } = setupItem(oldLine, newLine);
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      expect(li.querySelector('.ac-del-span')).toBeNull();
      expect(li.querySelector('.ac-add-span')).toBeNull();
      expect(li.querySelector(tag)).not.toBeNull();
      expect(li.getAttribute('data-diff-fallback-reason')).toBeTruthy();
      unmount();
    }
  });

  it('falls back to the whole-item treatment when the edit spans an element boundary', async () => {
    // "fresh" is added as new bold text; the add segment's flattened-text
    // range extends past the end of the new <strong>'s own text into the
    // following plain-text run, straddling the element boundary.
    const { container } = setupItem('- Buy bread', '- Buy **fresh** bread');
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(li.querySelector('.ac-del-span')).toBeNull();
    expect(li.querySelector('.ac-add-span')).toBeNull();
    expect(li.querySelector('strong')?.textContent).toBe('fresh');
    expect(li.getAttribute('data-diff-fallback-reason')).toBeTruthy();
  });

  it('never splices into a nested list; the parent still gets clean spans for its own text', async () => {
    const oldSrc = ['- parent alpha', '  - nested one', ''].join('\n');
    const newSrc = ['- parent beta', '  - nested one', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('li ul, li ol')).not.toBeNull());

    const [parent, child] = Array.from(container.querySelectorAll('li'));
    expect(parent.classList.contains('ac-item-edited')).toBe(true);
    expect(parent.querySelector('.ac-mini-tag')).toBeNull();
    expect(parent.hasAttribute('data-diff-fallback-reason')).toBe(false);
    expect(parent.querySelectorAll('.ac-del-span')).toHaveLength(1);
    expect(parent.querySelectorAll('.ac-add-span')).toHaveLength(1);
    expect(parent.querySelector('.ac-del-span')?.textContent).toBe('alpha');
    expect(parent.querySelector('.ac-add-span')?.textContent).toBe('beta');
    // The parent's own DIRECT children (excluding the nested <ul> and its
    // subtree) reconstruct exactly, with no duplicated/dropped text around
    // the splice point — the pretty-printed newlines rehype-stringify emits
    // immediately before/after the nested <ul> both survive verbatim.
    expect(ownText(parent)).toBe('parent alphabeta\n\n');
    await expectFullReconstruction(parent, oldSrc, newSrc, 0);

    // The nested item is untouched: no spans inside it, text unchanged, and
    // the del/add spans found above belong to the PARENT, not leaked into it.
    expect(child.querySelector('.ac-del-span')).toBeNull();
    expect(child.querySelector('.ac-add-span')).toBeNull();
    expect(child.textContent).toBe('nested one');
  });

  it('short-circuits to the whole-item treatment above the size bound, without corrupting the item', async () => {
    const bigOld = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');
    const bigNew = Array.from({ length: 700 }, (_, i) => (i === 0 ? 'CHANGED' : `word${i}`)).join(
      ' ',
    );
    const { container } = setupItem(`- ${bigOld}`, `- ${bigNew}`);
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(li.querySelector('.ac-del-span')).toBeNull();
    expect(li.querySelector('.ac-add-span')).toBeNull();
    expect(li.textContent).toContain('CHANGED');
    expect(li.getAttribute('data-diff-fallback-reason')).toBeTruthy();
  });

  it('falls back to the whole-item treatment for a degenerate diff (formatting-only edit, no visible word change)', async () => {
    // Flattened text is "stress test" on both sides — only the markup
    // (em -> strong) changed, so the word-level diff has no del/add at all.
    const { container } = setupItem('- *stress* test', '- **stress** test');
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.classList.contains('ac-item-edited')).toBe(true);
    expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(li.querySelector('.ac-del-span')).toBeNull();
    expect(li.querySelector('.ac-add-span')).toBeNull();
    expect(li.querySelector('strong')?.textContent).toBe('stress');
    // The reason is specifically distinguishable as "nothing to show" (not
    // a DOM-boundary failure) — leaf .4's hover preview reads this string.
    expect(li.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');
  });

  // These reconcile `entry.oldText` (markdownItemDiff.ts's normalizeText —
  // whitespace-collapsed, trimmed) against the item's raw rendered DOM text
  // (buildSlots — un-normalized) BEFORE diffing (local_repo_explorer-rendered-md-per-item-diff-bibv.2's
  // REJECT): a GFM checkbox's genuine leading space, a multi-space run, and a
  // soft/hard line break all previously produced phantom del/add spans
  // purely from that whitespace-regime mismatch, never a real content edit.
  // Driven through RenderedMarkdown (never hand-fed diff inputs) per the
  // review's requirement, so a regression here is caught exactly the way a
  // user would see it.
  describe('whitespace-regime reconciliation (local_repo_explorer-rendered-md-per-item-diff-bibv.2 REJECT correction)', () => {
    it('renders a GFM task-list item with no phantom span for the checkbox gap', async () => {
      const { container } = setup('- [ ] Buy fresh milk\n', {
        oldSource: '- [ ] Buy milk\n',
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      // Exactly one add span for the real edit — no second, phantom
      // whitespace-only span for the checkbox's leading space.
      const addSpans = li.querySelectorAll('.ac-add-span');
      expect(addSpans).toHaveLength(1);
      expect(addSpans[0].textContent).toBe('fresh ');
      expect(li.querySelectorAll('.ac-del-span')).toHaveLength(0);
      // No span's text is pure whitespace.
      for (const span of li.querySelectorAll('.ac-add-span, .ac-del-span')) {
        expect((span.textContent ?? '').trim().length).toBeGreaterThan(0);
      }
      // Full reconstruction (local_repo_explorer-rendered-md-per-item-diff-bibv.2's
      // 2nd-pass REJECT): the checkbox's genuine leading space is preserved
      // exactly once — neither dropped nor duplicated. This is precisely the
      // tight-GFM-task-list-item case that was silently corrupted before the
      // fix (a leading space before the item's first text slot shifted every
      // downstream splice position).
      expect(li.textContent).toBe(' Buy fresh milk');
      await expectFullReconstruction(li, '- [ ] Buy milk\n', '- [ ] Buy fresh milk\n');
    });

    it('collapses a multi-space run instead of treating it as a phantom change', async () => {
      const { container } = setup('- Buy   fresh milk today\n', {
        oldSource: '- Buy   milk today\n',
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      const addSpans = li.querySelectorAll('.ac-add-span');
      expect(addSpans).toHaveLength(1);
      // The pre-existing 3-space run is untouched, original formatting —
      // not swept into the add span as if it were part of the change.
      expect(addSpans[0].textContent).toBe('fresh ');
      expect(li.querySelectorAll('.ac-del-span')).toHaveLength(0);
      // Reconstructing the item's own text (outside the checkbox/mini-tag
      // concerns this item has neither of) reproduces the new source
      // exactly, spacing included.
      expect(li.textContent).toBe('Buy   fresh milk today');
      await expectFullReconstruction(li, '- Buy   milk today\n', '- Buy   fresh milk today\n');
    });

    it('splices a clean edit immediately adjacent to punctuation (comma-adjacent boundary)', async () => {
      // "a,b" -> "a, b": tokenization merges adjacent punctuation+whitespace
      // into one non-word run, so this is a real ','->', ' token edit, not a
      // whitespace-only one — exercising that boundary rather than assuming
      // punctuation and whitespace tokenize independently.
      const { container } = setup('- a, b\n', {
        oldSource: '- a,b\n',
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.classList.contains('ac-item-edited')).toBe(true);
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      expect(li.textContent).toBe('a,, b');
      await expectFullReconstruction(li, '- a,b\n', '- a, b\n');
    });

    it('reconciles a soft-wrapped multi-line item without a phantom span at the line break', async () => {
      const oldSrc = ['- line one', '  line two', ''].join('\n');
      const newSrc = ['- line one', '  line TWO', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.classList.contains('ac-item-edited')).toBe(true);
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      // Exactly the real "two" -> "TWO" edit — no extra span around the
      // line break itself.
      expect(li.querySelectorAll('.ac-del-span')).toHaveLength(1);
      expect(li.querySelectorAll('.ac-add-span')).toHaveLength(1);
      expect(li.querySelector('.ac-del-span')?.textContent).toBe('two');
      expect(li.querySelector('.ac-add-span')?.textContent).toBe('TWO');
      // The line break itself survives verbatim (a literal newline in the
      // rendered text), not absorbed into either span.
      expect(li.textContent).toContain('line one\nline ');
      await expectFullReconstruction(li, oldSrc, newSrc);
    });

    it('reconciles a hard line break (trailing double-space -> <br>) without a phantom span around it', async () => {
      const oldSrc = ['- line one  ', '  line two', ''].join('\n');
      const newSrc = ['- line one  ', '  line TWO', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.querySelector('br')).not.toBeNull();
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      // No phantom span spliced in immediately before/after the <br> —
      // only the real "two" -> "TWO" edit gets spans.
      expect(li.querySelectorAll('.ac-del-span')).toHaveLength(1);
      expect(li.querySelectorAll('.ac-add-span')).toHaveLength(1);
      expect(li.querySelector('.ac-del-span')?.textContent).toBe('two');
      expect(li.querySelector('.ac-add-span')?.textContent).toBe('TWO');
      // The <br> is the direct previous sibling of the surviving text run
      // — nothing (like a stray del span) was spliced in between them.
      const br = li.querySelector('br')!;
      expect(br.nextSibling?.textContent?.replace(/^\n/, '')).toBe('line ');
      await expectFullReconstruction(li, oldSrc, newSrc);
    });

    it('reconciles a leading opaque slot with no text of its own (an item starting with an image) without dropping or duplicating characters', async () => {
      // The image contributes ZERO characters to buildSlots' flattened text
      // (an <img>'s DOM textContent is always '' — alt is an attribute, not
      // rendered text) — matching a task-list checkbox's <input>, this is
      // the OTHER concrete case local_repo_explorer-rendered-md-per-item-diff-bibv.2's
      // 2nd REJECT named as silently corrupted: an item whose first slot
      // contributes no text, so the item's WHOLE diffable text is the
      // leading-space-prefixed run after it.
      const oldSrc = '- ![](https://img.example.com/a.png) alpha\n';
      const newSrc = '- ![](https://img.example.com/a.png) beta\n';
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

      const li = container.querySelector('li')!;
      expect(li.classList.contains('ac-item-edited')).toBe(true);
      expect(li.querySelector('.ac-mini-tag')).toBeNull();
      expect(li.hasAttribute('data-diff-fallback-reason')).toBe(false);
      expect(li.querySelector('img')).not.toBeNull();
      expect(li.querySelector('.ac-del-span')?.textContent).toBe('alpha');
      expect(li.querySelector('.ac-add-span')?.textContent).toBe('beta');
      // The image's own leading space survives exactly once.
      expect(li.textContent).toBe(' alphabeta');
      await expectFullReconstruction(li, oldSrc, newSrc);
    });
  });

  // Secondary correction: loose lists (blank line between items, so remark
  // wraps each item's own content in a <p>) previously got ZERO intraline
  // support — buildSlots only read li's direct children, and a <p>-wrapped
  // item's content was never seen as "clean" — and, when they fell back,
  // the reported reason was the misleading "formatting or link boundary"
  // message even though no formatting/link was involved. This leaf now
  // descends into a single-<p>-child li (a nested <ul>/<ol> sibling of that
  // <p> is unaffected — still skipped exactly as for a tight item), and
  // gives the still-unsupported multi-paragraph shape its own accurate
  // reason instead.
  describe('loose lists (local_repo_explorer-rendered-md-per-item-diff-bibv.2 REJECT correction)', () => {
    it('renders clean intraline spans for a loose list item (blank-line-separated, <li><p> shape)', async () => {
      const oldSrc = ['- one', '', '- two', ''].join('\n');
      const newSrc = ['- one', '', '- TWO revised', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

      const edited = container.querySelectorAll('li')[1];
      expect(edited.classList.contains('ac-item-edited')).toBe(true);
      expect(edited.querySelector('.ac-mini-tag')).toBeNull();
      expect(edited.hasAttribute('data-diff-fallback-reason')).toBe(false);
      expect(edited.querySelector('.ac-del-span')?.textContent).toBe('two');
      expect(edited.querySelector('.ac-add-span')?.textContent).toBe('TWO revised');
      // Genuinely the loose shape — the <p> wrapper is still there.
      expect(edited.querySelector('p')).not.toBeNull();
      await expectFullReconstruction(edited, oldSrc, newSrc, 1);
    });

    it('renders clean intraline spans for a LOOSE GFM task-list item (checkbox inside the <p> wrapper)', async () => {
      // A loose list makes every item's content a <li><p>...</p></li> — for
      // a task-list item specifically, the checkbox <input> renders as the
      // <p>'s OWN first child (verified via direct rendering), so this
      // exercises BOTH REQUIRED FIX cases at once: a leading opaque slot
      // with no text (the checkbox) AND the loose <p>-descent from the
      // SECONDARY correction — exactly the "loose GFM task-list item" case
      // local_repo_explorer-rendered-md-per-item-diff-bibv.2's 2nd REJECT
      // named as silently corrupted.
      const oldSrc = ['- [ ] one', '', '- [ ] two', ''].join('\n');
      const newSrc = ['- [ ] one', '', '- [ ] TWO revised', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

      const edited = container.querySelectorAll('li')[1];
      expect(edited.classList.contains('ac-item-edited')).toBe(true);
      expect(edited.querySelector('input[type="checkbox"]')).not.toBeNull();
      expect(edited.querySelector('.ac-mini-tag')).toBeNull();
      expect(edited.hasAttribute('data-diff-fallback-reason')).toBe(false);
      expect(edited.querySelector('.ac-del-span')?.textContent).toBe('two');
      expect(edited.querySelector('.ac-add-span')?.textContent).toBe('TWO revised');
      expect(edited.querySelector('p')).not.toBeNull();
      await expectFullReconstruction(edited, oldSrc, newSrc, 1);
    });

    it('gives a multi-paragraph loose item its own accurate reason, not the formatting/link message', async () => {
      const oldSrc = ['- one', '', '  second para', '', '- two', ''].join('\n');
      const newSrc = ['- ONE revised', '', '  second para', '', '- two', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

      const edited = container.querySelectorAll('li')[0];
      expect(edited.classList.contains('ac-item-edited')).toBe(true);
      expect(edited.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      expect(edited.querySelector('.ac-del-span')).toBeNull();
      expect(edited.querySelector('.ac-add-span')).toBeNull();
      // Accurate: no formatting or link is involved — this item just has
      // more than one paragraph, which isn't (yet) supported.
      expect(edited.getAttribute('data-diff-fallback-reason')).toBe(
        'item spans multiple paragraphs',
      );
      expect(edited.querySelectorAll('p')).toHaveLength(2);
    });

    it('supports a loose list item that also has a nested sub-list sibling of its <p>', async () => {
      const oldSrc = ['- one', '', '  - nested', '', '- two', ''].join('\n');
      const newSrc = ['- ONE revised', '', '  - nested', '', '- two', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('li ul, li ol')).not.toBeNull());

      const [parent, child] = Array.from(container.querySelectorAll('li'));
      expect(parent.classList.contains('ac-item-edited')).toBe(true);
      expect(parent.hasAttribute('data-diff-fallback-reason')).toBe(false);
      expect(parent.querySelector('.ac-del-span')?.textContent).toBe('one');
      expect(parent.querySelector('.ac-add-span')?.textContent).toBe('ONE revised');
      // The nested list is untouched, still present as a sibling of the <p>
      // — never spliced into (see `Slot`'s `skip` case).
      expect(parent.querySelector('ul')).not.toBeNull();
      expect(child.textContent).toBe('nested');
      expect(child.querySelector('.ac-del-span')).toBeNull();
      expect(child.querySelector('.ac-add-span')).toBeNull();
      await expectFullReconstruction(parent, oldSrc, newSrc, 0);
    });
  });
});

describe('RenderedMarkdown — ghost rows for removed list items (local_repo_explorer-rendered-md-per-item-diff-bibv.3)', () => {
  /** `li`'s own text with any mini-tag's label stripped out — the item's
   *  displayed content alone, for order/content assertions below. */
  function textWithoutTag(li: Element): string {
    const clone = li.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('.ac-mini-tag').forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  /** Mirrors the CSS spec's `list-item` counter algorithm well enough to
   *  compute the ACTUAL browser-displayed ordinal of every <li> in an <ol>
   *  from DOM state alone — jsdom does no layout/counter rendering, so
   *  reading `li.value` directly can't prove "the displayed number is
   *  unaffected" for an item that never got an explicit value at all (its
   *  IDL `.value` defaults to 0, not its position). Each item's effective
   *  ordinal is its OWN explicit `value` when present (overriding whatever
   *  came before it — the real CSS counter rule), else the previous item's
   *  effective ordinal + 1; `ol[start]` seeds the count (default 1). */
  function effectiveOrdinals(ol: HTMLOListElement): number[] {
    const startAttr = ol.getAttribute('start');
    let next = startAttr ? Number(startAttr) : 1;
    const out: number[] = [];
    for (const child of Array.from(ol.children)) {
      if (child.tagName !== 'LI') continue;
      const li = child as HTMLLIElement;
      const explicit = li.getAttribute('value');
      const ordinal = explicit != null && explicit !== '' ? Number(explicit) : next;
      out.push(ordinal);
      next = ordinal + 1;
    }
    return out;
  }

  it('renders a ghost row for a removed middle item, positioned between its original neighbors', async () => {
    const oldSrc = [
      '- Buy milk',
      '- Buy whole wheat bread',
      '- Buy paper towels',
      '- Buy eggs',
      '',
    ].join('\n');
    const newSrc = ['- Buy milk', '- Buy whole wheat bread', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(4));

    const items = Array.from(container.querySelectorAll('ul > li'));
    expect(items).toHaveLength(4);
    expect(items.map(textWithoutTag)).toEqual([
      'Buy milk',
      'Buy whole wheat bread',
      'Buy paper towels',
      'Buy eggs',
    ]);
    const ghost = items[2];
    expect(ghost.classList.contains('ac-item-removed')).toBe(true);
    expect(ghost.querySelector('.ac-mini-tag-removed')?.textContent).toBe('removed');
    expect(ghost.hasAttribute('data-start-line')).toBe(false);
    expect(ghost.hasAttribute('data-end-line')).toBe(false);
    // Neighbors are untouched real items.
    for (const li of [items[0], items[1], items[3]]) {
      expect(li.classList.contains('ac-item-removed')).toBe(false);
    }
  });

  it('renders the ghost at the top when the FIRST item is removed', async () => {
    const oldSrc = ['- Buy paper towels', '- Buy milk', '- Buy eggs', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const items = Array.from(container.querySelectorAll('ul > li'));
    expect(items.map(textWithoutTag)).toEqual(['Buy paper towels', 'Buy milk', 'Buy eggs']);
    expect(items[0].classList.contains('ac-item-removed')).toBe(true);
  });

  it('renders the ghost at the bottom when the LAST item is removed', async () => {
    const oldSrc = ['- Buy milk', '- Buy eggs', '- Buy paper towels', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const items = Array.from(container.querySelectorAll('ul > li'));
    expect(items.map(textWithoutTag)).toEqual(['Buy milk', 'Buy eggs', 'Buy paper towels']);
    expect(items[2].classList.contains('ac-item-removed')).toBe(true);
  });

  it('renders two ghost rows in original relative order for adjacent deletions', async () => {
    const oldSrc = [
      '- Buy milk',
      '- Buy whole wheat bread',
      '- Buy paper towels',
      '- Buy eggs',
      '',
    ].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(4));

    const items = Array.from(container.querySelectorAll('ul > li'));
    expect(items.map(textWithoutTag)).toEqual([
      'Buy milk',
      'Buy whole wheat bread',
      'Buy paper towels',
      'Buy eggs',
    ]);
    expect(items[1].classList.contains('ac-item-removed')).toBe(true);
    expect(items[2].classList.contains('ac-item-removed')).toBe(true);
  });

  it('produces no ghost output (and does not crash) when an entire list is deleted', async () => {
    const oldSrc = ['# Notes', '', '- one', '- two', '- three', ''].join('\n');
    const newSrc = ['# Notes', '', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(container.querySelectorAll('li').length).toBe(0);
    expect(container.querySelectorAll('.ac-item-removed').length).toBe(0);
  });

  it('synthesizes no ghost rows when oldSource is absent (undefined or null)', async () => {
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    for (const oldSource of [undefined, null] as const) {
      const { container, unmount } = setup(newSrc, { oldSource, changedLineSet: new Set() });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));
      expect(container.querySelectorAll('.ac-item-removed').length).toBe(0);
      unmount();
    }
  });

  it('flattens a removed item containing a link and bold text to plain text (no markup reaches the DOM)', async () => {
    const oldSrc = [
      '- Buy milk',
      '- Order the [report](https://example.com/doc) **today**',
      '- Buy eggs',
      '',
    ].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const ghost = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-removed'),
    )!;
    expect(ghost.querySelector('a')).toBeNull();
    expect(ghost.querySelector('strong')).toBeNull();
    expect(textWithoutTag(ghost)).toBe('Order the report today');
  });

  it('renders a removed item containing markup-shaped text as inert plain text (XSS-shaped input)', async () => {
    const oldSrc = [
      '- Buy milk',
      '- Reminder: <img src=x onerror=alert(1)> check pantry',
      '- Buy eggs',
      '',
    ].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const ghost = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-removed'),
    )!;
    expect(ghost).toBeTruthy();
    // No element was ever created from the markup-shaped text anywhere in
    // the tree — proof it was never parsed as HTML.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    // The literal text — angle brackets included — survives as inert text.
    expect(textWithoutTag(ghost)).toContain('<img src=x onerror=alert(1)>');
    // It arrived as an actual DOM Text node (never assigned via innerHTML,
    // which would have parsed it into an <img> element instead).
    const textNode = Array.from(ghost.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    expect(textNode?.textContent).toContain('<img');
  });

  it("keeps real items' effective ordinals identical to a ghost-free render (ordered list, middle deletion)", async () => {
    const oldOrdered = ['1. first', '2. second', '3. third', '4. fourth', ''].join('\n');
    const newOrdered = ['1. first', '2. third', '3. fourth', ''].join('\n'); // "second" removed

    const { container: withGhost } = setup(newOrdered, {
      oldSource: oldOrdered,
      changedLineSet: new Set(),
    });
    await waitFor(() => expect(withGhost.querySelectorAll('li').length).toBe(4));
    const ghostOl = withGhost.querySelector('ol') as HTMLOListElement;
    const ghostLis = Array.from(ghostOl.children) as HTMLLIElement[];
    expect(ghostLis.filter((li) => li.classList.contains('ac-item-removed'))).toHaveLength(1);

    const { container: plain } = setup(newOrdered);
    await waitFor(() => expect(plain.querySelectorAll('li').length).toBe(3));
    const plainOl = plain.querySelector('ol') as HTMLOListElement;

    const withGhostOrdinals = effectiveOrdinals(ghostOl);
    const realOrdinals = withGhostOrdinals.filter(
      (_, i) => !ghostLis[i].classList.contains('ac-item-removed'),
    );
    const plainOrdinals = effectiveOrdinals(plainOl);

    // The actual claim under test: every REAL item's effective (browser-
    // computed) ordinal is identical with and without the ghost present.
    expect(realOrdinals).toEqual(plainOrdinals);
    expect(plainOrdinals).toEqual([1, 2, 3]); // sanity: the natural, ghost-free sequence
  });

  it('keeps ordinals correct when the ghost is inserted at the very start of an ordered list', async () => {
    const oldOrdered = ['1. first', '2. second', '3. third', ''].join('\n');
    const newOrdered = ['1. second', '2. third', ''].join('\n'); // "first" removed
    const { container } = setup(newOrdered, { oldSource: oldOrdered, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const ol = container.querySelector('ol') as HTMLOListElement;
    const lis = Array.from(ol.children) as HTMLLIElement[];
    expect(lis[0].classList.contains('ac-item-removed')).toBe(true);
    const ordinals = effectiveOrdinals(ol);
    const realOrdinals = ordinals.filter((_, i) => !lis[i].classList.contains('ac-item-removed'));
    expect(realOrdinals).toEqual([1, 2]);
  });

  it('shows the note "+" affordance when hovering a real sibling item (sanity: the hover mechanism works)', async () => {
    const oldSrc = ['- Buy milk', '- Buy paper towels', '- Buy eggs', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, {
      oldSource: oldSrc,
      changedLineSet: new Set(),
      filePath: 'shopping-list.md',
    });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const real = Array.from(container.querySelectorAll('li')).find((li) =>
      li.textContent?.includes('Buy eggs'),
    )!;
    fireEvent.mouseMove(real);
    expect(container.querySelector('button[title^="Add a note on line"]')).not.toBeNull();
  });

  it('never shows the note "+" affordance when hovering a ghost row (no note thread can ever anchor to it)', async () => {
    const oldSrc = ['- Buy milk', '- Buy paper towels', '- Buy eggs', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, {
      oldSource: oldSrc,
      changedLineSet: new Set(),
      filePath: 'shopping-list.md',
    });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const ghost = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-removed'),
    )!;
    expect(ghost.hasAttribute('data-start-line')).toBe(false);
    expect(ghost.hasAttribute('data-end-line')).toBe(false);

    fireEvent.mouseMove(ghost);
    // Without markdown.tsx's `.closest('.ac-item-removed')` guard in
    // BlockView's onMove, this would still resolve to the ENCLOSING real
    // list/item's own data-start-line (the ghost itself lacks the attribute,
    // but `.closest('[data-start-line]')` would keep walking up past it) and
    // incorrectly show the "+" anchored to that ancestor's line instead.
    expect(container.querySelector('button[title^="Add a note on line"]')).toBeNull();
  });
});

describe('RenderedMarkdown — fallback detail marker (local_repo_explorer-rendered-md-per-item-diff-bibv.4)', () => {
  // A link-text edit is the Contract's own canonical fallback example (an
  // edit inside a link's text can never cleanly splice — see leaf .2's
  // "falls back to the whole-item treatment ... inside a link's text" test).
  // Reused as the base fixture for every marker assertion below.
  const oldLinkSrc = '- Order the [report](https://example.com/doc) today\n';
  const newLinkSrc = '- Order the [file](https://example.com/doc) today\n';

  function setupFallback(props: Record<string, unknown> = {}) {
    return setup(newLinkSrc, { oldSource: oldLinkSrc, changedLineSet: new Set([1]), ...props });
  }

  it('renders the marker with the amber rail, changed mini-tag, and verbatim before/after source text (not the flattened pairing text)', async () => {
    const { container } = setupFallback();
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.classList.contains('ac-item-edited')).toBe(true);
    expect(li.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(li.querySelector('details.ac-detail')).not.toBeNull();

    // VERBATIM raw source lines — including the "- " marker and the
    // unflattened [text](href) link syntax — never extractListItems'
    // markup-flattened pairing text (which would read "Order the report
    // today" / "Order the file today", with no markdown syntax at all).
    const before = li.querySelector('.ac-before');
    const after = li.querySelector('.ac-after');
    expect(before?.textContent).toBe('- Order the [report](https://example.com/doc) today');
    expect(after?.textContent).toBe('- Order the [file](https://example.com/doc) today');
  });

  it('shows a real difference for the formatting-only degenerate case that flattened text cannot distinguish (*em* -> **em**)', async () => {
    // The exact scenario the Contract calls out by name: leaf .2 routes an
    // item here specifically because its flattened text is IDENTICAL on
    // both sides ("no word-level change detected"). A marker built from
    // that flattened text would render two identical rows — reproducing the
    // very "no visible difference" state the marker exists to avoid. The
    // verbatim source slice must not.
    const { container } = setup('- **stress** test\n', {
      oldSource: '- *stress* test\n',
      changedLineSet: new Set([1]),
    });
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');
    const before = li.querySelector('.ac-before')?.textContent;
    const after = li.querySelector('.ac-after')?.textContent;
    expect(before).toBe('- *stress* test');
    expect(after).toBe('- **stress** test');
    expect(before).not.toBe(after);
  });

  it('shows a real difference for a GFM task-list checkbox toggle, which remark-gfm never puts in the item’s own flattened text at all', async () => {
    // A second, independent way to reach "flattened text can't show it": a
    // checked-state change is consumed into a boolean by remark-gfm, never
    // into the item's own text, so old/new flattened text is identical here
    // too (verified: falls back with the same "no word-level change
    // detected" reason as the em/strong case above).
    const { container } = setup('- [x] water the plants\n', {
      oldSource: '- [ ] water the plants\n',
      changedLineSet: new Set([1]),
    });
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');
    const before = li.querySelector('.ac-before')?.textContent;
    const after = li.querySelector('.ac-after')?.textContent;
    expect(before).toBe('- [ ] water the plants');
    expect(after).toBe('- [x] water the plants');
    expect(before).not.toBe(after);
  });

  it('renders no marker for a CLEAN intraline-diff edited item', async () => {
    const { container } = setup('- Buy sourdough bread\n', {
      oldSource: '- Buy whole wheat bread\n',
      changedLineSet: new Set([1]),
    });
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    expect(li.classList.contains('ac-item-edited')).toBe(true);
    expect(li.querySelector('.ac-add-span')).not.toBeNull(); // sanity: the clean path was taken
    expect(li.querySelector('.ac-mini-tag')).toBeNull();
    expect(li.querySelector('details.ac-detail')).toBeNull();
    expect(li.querySelector('.ac-hover-tip')).toBeNull();
  });

  it('renders no marker for an added item', async () => {
    const { container } = setup(['- item one', '- item two', ''].join('\n'), {
      oldSource: ['- item one', ''].join('\n'),
      changedLineSet: new Set([2]),
    });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

    const added = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-added'),
    )!;
    expect(added.querySelector('details.ac-detail')).toBeNull();
    expect(added.querySelector('.ac-hover-tip')).toBeNull();
  });

  it('renders no marker for a removed (ghost) item', async () => {
    const oldSrc = ['- Buy milk', '- Buy paper towels', '- Buy eggs', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

    const ghost = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-removed'),
    )!;
    expect(ghost.querySelector('details.ac-detail')).toBeNull();
    expect(ghost.querySelector('.ac-hover-tip')).toBeNull();
  });

  it('the marker is Tab-reachable, has an accessible name, and toggles open/closed on activation', async () => {
    const { container } = setupFallback();
    await waitFor(() => expect(container.querySelector('summary')).not.toBeNull());

    const summary = container.querySelector('summary') as HTMLElement;
    const details = container.querySelector('details.ac-detail') as HTMLDetailsElement;
    // Keyboard-reachable: a native <summary> is implicitly in the Tab order
    // (tabIndex 0) with no explicit tabindex needed — part of what "keep it
    // native" buys for free per the design record.
    expect(summary.tabIndex).toBe(0);
    expect(summary.getAttribute('title') || summary.getAttribute('aria-label')).toBeTruthy();

    // jsdom does not synthesize a `click` from an Enter/Space keydown on a
    // focused <summary> the way real browsers do (confirmed by direct probe:
    // keyDown('Enter'/' ') on a focused summary leaves `.open` unchanged in
    // jsdom, while a real click toggles it in both jsdom and real browsers)
    // — that keyboard-to-click translation is native browser/engine
    // behavior the design deliberately relies on `<details>` to provide "for
    // free," not something application code implements or should
    // reimplement. `fireEvent.click` below exercises the exact activation
    // handling this code DOES own; genuine Enter/Space-in-a-real-browser
    // behavior is confirmed by the manual Content-panel check recorded as
    // bead evidence.
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('activating the marker does not trigger onBlockClick and does not go through the anchor-routing click handler', async () => {
    const onBlockClick = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = setupFallback({ onBlockClick });
    await waitFor(() => expect(container.querySelector('summary')).not.toBeNull());

    fireEvent.click(container.querySelector('summary')!);

    expect(onBlockClick).not.toHaveBeenCalled();
    // handleRootClick (the anchor-routing handler) only ever acts on a
    // `.closest('a')` match and, for an external link, opens it via
    // `window.open` — the decisive proof it never engaged for this click is
    // that side effect never firing.
    expect(openSpy).not.toHaveBeenCalled();

    // A normal click elsewhere on the SAME item is unaffected by the guard —
    // proves this isn't an accidental blanket click suppression.
    fireEvent.click(container.querySelector('li')!);
    expect(onBlockClick).toHaveBeenCalledTimes(1);

    openSpy.mockRestore();
  });

  it('does not trigger onBlockClick for a click inside the revealed before/after body either', async () => {
    const onBlockClick = vi.fn();
    const { container } = setupFallback({ onBlockClick });
    await waitFor(() => expect(container.querySelector('summary')).not.toBeNull());

    fireEvent.click(container.querySelector('summary')!); // open it
    expect(container.querySelector('details.ac-detail')?.hasAttribute('open')).toBe(true);
    fireEvent.click(container.querySelector('.ac-before')!);
    expect(onBlockClick).not.toHaveBeenCalled();
  });

  it('reopening the file (remount) shows the marker closed again', async () => {
    const first = setupFallback();
    await waitFor(() => expect(first.container.querySelector('summary')).not.toBeNull());
    fireEvent.click(first.container.querySelector('summary')!);
    expect(first.container.querySelector('details.ac-detail')?.hasAttribute('open')).toBe(true);
    first.unmount();

    // A genuine remount (switching away from and back to this file) is a
    // fresh component instance with no persisted marker state (design
    // record, "State Ownership": ephemeral native DOM state only).
    const second = setupFallback();
    await waitFor(() => expect(second.container.querySelector('summary')).not.toBeNull());
    expect(second.container.querySelector('details.ac-detail')?.hasAttribute('open')).toBe(false);
  });

  it('renders markdown/HTML-like before/after text as literal text, never as markup', async () => {
    // The stray inline HTML sits OUTSIDE the link (so it's real inline-HTML
    // content the rendered pipeline already sanitizes independently); the
    // link-text edit (pantry -> fridge) is what forces the fallback path.
    // Reuses the exact XSS-shaped payload leaf .3's ghost-row test uses, so
    // a regression here is caught the identical way.
    const oldSrc =
      '- Reminder: <img src=x onerror=alert(1)> check the [pantry](https://example.com/list)\n';
    const newSrc =
      '- Reminder: <img src=x onerror=alert(1)> check the [fridge](https://example.com/list)\n';
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    const body = li.querySelector('.ac-detail-body')!;
    expect(body.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    const before = body.querySelector('.ac-before')!;
    const after = body.querySelector('.ac-after')!;
    expect(before.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(after.textContent).toContain('<img src=x onerror=alert(1)>');
    // Arrived as an actual Text node (never assigned via innerHTML, which
    // would have parsed it into a real <img> element instead).
    const beforeTextNode = Array.from(before.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    expect(beforeTextNode?.textContent).toContain('<img');
  });

  it('renders a hover quick preview carrying the mapper-reported reason, hidden from the accessibility tree, present only on the fallback item', async () => {
    const { container } = setupFallback();
    await waitFor(() => expect(container.querySelector('li')).not.toBeNull());

    const li = container.querySelector('li')!;
    const tip = li.querySelector('.ac-hover-tip');
    expect(tip).not.toBeNull();
    // Same string the marker's own "why" row shows — never a mouse-only
    // fact (docs/design/ui-rendered-markdown-diff.md's requirement that
    // everything the tip conveys stays reachable without a mouse) — and the
    // real mapper-reported reason, never an invented one.
    expect(tip?.textContent).toBe(li.getAttribute('data-diff-fallback-reason'));
    expect(tip?.textContent).toBe(li.querySelector('.ac-detail-reason')?.textContent);
    expect(tip?.textContent).toBe('edit crosses a formatting or link boundary');
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
  });

  it('the hover tip never appears on a clean-diff, added, or ghost item', async () => {
    const { container: clean } = setup('- Buy sourdough bread\n', {
      oldSource: '- Buy whole wheat bread\n',
      changedLineSet: new Set([1]),
    });
    await waitFor(() => expect(clean.querySelector('li')).not.toBeNull());
    expect(clean.querySelector('.ac-hover-tip')).toBeNull();

    const { container: added } = setup(['- item one', '- item two', ''].join('\n'), {
      oldSource: ['- item one', ''].join('\n'),
      changedLineSet: new Set([2]),
    });
    await waitFor(() => expect(added.querySelectorAll('li').length).toBe(2));
    expect(added.querySelector('.ac-hover-tip')).toBeNull();

    const oldSrc = ['- Buy milk', '- Buy paper towels', '- Buy eggs', ''].join('\n');
    const newSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
    const { container: ghosted } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(ghosted.querySelectorAll('li').length).toBe(3));
    expect(ghosted.querySelector('.ac-hover-tip')).toBeNull();
  });

  describe('nested-list fallback (local_repo_explorer-rendered-md-per-item-diff-bibv.4 REJECT correction)', () => {
    it("positions the marker and hover tip before the item's own DIRECT nested sublist, not after it", async () => {
      // A parent item that both (a) triggers the fallback path (edit inside
      // a link — the same trigger `setupFallback` uses above) AND (b) has a
      // direct nested sublist of its own: the exact shape `appendDetailMarker`
      // previously got wrong. It used to `li.appendChild` unconditionally,
      // which landed the marker/tip AFTER the nested sublist instead of
      // inline after the parent's own text, visually misattributing the
      // change to the sublist's last item. Every other fallback test above
      // uses a flat, single-line list and cannot catch this class of bug.
      const oldSrc = [
        '- Order the [report](https://example.com/doc) today',
        '  - a sub-item',
        '',
      ].join('\n');
      const newSrc = [
        '- Order the [file](https://example.com/doc) today',
        '  - a sub-item',
        '',
      ].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('li ul, li ol')).not.toBeNull());

      const parent = container.querySelector('li')!;
      expect(parent.classList.contains('ac-item-edited')).toBe(true);
      expect(parent.getAttribute('data-diff-fallback-reason')).toBeTruthy(); // sanity: fallback path taken

      const details = parent.querySelector('details.ac-detail')!;
      const tip = parent.querySelector('.ac-hover-tip')!;
      const nestedList = parent.querySelector('ul, ol')!;
      expect(details).not.toBeNull();
      expect(tip).not.toBeNull();
      expect(nestedList).not.toBeNull();

      // Direct-child order on the parent itself: details, then tip, then the
      // nested sublist — never the sublist first. `.children` walks only the
      // parent's OWN direct Element children, in document order.
      const directChildren = Array.from(parent.children);
      expect(directChildren.indexOf(details)).toBeGreaterThanOrEqual(0);
      expect(directChildren.indexOf(tip)).toBeGreaterThanOrEqual(0);
      expect(directChildren.indexOf(nestedList)).toBeGreaterThanOrEqual(0);
      expect(directChildren.indexOf(details)).toBeLessThan(directChildren.indexOf(nestedList));
      expect(directChildren.indexOf(tip)).toBeLessThan(directChildren.indexOf(nestedList));

      // Independent confirmation via compareDocumentPosition: the nested
      // list FOLLOWS both the marker and the tip in tree order.
      expect(details.compareDocumentPosition(nestedList) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(tip.compareDocumentPosition(nestedList) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );

      // The nested sub-item itself is untouched — no marker/tip meant for
      // the parent leaked into it.
      const nestedItem = nestedList.querySelector('li')!;
      expect(nestedItem.querySelector('details.ac-detail')).toBeNull();
      expect(nestedItem.querySelector('.ac-hover-tip')).toBeNull();
    });
  });
});

describe('RenderedMarkdown — prose intraline diff for paragraphs & headings (local_repo_explorer-rendered-md-nonlist-diff-ek7c.1)', () => {
  it('a clean single-word paragraph edit renders del/add spans inline, amber rail, no mini-tag, no marker — and the enclosing BlockView shows neither accent wash nor ChangedTag', async () => {
    const oldSrc = ['Some intro text.', '', 'The terminal now reconnects automatically.', ''].join(
      '\n',
    );
    const newSrc = ['Some intro text.', '', 'The terminal now recovers automatically.', ''].join(
      '\n',
    );
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelectorAll('p').length).toBe(2));

    const paras = Array.from(container.querySelectorAll('p'));
    const untouched = paras.find((p) => p.textContent?.includes('intro'))!;
    const edited = paras.find((p) => p.textContent?.includes('automatically'))!;

    expect(edited.classList.contains('ac-prose-changed')).toBe(true);
    expect(edited.querySelector('.ac-mini-tag')).toBeNull();
    expect(edited.querySelector('details.ac-detail')).toBeNull();
    const del = edited.querySelector('.ac-del-span');
    const add = edited.querySelector('.ac-add-span');
    expect(del?.textContent).toBe('reconnects');
    expect(add?.textContent).toBe('recovers');

    // Enclosing BlockView shows neither the accent wash nor the ChangedTag —
    // blockChanged is false because decoratedHtml took over the treatment.
    expect(hasBlockChangedTag(edited)).toBe(false);

    // Untouched sibling paragraph: zero decoration.
    expect(untouched.className).not.toMatch(/ac-prose-/);
    expect(hasBlockChangedTag(untouched)).toBe(false);
  });

  it('sibling paragraphs and headings that did not change render with zero decoration', async () => {
    const oldSrc = ['# Title', '', 'First paragraph.', '', 'Second paragraph old.', ''].join('\n');
    const newSrc = ['# Title', '', 'First paragraph.', '', 'Second paragraph new.', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([5]) });
    await waitFor(() => expect(container.querySelectorAll('p').length).toBe(2));

    const h1 = container.querySelector('h1')!;
    const paras = Array.from(container.querySelectorAll('p'));
    const untouched = paras.find((p) => p.textContent?.includes('First paragraph'))!;
    const edited = paras.find((p) => p.textContent?.includes('Second paragraph'))!;

    expect(h1.className).not.toMatch(/ac-prose-/);
    expect(untouched.className).not.toMatch(/ac-prose-/);
    expect(edited.classList.contains('ac-prose-changed')).toBe(true);
  });

  it('a heading edit is treated identically to a paragraph edit (both are single units)', async () => {
    const oldSrc = ['## Old heading text', ''].join('\n');
    const newSrc = ['## New heading text', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('h2')).not.toBeNull());

    const h2 = container.querySelector('h2')!;
    expect(h2.classList.contains('ac-prose-changed')).toBe(true);
    expect(h2.querySelector('.ac-mini-tag')).toBeNull();
    const del = h2.querySelector('.ac-del-span');
    const add = h2.querySelector('.ac-add-span');
    expect(del?.textContent).toBe('Old');
    expect(add?.textContent).toBe('New');
  });

  it('a heading never pairs with a paragraph even when their flattened text coincides', async () => {
    // Old side: a plain paragraph. New side: a heading with the SAME text.
    // markdownItemDiff.test.ts's unit-level tests already prove `pairUnits`
    // itself keeps 'p'/'h1' buckets separate; this proves it end-to-end
    // through RenderedMarkdown: the heading must render as ADDED (no old
    // counterpart), never paired against the unrelated old paragraph.
    const oldSrc = ['Shared text', ''].join('\n');
    const newSrc = ['# Shared text', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());

    const h1 = container.querySelector('h1')!;
    expect(h1.classList.contains('ac-prose-added')).toBe(true);
    expect(h1.classList.contains('ac-prose-changed')).toBe(false);
  });

  it('a wholly-new paragraph renders the green prose rail and no mini-tag', async () => {
    const oldSrc = ['First paragraph.', ''].join('\n');
    const newSrc = ['First paragraph.', '', 'Brand new paragraph.', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelectorAll('p').length).toBe(2));

    const added = Array.from(container.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('Brand new'),
    )!;
    expect(added.classList.contains('ac-prose-added')).toBe(true);
    expect(added.querySelector('.ac-mini-tag')).toBeNull();
    expect(added.querySelector('details.ac-detail')).toBeNull();
  });

  it('a wholly-new heading renders the green prose rail and no mini-tag', async () => {
    const oldSrc = ['# Title', ''].join('\n');
    const newSrc = ['# Title', '', '## New Section', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelector('h2')).not.toBeNull());

    const h2 = container.querySelector('h2')!;
    expect(h2.classList.contains('ac-prose-added')).toBe(true);
    expect(h2.querySelector('.ac-mini-tag')).toBeNull();
  });

  describe('fallback marker (edit crosses a formatting/link boundary)', () => {
    const oldSrc = 'Order the [report](https://example.com/doc) today\n';
    const newSrc = 'Order the [file](https://example.com/doc) today\n';

    it('on a HEADING, the marker nests as a real direct child (unlike the <p> sibling-wrapper case — headings have no <p>-specific HTML-parsing restriction)', async () => {
      const oldHeadingSrc = '## Order the [report](https://example.com/doc) today\n';
      const newHeadingSrc = '## Order the [file](https://example.com/doc) today\n';
      const { container } = setup(newHeadingSrc, {
        oldSource: oldHeadingSrc,
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(container.querySelector('h2')).not.toBeNull());

      const h2 = container.querySelector('h2')!;
      expect(h2.classList.contains('ac-prose-changed')).toBe(true);
      expect(h2.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      // Unlike the <p> case, the marker and tip DO nest as real descendants
      // of the heading itself (no spurious sibling relocation — headings
      // don't trigger the HTML parser's "close a p element" step).
      expect(h2.querySelector('details.ac-detail')).not.toBeNull();
      expect(h2.querySelector('.ac-hover-tip')).not.toBeNull();
      const before = h2.querySelector('.ac-before');
      const after = h2.querySelector('.ac-after');
      expect(before?.textContent).toBe('## Order the [report](https://example.com/doc) today');
      expect(after?.textContent).toBe('## Order the [file](https://example.com/doc) today');
    });

    it('falls back to the amber rail + changed mini-tag + verbatim before/after marker', async () => {
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('p')).not.toBeNull());

      const p = container.querySelector('p')!;
      expect(p.classList.contains('ac-prose-changed')).toBe(true);
      expect(p.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      expect(p.getAttribute('data-diff-fallback-reason')).toBe(
        'edit crosses a formatting or link boundary',
      );
      // The marker is a SIBLING of `<p>` in the rendered DOM, not a
      // descendant — `<details>` is flow content and cannot survive being
      // nested inside a `<p>` through the serialize+reparse round-trip
      // `dangerouslySetInnerHTML` performs (decorateProseBlock's own doc
      // comment has the full HTML-parsing rationale); look it up at the
      // container level, immediately following the paragraph.
      expect(container.querySelector('details.ac-detail')).not.toBeNull();
      expect(p.nextElementSibling?.matches('details.ac-detail')).toBe(true);

      // VERBATIM raw source — never the markup-flattened pairing text.
      const before = container.querySelector('.ac-before');
      const after = container.querySelector('.ac-after');
      expect(before?.textContent).toBe('Order the [report](https://example.com/doc) today');
      expect(after?.textContent).toBe('Order the [file](https://example.com/doc) today');
    });

    it('carries the hover quick preview (a sibling of the paragraph, not a descendant — see decorateProseBlock), hidden from the accessibility tree', async () => {
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('p')).not.toBeNull());

      const p = container.querySelector('p')!;
      const tip = container.querySelector('.ac-hover-tip');
      expect(tip).not.toBeNull();
      expect(p.contains(tip)).toBe(false); // sibling, not nested inside <p>
      expect(tip?.textContent).toBe(p.getAttribute('data-diff-fallback-reason'));
      expect(tip?.textContent).toBe(container.querySelector('.ac-detail-reason')?.textContent);
      expect(tip?.getAttribute('aria-hidden')).toBe('true');
    });

    it('never shows the hover tip on a clean-diff or added paragraph', async () => {
      const { container: clean } = setup('Buy sourdough bread.\n', {
        oldSource: 'Buy whole wheat bread.\n',
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(clean.querySelector('p')).not.toBeNull());
      expect(clean.querySelector('.ac-hover-tip')).toBeNull();

      const { container: added } = setup(['First.', '', 'Second.', ''].join('\n'), {
        oldSource: ['First.', ''].join('\n'),
        changedLineSet: new Set([3]),
      });
      await waitFor(() => expect(added.querySelectorAll('p').length).toBe(2));
      expect(added.querySelector('.ac-hover-tip')).toBeNull();
    });

    it('does not trigger onBlockClick for a click on the marker or its revealed body (BlockView click-isolation guard is element-agnostic)', async () => {
      const onBlockClick = vi.fn();
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([1]),
        onBlockClick,
      });
      await waitFor(() => expect(container.querySelector('summary')).not.toBeNull());

      fireEvent.click(container.querySelector('summary')!);
      expect(onBlockClick).not.toHaveBeenCalled();
      expect(container.querySelector('details.ac-detail')?.hasAttribute('open')).toBe(true);

      fireEvent.click(container.querySelector('.ac-before')!);
      expect(onBlockClick).not.toHaveBeenCalled();

      // A normal click elsewhere on the SAME paragraph still reaches onBlockClick.
      fireEvent.click(container.querySelector('p')!);
      expect(onBlockClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("degradation (Contract: every paragraph/heading falls back to today's exact whole-block behavior)", () => {
    it('falls back to the whole-block treatment when oldSource is absent (undefined or null)', async () => {
      for (const oldSource of [undefined, null] as const) {
        const src = ['# Title', '', 'A paragraph.', ''].join('\n');
        const { container } = setup(src, { oldSource, changedLineSet: new Set([1]) });
        await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
        expect(container.querySelector('h1')!.className).not.toMatch(/ac-prose-/);
        expect(hasBlockChangedTag(container.querySelector('h1')!)).toBe(true);
      }
    });

    it('falls back to the whole-block treatment when changedLineSet is absent, even with oldSource', async () => {
      const oldSrc = ['# Old Title', ''].join('\n');
      const newSrc = ['# New Title', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc });
      await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
      expect(container.querySelector('h1')!.className).not.toMatch(/ac-prose-/);
      // No changedLineSet -> nothing is flagged changed at all.
      expect(hasBlockChangedTag(container.querySelector('h1')!)).toBe(false);
    });
  });

  it('list and prose per-unit classification coexist independently in the same document', async () => {
    const oldSrc = ['# Title', '', '- item one', '- item two', '', 'A paragraph.', ''].join('\n');
    const newSrc = [
      '# Title',
      '',
      '- item one',
      '- item two revised',
      '',
      'A paragraph edited.',
      '',
    ].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([4, 6]) });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

    const editedLi = Array.from(container.querySelectorAll('li')).find((li) =>
      li.classList.contains('ac-item-edited'),
    );
    expect(editedLi).toBeTruthy();

    const p = container.querySelector('p')!;
    expect(p.classList.contains('ac-prose-changed')).toBe(true);
  });
});

describe('RenderedMarkdown — fenced code-block intraline diff (local_repo_explorer-rendered-md-nonlist-diff-ek7c.2)', () => {
  /** The `<code>` element's rendered text with every `.ac-del-span`'s content
   *  removed — the code counterpart of the list-diff suite's
   *  `ownTextWithout`, minus the `ul, ol` stripping (a code block can never
   *  contain a nested list). Used to prove byte-exact reconstruction,
   *  including every newline and leading indentation, since this reads
   *  `textContent` directly off the live (already-spliced) DOM rather than
   *  any intermediate string representation. */
  function codeTextWithoutDelSpans(codeEl: Element): string {
    const clone = codeEl.cloneNode(true) as Element;
    clone.querySelectorAll('.ac-del-span').forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  /** `codeTextWithoutDelSpans`'s mirror image: strips `.ac-add-span` content
   *  instead, reconstructing the OLD text. Together the two prove no
   *  character was dropped or duplicated anywhere in the block, not just
   *  around one span — same "full reconstruction" property the list-diff
   *  suite's `expectFullReconstruction` establishes. */
  function codeTextWithoutAddSpans(codeEl: Element): string {
    const clone = codeEl.cloneNode(true) as Element;
    clone.querySelectorAll('.ac-add-span').forEach((el) => el.remove());
    return clone.textContent ?? '';
  }

  /** Renders `source` with no diffing at all and returns the FIRST `<pre
   *  code>`'s own `outerHTML` — the byte-identical-to-undecorated ground
   *  truth a fallback (`clean: false`) splice attempt must match exactly. */
  async function renderUndecoratedCodeHtml(source: string): Promise<string> {
    const { container, unmount } = setup(source);
    await waitFor(() => expect(container.querySelector('pre code')).not.toBeNull());
    const html = container.querySelector('pre code')!.outerHTML;
    unmount();
    return html;
  }

  const jsOldBody = 'const total = items.reduce((sum, item) => sum + item.price, 0);\nreturn total;';
  const jsNewBody = 'const total = items.reduce((sum, item) => sum + item.cost, 0);\nreturn total;';

  it('a clean single-token change inside a highlighted-language block splices spans inline, preserving every surrounding hljs class', async () => {
    const oldSrc = ['```js', jsOldBody, '```', ''].join('\n');
    const newSrc = ['```js', jsNewBody, '```', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    expect(pre.hasAttribute('data-diff-fallback-reason')).toBe(false);
    expect(pre.querySelector('.ac-mini-tag')).toBeNull();
    expect(pre.querySelector('details.ac-detail')).toBeNull();
    // Enclosing BlockView shows neither the legacy accent wash nor the old
    // ChangedTag — decoratedHtml took over the treatment, same as prose/list.
    expect(hasBlockChangedTag(pre)).toBe(false);

    const del = code.querySelector('.ac-del-span');
    const add = code.querySelector('.ac-add-span');
    expect(del?.textContent).toBe('price');
    expect(add?.textContent).toBe('cost');

    // Every surrounding hljs token class survives the splice untouched —
    // the whole reason this is its own leaf (see markdown.tsx's
    // buildCodeSlots doc comment). `const`/`return` are keywords; `reduce`
    // is a highlighted call target; `0` is a highlighted numeric literal.
    expect(code.className).toContain('hljs');
    expect(code.className).toContain('language-js');
    expect(code.querySelectorAll('.hljs-keyword').length).toBeGreaterThanOrEqual(2);
    expect(code.querySelector('[class*="hljs-title"]')).not.toBeNull();
    expect(code.querySelector('.hljs-number')).not.toBeNull();

    // No per-line row wrapper anywhere — the rejected line-level mockup
    // candidate's class name must never appear (word-level only).
    expect(container.querySelector('.code-line')).toBeNull();

    // Byte-exact: the rendered code text (minus the del span) reproduces the
    // NEW fence content exactly, including its trailing newline; minus the
    // add span it reproduces the OLD fence content exactly.
    expect(codeTextWithoutDelSpans(code)).toBe(`${jsNewBody}\n`);
    expect(codeTextWithoutAddSpans(code)).toBe(`${jsOldBody}\n`);
  });

  it('an unlabeled (no-language) code block gets the same word-level treatment', async () => {
    const oldSrc = ['```', jsOldBody, '```', ''].join('\n');
    const newSrc = ['```', jsNewBody, '```', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    expect(pre.hasAttribute('data-diff-fallback-reason')).toBe(false);
    expect(code.querySelector('[class*="hljs-"]')).toBeNull(); // no language -> no tokens at all
    expect(code.querySelector('.ac-del-span')?.textContent).toBe('price');
    expect(code.querySelector('.ac-add-span')?.textContent).toBe('cost');
    expect(codeTextWithoutDelSpans(code)).toBe(`${jsNewBody}\n`);
  });

  it('byte-exact reconstruction holds across two edits at different nesting depths, preserving 4- and 8-space indentation', async () => {
    const pyOldBody = 'def load(path):\n    with open(path) as f:\n        return json.load(f)';
    const pyNewBody = 'def load(path):\n    with open(path) as fh:\n        return json.load(fh)';
    const oldSrc = ['```python', pyOldBody, '```', ''].join('\n');
    const newSrc = ['```python', pyNewBody, '```', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    expect(pre.hasAttribute('data-diff-fallback-reason')).toBe(false);
    expect(code.querySelectorAll('.ac-del-span')).toHaveLength(2);
    expect(code.querySelectorAll('.ac-add-span')).toHaveLength(2);

    expect(codeTextWithoutDelSpans(code)).toBe(`${pyNewBody}\n`);
    expect(codeTextWithoutAddSpans(code)).toBe(`${pyOldBody}\n`);
  });

  it('an indentation-only change takes the documented no-word-level-change fallback, not corruption', async () => {
    const oldBody = 'if (x) {\n  doIt();\n}';
    const newBody = 'if (x) {\n    doIt();\n}';
    const oldSrc = ['```js', oldBody, '```', ''].join('\n');
    const newSrc = ['```js', newBody, '```', ''].join('\n');
    const undecoratedHtml = await renderUndecoratedCodeHtml(newSrc);

    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    expect(pre.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');
    expect(code.querySelector('.ac-del-span')).toBeNull();
    expect(code.querySelector('.ac-add-span')).toBeNull();
    // The <code> subtree itself is untouched — fails toward the fallback,
    // never toward a corrupted or partially-spliced render.
    expect(code.outerHTML).toBe(undecoratedHtml);
    expect(code.textContent).toBe(`${newBody}\n`);
  });

  it('an edit crossing a syntax-highlighting boundary falls back with a code-accurate reason, leaving the <code> subtree byte-identical to undecorated', async () => {
    const oldSrc = ['```js', 'foo();', 'baz();', '```', ''].join('\n');
    const newSrc = ['```js', 'foo();', 'const n = 1;', 'baz();', '```', ''].join('\n');
    const undecoratedHtml = await renderUndecoratedCodeHtml(newSrc);

    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    const code = pre.querySelector('code')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    expect(pre.getAttribute('data-diff-fallback-reason')).toBe(
      'edit crosses a syntax-highlighting boundary',
    );
    expect(code.querySelector('.ac-del-span')).toBeNull();
    expect(code.querySelector('.ac-add-span')).toBeNull();
    expect(code.outerHTML).toBe(undecoratedHtml); // untouched, never partially spliced

    // The mini-tag + <details> marker live OUTSIDE <pre>, as its later
    // siblings — never inside <pre> itself (invalid HTML: <pre> is phrasing
    // content only, same restriction decorateProseBlock's <p> case works
    // around).
    const wrapper = pre.parentElement!;
    expect(pre.nextElementSibling?.classList.contains('ac-mini-tag-changed')).toBe(true);
    expect(pre.nextElementSibling?.nextElementSibling?.matches('details.ac-detail')).toBe(true);

    const before = wrapper.querySelector('.ac-before');
    const after = wrapper.querySelector('.ac-after');
    expect(before?.textContent).toBe(['```js', 'foo();', 'baz();', '```'].join('\n'));
    expect(after?.textContent).toBe(['```js', 'foo();', 'const n = 1;', 'baz();', '```'].join('\n'));

    // Hover quick preview: sibling of <pre> (never nested inside it),
    // hidden from the accessibility tree, showing the same reason.
    const tip = wrapper.querySelector('.ac-hover-tip');
    expect(tip).not.toBeNull();
    expect(pre.contains(tip)).toBe(false);
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
    expect(tip?.textContent).toBe(pre.getAttribute('data-diff-fallback-reason'));
  });

  it('a code block exceeding the shared word-diff token bound falls back with a code-accurate "too large" reason', async () => {
    // MAX_WORD_DIFF_TOKENS (wordDiff.ts) is 600 and intentionally shared with
    // prose (see spliceCodeInto's doc comment); 150 lines of `const xN = N;`
    // tokenizes to 900 tokens (verified), comfortably past the bound.
    const bigBody = Array.from({ length: 150 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const oldSrc = ['```js', bigBody, '```', ''].join('\n');
    const newSrc = ['```js', bigBody.replace('x0 = 0', 'x0 = 999'), '```', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    const pre = container.querySelector('pre')!;
    expect(pre.classList.contains('ac-code-changed')).toBe(true);
    // The shipped wordDiff.ts reason ('item is too large for a word-level
    // diff') is translated to code-accurate wording at the splice call site,
    // NOT reused verbatim.
    expect(pre.getAttribute('data-diff-fallback-reason')).toBe(
      'code block is too large for a word-level diff',
    );
    expect(pre.querySelector('.ac-del-span')).toBeNull();
    expect(pre.querySelector('.ac-add-span')).toBeNull();
  });

  it('a wholly-new code block renders the green rail with no mini-tag; an untouched sibling block stays undecorated', async () => {
    const oldSrc = ['```js', 'const a = 1;', '```', ''].join('\n');
    const newSrc = ['```js', 'const a = 1;', '```', '', '```python', 'x = 1', '```', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([6]) });
    await waitFor(() => expect(container.querySelectorAll('pre').length).toBe(2));

    const pres = Array.from(container.querySelectorAll('pre'));
    const added = pres.find((p) => p.textContent?.includes('x = 1'))!;
    const untouched = pres.find((p) => p !== added)!;

    expect(added.classList.contains('ac-code-added')).toBe(true);
    expect(added.classList.contains('ac-code-changed')).toBe(false);
    expect(added.querySelector('.ac-mini-tag')).toBeNull();
    expect(added.querySelector('details.ac-detail')).toBeNull();

    expect(untouched.className).not.toMatch(/ac-code-/);
    expect(hasBlockChangedTag(untouched)).toBe(false);
  });

  it('never routes mermaid/dot/graphviz blocks into code-diff decoration, even when their content changed inside changedLineSet', async () => {
    const oldSrc = [
      '```mermaid',
      'graph TD; A-->B;',
      '```',
      '',
      '```dot',
      'digraph { a -> b; }',
      '```',
      '',
      '```js',
      'const a = 1;',
      '```',
      '',
    ].join('\n');
    const newSrc = [
      '```mermaid',
      'graph TD; A-->C;',
      '```',
      '',
      '```dot',
      'digraph { a -> c; }',
      '```',
      '',
      '```js',
      'const a = 2;',
      '```',
      '',
    ].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([2, 6, 10]) });
    await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

    // Only the real js block ever produces a <pre> — mermaid/dot render via
    // MermaidFrame/GraphvizFrame instead, neither of which emits one.
    expect(container.querySelectorAll('pre').length).toBe(1);
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toContain('const a');
    expect(container.querySelectorAll('.ac-code-changed, .ac-code-added').length).toBe(1);
    expect(
      pre.classList.contains('ac-code-changed') || pre.classList.contains('ac-code-added'),
    ).toBe(true);
  });

  describe("degradation (Contract: fenced code blocks fall back to today's exact whole-block behavior)", () => {
    const oldSrc = ['```js', 'const a = 1;', '```', ''].join('\n');
    const newSrc = ['```js', 'const a = 2;', '```', ''].join('\n');

    it('falls back to the whole-block treatment when oldSource is absent (undefined or null)', async () => {
      for (const oldSource of [undefined, null] as const) {
        const { container, unmount } = setup(newSrc, { oldSource, changedLineSet: new Set([2]) });
        await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
        const pre = container.querySelector('pre')!;
        expect(pre.className).not.toMatch(/ac-code-/);
        expect(pre.hasAttribute('data-diff-fallback-reason')).toBe(false);
        // The legacy whole-block wash/ChangedTag itself must still fire for a
        // degraded (no-decoration) code block — local_repo_explorer-rendered-md-nonlist-diff-ek7c.5's
        // fix for the general (non-decoration) startLine/endLine lookup
        // (markdown.tsx's render loop, via codeBlockStartLine/codeBlockEndLine).
        // Before that fix this could not even be asserted: a top-level `<pre>`
        // has no data-start-line of its own, so the general lookup always
        // read 0, `changed` was always false, and this "whole-block fallback"
        // test's own title was never actually true for code blocks — a code
        // block silently got NEITHER the per-unit decoration NOR the legacy
        // fallback wash, unlike every other degraded block kind. This
        // assertion is the concrete regression proof the fix closes that gap.
        expect(hasBlockChangedTag(pre)).toBe(true);
        unmount();
      }
    });

    it('falls back to the whole-block treatment when changedLineSet is absent, even with oldSource', async () => {
      const { container } = setup(newSrc, { oldSource: oldSrc });
      await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
      const pre = container.querySelector('pre')!;
      expect(pre.className).not.toMatch(/ac-code-/);
    });
  });
});

describe('RenderedMarkdown — table row diff (local_repo_explorer-rendered-md-nonlist-diff-ek7c.3)', () => {
  /** A cell's own text with any mini-tag/detail-marker/hover-tip descendant
   *  stripped out — the per-cell analogue of the ghost-list-item suite's
   *  `textWithoutTag` helper, one level more granular (a table row has
   *  several cells, not one flattened text). */
  function rowCellTexts(tr: Element): string[] {
    return Array.from(tr.querySelectorAll(':scope > td, :scope > th')).map((cell) => {
      const clone = cell.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.ac-mini-tag, .ac-detail, .ac-hover-tip').forEach((el) => el.remove());
      return clone.textContent?.trim() ?? '';
    });
  }

  const oldSrc = [
    '| Action | Shortcut |',
    '|---|---|',
    '| New tab | Cmd+T |',
    '| Close tab | Cmd+W |',
    '| Split pane | Cmd+D |',
    '',
  ].join('\n');
  const newSrcEdited = [
    '| Action | Shortcut |',
    '|---|---|',
    '| New tab | Cmd+T |',
    '| Close tab | Cmd+W |',
    '| Split pane | Cmd+E |',
    '',
  ].join('\n');

  it('decorates only the edited <tr>; only the changed cell gets intraline spans, the other cell and every other row stay undecorated', async () => {
    const { container } = setup(newSrcEdited, { oldSource: oldSrc, changedLineSet: new Set([5]) });
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

    const bodyRows = Array.from(container.querySelectorAll('tbody > tr'));
    expect(bodyRows).toHaveLength(3);
    const edited = bodyRows.find((tr) => rowCellTexts(tr)[0] === 'Split pane')!;
    const untouched = bodyRows.filter((tr) => tr !== edited);

    expect(edited.classList.contains('ac-item-edited')).toBe(true);
    const cells = Array.from(edited.querySelectorAll('td'));
    // First cell ("Split pane") is untouched by the diff.
    expect(cells[0].querySelector('.ac-del-span, .ac-add-span')).toBeNull();
    // Second cell carries the actual word-level change.
    const del = cells[1].querySelector('.ac-del-span');
    const add = cells[1].querySelector('.ac-add-span');
    expect(del?.textContent).toBe('D');
    expect(add?.textContent).toBe('E');
    expect(edited.querySelector('.ac-mini-tag')).toBeNull(); // clean diff — no fallback tag
    expect(edited.getAttribute('data-diff-fallback-reason')).toBeNull();

    for (const tr of untouched) {
      expect(tr.className).not.toMatch(/ac-item-/);
    }
    expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
  });

  it('decorates an added row in the added role with the mini-tag (tables DO tag added rows, unlike prose)', async () => {
    const oldTwoRows = ['| Action | Shortcut |', '|---|---|', '| New tab | Cmd+T |', ''].join('\n');
    const newThreeRows = [
      '| Action | Shortcut |',
      '|---|---|',
      '| New tab | Cmd+T |',
      '| Zoom pane | Cmd+Shift+Z |',
      '',
    ].join('\n');
    const { container } = setup(newThreeRows, { oldSource: oldTwoRows, changedLineSet: new Set([4]) });
    await waitFor(() => expect(container.querySelectorAll('tbody > tr').length).toBe(2));

    const rows = Array.from(container.querySelectorAll('tbody > tr'));
    const added = rows.find((tr) => rowCellTexts(tr)[0] === 'Zoom pane')!;
    const untouched = rows.find((tr) => tr !== added)!;

    expect(added.classList.contains('ac-item-added')).toBe(true);
    expect(added.querySelector('.ac-mini-tag-added')?.textContent).toBe('new');
    expect(untouched.className).not.toMatch(/ac-item-/);
    expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
  });

  it('renders a ghost row for a removed body row, positioned between its original neighbors, text-node-only content, right column count, never a note-anchor target', async () => {
    const { container } = setup(
      ['| Action | Shortcut |', '|---|---|', '| New tab | Cmd+T |', '| Split pane | Cmd+D |', ''].join(
        '\n',
      ),
      { oldSource: oldSrc, changedLineSet: new Set(), filePath: 'shortcuts.md' },
    );
    await waitFor(() => expect(container.querySelectorAll('tbody > tr').length).toBe(3));

    const rows = Array.from(container.querySelectorAll('tbody > tr'));
    expect(rows.map(rowCellTexts)).toEqual([
      ['New tab', 'Cmd+T'],
      ['Close tab', 'Cmd+W'],
      ['Split pane', 'Cmd+D'],
    ]);
    const ghost = rows[1];
    expect(ghost.classList.contains('ac-item-removed')).toBe(true);
    expect(ghost.querySelector('.ac-mini-tag-removed')?.textContent).toBe('removed');
    expect(ghost.hasAttribute('data-start-line')).toBe(false);
    expect(ghost.hasAttribute('data-end-line')).toBe(false);
    // Exactly one <td> per column — matches every real row's own count.
    expect(ghost.children.length).toBe(2);
    expect(Array.from(ghost.children).every((c) => c.tagName === 'TD')).toBe(true);
    // Neighbors are untouched real rows.
    expect(rows[0].classList.contains('ac-item-removed')).toBe(false);
    expect(rows[2].classList.contains('ac-item-removed')).toBe(false);

    // Never a note-anchor target.
    fireEvent.mouseMove(ghost);
    expect(container.querySelector('button[title^="Add a note on line"]')).toBeNull();
  });

  it('renders a removed row containing markup-shaped cell text as inert plain text (XSS-shaped input), never as an element', async () => {
    const xssOldSrc = [
      '| Action | Notes |',
      '|---|---|',
      '| New tab | ok |',
      '| Reopen tab | <img src=x onerror=alert(1)> |',
      '',
    ].join('\n');
    const xssNewSrc = ['| Action | Notes |', '|---|---|', '| New tab | ok |', ''].join('\n');
    const { container } = setup(xssNewSrc, { oldSource: xssOldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('tbody > tr').length).toBe(2));

    const ghost = Array.from(container.querySelectorAll('tbody > tr')).find((tr) =>
      tr.classList.contains('ac-item-removed'),
    )!;
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(rowCellTexts(ghost)[1]).toContain('<img src=x onerror=alert(1)>');
    const textNode = Array.from(ghost.children[1].childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    expect(textNode?.textContent).toContain('<img');
  });

  it('renders two ghost rows in original relative order for adjacent deletions', async () => {
    const twoDelOldSrc = ['| A |', '|---|', '| one |', '| two |', '| three |', '| four |', ''].join('\n');
    const twoDelNewSrc = ['| A |', '|---|', '| one |', '| four |', ''].join('\n');
    const { container } = setup(twoDelNewSrc, { oldSource: twoDelOldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelectorAll('tbody > tr').length).toBe(4));

    const rows = Array.from(container.querySelectorAll('tbody > tr'));
    expect(rows.map((tr) => rowCellTexts(tr)[0])).toEqual(['one', 'two', 'three', 'four']);
    expect(rows[1].classList.contains('ac-item-removed')).toBe(true);
    expect(rows[2].classList.contains('ac-item-removed')).toBe(true);
  });

  it('a table whose ONLY change is a deletion still renders its ghost row (ghost gate is independent of the classification gate)', async () => {
    const delOnlyOldSrc = ['| A |', '|---|', '| one |', '| two |', ''].join('\n');
    const delOnlyNewSrc = ['| A |', '|---|', '| one |', ''].join('\n');
    // Empty changedLineSet: nothing is flagged "changed" at all — proves
    // the ghost gate does not depend on tableClassification having entries.
    const { container } = setup(delOnlyNewSrc, {
      oldSource: delOnlyOldSrc,
      changedLineSet: new Set(),
    });
    await waitFor(() => expect(container.querySelectorAll('tbody > tr').length).toBe(2));
    const ghost = Array.from(container.querySelectorAll('tbody > tr')).find((tr) =>
      tr.classList.contains('ac-item-removed'),
    );
    expect(ghost).toBeTruthy();
    expect(rowCellTexts(ghost!)[0]).toBe('two');
  });

  it('produces no ghost rows when a table is wholly deleted', async () => {
    const wholeTableOldSrc = ['# Notes', '', '| A |', '|---|', '| one |', ''].join('\n');
    const wholeTableNewSrc = ['# Notes', '', ''].join('\n');
    const { container } = setup(wholeTableNewSrc, {
      oldSource: wholeTableOldSrc,
      changedLineSet: new Set(),
    });
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    expect(container.querySelectorAll('table').length).toBe(0);
    expect(container.querySelectorAll('.ac-item-removed').length).toBe(0);
  });

  it('keeps zebra striping stable across a ghost-row insertion (presentational restripe classes, no row index/ordinal exposed)', async () => {
    const zebraOldSrc = ['| A |', '|---|', '| r1 |', '| r2 |', '| r3 |', '| r4 |', '| r5 |', ''].join(
      '\n',
    );
    // r2 removed — a ghost lands between r1 and r3.
    const zebraNewSrc = ['| A |', '|---|', '| r1 |', '| r3 |', '| r4 |', '| r5 |', ''].join('\n');

    // Ghost-free baseline: which rows are naturally striped (2nd/4th).
    const { container: plain } = setup(zebraNewSrc);
    await waitFor(() => expect(plain.querySelectorAll('tbody > tr').length).toBe(4));
    expect(plain.querySelector('table')?.classList.contains('ac-table-restriped')).toBe(false);

    const { container: withGhost } = setup(zebraNewSrc, {
      oldSource: zebraOldSrc,
      changedLineSet: new Set(),
    });
    await waitFor(() => expect(withGhost.querySelectorAll('tbody > tr').length).toBe(5));
    const table = withGhost.querySelector('table')!;
    expect(table.classList.contains('ac-table-restriped')).toBe(true);

    const rows = Array.from(withGhost.querySelectorAll('tbody > tr'));
    expect(rows.map((tr) => rowCellTexts(tr)[0])).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    const ghost = rows[1];
    expect(ghost.classList.contains('ac-item-removed')).toBe(true);
    // The ghost itself never gets a stripe class.
    expect(ghost.classList.contains('ac-row-even')).toBe(false);

    // Real rows only: with the ghost EXCLUDED from counting, the striped
    // set must be IDENTICAL to the ghost-free baseline's own 2nd/4th rows.
    const realRows = rows.filter((tr) => tr !== ghost);
    const stripedRealTexts = realRows
      .filter((tr) => tr.classList.contains('ac-row-even'))
      .map((tr) => rowCellTexts(tr)[0]);
    const plainRows = Array.from(plain.querySelectorAll('tbody > tr'));
    const plainEvenTexts = plainRows
      .filter((_, i) => (i + 1) % 2 === 0)
      .map((tr) => rowCellTexts(tr)[0]);
    expect(stripedRealTexts).toEqual(plainEvenTexts);
    expect(plainEvenTexts).toEqual(['r3', 'r5']); // sanity: the natural pattern
  });

  describe('zero-visible-decoration row (REJECT correction, ek7c.3: a row classified "edited" whose every cell has mdast-identical text must still indicate something changed)', () => {
    it('a formatting-only cell change (**x** -> __x__, identical flattened text) shows the row-level marker with the shared "no word-level change detected" reason', async () => {
      const oldSrc = ['| Action | Notes |', '|---|---|', '| keep | **bold** note |', ''].join('\n');
      const newSrc = ['| Action | Notes |', '|---|---|', '| keep | __bold__ note |', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

      const row = container.querySelector('tbody > tr')!;
      expect(row.classList.contains('ac-item-edited')).toBe(true);
      expect(row.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');

      const cells = Array.from(row.querySelectorAll('td'));
      // Neither cell was ever attempted (both skipped as mdast-identical) —
      // no spans anywhere in the row.
      expect(cells.every((c) => c.querySelector('.ac-del-span, .ac-add-span') === null)).toBe(true);
      expect(cells[0].querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      const detail = cells[0].querySelector('details.ac-detail');
      expect(detail).not.toBeNull();
      expect(detail!.querySelector('.ac-before')?.textContent).toBe('| keep | **bold** note |');
      expect(detail!.querySelector('.ac-after')?.textContent).toBe('| keep | __bold__ note |');
      // A decorated clone WAS produced (the row-level marker), so the
      // legacy whole-block wash is still correctly suppressed.
      expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
    });

    it('a pure whitespace-only source change (identical flattened text after normalizeText) shows the row-level marker with the shared reason', async () => {
      const oldSrc = ['| Action | Notes |', '|---|---|', '| keep | some notes |', ''].join('\n');
      const newSrc = ['| Action | Notes |', '|---|---|', '| keep | some  notes |', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

      const row = container.querySelector('tbody > tr')!;
      expect(row.classList.contains('ac-item-edited')).toBe(true);
      expect(row.getAttribute('data-diff-fallback-reason')).toBe('no word-level change detected');

      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells.every((c) => c.querySelector('.ac-del-span, .ac-add-span') === null)).toBe(true);
      expect(cells[0].querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
      const detail = cells[0].querySelector('details.ac-detail');
      expect(detail).not.toBeNull();
      expect(detail!.querySelector('.ac-before')?.textContent).toBe('| keep | some notes |');
      expect(detail!.querySelector('.ac-after')?.textContent).toBe('| keep | some  notes |');
    });

    it('does not regress: a row with one cleanly-spliced cell and one formatting-only-unchanged cell shows NO row-level marker (the clean cell already indicates the change)', async () => {
      const oldSrc = ['| Action | Notes |', '|---|---|', '| old | **bold** note |', ''].join('\n');
      const newSrc = ['| Action | Notes |', '|---|---|', '| new | __bold__ note |', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

      const row = container.querySelector('tbody > tr')!;
      expect(row.classList.contains('ac-item-edited')).toBe(true);
      expect(row.getAttribute('data-diff-fallback-reason')).toBeNull();

      const cells = Array.from(row.querySelectorAll('td'));
      expect(cells[0].querySelector('.ac-del-span')?.textContent).toBe('old');
      expect(cells[0].querySelector('.ac-add-span')?.textContent).toBe('new');
      // Cell 1 ("Notes"): formatting-only, mdast-identical — skipped, no
      // spans of its own, but this must NOT trigger the row-level marker
      // since cell 0 already shows real visible decoration.
      expect(cells[1].querySelector('.ac-del-span, .ac-add-span')).toBeNull();
      expect(row.querySelector('.ac-mini-tag')).toBeNull();
      expect(row.querySelector('details.ac-detail')).toBeNull();
    });
  });

  describe('header-row behavior (Contract: define and test; an edit confined to the header must not mark body rows changed)', () => {
    it('an edit confined to the header DECORATES the header row (clean intraline diff); the table skips the legacy whole-block wash since a decorated clone now exists (REJECT-corrected: option (a), decorate headers too)', async () => {
      const headerOldSrc = ['| Old Header | B |', '|---|---|', '| one | two |', ''].join('\n');
      const headerNewSrc = ['| New Header | B |', '|---|---|', '| one | two |', ''].join('\n');
      const { container } = setup(headerNewSrc, {
        oldSource: headerOldSrc,
        changedLineSet: new Set([1]),
      });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

      const headerRow = container.querySelector('thead > tr')!;
      expect(headerRow.classList.contains('ac-item-edited')).toBe(true);
      const headerCells = Array.from(headerRow.querySelectorAll('th'));
      expect(headerCells[0].querySelector('.ac-del-span')?.textContent).toBe('Old');
      expect(headerCells[0].querySelector('.ac-add-span')?.textContent).toBe('New');
      // Second header cell ("B") is untouched by the diff.
      expect(headerCells[1].querySelector('.ac-del-span, .ac-add-span')).toBeNull();
      expect(headerRow.querySelector('.ac-mini-tag')).toBeNull(); // clean diff — no fallback tag
      expect(headerRow.getAttribute('data-diff-fallback-reason')).toBeNull();

      const bodyRow = container.querySelector('tbody > tr')!;
      expect(bodyRow.className).not.toMatch(/ac-item-/);

      // A decorated clone now exists for this table (the header's own
      // decoration), so `blockChanged` (changed && decoratedHtml ===
      // undefined) is correctly false — the header's own rail/spans ARE
      // the change indication, replacing the old whole-block wash.
      expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
    });

    it('a header edit and a body-row edit in the same document classify AND decorate independently — each shows its OWN change (pins the REJECT-corrected mixed case: the header change is now actually indicated, not just the body row)', async () => {
      const bothOldSrc = ['| Old Header | B |', '|---|---|', '| one | old-two |', ''].join('\n');
      const bothNewSrc = ['| New Header | B |', '|---|---|', '| one | new-two |', ''].join('\n');
      const { container } = setup(bothNewSrc, {
        oldSource: bothOldSrc,
        changedLineSet: new Set([1, 3]),
      });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

      const headerRow = container.querySelector('thead > tr')!;
      expect(headerRow.classList.contains('ac-item-edited')).toBe(true);
      expect(headerRow.querySelector('.ac-del-span')?.textContent).toBe('Old');
      expect(headerRow.querySelector('.ac-add-span')?.textContent).toBe('New');

      const bodyRow = container.querySelector('tbody > tr')!;
      expect(bodyRow.classList.contains('ac-item-edited')).toBe(true);
      // The body row's OWN decoration reflects only its OWN cell change
      // (old-two -> new-two) — never anything derived from the header,
      // confirming pairing keeps header/body classification independent
      // (the binding Contract requirement) even now that BOTH decorate.
      expect(bodyRow.querySelector('.ac-del-span')?.textContent).toBe('old');
      expect(bodyRow.querySelector('.ac-add-span')?.textContent).toBe('new');

      expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
    });
  });

  it('fails closed PER CELL: a cleanly-spliced cell keeps its own del/add spans even when a SIBLING cell in the same row falls back', async () => {
    // Three columns: "Action" is untouched; "Qty" is a clean single-token
    // replace; "Notes" crosses a **bold** boundary (unclean). All three
    // states coexist in one row, proving the fallback in one cell never
    // disturbs an already-clean sibling cell or an untouched one.
    const mixedOldSrc = ['| Action | Qty | Notes |', '|---|---|---|', '| item | 3 | **old** thing |', ''].join(
      '\n',
    );
    const mixedNewSrc = ['| Action | Qty | Notes |', '|---|---|---|', '| item | 4 | **new** thing |', ''].join(
      '\n',
    );
    const { container } = setup(mixedNewSrc, { oldSource: mixedOldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

    const row = container.querySelector('tbody > tr')!;
    expect(row.classList.contains('ac-item-edited')).toBe(true);
    expect(row.getAttribute('data-diff-fallback-reason')).toBeTruthy();

    const cells = Array.from(row.querySelectorAll('td'));
    // Cell 0 ("Action"/"item"): untouched — never even attempted, no spans.
    expect(cells[0].querySelector('.ac-del-span, .ac-add-span')).toBeNull();
    // Cell 1 ("Qty"): CLEANLY spliced — keeps its del/add spans despite
    // cell 2's fallback.
    expect(cells[1].querySelector('.ac-del-span')?.textContent).toBe('3');
    expect(cells[1].querySelector('.ac-add-span')?.textContent).toBe('4');
    // Cell 2 ("Notes"): fell back — byte-identical to its undecorated new
    // rendering, no spans of its own.
    expect(cells[2].querySelector('.ac-del-span, .ac-add-span')).toBeNull();
    expect(cells[2].querySelector('strong')?.textContent).toBe('new');
    // The row-level marker/mini-tag land in the FIRST cell only (cell 0),
    // regardless of which cell actually failed.
    expect(cells[0].querySelector('.ac-mini-tag-changed')).not.toBeNull();
    expect(cells[0].querySelector('details.ac-detail')).not.toBeNull();
    expect(cells[1].querySelector('.ac-mini-tag, .ac-detail')).toBeNull();
    expect(cells[2].querySelector('.ac-mini-tag, .ac-detail')).toBeNull();
  });

  it('never foster-parents a decoration outside the table (mini-tags, detail markers, and hover tips always end up nested inside a cell, never as a sibling of <tr>/<tbody>)', async () => {
    // Exercises every decoration surface in one render: an edited row whose
    // cell edit crosses a **bold** boundary (unclean splice -> mini-tag +
    // detail marker + hover tip, all appended into a <td>), an added row
    // (mini-tag into a <td>), and a removed row (ghost <tr> + its own
    // mini-tag into a <td>).
    const fosterOldSrc = [
      '| Action | Notes |',
      '|---|---|',
      '| keep | **quarterly** report |',
      '| gone | bye |',
      '',
    ].join('\n');
    const fosterNewSrc = [
      '| Action | Notes |',
      '|---|---|',
      '| keep | **annual** report |',
      '| fresh | new |',
      '',
    ].join('\n');
    const { container } = setup(fosterNewSrc, {
      oldSource: fosterOldSrc,
      changedLineSet: new Set([3, 4]),
    });
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());

    const table = container.querySelector('table')!;
    const edited = Array.from(container.querySelectorAll('tbody > tr')).find((tr) =>
      tr.classList.contains('ac-item-edited'),
    )!;
    expect(edited.getAttribute('data-diff-fallback-reason')).toBeTruthy();

    const decorations = container.querySelectorAll('.ac-mini-tag, .ac-detail, .ac-hover-tip');
    expect(decorations.length).toBeGreaterThan(0);
    for (const deco of Array.from(decorations)) {
      const cell = deco.closest('td, th');
      expect(cell).not.toBeNull();
      expect(table.contains(cell)).toBe(true);
    }
    // Structural sanity: every <tr>'s direct children are only <td>/<th>,
    // and every <tbody>'s direct children are only <tr> — nothing else ever
    // landed as a direct sibling of row/cell content.
    for (const tr of Array.from(table.querySelectorAll('tr'))) {
      for (const child of Array.from(tr.children)) {
        expect(['TD', 'TH']).toContain(child.tagName);
      }
    }
    for (const tbody of Array.from(table.querySelectorAll('tbody'))) {
      for (const child of Array.from(tbody.children)) {
        expect(child.tagName).toBe('TR');
      }
    }
  });

  describe("degradation (Contract: every table falls back to today's exact whole-block behavior)", () => {
    const degOldSrc = ['| A |', '|---|', '| one |', ''].join('\n');
    const degNewSrc = ['| A |', '|---|', '| two |', ''].join('\n');

    it('falls back to the whole-block treatment when oldSource is absent (undefined or null)', async () => {
      for (const oldSource of [undefined, null] as const) {
        const { container, unmount } = setup(degNewSrc, { oldSource, changedLineSet: new Set([3]) });
        await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
        expect(container.querySelector('tr')?.className).not.toMatch(/ac-item-/);
        expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(true);
        unmount();
      }
    });

    it('falls back to the whole-block treatment when changedLineSet is absent, even with oldSource', async () => {
      const { container } = setup(degNewSrc, { oldSource: degOldSrc });
      await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
      expect(container.querySelector('tr')?.className).not.toMatch(/ac-item-/);
      expect(hasBlockChangedTag(container.querySelector('table')!)).toBe(false);
    });
  });
});

describe('RenderedMarkdown — blockquote per-child diff (local_repo_explorer-rendered-md-nonlist-diff-ek7c.4)', () => {
  it('in a blockquote with two paragraphs where only the second changed, the second renders the amber rail + inline spans; the first renders with zero decoration; the blockquote itself shows no accent wash or ChangedTag', async () => {
    const oldSrc = [
      '> First quoted line.',
      '>',
      '> The terminal now reconnects automatically.',
      '',
    ].join('\n');
    const newSrc = [
      '> First quoted line.',
      '>',
      '> The terminal now recovers automatically.',
      '',
    ].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelectorAll('blockquote > p').length).toBe(2));

    const paras = Array.from(container.querySelectorAll('blockquote > p'));
    const untouched = paras.find((p) => p.textContent?.includes('First quoted'))!;
    const edited = paras.find((p) => p.textContent?.includes('automatically'))!;

    expect(edited.classList.contains('ac-item-edited')).toBe(true);
    expect(edited.querySelector('.ac-mini-tag')).toBeNull();
    expect(edited.querySelector('details.ac-detail')).toBeNull();
    const del = edited.querySelector('.ac-del-span');
    const add = edited.querySelector('.ac-add-span');
    expect(del?.textContent).toBe('reconnects');
    expect(add?.textContent).toBe('recovers');

    // Untouched sibling: zero decoration.
    expect(untouched.className).not.toMatch(/ac-item-/);

    // The blockquote block itself shows no accent wash and no ChangedTag —
    // blockChanged is false because decoratedHtml took over the treatment.
    expect(hasBlockChangedTag(container.querySelector('blockquote')!)).toBe(false);
  });

  it('a newly added blockquote child renders the green rail + wash + new mini-tag', async () => {
    const oldSrc = ['> Keep this.', ''].join('\n');
    const newSrc = ['> Keep this.', '>', '> Brand new quoted line.', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([3]) });
    await waitFor(() => expect(container.querySelectorAll('blockquote > p').length).toBe(2));

    const paras = Array.from(container.querySelectorAll('blockquote > p'));
    const added = paras.find((p) => p.textContent?.includes('Brand new'))!;
    const untouched = paras.find((p) => p.textContent?.includes('Keep this'))!;

    expect(added.classList.contains('ac-item-added')).toBe(true);
    expect(added.querySelector('.ac-mini-tag-added')?.textContent).toBe('new');
    expect(untouched.className).not.toMatch(/ac-item-/);
    expect(hasBlockChangedTag(container.querySelector('blockquote')!)).toBe(false);
  });

  it('a blockquote child whose edit cannot be cleanly mapped renders the rail + changed mini-tag + the <details> marker with verbatim before/after source, and is otherwise byte-identical to its undecorated form', async () => {
    const oldSrc = '> Order the [report](https://example.com/doc) today\n';
    const newSrc = '> Order the [file](https://example.com/doc) today\n';
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

    const blockquote = container.querySelector('blockquote')!;
    const p = container.querySelector('blockquote > p')!;
    expect(p.classList.contains('ac-item-edited')).toBe(true);
    expect(p.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(p.getAttribute('data-diff-fallback-reason')).toBe(
      'edit crosses a formatting or link boundary',
    );

    // The marker is a SIBLING of the <p>, inserted directly into the
    // blockquote — never a descendant (the same <p>-can't-host-flow-content
    // HTML-parsing trap the top-level prose fallback case has; see
    // decorateBlockquoteChildren's own doc comment).
    expect(p.nextElementSibling?.matches('details.ac-detail')).toBe(true);
    expect(blockquote.contains(p.nextElementSibling)).toBe(true);
    expect(p.querySelector('details.ac-detail')).toBeNull(); // never nested inside

    // Verbatim RAW source line, including the `> ` blockquote marker (the
    // literal characters on that source line) — never the markup-flattened
    // pairing text, matching `verbatimSourceSlice`'s contract everywhere
    // else in this file.
    const before = container.querySelector('.ac-before');
    const after = container.querySelector('.ac-after');
    expect(before?.textContent).toBe('> Order the [report](https://example.com/doc) today');
    expect(after?.textContent).toBe('> Order the [file](https://example.com/doc) today');

    // Otherwise byte-identical to its undecorated form: the <p>'s own link
    // markup is untouched (spliceIntralineInto never mutates on a
    // clean:false result — see its own doc comment).
    const link = p.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/doc');
    expect(link?.textContent).toBe('file');
  });

  it('carries the hover quick preview (a sibling of the paragraph, not a descendant), hidden from the accessibility tree — mirrors the top-level prose fallback case', async () => {
    const oldSrc = '> Order the [report](https://example.com/doc) today\n';
    const newSrc = '> Order the [file](https://example.com/doc) today\n';
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

    const p = container.querySelector('blockquote > p')!;
    const tip = container.querySelector('.ac-hover-tip');
    expect(tip).not.toBeNull();
    expect(p.contains(tip)).toBe(false); // sibling, not nested inside <p>
    expect(tip?.textContent).toBe(p.getAttribute('data-diff-fallback-reason'));
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a heading child gets the marker/tip nested as real direct children (unlike the <p> sibling case — headings have no <p>-specific HTML-parsing restriction)', async () => {
    const oldSrc = '> ## Order the [report](https://example.com/doc) today\n';
    const newSrc = '> ## Order the [file](https://example.com/doc) today\n';
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
    await waitFor(() => expect(container.querySelector('blockquote > h2')).not.toBeNull());

    const h2 = container.querySelector('blockquote > h2')!;
    expect(h2.classList.contains('ac-item-edited')).toBe(true);
    expect(h2.querySelector('.ac-mini-tag-changed')?.textContent).toBe('changed');
    expect(h2.querySelector('details.ac-detail')).not.toBeNull();
    expect(h2.querySelector('.ac-hover-tip')).not.toBeNull();
    // Never gets the <p>-only tail-fallback compensating class.
    expect(h2.classList.contains('ac-blockquote-tail-fallback')).toBe(false);
  });

  describe('margin-reset guardrail (Contract: blockquote > :first-child/:last-child margin resets must still apply to a decorated child)', () => {
    it('a decorated LAST child needing the fallback marker gets the tail-fallback compensating class; the marker/tip trail it as the blockquote\'s new last children', async () => {
      const oldSrc = '> Order the [report](https://example.com/doc) today\n';
      const newSrc = '> Order the [file](https://example.com/doc) today\n';
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

      const blockquote = container.querySelector('blockquote')!;
      const p = container.querySelector('blockquote > p')!;
      expect(p.classList.contains('ac-blockquote-tail-fallback')).toBe(true);
      // Still the blockquote's FIRST child (nothing is ever inserted before
      // it) but no longer its LAST child (the marker/tip now trail it).
      expect(blockquote.firstElementChild).toBe(p);
      expect(blockquote.lastElementChild).not.toBe(p);
      expect(blockquote.lastElementChild?.classList.contains('ac-hover-tip')).toBe(true);
    });

    it('a decorated NON-last child needing the fallback marker does NOT get the tail-fallback class — the true last child is untouched and keeps the plain :last-child reset', async () => {
      const oldSrc = [
        '> Order the [report](https://example.com/doc) today.',
        '>',
        '> Unaffected closer.',
        '',
      ].join('\n');
      const newSrc = [
        '> Order the [file](https://example.com/doc) today.',
        '>',
        '> Unaffected closer.',
        '',
      ].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() =>
        expect(container.querySelectorAll('blockquote > p').length).toBeGreaterThanOrEqual(2),
      );

      const paras = Array.from(container.querySelectorAll('blockquote > p'));
      const edited = paras.find((p) => p.getAttribute('data-diff-fallback-reason'))!;
      expect(edited.classList.contains('ac-blockquote-tail-fallback')).toBe(false);

      const blockquote = container.querySelector('blockquote')!;
      expect(blockquote.lastElementChild?.textContent).toContain('Unaffected closer');
      expect(blockquote.lastElementChild?.className).not.toMatch(
        /ac-item-|ac-blockquote-tail-fallback/,
      );
    });

    it('a decorated FIRST child keeps its position — margin-top: 0 keeps applying via the existing :first-child selector regardless of classification', async () => {
      const oldSrc = ['> First old.', '>', '> Second.', ''].join('\n');
      const newSrc = ['> First new.', '>', '> Second.', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

      const blockquote = container.querySelector('blockquote')!;
      const firstPara = container.querySelectorAll('blockquote > p')[0];
      expect(firstPara.classList.contains('ac-item-edited')).toBe(true);
      expect(blockquote.firstElementChild).toBe(firstPara);
    });
  });

  it('a removed blockquote child produces no ghost/placeholder output — the surviving children render exactly as if it were never there (permanent exclusion; no anchor mechanism exists for blockquote children)', async () => {
    const oldSrc = ['> Keep first.', '>', '> Removed middle.', '>', '> Keep last.', ''].join('\n');
    const newSrc = ['> Keep first.', '>', '> Keep last.', ''].join('\n');
    const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set() });
    await waitFor(() => expect(container.querySelector('blockquote')).not.toBeNull());

    const paras = Array.from(container.querySelectorAll('blockquote > p'));
    expect(paras).toHaveLength(2);
    expect(paras.map((p) => p.textContent)).toEqual(['Keep first.', 'Keep last.']);
    expect(container.querySelectorAll('.ac-item-removed').length).toBe(0);
    expect(container.querySelectorAll('.ac-mini-tag-removed').length).toBe(0);
  });

  describe('nested-structure boundary (Guardrail: compose with what exists, do not extend — a nested list/blockquote inside a blockquote is untouched by this feature family)', () => {
    it('a nested list inside a blockquote gets NO per-item decoration when an item inside it changes; the blockquote falls back to the SAME legacy whole-block wash it showed before this leaf existed', async () => {
      const oldSrc = ['> Intro.', '>', '> - alpha', '> - beta', ''].join('\n');
      const newSrc = ['> Intro.', '>', '> - alpha', '> - beta revised', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([4]) });
      await waitFor(() => expect(container.querySelector('blockquote ul')).not.toBeNull());

      // No per-item decoration anywhere inside the nested list.
      const items = Array.from(container.querySelectorAll('blockquote li'));
      expect(items).toHaveLength(2);
      for (const li of items) {
        expect(li.className).not.toMatch(/ac-item-/);
      }
      // The unrelated sibling paragraph is undecorated too — the only
      // change is confined to the excluded nested list, so nothing in this
      // blockquote was per-child classified at all.
      const intro = container.querySelector('blockquote > p')!;
      expect(intro.className).not.toMatch(/ac-item-/);

      // The blockquote itself falls back to the SAME legacy whole-block
      // wash it always showed pre-leaf (kindFromTag used to map
      // 'blockquote' to 'other', which always got `blockChanged = changed`
      // with nothing to suppress it) — this leaf's routing change must not
      // alter that outcome when nothing ends up per-child-decorated.
      expect(hasBlockChangedTag(container.querySelector('blockquote')!)).toBe(true);
    });

    it('a nested list inside a blockquote stays completely untouched even when a SIBLING paragraph in the same blockquote is decorated (documented compose boundary, not a regression)', async () => {
      const oldSrc = ['> Intro old.', '>', '> - alpha', '> - beta', ''].join('\n');
      const newSrc = ['> Intro new.', '>', '> - alpha', '> - beta', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

      const intro = container.querySelector('blockquote > p')!;
      expect(intro.classList.contains('ac-item-edited')).toBe(true);
      const del = intro.querySelector('.ac-del-span');
      const add = intro.querySelector('.ac-add-span');
      expect(del?.textContent).toBe('old');
      expect(add?.textContent).toBe('new');

      const items = Array.from(container.querySelectorAll('blockquote li'));
      expect(items).toHaveLength(2);
      for (const li of items) {
        expect(li.className).not.toMatch(/ac-item-/);
      }
    });

    it('a nested blockquote child stays completely untouched — its own children are never classified by this leaf', async () => {
      const oldSrc = ['> Intro old.', '>', '> > nested quote', ''].join('\n');
      const newSrc = ['> Intro new.', '>', '> > nested quote', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('blockquote blockquote')).not.toBeNull());

      const nested = container.querySelector('blockquote blockquote')!;
      expect(nested.className).not.toMatch(/ac-item-/);
      const nestedPara = nested.querySelector('p')!;
      expect(nestedPara.className).not.toMatch(/ac-item-/);
    });
  });

  describe("degradation (Contract: with oldSource null or changedLineSet absent, blockquotes fall back to today's exact whole-block behavior)", () => {
    it('falls back to the whole-block treatment when oldSource is absent (undefined or null)', async () => {
      for (const oldSource of [undefined, null] as const) {
        const src = ['> First.', '>', '> Second.', ''].join('\n');
        const { container, unmount } = setup(src, { oldSource, changedLineSet: new Set([1]) });
        await waitFor(() => expect(container.querySelector('blockquote')).not.toBeNull());
        expect(container.querySelector('blockquote > p')!.className).not.toMatch(/ac-item-/);
        expect(hasBlockChangedTag(container.querySelector('blockquote')!)).toBe(true);
        unmount();
      }
    });

    it('falls back to the whole-block treatment when changedLineSet is absent, even with oldSource', async () => {
      const oldSrc = ['> Old first.', ''].join('\n');
      const newSrc = ['> New first.', ''].join('\n');
      const { container } = setup(newSrc, { oldSource: oldSrc });
      await waitFor(() => expect(container.querySelector('blockquote')).not.toBeNull());
      expect(container.querySelector('blockquote > p')!.className).not.toMatch(/ac-item-/);
      // No changedLineSet -> nothing is flagged changed at all.
      expect(hasBlockChangedTag(container.querySelector('blockquote')!)).toBe(false);
    });
  });

  it('list, table, prose, and blockquote per-unit classification coexist independently in the same document', async () => {
    const oldSrc = [
      '- item one',
      '- item two',
      '',
      'A paragraph.',
      '',
      '> quoted old.',
      '',
      '| A |',
      '|---|',
      '| one |',
      '',
    ].join('\n');
    const newSrc = [
      '- item one',
      '- item two revised',
      '',
      'A paragraph edited.',
      '',
      '> quoted new.',
      '',
      '| A |',
      '|---|',
      '| one revised |',
      '',
    ].join('\n');
    const { container } = setup(newSrc, {
      oldSource: oldSrc,
      changedLineSet: new Set([2, 4, 6, 10]),
    });
    await waitFor(() => expect(container.querySelectorAll('li').length).toBe(2));

    expect(
      Array.from(container.querySelectorAll('li')).some((li) =>
        li.classList.contains('ac-item-edited'),
      ),
    ).toBe(true);
    expect(container.querySelector('p')!.classList.contains('ac-prose-changed')).toBe(true);
    expect(
      container.querySelector('blockquote > p')!.classList.contains('ac-item-edited'),
    ).toBe(true);
    expect(
      container.querySelector('tbody > tr')!.classList.contains('ac-item-edited'),
    ).toBe(true);
  });
});

// Integration verification (local_repo_explorer-rendered-md-per-item-diff-bibv.5):
// cross-cutting properties no single leaf (.1-.4) owns — note-anchoring
// compatibility, the degradation matrix, TaskDetail/compact usage, and
// large-list performance. Corpus parity (every non-list construct unchanged)
// is already covered by the "structure (regression net)" suite at the top of
// this file, which every leaf's own describe blocks above have exercised
// unmodified — not duplicated here. Theme legibility/distinguishability and
// real-app evidence for all five item states are verified separately against
// the actual built app (not unit-testable) and recorded in this leaf's bead
// comment.
describe('RenderedMarkdown — integration verification (local_repo_explorer-rendered-md-per-item-diff-bibv.5)', () => {
  describe('note-anchoring compatibility (Contract: "should be verified in implementation, not assumed")', () => {
    // Ghost rows as non-anchors are ALREADY covered by leaf .3's own tests
    // above ("shows the note '+' affordance when hovering a real sibling
    // item" / "never shows the note '+' affordance when hovering a ghost
    // row") — not duplicated here. What those tests don't cover: the "+"
    // resolving to a DECORATED item's own line (not just any real sibling),
    // and an EXISTING note actually rendering its inline thread on a
    // decorated item.

    it('hovering a DECORATED edited item resolves the "+" affordance to that item\'s own source line', async () => {
      const oldSrc = ['- Buy milk', '- Buy whole wheat bread', '- Buy eggs', ''].join('\n');
      const newSrc = ['- Buy milk', '- Buy sourdough bread', '- Buy eggs', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([2]),
        filePath: 'shopping-list.md',
      });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

      const edited = Array.from(container.querySelectorAll('li')).find((li) =>
        li.classList.contains('ac-item-edited'),
      )!;
      expect(edited.getAttribute('data-start-line')).toBe('2');
      fireEvent.mouseMove(edited);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 2');
    });

    it('hovering a DECORATED added item resolves the "+" affordance to that item\'s own source line', async () => {
      const oldSrc = ['- Buy milk', '- Buy eggs', ''].join('\n');
      const newSrc = ['- Buy milk', '- Buy eggs', '- Buy stamps', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([3]),
        filePath: 'shopping-list.md',
      });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

      const added = Array.from(container.querySelectorAll('li')).find((li) =>
        li.classList.contains('ac-item-added'),
      )!;
      expect(added.getAttribute('data-start-line')).toBe('3');
      fireEvent.mouseMove(added);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 3');
    });

    it("an existing line note anchored to a decorated item's line still renders its inline thread", async () => {
      const oldSrc = ['- Buy milk', '- Buy whole wheat bread', '- Buy eggs', ''].join('\n');
      const newSrc = ['- Buy milk', '- Buy sourdough bread', '- Buy eggs', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([2]),
        filePath: 'shopping-list.md',
      });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));
      // Sanity: the item is genuinely decorated (edited-clean), not just present.
      const edited = Array.from(container.querySelectorAll('li')).find((li) =>
        li.classList.contains('ac-item-edited'),
      )!;
      expect(edited.querySelector('.ac-add-span')).not.toBeNull();

      try {
        act(() => {
          useNotesStore.setState({
            notes: [
              {
                id: 1,
                projectId: 'p1',
                targetKind: 'file',
                targetId: 'shopping-list.md',
                body: 'why bread?',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                line: 2,
                anchorText: '- Buy whole wheat bread',
              },
            ],
          });
        });

        await waitFor(() => expect(container.textContent).toContain('why bread?'));
        // BlockView's thread label ("L<line>: <source snippet>") — proves the
        // thread rendered against the DECORATED item's own line, not some
        // other line.
        expect(container.textContent).toContain('L2:');
      } finally {
        // This file has no global useNotesStore reset between tests (unlike
        // content.test.tsx/foldingView.test.tsx) — undo the seed locally so a
        // later test in this file never sees a leaked note.
        act(() => {
          useNotesStore.setState({ notes: [] });
        });
      }
    });
  });

  describe('degradation matrix (Contract: no crash, no stray decoration)', () => {
    // No-oldSource, no-changedLineSet, external/untracked file, and a
    // still-loading diff bundle are ALL the SAME code path at this layer
    // (oldSource == null — ContentViewer.tsx passes exactly null for every
    // one of those cases) — already covered by leaf .1's own tests above
    // ("falls back to the whole-block treatment when oldSource is absent",
    // "... when changedLineSet is absent"). Not duplicated here. The one row
    // genuinely untested until now: a document with no list at all.
    it('a document with no list at all renders normally, with no crash and no per-item classification/ghost machinery engaged', async () => {
      const src = ['# Notes', '', 'Just a paragraph, no list anywhere.', ''].join('\n');
      const { container } = setup(src, { oldSource: src, changedLineSet: new Set([1]) });
      await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());

      expect(container.querySelectorAll('li').length).toBe(0);
      expect(container.querySelectorAll('[class*="ac-item-"]').length).toBe(0);
      // The heading itself still gets the legacy whole-block treatment (its
      // own line is in changedLineSet) — proves the per-item gate degrading
      // to null for a list-less document doesn't also suppress an unrelated,
      // legitimate non-list callout.
      expect(hasBlockChangedTag(container.querySelector('h1')!)).toBe(true);
    });
  });

  describe('TaskDetail / compact usage (no filePath, no oldSource, no changedLineSet — matches src/renderer/beads/TaskDetail.tsx exactly)', () => {
    it('renders unaffected by the per-item pipeline: no decoration classes, no notes affordance, compact spacing applied', async () => {
      const src = ['- one', '- two', '- three', ''].join('\n');
      const { container } = render(
        <RenderedMarkdown source={src} compact linkContext={{ projectId: 'p1' }} />,
      );
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(3));

      for (const li of container.querySelectorAll('li')) {
        expect(li.className).not.toMatch(/ac-item-/);
      }
      expect(container.querySelectorAll('.ac-mini-tag, .ac-detail, details').length).toBe(0);

      // No notes UI at all — filePath is absent, so notesEnabled is false.
      fireEvent.mouseMove(container.querySelector('li')!);
      expect(container.querySelector('button[title^="Add a note on line"]')).toBeNull();

      // Compact spacing (markdown.tsx's inline style, not a class) is
      // actually applied.
      const root = container.querySelector('.agent-cockpit-markdown') as HTMLElement;
      expect(root.style.padding).toBe('4px 8px');
      expect(root.style.fontSize).toBe('13px');
    });
  });

  describe('large-list performance sanity', () => {
    it('classifies a few-hundred-item list with one edited item without a perceptible stall', async () => {
      const ITEM_COUNT = 300;
      const oldLines = Array.from({ length: ITEM_COUNT }, (_, i) => `- item ${i}`);
      const newLines = oldLines.map((line, i) => (i === 150 ? '- item 150 revised' : line));
      const oldSrc = `${oldLines.join('\n')}\n`;
      const newSrc = `${newLines.join('\n')}\n`;

      const start = Date.now();
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([151]), // 1-based line for item index 150
      });
      await waitFor(() => expect(container.querySelectorAll('li').length).toBe(ITEM_COUNT), {
        timeout: 10000,
      });
      const elapsedMs = Date.now() - start;

      // Generous bound — this exercises the FULL pipeline in jsdom (markdown
      // parse x2 + LCS pairing + per-item classification + React render of
      // 300 <li>s), not a micro-benchmark; the point is "no perceptible
      // stall" (a couple of seconds at most), mirroring wordDiff.test.ts's
      // own bounded-time pattern for the per-item token LCS. 300 items is
      // comfortably inside markdownItemDiff.ts's own stated scale assumption
      // ("tens to low hundreds of items").
      expect(elapsedMs).toBeLessThan(5000);

      const items = Array.from(container.querySelectorAll('li'));
      const edited = items.filter((li) => li.classList.contains('ac-item-edited'));
      expect(edited).toHaveLength(1);
      expect(edited[0].textContent).toContain('item 150 revised');
      const decorated = items.filter((li) => /ac-item-/.test(li.className));
      expect(decorated).toHaveLength(1); // exactly the one edit — no collateral
    });
  });
});

// Integration verification (local_repo_explorer-rendered-md-nonlist-diff-ek7c.5):
// closes the non-list block-type extension epic (ek7c.1-.4) the same way
// bibv.5 above closes the list-item epic — note-anchoring compatibility
// across the four new decorated types (plus the code-block startLine/endLine
// gap this leaf itself fixed — see markdown.tsx's codeBlockStartLine/
// codeBlockEndLine and the upgraded degradation test in the ek7c.2 describe
// block above) and corpus parity over real repository markdown. Theme
// legibility/distinguishability and real-app evidence are verified
// separately against the actual built app (not unit-testable) and recorded
// in this leaf's bead comment, exactly like bibv.5's own split.
describe('RenderedMarkdown — integration verification (local_repo_explorer-rendered-md-nonlist-diff-ek7c.5)', () => {
  describe('note-anchoring compatibility (Contract: verified in implementation for every new decorated type, not assumed)', () => {
    // A ghost <tr> as a non-anchor is ALREADY covered by leaf .3's own test
    // above ("renders a ghost row for a removed body row... never a
    // note-anchor target", markdown.test.tsx:2083) — mirroring the ghost
    // <li> precedent bibv.5 itself does not duplicate. Not repeated here.

    it('hovering a DECORATED edited paragraph resolves the "+" affordance to that paragraph\'s own source line', async () => {
      const oldSrc = [
        'Untouched intro paragraph.',
        '',
        'The terminal now reconnects automatically.',
        '',
      ].join('\n');
      const newSrc = [
        'Untouched intro paragraph.',
        '',
        'The terminal now recovers automatically.',
        '',
      ].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([3]),
        filePath: 'notes.md',
      });
      await waitFor(() => expect(container.querySelectorAll('p').length).toBe(2));

      const edited = Array.from(container.querySelectorAll('p')).find((p) =>
        p.classList.contains('ac-prose-changed'),
      )!;
      expect(edited.getAttribute('data-start-line')).toBe('3');
      fireEvent.mouseMove(edited);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 3');
    });

    it('hovering a DECORATED edited heading resolves the "+" affordance to that heading\'s own source line', async () => {
      const oldSrc = ['## Old heading text', '', 'Body paragraph.', ''].join('\n');
      const newSrc = ['## New heading text', '', 'Body paragraph.', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([1]),
        filePath: 'notes.md',
      });
      await waitFor(() => expect(container.querySelector('h2')).not.toBeNull());

      const h2 = container.querySelector('h2')!;
      expect(h2.classList.contains('ac-prose-changed')).toBe(true);
      expect(h2.getAttribute('data-start-line')).toBe('1');
      fireEvent.mouseMove(h2);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 1');
    });

    it('hovering a DECORATED edited code block resolves the "+" affordance to the block\'s own source line (proves this leaf\'s startLine/endLine fix — a <pre> carries no data-start-line of its own)', async () => {
      const jsOldBody =
        'const total = items.reduce((sum, item) => sum + item.price, 0);\nreturn total;';
      const jsNewBody =
        'const total = items.reduce((sum, item) => sum + item.cost, 0);\nreturn total;';
      const oldSrc = ['```js', jsOldBody, '```', ''].join('\n');
      const newSrc = ['```js', jsNewBody, '```', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([2]),
        filePath: 'snippet.md',
      });
      await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());

      const pre = container.querySelector('pre')!;
      const code = pre.querySelector('code')!;
      expect(pre.classList.contains('ac-code-changed')).toBe(true); // sanity: genuinely decorated
      expect(code.getAttribute('data-start-line')).toBe('1'); // the fence line, not the edited body line

      fireEvent.mouseMove(code);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 1');
    });

    it('hovering a DECORATED edited table row resolves the "+" affordance to that row\'s own source line', async () => {
      const oldSrc = ['| A | B |', '|---|---|', '| one | two |', ''].join('\n');
      const newSrc = ['| A | B |', '|---|---|', '| one | three |', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([3]),
        filePath: 'table.md',
      });
      await waitFor(() => expect(container.querySelector('tbody > tr')).not.toBeNull());

      const row = container.querySelector('tbody > tr')!;
      expect(row.classList.contains('ac-item-edited')).toBe(true);
      expect(row.getAttribute('data-start-line')).toBe('3');
      fireEvent.mouseMove(row);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 3');
    });

    it('hovering a DECORATED edited blockquote child resolves the "+" affordance to that child\'s own source line', async () => {
      const oldSrc = ['> Quoted old text.', ''].join('\n');
      const newSrc = ['> Quoted new text.', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([1]),
        filePath: 'quote.md',
      });
      await waitFor(() => expect(container.querySelector('blockquote > p')).not.toBeNull());

      const p = container.querySelector('blockquote > p')!;
      expect(p.classList.contains('ac-item-edited')).toBe(true);
      expect(p.getAttribute('data-start-line')).toBe('1');
      fireEvent.mouseMove(p);
      const btn = container.querySelector('button[title^="Add a note on line"]');
      expect(btn?.getAttribute('title')).toBe('Add a note on line 1');
    });

    it("an existing line note anchored to a decorated code block's line still renders its inline thread (representative case — the mechanism is uniform across all five decorated types once this leaf's code fix lands)", async () => {
      const jsOldBody =
        'const total = items.reduce((sum, item) => sum + item.price, 0);\nreturn total;';
      const jsNewBody =
        'const total = items.reduce((sum, item) => sum + item.cost, 0);\nreturn total;';
      const oldSrc = ['```js', jsOldBody, '```', ''].join('\n');
      const newSrc = ['```js', jsNewBody, '```', ''].join('\n');
      const { container } = setup(newSrc, {
        oldSource: oldSrc,
        changedLineSet: new Set([2]),
        filePath: 'snippet.md',
      });
      await waitFor(() => expect(container.querySelector('pre')).not.toBeNull());
      const pre = container.querySelector('pre')!;
      // Sanity: the block is genuinely decorated (clean intraline diff), not just present.
      expect(pre.classList.contains('ac-code-changed')).toBe(true);
      expect(pre.querySelector('.ac-add-span')?.textContent).toBe('cost');

      try {
        act(() => {
          useNotesStore.setState({
            notes: [
              {
                id: 1,
                projectId: 'p1',
                targetKind: 'file',
                targetId: 'snippet.md',
                body: 'why the field rename?',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                line: 2,
                anchorText: jsNewBody.split('\n')[0],
              },
            ],
          });
        });

        await waitFor(() => expect(container.textContent).toContain('why the field rename?'));
        // BlockView's thread label ("L<line>: <source snippet>") — line 2 is
        // only inside the block's own [1,4] threading range once BOTH
        // startLine AND endLine resolve correctly for a <pre> (this leaf's
        // fix) — before it, endLine was also always 0, so canAnchor (and
        // hence threadLines) was false for every code block regardless of
        // where a note's own line fell.
        expect(container.textContent).toContain('L2:');
      } finally {
        // No global useNotesStore reset in this file — undo the seed locally.
        act(() => {
          useNotesStore.setState({ notes: [] });
        });
      }
    });
  });

  describe('corpus parity (real repository markdown)', () => {
    // Real documentation files, chosen to cover every block type this epic
    // decorates (docs/design/ui-rendered-markdown-diff.md's own
    // "Compatibility with Existing Note-Anchoring & Verification" section):
    // headings/paragraphs from every file; fenced code from DESIGN.md's
    // directory-tree fence and ghostty-wterm-multiplexer.md's typescript/sql/
    // sh fences; tables from ARCHITECTURE.md, ui-design-language.md, and
    // ghostty-wterm-multiplexer.md; blockquotes from
    // ghostty-wterm-multiplexer.md (verified via `grep -rn '^>' docs` before
    // picking this corpus — real blockquotes exist in docs/BUILD.md and
    // several docs/proposals/*.md, so no synthetic blockquote document was
    // needed).
    const CORPUS_FILES = [
      'docs/ARCHITECTURE.md',
      'docs/DESIGN.md',
      'CLAUDE.md',
      'docs/design/ui-design-language.md',
      'docs/design/ui-rendered-markdown-diff.md',
      'docs/TEST_PLAN.md',
      'docs/proposals/ghostty-wterm-multiplexer.md',
    ] as const;

    // Resolved from process.cwd() (repo root under every sanctioned
    // invocation — `npm run test`/`npx vitest run` from the repo root, per
    // this repo's own scripts/CI), NOT `new URL(relPath, import.meta.url)`:
    // Vite's import-analysis plugin statically pattern-matches the literal
    // `new URL(x, import.meta.url)` syntax anywhere it appears in a
    // jsdom-environment test and rewrites it into a dev-server asset URL
    // (e.g. `http://localhost:3000/...`) at transform time, independent of
    // `x`'s actual runtime value — confirmed by a focused probe (not kept):
    // the identical pattern that works in foldModel.test.ts's `node`-
    // environment test silently breaks under `@vitest-environment jsdom`.
    // `foldModel.test.ts`'s use case (locate a SIBLING source file relative
    // to the current test file) also differs from this one (a fixed
    // repo-root-relative doc path), so cwd-relative resolution is the
    // simpler, more direct fit here regardless.
    function readRepoDoc(relPath: string): string {
      return readFileSync(resolve(process.cwd(), relPath), 'utf8');
    }

    /** Blanks out every mermaid/dot/graphviz fenced block (open fence
     *  through close fence, inclusive) while preserving line COUNT, so every
     *  other line's 1-based number is unaffected. These languages are
     *  already fully out of scope for per-unit diffing
     *  (`NON_DIFFABLE_CODE_LANGS` in markdownItemDiff.ts; renderDoc replaces
     *  them with a MermaidFrame/GraphvizFrame placeholder before the normal
     *  pipeline runs at all) and independently render via a real, heavy
     *  WASM/canvas-touching library that jsdom cannot fully execute — a
     *  focused manual probe (not kept) confirmed DiagramFrame's own
     *  try/catch fully absorbs a failed jsdom mermaid render into its error
     *  UI state (no console.error, no unhandled rejection either way), but
     *  it is slow and exercises nothing this corpus test is responsible for.
     *  Stripping keeps the pass fast and focused on the block types this
     *  epic actually decorates. */
    function stripDiagramFences(text: string): string {
      const lines = text.split('\n');
      const out = [...lines];
      let i = 0;
      while (i < lines.length) {
        if (/^```\s*(mermaid|dot|graphviz)\b/i.test(lines[i])) {
          let j = i + 1;
          while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
          for (let k = i; k <= j && k < lines.length; k++) out[k] = '';
          i = j + 1;
        } else {
          i++;
        }
      }
      return out.join('\n');
    }

    /** Deterministically mutates one real word on `line` (reversing its
     *  first run of 3+ letters) — a stand-in "prior revision" of that single
     *  line for corpus-parity testing. Preserves line length/shape; every
     *  other character on the line, and every other line in the file, is
     *  untouched. Returns null when the line has no eligible word (caller
     *  tries the next candidate). */
    function reverseFirstWord(line: string): string | null {
      const m = /[A-Za-z]{3,}/.exec(line);
      if (!m) return null;
      const word = m[0];
      const reversed = word.split('').reverse().join('');
      if (reversed === word) return null; // palindrome-safe guard
      return line.slice(0, m.index) + reversed + line.slice(m.index + word.length);
    }

    type BlockKind = 'paragraph' | 'heading' | 'code' | 'table-row' | 'blockquote';

    interface Perturbation {
      kind: BlockKind;
      /** The unit's own decoration key — matches the rendered element's own
       *  `data-start-line` (its `<code>` child's, for `code`). */
      anchorLine: number;
    }

    /** Builds a perturbed-old / current-new source pair for one real repo
     *  file: for each block kind the file actually contains, finds ONE real
     *  unit via the SAME extractors markdown.tsx's own classification uses
     *  (never a hand-rolled regex scan for "is this a paragraph/table row/
     *  etc" — a target is therefore guaranteed to be a genuine unit the
     *  production code itself would classify, never e.g. a nested list item
     *  or a lazy-continuation line the real extractors wouldn't recognize),
     *  and reverses one word on one of its source lines. `changedLineSet` is
     *  exactly the set of perturbed lines. Pairing correctness for a
     *  single-line word-reversal (never mis-pairing as added+removed
     *  instead of edited) follows directly from `alignBucket`'s LCS +
     *  positional-gap-substitution design (markdownItemDiff.ts): every OTHER
     *  unit in the same bucket keeps identical text and anchors exactly via
     *  LCS, leaving only the one perturbed unit as an unanchored gap of size
     *  1 on each side, which positional substitution pairs as 'edited'. */
    function buildCorpusFixture(file: string): {
      newSource: string;
      oldSource: string;
      changedLineSet: Set<number>;
      perturbed: Perturbation[];
    } {
      const newSource = stripDiagramFences(readRepoDoc(file));
      const lines = newSource.split('\n');
      const oldLines = [...lines];
      const changedLineSet = new Set<number>();
      const perturbed: Perturbation[] = [];

      const perturbAt = (kind: BlockKind, anchorLine: number, editLine: number): boolean => {
        if (changedLineSet.has(editLine)) return false;
        const rewritten = reverseFirstWord(lines[editLine - 1] ?? '');
        if (rewritten == null) return false;
        oldLines[editLine - 1] = rewritten;
        changedLineSet.add(editLine);
        perturbed.push({ kind, anchorLine });
        return true;
      };

      const proseUnits = extractProseUnits(newSource);
      for (const unit of proseUnits.filter((u) => u.kind === 'p')) {
        if (perturbAt('paragraph', unit.startLine, unit.startLine)) break;
      }
      for (const unit of proseUnits.filter((u) => u.kind !== 'p')) {
        if (perturbAt('heading', unit.startLine, unit.startLine)) break;
      }
      const tryPerturbCode = (): void => {
        for (const unit of extractCodeUnits(newSource)) {
          for (let editLine = unit.startLine + 1; editLine < unit.endLine; editLine++) {
            if (perturbAt('code', unit.startLine, editLine)) return;
          }
        }
      };
      tryPerturbCode();
      for (const row of extractTableRows(newSource).filter((r) => !r.isHeader)) {
        if (perturbAt('table-row', row.startLine, row.startLine)) break;
      }
      for (const child of extractBlockquoteChildren(newSource)) {
        if (perturbAt('blockquote', child.startLine, child.startLine)) break;
      }

      return { newSource, oldSource: oldLines.join('\n'), changedLineSet, perturbed };
    }

    type Verdict = 'clean' | 'fallback' | 'undecorated';

    /** Reads the actual rendered DOM to determine, for one perturbation,
     *  whether it landed CLEAN (decorated, no fallback marker), FALLBACK
     *  (decorated with a `data-diff-fallback-reason`), or UNDECORATED (no
     *  per-unit decoration reached the DOM at all — see the invariant
     *  asserted below this helper's only caller). */
    /** Tags that can carry `decorateProseBlock`/`decorateBlockquoteChildren`'s
     *  own decoration classes — used to scope the DOM lookup below to the
     *  actual decorated element. A plain `[data-start-line="N"]` selector is
     *  NOT safe here: a blockquote child's line number is frequently the
     *  SAME as its enclosing `<blockquote>`'s own `data-start-line` (the `>`
     *  marker and its first child's content share one source line), and
     *  `querySelector` returns the FIRST match in document order — the
     *  ancestor `<blockquote>`, which never itself carries a decoration
     *  class (only its children do) — silently misreporting a genuinely
     *  decorated child as 'undecorated'. Scoping to these tag names only
     *  matches the actual content element, never a `<blockquote>`/`<table>`
     *  wrapper that happens to share the same start line. */
    const PROSE_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'];

    function classifyPerturbation(
      container: HTMLElement,
      p: Perturbation,
    ): { verdict: Verdict; reason?: string } {
      if (p.kind === 'code') {
        const code = container.querySelector(`pre > code[data-start-line="${p.anchorLine}"]`);
        const pre = code?.parentElement ?? null;
        const decorated =
          pre != null &&
          (pre.classList.contains('ac-code-changed') || pre.classList.contains('ac-code-added'));
        if (!decorated) return { verdict: 'undecorated' };
        const reason = pre!.getAttribute('data-diff-fallback-reason');
        return reason ? { verdict: 'fallback', reason } : { verdict: 'clean' };
      }
      const selector =
        p.kind === 'table-row'
          ? `tr[data-start-line="${p.anchorLine}"]`
          : PROSE_TAGS.map((tag) => `${tag}[data-start-line="${p.anchorLine}"]`).join(', ');
      const el = container.querySelector(selector);
      const decorated =
        el != null &&
        (el.classList.contains('ac-prose-changed') ||
          el.classList.contains('ac-prose-added') ||
          el.classList.contains('ac-item-edited') ||
          el.classList.contains('ac-item-added'));
      if (!decorated) return { verdict: 'undecorated' };
      const reason = el!.getAttribute('data-diff-fallback-reason');
      return reason ? { verdict: 'fallback', reason } : { verdict: 'clean' };
    }

    it(
      'renders every corpus file with a perturbed old side: no crash, no unhandled rejection, no console.error, no unsafe markup — and records the clean/fallback distribution',
      async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown): void => {
          rejections.push(reason);
        };
        process.on('unhandledRejection', onRejection);

        const rows: Array<{ file: string; kind: BlockKind; verdict: Verdict; reason?: string }> = [];

        try {
          for (const file of CORPUS_FILES) {
            const { newSource, oldSource, changedLineSet, perturbed } = buildCorpusFixture(file);
            // Sanity: this file actually contributed at least one real,
            // extractor-verified perturbation (zero would mean the corpus
            // silently stopped exercising this file at all).
            expect(perturbed.length, `${file} contributed no perturbations`).toBeGreaterThan(0);

            const { container, unmount } = render(
              <RenderedMarkdown
                source={newSource}
                oldSource={oldSource}
                changedLineSet={changedLineSet}
              />,
            );
            // renderDoc runs in a useEffect — wait for real content, not just
            // the empty shell.
            await waitFor(() =>
              expect(container.querySelector('.agent-cockpit-markdown > *')).not.toBeNull(),
            );

            // Sanitizer invariant — DOMPurify's FORBID_TAGS/FORBID_ATTR
            // (markdown.tsx's `sanitize`) must hold across real content, not
            // just the hand-written XSS-shaped fixtures elsewhere in this file.
            expect(container.innerHTML).not.toMatch(/<script/i);
            const lowerHtml = container.innerHTML.toLowerCase();
            for (const attr of ['onerror=', 'onload=', 'onclick=']) {
              expect(lowerHtml).not.toContain(attr);
            }

            for (const p of perturbed) {
              const { verdict, reason } = classifyPerturbation(container, p);
              rows.push({ file, kind: p.kind, verdict, reason });
            }

            unmount();
          }
        } finally {
          process.off('unhandledRejection', onRejection);
          errorSpy.mockRestore();
        }

        expect(rejections).toEqual([]);
        expect(errorSpy.mock.calls).toEqual([]);

        // Every genuinely-classified perturbation (verified via the real
        // extractors above, so a genuine 'edited'/'added' unit) must show
        // SOME decoration — an 'undecorated' result would mean a unit
        // classifyUnits marks changed never reaches decoratedBlockHtml,
        // itself a real defect distinct from clean-vs-fallback.
        const undecorated = rows.filter((r) => r.verdict === 'undecorated');
        expect(undecorated, JSON.stringify(undecorated)).toEqual([]);

        expect(rows.length).toBeGreaterThanOrEqual(10); // meaningful spread, not a token sample

        // ---- Distribution table + fallback-reason set, for this leaf's
        // Validation requirement (recorded verbatim as a bead comment).
        const distribution: Record<
          string,
          { clean: number; fallback: number; undecorated: number }
        > = {};
        for (const r of rows) {
          distribution[r.kind] ??= { clean: 0, fallback: 0, undecorated: 0 };
          distribution[r.kind][r.verdict]++;
        }
        const reasonsSeen = Array.from(
          new Set(rows.map((r) => r.reason).filter((r): r is string => Boolean(r))),
        ).sort();

        console.log('[corpus-parity distribution]', JSON.stringify(distribution, null, 2));
        console.log('[corpus-parity fallback reasons]', JSON.stringify(reasonsSeen));
        console.log('[corpus-parity rows]', JSON.stringify(rows));
      },
      30000,
    );
  });
});
