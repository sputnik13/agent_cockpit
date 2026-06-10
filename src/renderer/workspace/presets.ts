import type { DockviewApi } from 'dockview-react';
import { useSettingsStore } from '../settings/settingsStore';
import { PanelIds, PANEL_TITLES, type PanelId } from './panelIds';

export type PresetName = 'edit' | 'review';

export const PRESET_LABELS: Record<PresetName, string> = {
  edit: 'Edit',
  review: 'Review',
};

function addPanel(
  api: DockviewApi,
  id: PanelId,
  position?: Parameters<DockviewApi['addPanel']>[0]['position'],
): void {
  api.addPanel({
    id,
    component: 'panel-host',
    params: { panelId: id },
    title: PANEL_TITLES[id],
    ...(position ? { position } : {}),
  });
}

/**
 * Edit view — for driving the agent. Three columns:
 *   [ Workgraph / Task / Run ] [ Terminal ] [ Changes·Explorer / Content ]
 * The agent works in the center terminal; the diff/content updates to its right.
 */
function applyEdit(api: DockviewApi, center: ColumnRatio): void {
  api.clear();
  // Build the three columns first (beads is the left column), then stack
  // taskDetail and run below beads so they land in the left column rather than
  // as full-width bottom rows.
  addPanel(api, PanelIds.beads);
  addPanel(api, PanelIds.terminal, { referencePanel: PanelIds.beads, direction: 'right' });
  addPanel(api, PanelIds.changes, { referencePanel: PanelIds.terminal, direction: 'right' });
  addPanel(api, PanelIds.explorer, { referencePanel: PanelIds.changes, direction: 'within' });
  addPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'below' });
  addPanel(api, PanelIds.taskDetail, { referencePanel: PanelIds.beads, direction: 'below' });
  // Run is optional (default off); it stays reopenable from the Panels menu.
  if (useSettingsStore.getState().settings.showRunPanel) {
    addPanel(api, PanelIds.run, { referencePanel: PanelIds.taskDetail, direction: 'below' });
  }
  // Terminal is the primary center tab; Changes (not Explorer) is the default
  // tab of the right column in Edit view.
  api.getPanel(PanelIds.changes)?.api.setActive();
  api.getPanel(PanelIds.terminal)?.api.setActive();
  sizeColumns(api, center);
}

/**
 * Review view — for reading the change. Three columns:
 *   [ Workgraph / Task / Run ] [ Content ] [ Changes · Explorer · Notes ]
 * Content takes the center; the right column tabs the review surfaces.
 */
function applyReview(api: DockviewApi, center: ColumnRatio): void {
  api.clear();
  // Columns first (beads = left column), then stack taskDetail and run below
  // beads so they occupy the left column, not full-width bottom rows.
  addPanel(api, PanelIds.beads);
  addPanel(api, PanelIds.content, { referencePanel: PanelIds.beads, direction: 'right' });
  addPanel(api, PanelIds.changes, { referencePanel: PanelIds.content, direction: 'right' });
  addPanel(api, PanelIds.explorer, { referencePanel: PanelIds.changes, direction: 'within' });
  addPanel(api, PanelIds.notes, { referencePanel: PanelIds.changes, direction: 'within' });
  addPanel(api, PanelIds.taskDetail, { referencePanel: PanelIds.beads, direction: 'below' });
  // Run is optional (default off); it stays reopenable from the Panels menu.
  if (useSettingsStore.getState().settings.showRunPanel) {
    addPanel(api, PanelIds.run, { referencePanel: PanelIds.taskDetail, direction: 'below' });
  }
  // Changes (not Notes/Explorer) is the default tab of the right column.
  api.getPanel(PanelIds.changes)?.api.setActive();
  sizeColumns(api, center);
}

export function applyPreset(
  api: DockviewApi,
  name: PresetName,
  center: ColumnRatio = DEFAULT_COLUMN_RATIO,
): void {
  if (name === 'review') applyReview(api, center);
  else applyEdit(api, center);
}

/** Column ratios offered by Reset, as the center's share in a `1:center:1` split. */
export const COLUMN_RATIOS = [3, 2, 1] as const;
export type ColumnRatio = (typeof COLUMN_RATIOS)[number];
export const DEFAULT_COLUMN_RATIO: ColumnRatio = 3;

/** Human label for a ratio, e.g. 3 -> "1:3:1". */
export const ratioLabel = (center: ColumnRatio): string => `1:${center}:1`;

/**
 * Width for each side column in a `1:center:1` (left:center:right) split:
 * total is divided into `center + 2` parts and each side takes one. Proportional
 * to the workspace width rather than a fixed pixel value.
 */
export function sideColumnWidth(totalWidth: number, center: ColumnRatio = DEFAULT_COLUMN_RATIO): number {
  return Math.max(1, Math.round(totalWidth / (center + 2)));
}

/** Size the side columns for a `1:center:1` split (center auto-takes the rest).
 *  Proportional to the live workspace width; defers a frame if not measured. */
function sizeColumns(api: DockviewApi, center: ColumnRatio = DEFAULT_COLUMN_RATIO): void {
  const total = api.width;
  if (total <= 0) {
    requestAnimationFrame(() => sizeColumns(api, center));
    return;
  }
  const side = sideColumnWidth(total, center);
  api.getPanel(PanelIds.beads)?.group.api.setSize({ width: side });
  api.getPanel(PanelIds.changes)?.group.api.setSize({ width: side });
}
