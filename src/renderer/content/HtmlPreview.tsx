import { useEffect, useState } from 'react';

interface HtmlPreviewProps {
  worktreePath: string;
  filePath: string;
}

/**
 * Restrictive CSP injected into every previewed document. A sandboxed iframe has
 * no CSP of its own, so without this a mockup could beacon out via
 * `<img src="https://attacker/…">`. `default-src 'none'` fails every fetch class
 * closed; only inline styles, `data:` images/fonts, and inline scripts are
 * permitted — and `script-src` is inert unless the sandbox also grants
 * `allow-scripts` (phase 2). No remote origin is ever allowed, so even with
 * scripts on a mockup cannot load or exfiltrate over the network.
 */
export const PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; script-src 'unsafe-inline'";

/**
 * Inject the egress-blocking CSP as the document's first `<head>` child so it
 * governs the whole document. Falls back to synthesizing a `<head>` (or a full
 * skeleton) when the source omits one, so a bare HTML fragment is still capped.
 */
export function injectPreviewCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
  const headOpen = /<head[^>]*>/i;
  if (headOpen.test(html)) return html.replace(headOpen, (m) => `${m}${meta}`);
  const htmlOpen = /<html[^>]*>/i;
  if (htmlOpen.test(html)) return html.replace(htmlOpen, (m) => `${m}<head>${meta}</head>`);
  return `<!doctype html><head>${meta}</head>${html}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'text'; content: string }
  | { kind: 'binary'; sizeBytes: number }
  | { kind: 'too-large'; sizeBytes: number }
  | { kind: 'missing' };

/**
 * Renders a repo `.html`/`.htm` file visually inside a sandboxed `blob:` iframe.
 * Static by construction: `sandbox=""` denies everything (no scripts, no forms,
 * no same-origin), and the injected {@link PREVIEW_CSP} blocks network egress.
 * The opaque-origin iframe cannot reach the app, its storage, or `window.parent`.
 * The file's current working-tree content is previewed.
 *
 * Scripts do NOT run — this is deliberate for v1. Interactive prototypes (an
 * opt-in "Run scripts" mode) are deferred to v2: the app applies a strict CSP
 * response header to every default-session response (electron/main/security.ts),
 * so enabling inline scripts requires a scoped main-process change to exempt the
 * preview blob from that header. See the v2 bead / proposal "Out of scope".
 */
export function HtmlPreview({ worktreePath, filePath }: HtmlPreviewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void window.api.provider.readFile(filePath, { worktreePath }).then((r) => {
      if (!active) return;
      if (r.content !== null) setState({ kind: 'text', content: r.content });
      else if (r.truncated) setState({ kind: 'too-large', sizeBytes: r.sizeBytes });
      else if (r.isBinary) setState({ kind: 'binary', sizeBytes: r.sizeBytes });
      else setState({ kind: 'missing' });
    });
    return () => {
      active = false;
    };
  }, [worktreePath, filePath]);

  // Build a blob: URL from the CSP-injected document; revoke it on unmount or
  // whenever the source changes so object URLs do not leak.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (state.kind !== 'text') {
      setBlobUrl(null);
      return;
    }
    const doc = injectPreviewCsp(state.content);
    const url = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [state]);

  if (state.kind === 'loading') {
    return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>;
  }
  if (state.kind === 'binary') {
    return (
      <div style={{ padding: 16, color: 'var(--fg-dim)' }}>Binary file ({fmtSize(state.sizeBytes)}).</div>
    );
  }
  if (state.kind === 'too-large') {
    return (
      <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
        File too large to preview inline ({fmtSize(state.sizeBytes)}).
      </div>
    );
  }
  if (state.kind === 'missing') {
    return <div style={{ padding: 16, color: 'var(--fg-dim)' }}>File not found.</div>;
  }

  return (
    <iframe
      title="HTML preview"
      // Deny everything: no scripts, no same-origin, no forms, no popups. The
      // opaque origin plus the injected CSP make this a read-only visual render.
      sandbox=""
      src={blobUrl ?? undefined}
      style={{ width: '100%', height: '100%', border: 0, background: 'white' }}
    />
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
