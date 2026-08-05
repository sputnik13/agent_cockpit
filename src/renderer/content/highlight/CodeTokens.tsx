import type { CSSProperties } from 'react';
import type { TokenLine } from './highlighter';

/**
 * Render primitives that turn a Shiki token model into React elements.
 *
 * Text content is preserved verbatim inside `<span>` text nodes, so the
 * find-in-content pass (CSS Custom Highlight API over text nodes) keeps working
 * over highlighted code. No `dangerouslySetInnerHTML`.
 *
 * `CodeLineTokens` renders a single line's tokens (reused by the diff view,
 * one line at a time); `CodeTokens` renders a whole `<pre><code>` block (the
 * raw file view).
 */

export function CodeLineTokens({ line }: { line: TokenLine }): JSX.Element {
  return (
    <>
      {line.map((t, i) =>
        t.color ? (
          <span key={i} style={{ color: t.color }}>
            {t.content}
          </span>
        ) : (
          <span key={i}>{t.content}</span>
        ),
      )}
    </>
  );
}

/**
 * Splits a single highlighted `TokenLine` into two `TokenLine`s at `column`
 * (a 0-based character offset into the line's OWN text — i.e. the offset a
 * caller would reach by summing every token's `content.length` in order).
 * If `column` falls strictly inside one token's content, that token is
 * itself split into two tokens carrying the SAME `color`, at the
 * corresponding local offset — `content` is only ever sliced, never
 * rewritten, so no character is added, dropped, or reordered.
 *
 * Used by FoldingView.tsx (local_repo_explorer-jp2f.6) to splice a small
 * badge element into a highlighted code line at a source column — e.g. an
 * anchor/alias linkage badge right after a `&name`/`*name` token — as
 * `[splitTokenLineAt(line, col)[0], <Badge/>, splitTokenLineAt(line,
 * col)[1]]`, WITHOUT mutating any token's text (the Guardrail this exists
 * to satisfy: badge markup must never be injected by editing token
 * content). Placing N badges on one line applies this repeatedly, once per
 * badge in ascending column order, re-basing each subsequent column against
 * the previous split's `after` half (see FoldingView.tsx's
 * `spliceTokenBadges`).
 *
 * Boundary behavior falls out of the single loop below with no special
 * cases: `column <= 0` yields `[[], line]` (every token's start is `>=
 * column`); `column >= ` the line's total length yields `[line, []]`
 * (every token's end is `<= column`); a `column` landing exactly on a
 * token boundary splits cleanly between the two original token objects
 * (no synthetic empty/partial token is ever created there — the boundary
 * check runs before the split branch).
 */
export function splitTokenLineAt(line: TokenLine, column: number): [TokenLine, TokenLine] {
  const before: TokenLine = [];
  const after: TokenLine = [];
  let pos = 0;
  for (const token of line) {
    const tokenStart = pos;
    const tokenEnd = pos + token.content.length;
    pos = tokenEnd;

    if (tokenEnd <= column) {
      before.push(token);
      continue;
    }
    if (tokenStart >= column) {
      after.push(token);
      continue;
    }
    // `column` falls strictly inside this token (tokenStart < column <
    // tokenEnd), so both halves below are guaranteed non-empty.
    const localCol = column - tokenStart;
    const left = token.content.slice(0, localCol);
    const right = token.content.slice(localCol);
    before.push(token.color ? { content: left, color: token.color } : { content: left });
    after.push(token.color ? { content: right, color: token.color } : { content: right });
  }
  return [before, after];
}

interface CodeTokensProps {
  lines: TokenLine[];
  className?: string;
  style?: CSSProperties;
}

export function CodeTokens({ lines, className, style }: CodeTokensProps): JSX.Element {
  return (
    <pre className={className} style={style}>
      <code>
        {lines.map((line, i) => (
          <span key={i}>
            <CodeLineTokens line={line} />
            {i < lines.length - 1 ? '\n' : null}
          </span>
        ))}
      </code>
    </pre>
  );
}
