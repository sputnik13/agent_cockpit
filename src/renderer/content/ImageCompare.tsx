import { useEffect, useState } from 'react';

interface ImageCompareProps {
  worktreePath: string;
  baseline: string;
  filePath: string;
  oldPath?: string | null;
}

export function ImageCompare({ worktreePath, baseline, filePath, oldPath }: ImageCompareProps): JSX.Element {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const previousPath = oldPath ?? filePath;
    void window.api.provider.readFile(previousPath, { ref: baseline }).then((r) => {
      if (!active) return;
      setBefore(r.isBinary ? makeDataUrl(r) : null);
    });
    void window.api.provider.readFile(filePath).then((r) => {
      if (!active) return;
      setAfter(r.isBinary ? makeDataUrl(r) : null);
    });
    return () => {
      active = false;
    };
  }, [worktreePath, baseline, filePath, oldPath]);

  return (
    <div style={{ display: 'flex', gap: 12, padding: 12, overflow: 'auto', height: '100%' }}>
      <ImagePane label="Before (baseline)" url={before} />
      <ImagePane label="After (working tree)" url={after} />
    </div>
  );
}

function ImagePane({ label, url }: { label: string; url: string | null }): JSX.Element {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{label}</div>
      <div
        style={{
          flex: 1,
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 8,
        }}
      >
        {url ? <img src={url} style={{ maxWidth: '100%', maxHeight: '100%' }} alt={label} /> : (
          <span style={{ color: 'var(--fg-dim)' }}>(unavailable)</span>
        )}
      </div>
    </div>
  );
}

function makeDataUrl(_r: { isBinary: boolean; sizeBytes: number; content: string | null }): string | null {
  // The IPC contract currently returns text content only; binary image data
  // round-trips would need a separate base64-aware path. For v1, the panel
  // shows a placeholder. This is a known limitation tracked by R10.
  return null;
}
