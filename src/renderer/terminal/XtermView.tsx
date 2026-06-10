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
  kind = 'terminal',
  resetToken = 0,
}: {
  /** Owning project; part of the terminal's identity so keys never collide. */
  projectId: string;
  terminalKey: string;
  visible: boolean;
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
    const ro = new ResizeObserver(() => registry.fit(entry));
    ro.observe(host);
    if (visible) registry.focus(entry);
    return () => {
      ro.disconnect();
      registry.detach(entry);
      entryRef.current = null;
    };
    // `visible` is handled by its own effect; re-running attach on it would churn.
    // `resetToken` is included so a reset re-acquires the (freshly disposed) entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, terminalKey, kind, resetToken]);

  // Refit + refocus when this view becomes active.
  useEffect(() => {
    if (!visible) return;
    const entry = entryRef.current;
    if (!entry) return;
    requestAnimationFrame(() => {
      registry.fit(entry);
      registry.focus(entry);
    });
  }, [visible]);

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
      className="h-full w-full bg-bg"
      style={{ display: visible ? 'block' : 'none' }}
      onMouseDown={() => {
        if (entryRef.current) registry.focus(entryRef.current);
      }}
    />
  );
}
