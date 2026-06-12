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
