import { useEffect, useState } from 'react';

interface RawFileProps {
  worktreePath: string;
  filePath: string;
  /** Git ref to read the file at instead of the working tree. `ref` is a
   *  reserved React prop name, so this is exposed as `gitRef`. */
  gitRef?: string;
}

export function RawFile({ worktreePath, filePath, gitRef }: RawFileProps): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'text'; content: string }
    | { kind: 'binary'; sizeBytes: number }
    | { kind: 'too-large'; sizeBytes: number }
    | { kind: 'missing' }
  >({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    const opts: { ref?: string } = {};
    if (gitRef !== undefined) opts.ref = gitRef;
    void window.api.provider.readFile(filePath, opts).then((r) => {
      if (!active) return;
      if (r.content !== null) setState({ kind: 'text', content: r.content });
      else if (r.truncated) setState({ kind: 'too-large', sizeBytes: r.sizeBytes });
      else if (r.isBinary) setState({ kind: 'binary', sizeBytes: r.sizeBytes });
      else setState({ kind: 'missing' });
    });
    return () => {
      active = false;
    };
  }, [worktreePath, filePath, gitRef]);

  switch (state.kind) {
    case 'loading':
      return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>;
    case 'binary':
      return (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          Binary file ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'too-large':
      return (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          File too large to display inline ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'missing':
      return <div style={{ padding: 16, color: 'var(--fg-dim)' }}>File not found at ref.</div>;
    case 'text':
      return (
        <pre
          style={{
            margin: 0,
            padding: 16,
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--mono-size)',
            whiteSpace: 'pre',
            background: 'var(--bg)',
            color: 'var(--fg)',
            overflow: 'auto',
            height: '100%',
          }}
        >
          {state.content}
        </pre>
      );
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
