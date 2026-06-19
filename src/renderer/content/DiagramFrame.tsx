import { useEffect, useRef, useState } from 'react';

/**
 * Shared chrome for inline diagram renderers (mermaid, graphviz). It owns the
 * async render lifecycle (loading/error/ok), the Source toggle, and the
 * zoom/pan viewport. The concrete renderer is injected as `render`, an async
 * function returning a **already-sanitized** SVG string (the caller is
 * responsible for DOMPurify, since the safe profile differs per source). The
 * render re-runs whenever `renderKey` changes.
 */
interface DiagramFrameProps {
  /** Toolbar label, e.g. "Mermaid" / "Graphviz". */
  label: string;
  /** The diagram source, shown by the Source toggle. */
  source: string;
  /** Produce a sanitized SVG string (or throw with a useful message). */
  render: () => Promise<string>;
  /** Re-run `render` whenever this changes (e.g. source, or source+theme). */
  renderKey: string;
}

type RenderState =
  | { kind: 'loading' }
  | { kind: 'ok'; svg: string }
  | { kind: 'error'; message: string };

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

// Diagram viewport height is user-resizable and persisted (applies to every
// diagram and across sessions), since some graphs need more vertical room.
const DIAGRAM_HEIGHT_KEY = 'ac:diagramHeight';
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 360;

function readDiagramHeight(): number {
  try {
    const n = Number(localStorage.getItem(DIAGRAM_HEIGHT_KEY));
    return Number.isFinite(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT ? n : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

export function DiagramFrame({ label, source, render, renderKey }: DiagramFrameProps): JSX.Element {
  const [state, setState] = useState<RenderState>({ kind: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [height, setHeight] = useState<number>(() => readDiagramHeight());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; x: number; y: number } | null>(null);
  const resizeRef = useRef<{ sy: number; h: number } | null>(null);
  // Hold the latest render closure in a ref so the effect depends only on
  // `renderKey` (not the closure identity, which changes every render).
  const renderRef = useRef(render);
  renderRef.current = render;

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    setView({ scale: 1, x: 0, y: 0 });
    void (async () => {
      try {
        const svg = await renderRef.current();
        if (active) setState({ kind: 'ok', svg });
      } catch (err) {
        if (active) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      active = false;
    };
  }, [renderKey]);

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

  // Persist the user's chosen viewport height so it applies to every diagram.
  useEffect(() => {
    try {
      localStorage.setItem(DIAGRAM_HEIGHT_KEY, String(height));
    } catch {
      /* no localStorage in this environment */
    }
  }, [height]);

  const onResizeDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    resizeRef.current = { sy: e.clientY, h: height };
  };
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resizeRef.current;
    if (!r) return;
    setHeight(Math.round(clamp(r.h + (e.clientY - r.sy), MIN_HEIGHT, MAX_HEIGHT)));
  };
  const endResize = (): void => {
    resizeRef.current = null;
  };

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
        <span>{label}</span>
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
          <strong>{label} render failed.</strong>
          <pre className="m-0 mt-1 whitespace-pre-wrap">{state.message}</pre>
        </div>
      )}
      {state.kind === 'ok' && (
        <>
          <div
            ref={viewportRef}
            className="relative cursor-grab overflow-hidden active:cursor-grabbing"
            style={{ height: `${height}px` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            <div
              className="absolute left-0 top-0 origin-top-left p-2 [&_svg]:max-w-none"
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
              // SVG is renderer-generated and DOMPurify-sanitized by the caller's `render`.
              dangerouslySetInnerHTML={{ __html: state.svg }}
            />
          </div>
          {/* Drag to resize the viewport height (persisted across diagrams). */}
          <div
            className="flex h-2 cursor-row-resize items-center justify-center border-t border-edge bg-bg hover:bg-panel-2"
            title="Drag to resize"
            onPointerDown={onResizeDown}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
            onPointerLeave={endResize}
          >
            <span className="h-0.5 w-8 rounded bg-dim" />
          </div>
        </>
      )}
    </div>
  );
}
