import { useEffect, type ReactNode } from 'react';
import { TooltipProvider } from '../ui';
import { initProjectsSync, initSessionSync } from '../providerClient';
import { initSettingsSync, useSettingsStore, SettingsDialog } from '../settings';
import { initPanelDataSync } from '../workspace/panelDataSync';
import { ProjectTabs } from './ProjectTabs';
import { StatusRegion } from './StatusRegion';

/**
 * Top-level cockpit shell: a horizontal project tab strip on top, a center
 * workspace host (passed as children — the Dockview workbench), and a bottom
 * status region.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    // Session-status sync must be wired BEFORE panelDataSync so the orchestrator
    // sees status edges (it also seeds from the current snapshot on init).
    const offSession = initSessionSync();
    const offProjects = initProjectsSync();
    const offPanelData = initPanelDataSync();
    const offSettings = initSettingsSync();
    return () => {
      offPanelData();
      offProjects();
      offSession();
      offSettings();
    };
  }, []);

  // macOS-standard Preferences shortcut (⌘,).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        // Blur whatever is focused before the dialog mounts: Radix sets
        // aria-hidden on the background, and Chromium warns ("Blocked
        // aria-hidden on an element because its descendant retained focus")
        // when an xterm textarea is still focused inside it.
        (document.activeElement as HTMLElement | null)?.blur?.();
        useSettingsStore.getState().setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ⌘⇧L (Ctrl⇧L off macOS) — open the Diagnostics window (separate OS window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'L') {
        e.preventDefault();
        void window.api.openDiagnostics();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <TooltipProvider>
      <div className="flex h-full w-full flex-col bg-bg text-fg">
        {/* Empty themed title strip housing the OS window controls (macOS traffic
            lights / Windows caption overlay). It is the window drag region; on
            Linux (default frame) it is omitted. Height matches TITLE_BAR_HEIGHT
            in electron/main/window.ts. */}
        {SHOW_TITLE_STRIP && (
          <div className="app-drag h-8 shrink-0 bg-panel" aria-hidden="true" />
        )}
        <ProjectTabs />
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        <StatusRegion />
      </div>
      <SettingsDialog />
    </TooltipProvider>
  );
}

// The OS overlays its window controls onto our content only with a hidden/inset
// title bar (macOS + Windows); Linux keeps a native frame, so no strip is needed.
const SHOW_TITLE_STRIP =
  typeof navigator !== 'undefined' && /Mac|Windows/i.test(navigator.userAgent);
