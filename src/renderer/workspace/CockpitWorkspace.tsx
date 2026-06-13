import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockviewApi, DockviewReadyEvent } from './Workspace';
import { Workspace } from './Workspace';
import { dockviewComponents } from './panels';
import {
  applyPreset,
  COLUMN_RATIOS,
  PRESET_LABELS,
  ratioLabel,
  type PresetName,
} from './presets';
import { activeViewKey, layoutKey } from './layoutKeys';
import { readFocus, writeFocus } from './focusMemory';
import { PANEL_TITLES, PanelIds, type PanelId } from './panelIds';
import { Button, DropdownMenu, Toolbar, ToolbarSpacer, type MenuItemDef } from '../ui';
import { useProjectsStore } from '../providerClient';
import { focusPanel, focusPanelForce, setFocusSuppressed } from './panelFocus';

/** Last view used for a project (defaults to edit). */
function readView(projectId: string): PresetName {
  return localStorage.getItem(activeViewKey(projectId)) === 'review' ? 'review' : 'edit';
}

/**
 * The center workbench: a themed Dockview hosting the cockpit panels, with
 * Edit/Review presets, a Panels menu to reopen closed panels, layout
 * persistence per project AND per view (localStorage), and reload of panel data
 * on project switch. Switching views restores that view's own saved layout.
 */
export function CockpitWorkspace(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const apiRef = useRef<DockviewApi | null>(null);
  const [view, setView] = useState<PresetName>('edit');
  // The layout-change saver is registered once, so it reads the live view here.
  const viewRef = useRef<PresetName>(view);
  viewRef.current = view;

  // Applying a layout/preset activates panels in a cascade; suppress keyboard
  // focus during it so it does not thrash, then clear on the next frame (covers
  // both synchronous and deferred Dockview active-panel events). An explicit
  // restoreFocusedPanel runs after and uses focusPanelForce to bypass this.
  const loadLayout = useCallback(
    (api: DockviewApi, projectId: string | null, which: PresetName) => {
      setFocusSuppressed(true);
      try {
        const saved = projectId ? localStorage.getItem(layoutKey(projectId, which)) : null;
        if (saved) {
          try {
            api.fromJSON(JSON.parse(saved));
            return;
          } catch {
            /* fall through to preset */
          }
        }
        applyPreset(api, which);
      } finally {
        requestAnimationFrame(() => setFocusSuppressed(false));
      }
    },
    [],
  );

  // Restore the panel that had focus for this project (remembered per project).
  // setActive makes it the active Dockview panel; focusPanelForce moves keyboard
  // focus into it through the shared seam (the panel's registered handler — the
  // Terminal's override focuses its active xterm pane), bypassing suppression.
  const restoreFocusedPanel = useCallback((api: DockviewApi, projectId: string | null) => {
    const saved = readFocus('panel', projectId);
    if (!saved) return;
    const panel = api.getPanel(saved);
    if (!panel) return;
    panel.api.setActive();
    focusPanelForce(saved as PanelId);
  }, []);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;
      loadLayout(event.api, activeId, viewRef.current);
      restoreFocusedPanel(event.api, useProjectsStore.getState().activeId);
      event.api.onDidLayoutChange(() => {
        const id = useProjectsStore.getState().activeId;
        if (id) localStorage.setItem(layoutKey(id, viewRef.current), JSON.stringify(event.api.toJSON()));
      });
      // Remember which panel has focus per project, so a switch-back restores it,
      // and move keyboard focus into the newly active panel (tab click, menu-open
      // via addPanel). Suppressed during layout/preset application.
      //
      // Only move focus on a GENUINE active-panel change. Dockview re-emits this
      // for the SAME panel when focus churns within it (e.g. a terminal split
      // remounts panes); re-running focusPanel then would dispatch the terminal's
      // focus override against the lagging active pane and steal focus back to the
      // old split. writeFocus stays unconditional.
      let lastActivePanelId: string | null = null;
      event.api.onDidActivePanelChange((panel) => {
        const id = useProjectsStore.getState().activeId;
        if (id && panel) writeFocus('panel', id, panel.id);
        if (!panel) {
          lastActivePanelId = null;
          return;
        }
        if (panel.id !== lastActivePanelId) {
          lastActivePanelId = panel.id;
          focusPanel(panel.id as PanelId);
        }
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Restore layout/focus on project switch (activeId change). Panel DATA
  // (Changes/Workgraph slices) is NOT loaded here: panelDataSync owns
  // load/refresh/clear off per-session connection status + watch events, so a
  // backgrounded project stays current and a switch renders its warm slice with
  // no fetch. This effect only handles the Dockview layout/view/focus.
  useEffect(() => {
    if (activeId) {
      const v = readView(activeId);
      setView(v);
      viewRef.current = v;
      if (apiRef.current) {
        loadLayout(apiRef.current, activeId, v);
        restoreFocusedPanel(apiRef.current, activeId);
      }
    } else if (apiRef.current) {
      loadLayout(apiRef.current, null, viewRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Ctrl+` focuses the Terminal panel from anywhere (VS Code convention) AND
  // moves keyboard focus into the active terminal so the user can type at once.
  // setActive only activates the Dockview panel; focusPanelForce routes through
  // the shared seam to the Terminal's override (focus the active xterm pane).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'Backquote') {
        const panel = apiRef.current?.getPanel(PanelIds.terminal);
        if (panel) {
          e.preventDefault();
          panel.api.setActive();
          focusPanelForce(PanelIds.terminal);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const choosePreset = (next: PresetName): void => {
    setView(next);
    viewRef.current = next;
    if (activeId) localStorage.setItem(activeViewKey(activeId), next);
    if (apiRef.current) {
      loadLayout(apiRef.current, activeId, next);
      // loadLayout lays panels out with focus suppressed; move keyboard focus
      // into the view's active panel (e.g. the terminal) so a keyboard
      // view-switch is immediately typeable without a click. focusPanelForce
      // bypasses the suppression; the pending path handles a not-yet-mounted panel.
      const active = apiRef.current.activePanel?.id as PanelId | undefined;
      if (active) focusPanelForce(active);
    }
  };

  // Keep a stable ref so the keydown handler below doesn't need re-registration
  // when activeId changes (same pattern as viewRef).
  const choosePresetRef = useRef(choosePreset);
  choosePresetRef.current = choosePreset;

  // Cmd+E → Edit view; Cmd+R → Review view (Ctrl+E/Ctrl+R on Win/Linux).
  // Platform-gated to the PRIMARY modifier only: on macOS that is Cmd, so
  // Ctrl+E/Ctrl+R stay with the focused terminal (end-of-line / reverse-i-search)
  // instead of being stolen by the view switch.
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const onKey = (e: KeyboardEvent): void => {
      const primary = isMac ? e.metaKey : e.ctrlKey;
      const other = isMac ? e.ctrlKey : e.metaKey;
      if (!primary || other || e.altKey || e.shiftKey) return;
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        choosePresetRef.current('edit');
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        choosePresetRef.current('review');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Reset the current view's layout to a proportional `1:center:1` default. */
  const resetTo = (center: (typeof COLUMN_RATIOS)[number]): void => {
    if (activeId) localStorage.removeItem(layoutKey(activeId, viewRef.current));
    if (apiRef.current) applyPreset(apiRef.current, viewRef.current, center);
  };

  /** Reopen a panel that was closed (or focus it if already open). */
  const openPanel = (id: PanelId): void => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    api.addPanel({ id, component: 'panel-host', params: { panelId: id }, title: PANEL_TITLES[id] });
  };

  const panelMenuItems: MenuItemDef[] = (Object.values(PanelIds) as PanelId[]).map((id) => ({
    label: PANEL_TITLES[id],
    onSelect: () => openPanel(id),
  }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <span className="text-xs text-dim">View</span>
        {(Object.keys(PRESET_LABELS) as PresetName[]).map((name) => (
          <Button
            key={name}
            size="sm"
            variant={view === name ? 'primary' : 'default'}
            onClick={() => view !== name && choosePreset(name)}
          >
            {PRESET_LABELS[name]}
          </Button>
        ))}
        <ToolbarSpacer />
        <DropdownMenu
          trigger={
            <Button size="sm" title="Reopen a closed panel">
              Panels ▾
            </Button>
          }
          items={panelMenuItems}
        />
        <DropdownMenu
          trigger={
            <Button size="sm" title="Reset layout to a column ratio">
              Reset ▾
            </Button>
          }
          items={COLUMN_RATIOS.map((center) => ({
            label: `Columns ${ratioLabel(center)}`,
            onSelect: () => resetTo(center),
          }))}
        />
      </Toolbar>
      <div className="min-h-0 flex-1">
        <Workspace components={dockviewComponents} onReady={onReady} />
      </div>
    </div>
  );
}
