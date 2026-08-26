import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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

// By default the viewport auto-sizes to the diagram's own natural rendered
// height (clamped to AUTO_MAX_HEIGHT) — small diagrams (a 3-node flowchart)
// no longer pay for a fixed-size box they don't need, matching how GitHub
// renders inline diagrams at their natural size. Large diagrams still need a
// bound (an unbounded viewport could blow out the panel), so auto-sizing caps
// at AUTO_MAX_HEIGHT; the drag handle still lets a user manually resize past
// that cap (up to MAX_HEIGHT) for a diagram that genuinely needs more room.
// A manual resize is persisted (applies to every diagram and across
// sessions, since "I want more room" is usually a lasting preference) and,
// once set, takes precedence over auto-sizing until the value is cleared
// from localStorage.
const DIAGRAM_HEIGHT_KEY = 'ac:diagramHeight';
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 2000;
const DEFAULT_HEIGHT = 360;
const AUTO_MAX_HEIGHT = 600;

/** A persisted MANUAL override, or `null` if the user has never resized (i.e.
 *  this diagram should auto-size to its own content). */
function readHeightOverride(): number | null {
  try {
    const raw = localStorage.getItem(DIAGRAM_HEIGHT_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= MIN_HEIGHT && n <= MAX_HEIGHT ? n : null;
  } catch {
    return null;
  }
}

export function DiagramFrame({ label, source, render, renderKey }: DiagramFrameProps): JSX.Element {
  const [state, setState] = useState<RenderState>({ kind: 'loading' });
  const [showSource, setShowSource] = useState(false);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  // Read once per mount: a manual override (if any) is the fixed starting
  // height; otherwise start at DEFAULT_HEIGHT as a placeholder until the
  // layout effect below measures the diagram's own natural height and
  // corrects it (before paint, so there's no visible flash).
  const heightOverrideRef = useRef<number | null>(readHeightOverride());
  const [height, setHeight] = useState<number>(() => heightOverrideRef.current ?? DEFAULT_HEIGHT);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
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

  // Auto-size to the diagram's own natural rendered height, unless a manual
  // override is already in effect. Runs as a layout effect (synchronously
  // before paint) so the DEFAULT_HEIGHT placeholder never actually flashes.
  // `contentRef` is the absolutely-positioned SVG wrapper, so its own layout
  // size is unaffected by the ancestor viewport's (possibly still-stale)
  // height — measuring it here is accurate regardless of the height in
  // effect at the moment of measurement. Re-runs on every successful render
  // (e.g. a source/theme change), so auto-sized diagrams keep tracking their
  // own content.
  useLayoutEffect(() => {
    if (state.kind !== 'ok' || heightOverrideRef.current !== null) return;
    const natural = contentRef.current?.getBoundingClientRect().height;
    if (natural && natural > 0) {
      setHeight(Math.round(clamp(natural, MIN_HEIGHT, AUTO_MAX_HEIGHT)));
    }
  }, [state]);

  const onResizeDown = (e: React.PointerEvent): void => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    resizeRef.current = { sy: e.clientY, h: height };
  };
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resizeRef.current;
    if (!r) return;
    const next = Math.round(clamp(r.h + (e.clientY - r.sy), MIN_HEIGHT, MAX_HEIGHT));
    // A manual drag establishes (or updates) the persisted override, which
    // takes over from auto-sizing — for this diagram immediately, and for
    // every OTHER diagram on its next mount (matching the pre-existing
    // "applies across every diagram and across sessions" persistence model).
    heightOverrideRef.current = next;
    setHeight(next);
    try {
      localStorage.setItem(DIAGRAM_HEIGHT_KEY, String(next));
    } catch {
      /* no localStorage in this environment */
    }
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
              ref={contentRef}
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
