import { Fragment, useEffect, useRef, useState } from 'react';
import type { LayoutNode } from '@shared/tmux';
import { useSettingsStore } from '../settings';
import { cn } from '../ui';
import * as registry from './controlPaneRegistry';
import { useTmuxStore } from './tmuxStore';

/**
 * Thin view over a registry-owned control-mode pane terminal. The xterm lives in
 * {@link registry} keyed by `(projectId, paneId)`; this component only reparents
 * that instance's container into its host and forwards size/focus changes. On
 * unmount it detaches (keeping the instance alive across project switches and
 * Dockview rebuilds); disposal happens only on explicit pane/window close or
 * idle reaping. Font/theme follow app settings live.
 */
export function PaneXterm({
  projectId,
  paneId,
  active = true,
  onFocusPane,
  showZoom = false,
  isZoomed = false,
  onZoomPane,
}: {
  projectId: string;
  paneId: string;
  active?: boolean;
  onFocusPane?: (id: string) => void;
  /** Show the per-pane zoom toggle (fades in on pane hover). */
  showZoom?: boolean;
  /** Whether the window is currently zoomed (drives the button glyph/label). */
  isZoomed?: boolean;
  /** Toggle tmux `resize-pane -Z` on this pane. */
  onZoomPane?: (id: string) => void;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const entryRef = useRef<registry.PaneEntry | null>(null);
  // Mirror `active` into a ref so the mount effect can read the current value
  // without taking `active` as a dependency (which would re-acquire the pane).
  const activeRef = useRef(active);
  activeRef.current = active;
  const theme = useSettingsStore((s) => s.settings.theme);
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily);
  const fontSize = useSettingsStore((s) => s.settings.fontSize);

  // Acquire + reparent the persistent pane terminal; detach (never dispose) on
  // unmount so switching projects keeps the instance and its scrollback.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = registry.acquire(projectId, paneId);
    entryRef.current = entry;
    registry.attach(entry, host);
    const ro = new ResizeObserver(() => registry.fit(entry));
    ro.observe(host);
    // If this pane mounts already-active (e.g. the rebuilt pane after a
    // reconnect, where `active` never transitions because it starts true),
    // focus it once the xterm element is attached. Without this, the
    // active-transition effect below never fires and the terminal is unfocusable
    // after reconnect.
    // Read `active` at mount only — intentionally NOT a dep, so a later active
    // toggle does not re-acquire/re-attach the pane (the transition effect below
    // owns ongoing focus). Captures the mount-time value to focus a pane that is
    // already active on mount (the reconnect-rebuild case).
    // Re-check `active` at FIRE time, not schedule time: a split restructures the
    // layout tree and remounts the pre-existing panes, so a pane that mounts
    // already-active can be superseded by the new split's pane before this frame
    // runs. Focusing on the stale schedule-time value let the remounting old pane
    // steal focus back from the new split (a race — sometimes it won). Only focus
    // if this pane is STILL the active one when the frame fires.
    const raf = requestAnimationFrame(() => {
      if (!activeRef.current) return;
      entry.renderer.focus();
    });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      registry.detach(entry);
      entryRef.current = null;
    };
  }, [projectId, paneId]);

  // Move keyboard focus to the pane when it BECOMES active after mount (arrow-key
  // split navigation / click). The mount run is skipped: a fresh or remounted
  // pane's initial focus is owned by the mount effect above (which re-checks
  // `active` at fire time). Without skipping, a pane that remounts already-active
  // during a sibling split would synchronously re-focus itself and steal focus
  // from the new split.
  const firstActiveRun = useRef(true);
  useEffect(() => {
    if (firstActiveRun.current) {
      firstActiveRun.current = false;
      return;
    }
    if (active) entryRef.current?.renderer.focus();
  }, [active]);

  // Apply font/theme changes to the live terminal without recreating it.
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    registry.applyAppearance(entry, useSettingsStore.getState().settings);
    requestAnimationFrame(() => registry.fit(entry));
  }, [theme, fontFamily, fontSize]);

  return (
    <div
      ref={hostRef}
      className={cn('ac-term-host group relative h-full w-full bg-bg', active && 'ring-1 ring-accent')}
      onMouseDown={() => {
        onFocusPane?.(paneId);
        entryRef.current?.renderer.focus();
      }}
    >
      {showZoom && onZoomPane && (
        // right-3 (not right-1) clears the ~10px xterm ::-webkit-scrollbar lane,
        // which would otherwise eat the pointerdown; z-10 paints above the xterm
        // viewport (xterm is position:relative with no z-index, so no isolation).
        <button
          type="button"
          aria-label={isZoomed ? 'Unzoom pane' : 'Zoom pane'}
          title={isZoomed ? 'Unzoom pane' : 'Zoom pane'}
          // Keep the host's onMouseDown from also firing select-pane/focus; the
          // zoom command targets this pane id explicitly.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onZoomPane(paneId);
          }}
          className={cn(
            'absolute right-3 top-1 z-10 flex h-5 w-5 items-center justify-center rounded',
            'border border-edge bg-panel text-xs leading-none text-dim',
            'opacity-0 transition-opacity hover:bg-elev hover:text-fg focus:opacity-100 group-hover:opacity-100',
            isZoomed && 'opacity-100 text-fg',
          )}
        >
          {isZoomed ? '⊟' : '⛶'}
        </button>
      )}
    </div>
  );
}

/** Recursively render a tmux layout tree as nested flex splits. Split nodes
 *  delegate to {@link SplitNode} so each level owns its own drag-resize state. */
export function PaneTree({
  projectId,
  node,
  activePaneId,
  onFocusPane,
  showZoom = false,
  isZoomed = false,
  onZoomPane,
}: {
  projectId: string;
  node: LayoutNode;
  activePaneId: string | null;
  onFocusPane: (id: string) => void;
  showZoom?: boolean;
  isZoomed?: boolean;
  onZoomPane?: (id: string) => void;
}): JSX.Element {
  if (node.type === 'leaf') {
    return (
      <PaneXterm
        projectId={projectId}
        paneId={node.paneId}
        active={node.paneId === activePaneId}
        onFocusPane={onFocusPane}
        showZoom={showZoom}
        isZoomed={isZoomed}
        onZoomPane={onZoomPane}
      />
    );
  }
  return (
    <SplitNode
      projectId={projectId}
      node={node}
      activePaneId={activePaneId}
      onFocusPane={onFocusPane}
      showZoom={showZoom}
      isZoomed={isZoomed}
      onZoomPane={onZoomPane}
    />
  );
}

/** One split-tree level: renders its children with a draggable separator between
 *  each. Dragging gives live visual feedback via a local flex override; on
 *  release it sends `resize-pane` to tmux and the resulting %layout-change
 *  repopulates the tree from the authoritative layout. */
function SplitNode({
  projectId,
  node,
  activePaneId,
  onFocusPane,
  showZoom = false,
  isZoomed = false,
  onZoomPane,
}: {
  projectId: string;
  node: Extract<LayoutNode, { type: 'split' }>;
  activePaneId: string | null;
  onFocusPane: (id: string) => void;
  showZoom?: boolean;
  isZoomed?: boolean;
  onZoomPane?: (id: string) => void;
}): JSX.Element {
  const isRow = node.dir === 'lr';
  const total = node.children.reduce((sum, c) => sum + (isRow ? c.w : c.h), 0) || 1;
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live-drag override: while a separator is being dragged, shift `deltaCells`
  // cells from child[idx+1] into child[idx] (negative = the other direction).
  const [drag, setDrag] = useState<{ idx: number; deltaCells: number } | null>(null);

  const onSeparatorPointerDown = (idx: number) => (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    const sep = e.currentTarget;
    const containerSize = isRow
      ? (containerRef.current?.clientWidth ?? 0)
      : (containerRef.current?.clientHeight ?? 0);
    if (containerSize <= 0) return;
    const cellPx = containerSize / total;
    const start = isRow ? e.clientX : e.clientY;
    sep.setPointerCapture(e.pointerId);
    e.preventDefault();

    const move = (ev: PointerEvent): void => {
      const pos = isRow ? ev.clientX : ev.clientY;
      setDrag({ idx, deltaCells: Math.round((pos - start) / cellPx) });
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (sep.hasPointerCapture(e.pointerId)) sep.releasePointerCapture(e.pointerId);
      const pos = isRow ? ev.clientX : ev.clientY;
      const deltaCells = Math.round((pos - start) / cellPx);
      setDrag(null);
      if (deltaCells === 0) return;
      // tmux's `resize-pane -t pane -L|-R|-U|-D N` shifts the pane's bottom-right
      // boundary N cells in the given direction; applied to the left/top child
      // it moves the separator between (child[idx], child[idx+1]).
      const leftPaneId = firstPaneId(node.children[idx] ?? null);
      if (!leftPaneId) return;
      const flag = isRow ? (deltaCells > 0 ? 'R' : 'L') : (deltaCells > 0 ? 'D' : 'U');
      void useTmuxStore.getState().command(`resize-pane -t ${leftPaneId} -${flag} ${Math.abs(deltaCells)}`).catch(() => {});
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div ref={containerRef} className={cn('flex h-full w-full', isRow ? 'flex-row' : 'flex-col')}>
      {node.children.map((child, i) => {
        const base = isRow ? child.w : child.h;
        // Apply the live drag override to the two children adjacent to the dragged separator.
        let size = base;
        if (drag) {
          if (i === drag.idx) size = Math.max(1, base + drag.deltaCells);
          else if (i === drag.idx + 1) size = Math.max(1, base - drag.deltaCells);
        }
        return (
          <Fragment key={i}>
            {i > 0 && (
              <div
                role="separator"
                aria-orientation={isRow ? 'vertical' : 'horizontal'}
                onPointerDown={onSeparatorPointerDown(i - 1)}
                className={cn(
                  'shrink-0 bg-edge transition-colors hover:bg-accent',
                  isRow ? 'w-[3px] cursor-col-resize' : 'h-[3px] cursor-row-resize',
                )}
              />
            )}
            <div className="min-h-0 min-w-0" style={{ flexGrow: size / total, flexBasis: 0 }}>
              <PaneTree
                projectId={projectId}
                node={child}
                activePaneId={activePaneId}
                onFocusPane={onFocusPane}
                showZoom={showZoom}
                isZoomed={isZoomed}
                onZoomPane={onZoomPane}
              />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Leaf pane ids of a layout tree (depth-first, left to right). */
export function paneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.paneId];
  return node.children.flatMap(paneIds);
}

export function firstPaneId(node: LayoutNode | null): string | null {
  return paneIds(node)[0] ?? null;
}
