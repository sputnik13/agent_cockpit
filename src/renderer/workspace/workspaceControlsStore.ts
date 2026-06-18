import { create } from 'zustand';
import type { ColumnRatio, PresetName } from './presets';
import type { PanelId } from './panelIds';

/**
 * Bridge store for the workbench controls that live logically in
 * {@link CockpitWorkspace} (it owns the Dockview api, the current view, and the
 * preset/panel handlers) but are now rendered in the shell top bar
 * (`ProjectTabs`), far from it in the tree. CockpitWorkspace publishes its
 * current view + handlers here on mount/update; the top bar consumes them.
 *
 * `available` is false whenever no workbench is mounted (e.g. no active
 * project), so the top bar can disable the view/panels/reset controls instead of
 * calling into a torn-down api.
 */
interface WorkspaceControlsState {
  /** Current preset/view, mirrored from CockpitWorkspace. */
  view: PresetName;
  /** True while a Dockview workbench is mounted and the handlers are live. */
  available: boolean;
  /** Switch the active view/preset (persists + restores that view's layout). */
  choosePreset: (next: PresetName) => void;
  /** Reopen (or focus) a panel by id. */
  openPanel: (id: PanelId) => void;
  /** Reset the current view's layout to a column ratio. */
  resetTo: (ratio: ColumnRatio) => void;
}

const noop = (): void => {};

export const useWorkspaceControlsStore = create<WorkspaceControlsState>(() => ({
  view: 'edit',
  available: false,
  choosePreset: noop,
  openPanel: noop,
  resetTo: noop,
}));
