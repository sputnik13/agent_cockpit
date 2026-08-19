/**
 * Pure word-level diff between two strings (see
 * docs/design/ui-rendered-markdown-diff.md, Decision item 3). No DOM, no
 * React — usable both from RenderedMarkdown's DOM-splicing mapper
 * (markdown.tsx's `applyIntralineSpans`) and standalone in tests.
 *
 * Algorithm mirrors `markdownItemDiff.ts`'s own hand-rolled LCS (same
 * DP-table + backtrack shape, retargeted at string tokens instead of
 * `MdListItem`s) — this repo has no diff library (jsdiff/diff-match-patch/
 * fast-diff) and must not gain one for this.
 */

export interface WordDiffSegment {
  kind: 'equal' | 'del' | 'add';
  text: string;
}

/** Above this many tokens (on either side), skip the LCS entirely — an
 *  O(n*m) DP table over a pathological item (e.g. a huge minified/base64
 *  blob mistakenly living in a list item) must never run unbounded. Realistic
 *  list-item prose (a sentence or two) is tens of tokens; 600 is generous
 *  headroom while still bounding the worst case to a ~360k-cell table. */
export const MAX_WORD_DIFF_TOKENS = 600;

export type WordDiffResult =
  | { clean: true; segments: WordDiffSegment[] }
  | { clean: false; reason: string };

const WORD_TOKEN_RE = /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]+/gu;

/**
 * Tokenizes on word vs. non-word (whitespace/punctuation) run boundaries.
 * Every character of `text` belongs to exactly one token and tokens stay in
 * order, so `tokenizeWords(text).join('') === text` always holds — this is
 * what makes segment reassembly round-trip exactly (see `wordDiff`'s doc
 * comment). A "word" token is a maximal run of Unicode letters/digits/`_`;
 * everything else (spaces, a multi-space run, punctuation) is its own
 * maximal run token, so e.g. three spaces tokenize as one `'   '` token, not
 * three separate ones.
 */
export function tokenizeWords(text: string): string[] {
  if (text === '') return [];
  return text.match(WORD_TOKEN_RE) ?? [];
}

/**
 * Word-level diff of `oldText` -> `newText`, as an ordered list of
 * `{kind, text}` segments. Deterministic and pure; always runs the full
 * diff (no size bound) — callers that need the bounded, "is this safe to
 * splice" gate should use `computeWordDiff` instead.
 *
 * Round-trip property: joining every segment whose kind !== 'del'
 * reproduces `newText` exactly; joining every segment whose kind !== 'add'
 * reproduces `oldText` exactly. Consecutive tokens of the same kind are
 * coalesced into one segment (e.g. a two-word deletion is one `del`
 * segment, not two), matching the mockup's phrase-level spans.
 */
export function wordDiff(oldText: string, newText: string): WordDiffSegment[] {
  return diffTokens(tokenizeWords(oldText), tokenizeWords(newText));
}

/**
 * Gated entry point for the intraline-splice feature: bails out BEFORE
 * running the LCS when either side exceeds `MAX_WORD_DIFF_TOKENS`, and
 * treats a diff with no del/add segments at all as not-clean too (a
 * formatting-only edit — e.g. `*em*` -> `**em**` — pairs as equal text
 * once markup is flattened, so splicing nothing would leave a decorated
 * item with no visible difference; see docs/design/ui-rendered-markdown-diff.md,
 * "Degenerate diff"). `reason` is a short, stable, user-showable string
 * (leaf .4 surfaces it in a hover quick preview), never an internal code.
 *
 * This is a TEXT-level gate only. The DOM-splicing mapper
 * (`applyIntralineSpans`, markdown.tsx) adds its own, separate clean/
 * not-clean determination on top of a `clean: true` result here, based on
 * whether the segments actually map onto splice-eligible DOM positions.
 */
export function computeWordDiff(oldText: string, newText: string): WordDiffResult {
  const oldTokens = tokenizeWords(oldText);
  const newTokens = tokenizeWords(newText);
  if (oldTokens.length > MAX_WORD_DIFF_TOKENS || newTokens.length > MAX_WORD_DIFF_TOKENS) {
    return { clean: false, reason: 'item is too large for a word-level diff' };
  }
  const segments = diffTokens(oldTokens, newTokens);
  if (!segments.some((s) => s.kind !== 'equal')) {
    return { clean: false, reason: 'no word-level change detected' };
  }
  return { clean: true, segments };
}

function diffTokens(oldTokens: string[], newTokens: string[]): WordDiffSegment[] {
  const anchors = longestCommonSubsequence(oldTokens, newTokens);
  const segments: WordDiffSegment[] = [];
  const push = (kind: WordDiffSegment['kind'], value: string): void => {
    if (value === '') return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += value;
    else segments.push({ kind, text: value });
  };

  let oldCursor = 0;
  let newCursor = 0;
  for (const [oi, ni] of anchors) {
    for (let k = oldCursor; k < oi; k++) push('del', oldTokens[k]);
    for (let k = newCursor; k < ni; k++) push('add', newTokens[k]);
    push('equal', newTokens[ni]);
    oldCursor = oi + 1;
    newCursor = ni + 1;
  }
  for (let k = oldCursor; k < oldTokens.length; k++) push('del', oldTokens[k]);
  for (let k = newCursor; k < newTokens.length; k++) push('add', newTokens[k]);
  return segments;
}

/** Standard O(n*m) LCS via DP table + backtrack, matching on exact token
 *  equality. Returns matched index pairs `[oldIndex, newIndex]`, strictly
 *  increasing on both sides. `computeWordDiff`'s `MAX_WORD_DIFF_TOKENS` gate
 *  bounds `n`/`m` before this ever runs. */
function longestCommonSubsequence(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}
