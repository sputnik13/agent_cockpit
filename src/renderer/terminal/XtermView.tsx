import { useEffect, useRef } from 'react';
import { useSettingsStore } from '../settings';
import type { TerminalKind } from '@shared/providers/types';
import * as registry from './terminalRegistry';

/**
 * Thin view over a registry-owned terminal. The xterm instance lives in
 * {@link registry} keyed by `(projectId, kind, key)`; this component only
 * reparents that instance's container into its host and forwards size/visibility
 * changes. On unmount it detaches (keeping the instance alive across Dockview
 * layout rebuilds and project switches); the instance is disposed only on an
 * explicit tab close. Font/theme follow the app settings live.
 */
export function XtermView({
  projectId,
  terminalKey,
  visible,
  focusOnVisible = visible,
  keepLayoutWhenHidden = false,
  layoutEpoch,
  kind = 'terminal',
  resetToken = 0,
}: {
  /** Owning project; part of the terminal's identity so keys never collide. */
  projectId: string;
  terminalKey: string;
  visible: boolean;
  /** A split keeps several panes visible; only the selected pane takes focus. */
  focusOnVisible?: boolean;
  /** Keep a retained renderer measurable while an enclosing mux window is hidden. */
  keepLayoutWhenHidden?: boolean;
  /** Changes whenever an enclosing mux split tree changes its leaf rectangles. */
  layoutEpoch?: string;
  /** tmux session namespace for this view; defaults to `terminal`. */
  kind?: TerminalKind;
  /** Bump to force re-acquire after a `registry.reset` (reattach the session). */
  resetToken?: number;
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const entryRef = useRef<registry.TerminalEntry | null>(null);
  const theme = useSettingsStore((s) => s.settings.theme);
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily);
  const fontSize = useSettingsStore((s) => s.settings.fontSize);

  // Acquire + reparent the persistent terminal; detach (never dispose) on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const entry = registry.acquire(projectId, kind, terminalKey);
    entryRef.current = entry;
    registry.attach(entry, host);
    const onRendererGeometry = (): void => registry.fit(entry);
    entry.container.addEventListener('ac:terminal-geometry', onRendererGeometry);
    const ro = new ResizeObserver(() => registry.fit(entry));
    ro.observe(host);
    // WTerm mutates its own DOM grid as it reflows. Observe that surface too:
    // a flex split can settle after the host's first callback, and the new
    // renderer rectangle must be propagated back to the PTY (not merely drawn).
    ro.observe(entry.container);
    // A topology split can remount this view while its new flex parent still
    // has the source pane's pre-split rectangle. Refit after layout commits as
    // well as through ResizeObserver: WTerm needs the corresponding PTY resize
    // for full-screen programs such as Neovim to redraw their grid.
    const settleFrame = requestAnimationFrame(() => registry.fit(entry));
    const settleTimer = window.setTimeout(() => registry.fit(entry), 50);
    if (focusOnVisible) registry.focus(entry);
    return () => {
      ro.disconnect();
      entry.container.removeEventListener('ac:terminal-geometry', onRendererGeometry);
      cancelAnimationFrame(settleFrame);
      window.clearTimeout(settleTimer);
      registry.detach(entry, host);
      entryRef.current = null;
    };
    // `visible` is handled by its own effect; re-running attach on it would churn.
    // `resetToken` is included so a reset re-acquires the (freshly disposed) entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalKey, kind, resetToken]);

  // Visibility is not a sizing boundary: retained mux windows remain mounted
  // with a real layout box while hidden. Re-fitting them on every window return
  // calls WTerm.resize(), which recreates its DOM grid and visibly redraws the
  // entire pane. The host ResizeObserver and the topology epoch own genuine
  // geometry changes; this effect owns focus only.
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      if (focusOnVisible) registry.focus(entry);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [visible, focusOnVisible]);

  // React can preserve a leaf's XtermView while its ancestors change from a
  // single pane to a flex split. That has no visible-prop transition, so make
  // the topology epoch an explicit sizing boundary. Both frames are needed:
  // the first observes the new leaf and the second catches flex settlement.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      if (entryRef.current) registry.fit(entryRef.current);
    });
    const settle = window.setTimeout(() => {
      const entry = entryRef.current;
      if (!entry) return;
      // WTerm virtualizes its DOM grid. A split's flex rectangle can settle
      // after its first attach/fit. The renderer's host observer owns its
      // settled repaint; this boundary only propagates final geometry.
      registry.fit(entry);
    }, 75);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [layoutEpoch]);

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
      data-terminal-key={terminalKey}
      className="h-full w-full bg-bg"
      style={
        visible || keepLayoutWhenHidden
          ? {
              display: 'block',
              visibility: visible ? 'visible' : 'hidden',
              pointerEvents: visible ? 'auto' : 'none',
            }
          : { display: 'none' }
      }
      onMouseDown={() => {
        if (entryRef.current) registry.focus(entryRef.current);
      }}
    />
  );
}
