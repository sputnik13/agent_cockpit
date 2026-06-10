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
        <ProjectTabs />
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
        <StatusRegion />
      </div>
      <SettingsDialog />
    </TooltipProvider>
  );
}
