import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useSettingsStore } from '../settings';

interface MermaidFrameProps {
  source: string;
}

// Lazy-load the bundled mermaid (a large dep) only when a diagram is shown.
// Loading from a CDN is impossible under the app CSP (script-src 'self'); the
// bundled copy is same-origin and works offline.
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

let idSeq = 0;

type RenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; svg: string }
  | { kind: 'error'; message: string };

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Renders a mermaid diagram from untrusted Markdown. mermaid runs with
 * securityLevel 'strict' and SVG-only labels; its SVG output is sanitized with
 * DOMPurify before insertion. The diagram is zoom/pan-able (wheel + drag).
 */
export function MermaidFrame({ source }: MermaidFrameProps): JSX.Element {
  const theme = useSettingsStore((s) => s.settings.theme);
  const [state, setState] = useState<RenderState>({ kind: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    setView({ scale: 1, x: 0, y: 0 });
    const renderId = `mmd-${++idSeq}`;
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'solarized-light' ? 'default' : 'dark',
          // Native SVG <text> labels (not HTML <foreignObject>), which the
          // DOMPurify SVG profile preserves — otherwise shapes have no text.
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render(renderId, source);
        const safe = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['style'],
        });
        if (active) setState({ kind: 'ok', svg: safe });
      } catch (err) {
        if (active) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        // mermaid appends a temporary measuring element (`#d<id>`) to
        // document.body to render into; on a PARSE error it injects its
        // "Syntax error in text" diagram there and throws BEFORE removing it,
        // leaking an orphan below the app root that makes the whole frame
        // scrollable. Always remove it (success or failure).
        document.getElementById(`d${renderId}`)?.remove();
        document.getElementById(renderId)?.remove();
      }
    })();
    return () => {
      active = false;
    };
  }, [source, theme]);

  // Non-passive wheel listener so we can preventDefault and zoom toward cursor.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || state.kind !== 'ok') return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const next = clamp(v.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_SCALE, MAX_SCALE);
        const k = next / v.scale;
        return { scale: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [state.kind]);

  const zoomBy = (factor: number): void =>
    setView((v) => {
      const el = viewportRef.current;
      const cx = el ? el.clientWidth / 2 : 0;
      const cy = el ? el.clientHeight / 2 : 0;
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const k = next / v.scale;
      return { scale: next, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.x + (e.clientX - d.sx), y: d.y + (e.clientY - d.sy) }));
  };
  const endDrag = (): void => {
    dragRef.current = null;
  };

  return (
    <div className="overflow-hidden rounded border border-edge bg-panel">
      <div className="flex items-center justify-between border-b border-edge bg-bg px-2 py-1 text-[11px] text-dim">
        <span>Mermaid</span>
        <div className="flex items-center gap-1">
          {state.kind === 'ok' && (
            <>
              <button className="px-1 hover:text-fg" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
                −
              </button>
              <span className="tabular-nums">{Math.round(view.scale * 100)}%</span>
              <button className="px-1 hover:text-fg" title="Zoom in" onClick={() => zoomBy(1.2)}>
                +
              </button>
              <button
                className="px-1 hover:text-fg"
                title="Reset zoom"
                onClick={() => setView({ scale: 1, x: 0, y: 0 })}
              >
                ⤢
              </button>
            </>
          )}
          <button className="px-1 hover:text-fg" onClick={() => setShowSource((s) => !s)}>
            {showSource ? 'Hide source' : 'Source'}
          </button>
        </div>
      </div>
      {showSource && (
        <pre className="m-0 whitespace-pre-wrap bg-bg p-2 text-[12px] text-dim">{source}</pre>
      )}
      {state.kind === 'loading' && <div className="p-3 text-[12px] text-dim">Rendering…</div>}
      {state.kind === 'error' && (
        <div className="px-2 py-2 text-[11px] text-removed">
          <strong>Mermaid render failed.</strong>
          <pre className="m-0 mt-1 whitespace-pre-wrap">{state.message}</pre>
        </div>
      )}
      {state.kind === 'ok' && (
        <div
          ref={viewportRef}
          className="relative h-[360px] cursor-grab overflow-hidden active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          <div
            className="absolute left-0 top-0 origin-top-left p-2 [&_svg]:max-w-none"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            // SVG is mermaid-generated (strict, SVG labels) and DOMPurify-sanitized.
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        </div>
      )}
    </div>
  );
}
