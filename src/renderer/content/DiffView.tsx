import { useMemo } from 'react';
import { parsePatch } from './parsePatch';

interface DiffViewProps {
  patch: string;
  emptyHint?: string;
  onHunkClick?: (hunkIndex: number) => void;
}

export function DiffView({ patch, emptyHint, onHunkClick }: DiffViewProps): JSX.Element {
  const parsed = useMemo(() => parsePatch(patch), [patch]);

  if (parsed.hunks.length === 0) {
    return (
      <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
        {emptyHint ?? 'No textual diff.'}
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--mono-size)',
        background: 'var(--bg)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      {parsed.hunks.map((h, idx) => (
        <div key={idx} style={{ borderTop: '1px solid var(--border)' }}>
          <div
            style={{
              padding: '4px 8px',
              color: 'var(--fg-dim)',
              background: 'var(--bg-panel)',
              cursor: onHunkClick ? 'pointer' : 'default',
            }}
            onClick={() => onHunkClick?.(idx)}
          >
            {h.header}
          </div>
          <div>
            {h.lines.map((ln, j) => {
              const color =
                ln.kind === 'add'
                  ? 'rgba(127, 201, 122, 0.15)'
                  : ln.kind === 'del'
                    ? 'rgba(255, 122, 122, 0.15)'
                    : 'transparent';
              const prefix = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ln.kind === 'meta' ? '\\' : ' ';
              return (
                <div key={j} style={{ display: 'flex', background: color, whiteSpace: 'pre' }}>
                  <span
                    style={{
                      width: 50,
                      textAlign: 'right',
                      paddingRight: 8,
                      color: 'var(--fg-dim)',
                      borderRight: '1px solid var(--border)',
                      userSelect: 'none',
                    }}
                  >
                    {ln.oldLine ?? ''}
                  </span>
                  <span
                    style={{
                      width: 50,
                      textAlign: 'right',
                      paddingRight: 8,
                      color: 'var(--fg-dim)',
                      borderRight: '1px solid var(--border)',
                      userSelect: 'none',
                    }}
                  >
                    {ln.newLine ?? ''}
                  </span>
                  <span style={{ paddingLeft: 8 }}>
                    {prefix}
                    {ln.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
