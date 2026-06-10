import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Find-in-content engine for the content panel. Highlights matches of a query in
 * the rendered DOM using the CSS Custom Highlight API (`CSS.highlights` +
 * `Highlight` + `Range`) — it paints ranges WITHOUT mutating the DOM, so it is
 * safe over React-rendered markdown / raw / diff content (no `<mark>` injection
 * that React would clobber). Matching is case-insensitive and limited to within
 * a single text node (a match spanning an inline-element boundary is not found —
 * acceptable for find-in-file).
 */

const MATCH_NAME = 'find-match';
const ACTIVE_NAME = 'find-active';

interface MatchPos {
  node: Text;
  start: number;
  end: number;
}

function supportsHighlights(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    typeof (globalThis as { Highlight?: unknown }).Highlight !== 'undefined'
  );
}

/** Collect case-insensitive match positions of `query` within `root`'s text
 *  nodes. Pure over the DOM (no mutation); unit-testable with jsdom. */
export function collectMatches(root: Node, query: string): MatchPos[] {
  const q = query.toLowerCase();
  if (q.length === 0) return [];
  const out: MatchPos[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode();
  while (n) {
    const text = n.nodeValue ?? '';
    if (text.length > 0) {
      const hay = text.toLowerCase();
      let i = hay.indexOf(q);
      while (i !== -1) {
        out.push({ node: n as Text, start: i, end: i + q.length });
        i = hay.indexOf(q, i + q.length);
      }
    }
    n = walker.nextNode();
  }
  return out;
}

function toRange(m: MatchPos): Range {
  const r = document.createRange();
  r.setStart(m.node, m.start);
  r.setEnd(m.node, m.end);
  return r;
}

function applyHighlights(matches: MatchPos[], activeIndex: number): void {
  if (!supportsHighlights()) return;
  const H = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  const ranges = matches.map(toRange);
  CSS.highlights.set(MATCH_NAME, new H(...ranges) as never);
  const active = activeIndex >= 0 && ranges[activeIndex] ? [ranges[activeIndex]!] : [];
  CSS.highlights.set(ACTIVE_NAME, new H(...active) as never);
}

/** Remove all find highlights. Safe to call when unsupported. */
export function clearHighlights(): void {
  if (!supportsHighlights()) return;
  CSS.highlights.delete(MATCH_NAME);
  CSS.highlights.delete(ACTIVE_NAME);
}

export interface FindState {
  count: number;
  /** 1-based index of the active match (0 when none). */
  active: number;
  next: () => void;
  prev: () => void;
}

/**
 * Drive find-in-content for `rootRef`: recomputes matches when `query` or
 * `revision` changes, paints them, and exposes next/prev that scroll the active
 * match into view. Highlights are cleared when the query is empty or on unmount.
 */
export function useFindInContent(
  rootRef: React.RefObject<HTMLElement>,
  query: string,
  revision: unknown,
): FindState {
  const [count, setCount] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const matchesRef = useRef<MatchPos[]>([]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || query.trim().length === 0) {
      matchesRef.current = [];
      setCount(0);
      setActiveIdx(0);
      clearHighlights();
      return;
    }
    const recompute = (): void => {
      const matches = collectMatches(root, query);
      matchesRef.current = matches;
      setCount(matches.length);
      setActiveIdx((prev) => (matches.length === 0 ? 0 : Math.min(prev, matches.length - 1)));
    };
    recompute();
    // Markdown renders asynchronously after `source` is ready, so re-collect on
    // DOM changes. Highlighting uses the CSS Highlight API (no DOM mutation), so
    // applying highlights cannot retrigger this observer.
    const obs = new MutationObserver(() => recompute());
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      clearHighlights();
    };
  }, [rootRef, query, revision]);

  // Repaint when the active match changes (and scroll it into view).
  useEffect(() => {
    const matches = matchesRef.current;
    applyHighlights(matches, matches.length ? activeIdx : -1);
    const m = matches[activeIdx];
    if (m) {
      const el = m.node.parentElement;
      el?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
  }, [activeIdx, count]);

  const next = useCallback(() => {
    setActiveIdx((i) => (count === 0 ? 0 : (i + 1) % count));
  }, [count]);
  const prev = useCallback(() => {
    setActiveIdx((i) => (count === 0 ? 0 : (i - 1 + count) % count));
  }, [count]);

  return { count, active: count === 0 ? 0 : activeIdx + 1, next, prev };
}
