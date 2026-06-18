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
function applyEdit(api: DockviewApi, ratio: ColumnRatio): void {
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
  sizeColumns(api, ratio);
}

/**
 * Review view — for reading the change. Three columns:
 *   [ Workgraph / Task / Run ] [ Content ] [ Changes·Explorer·Notes / Terminal ]
 * This is the mirror of Edit: Terminal and Content swap places. Content takes
 * the center; the right column tabs the review surfaces with the Terminal below
 * them — exactly where Content sits (below Changes) in Edit.
 */
function applyReview(api: DockviewApi, ratio: ColumnRatio): void {
  api.clear();
  // Columns first (beads = left column), then stack taskDetail and run below
  // beads so they occupy the left column, not full-width bottom rows.
  addPanel(api, PanelIds.beads);
  addPanel(api, PanelIds.content, { referencePanel: PanelIds.beads, direction: 'right' });
  addPanel(api, PanelIds.changes, { referencePanel: PanelIds.content, direction: 'right' });
  addPanel(api, PanelIds.explorer, { referencePanel: PanelIds.changes, direction: 'within' });
  addPanel(api, PanelIds.notes, { referencePanel: PanelIds.changes, direction: 'within' });
  // Terminal sits below the right-column review group — the slot Content occupies
  // in Edit (the Terminal/Content swap).
  addPanel(api, PanelIds.terminal, { referencePanel: PanelIds.changes, direction: 'below' });
  addPanel(api, PanelIds.taskDetail, { referencePanel: PanelIds.beads, direction: 'below' });
  // Run is optional (default off); it stays reopenable from the Panels menu.
  if (useSettingsStore.getState().settings.showRunPanel) {
    addPanel(api, PanelIds.run, { referencePanel: PanelIds.taskDetail, direction: 'below' });
  }
  // Changes (not Notes/Explorer) is the default tab of the right column; Content
  // is the focused center surface for reading.
  api.getPanel(PanelIds.changes)?.api.setActive();
  api.getPanel(PanelIds.content)?.api.setActive();
  sizeColumns(api, ratio);
}

export function applyPreset(
  api: DockviewApi,
  name: PresetName,
  ratio: ColumnRatio = DEFAULT_COLUMN_RATIO,
): void {
  if (name === 'review') applyReview(api, ratio);
  else applyEdit(api, ratio);
}

/**
 * Column ratios offered by Reset, as `[left, center, right]` shares. The first
 * three are symmetric (`1:c:1`); `2:3:1` gives the left column (Workgraph) extra
 * width — useful for the side-by-side Columns view — at the right column's
 * expense.
 */
export const COLUMN_RATIOS = [
  [1, 3, 1],
  [1, 2, 1],
  [1, 1, 1],
  [2, 3, 1],
] as const;
export type ColumnRatio = (typeof COLUMN_RATIOS)[number];
export const DEFAULT_COLUMN_RATIO: ColumnRatio = COLUMN_RATIOS[0];

/** Human label for a ratio, e.g. `[1,3,1]` -> "1:3:1". */
export const ratioLabel = (ratio: ColumnRatio): string => ratio.join(':');

/**
 * Left/right side-column widths for a `[left:center:right]` split; the center
 * group auto-takes the remainder. Each side is its share of the total
 * (`total * share / (left+center+right)`), proportional to the workspace width
 * rather than a fixed pixel value.
 */
export function sideColumnWidths(
  totalWidth: number,
  ratio: ColumnRatio = DEFAULT_COLUMN_RATIO,
): { left: number; right: number } {
  const [l, c, r] = ratio;
  const parts = l + c + r;
  return {
    left: Math.max(1, Math.round((totalWidth * l) / parts)),
    right: Math.max(1, Math.round((totalWidth * r) / parts)),
  };
}

/** Size the side columns for a `[left:center:right]` split (center auto-takes the
 *  rest). Proportional to the live workspace width; defers a frame if not
 *  measured. */
function sizeColumns(api: DockviewApi, ratio: ColumnRatio = DEFAULT_COLUMN_RATIO): void {
  const total = api.width;
  if (total <= 0) {
    requestAnimationFrame(() => sizeColumns(api, ratio));
    return;
  }
  const { left, right } = sideColumnWidths(total, ratio);
  api.getPanel(PanelIds.beads)?.group.api.setSize({ width: left });
  api.getPanel(PanelIds.changes)?.group.api.setSize({ width: right });
}
