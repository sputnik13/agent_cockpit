import type { DockviewGroupPanel } from 'dockview-react';
import { PanelIds } from './panelIds';
import { panelOptions } from './presets';
import type { DockviewApi } from './Workspace';

/**
 * Show the Content panel for a terminal's `cockpit open` WITHOUT moving keyboard
 * focus (docs/ARCHITECTURE.md, "Showing Content without moving keyboard focus").
 *
 * The user is typing in the terminal that ran the command, so the open must not
 * take the keyboard from it, and must not rearrange what they are working in.
 *
 * **Why not `panel.api.setActive()` under `withFocusSuppressed` (checked, and
 * insufficient).** `setActive()` goes through `DockviewComponent.setActivePanel`
 * -> `doSetGroupAndPanelActive`: the panel's group becomes the ACTIVE group (a
 * maximized group is exited) and `onDidActivePanelChange` fires. Its handler in
 * CockpitWorkspace writes the persisted per-project focus memory
 * (`writeFocus('panel', …)`, unconditionally) and records `lastActivePanelId`,
 * then calls `focusPanel`. `withFocusSuppressed` only silences that last call: the
 * focus memory would still be overwritten (so the next project switch-back would
 * `focusPanelForce` the Content panel), the active group and its highlight would
 * still move to Content while keystrokes keep going to the terminal, and the
 * flag is a global that swallows any genuine `focusPanel` landing in the same
 * window. So this path never activates anything: no activation, no event, nothing
 * to suppress.
 *
 * **What it does instead.** `group.model.openPanel(panel, { skipSetGroupActive })`
 * makes Content the visible tab of ITS group and leaves the active group, the
 * active panel and DOM focus alone (no `onDidActivePanelChange`: Dockview only
 * emits it when the group is the active one). The tests in
 * `panelReveal.test.tsx` pin this against the real Dockview, so a Dockview
 * upgrade that changes it fails there.
 *
 * **When it declines (the panel stays hidden; the tab is already recorded).**
 * Dockview's default `onlyWhenVisible` renderer DETACHES a hidden tab's DOM, so
 * showing Content in a group replaces what that group shows and drops DOM focus
 * if the replaced panel held it. The choice, in order:
 *  - `withheld-terminal`: Content is tabbed behind the Terminal. Revealing it
 *    would hide the terminal (and drop its focus when it has it). It stays hidden.
 *  - `withheld-active-group`: Content is a background tab of the group the user
 *    is working in: Dockview's active group (which follows DOM focus), or the
 *    group that contains the focused element even if Dockview's notion lags.
 *    Switching its tab would pull that panel out from under them.
 *  - `withheld-maximized`: another group is maximized, an explicit user choice;
 *    leaving it would also resize the maximized terminal.
 *  - `withheld-no-room`: Content is closed and there is no room to add it
 *    without resizing the terminal.
 *  In every other layout (Content visible in its own group, or a background tab
 *  of a group that is not the active one) there is nothing to protect.
 *
 * **Absent from the layout** (the user closed it): it is re-added without
 * activating anything, under the Changes group (the Edit view's own slot for it),
 * else as a new column at the right edge. Adding a group makes Dockview EQUALIZE
 * every sibling in the splitview it joins (`Sizing.Distribute`), which would
 * resize the terminal whenever it shares that splitview (the Review view's right
 * column, any right-edge column). So the terminal group is PINNED at its current
 * size (min == max, restored afterwards) while the panel is added: Dockview's
 * equalizing and its resize absorption both clamp to [min, max], so the terminal
 * cannot change, by construction, and the remaining space is split among the
 * other groups (in Review, Changes and Content split Changes' old cell). The
 * terminal is never carved: if Changes shares the terminal's group the right
 * edge is used, and if neither placement leaves room (checked up front; a panel
 * added without room would land outside the container) the add is declined. The
 * Panels menu's `openPanel` is NOT reused: it adds to the ACTIVE group, which is
 * usually the terminal's.
 */
export type RevealOutcome =
  /** Content is already on screen; nothing to do. */
  | 'already-visible'
  /** Content was a background tab of a group that is not the active one; it is now that group's visible tab. */
  | 'revealed'
  /** Content was closed; it was re-added and is on screen. */
  | 'added'
  | 'withheld-terminal'
  | 'withheld-active-group'
  | 'withheld-maximized'
  | 'withheld-no-room'
  /** No workbench is mounted (decided by the caller). */
  | 'unavailable'
  /** The workbench still shows another project's layout (a project switch is in flight; decided by the caller). */
  | 'not-loaded';

/** Where a closed Content panel comes back: under Changes. */
const CONTENT_RETURN_BELOW = PanelIds.changes;

/**
 * Dockview's minimum group size (`MINIMUM_DOCKVIEW_GROUP_PANEL_WIDTH/HEIGHT`). Used to
 * check there is room for Content before adding it; Dockview itself would otherwise
 * place a group that cannot fit outside the container.
 */
const MIN_GROUP_PX = 100;

/** Outcomes that leave Content hidden on purpose: the user should be told (a cue). */
export function isDeclinedReveal(outcome: RevealOutcome): boolean {
  return (
    outcome === 'withheld-terminal' ||
    outcome === 'withheld-active-group' ||
    outcome === 'withheld-maximized' ||
    outcome === 'withheld-no-room'
  );
}

/** Why a reveal did not put Content on screen, or null when it did / it already was. */
export function revealDeclinedReason(outcome: RevealOutcome): string | null {
  switch (outcome) {
    case 'withheld-terminal':
      return 'the Content panel is tabbed behind the Terminal, and showing it would hide the terminal';
    case 'withheld-active-group':
      return 'the Content panel is a background tab of the panel group in use';
    case 'withheld-maximized':
      return 'another panel group is maximized';
    case 'withheld-no-room':
      return 'there is no room to add the Content panel without resizing the terminal';
    case 'unavailable':
      return 'the workbench is not available';
    case 'not-loaded':
      return 'the project layout is still loading';
    default:
      return null;
  }
}

/**
 * Pin a grid group at its current size (min == max) and return the undo. Dockview's
 * equalizing add and its resize absorption clamp every view to [min, max], so a
 * pinned group cannot change while the layout around it does. A group that has not
 * been laid out yet (size 0), or that is not in the grid (floating, popout), has
 * nothing to keep and is left alone.
 */
function pinGroupSize(group: DockviewGroupPanel): () => void {
  const { width, height } = group.api;
  if (group.api.location.type !== 'grid' || !(width > 0) || !(height > 0)) return () => undefined;
  const original = {
    minimumWidth: group.minimumWidth,
    maximumWidth: group.maximumWidth,
    minimumHeight: group.minimumHeight,
    maximumHeight: group.maximumHeight,
  };
  group.api.setConstraints({
    minimumWidth: width,
    maximumWidth: width,
    minimumHeight: height,
    maximumHeight: height,
  });
  return () => group.api.setConstraints(original);
}

/**
 * Whether Content fits next to what is there without resizing the terminal. Only
 * judged once the workbench has been laid out (sizes are 0 before that).
 */
function hasRoom(
  api: DockviewApi,
  terminal: DockviewGroupPanel | undefined,
  below: DockviewGroupPanel | null,
): boolean {
  if (!(api.width > 0) || !(api.height > 0)) return true;
  if (below) return below.api.height >= 2 * MIN_GROUP_PX;
  // A new right-edge column is carved out of the columns that are not the terminal's.
  return api.width - (terminal?.api.width ?? 0) >= 2 * MIN_GROUP_PX;
}

function addContentAtReturnSlot(api: DockviewApi): RevealOutcome {
  const terminal = api.getPanel(PanelIds.terminal)?.group;
  const changes = api.getPanel(CONTENT_RETURN_BELOW)?.group;
  // Under Changes, unless Changes shares the terminal's group: carving Content out of
  // THAT cell would have to shrink the terminal.
  let below: DockviewGroupPanel | null = changes && changes !== terminal ? changes : null;
  if (below && !hasRoom(api, terminal, below)) below = null;
  if (!below && !hasRoom(api, terminal, null)) return 'withheld-no-room';

  const unpin = terminal ? pinGroupSize(terminal) : () => undefined;
  try {
    const panel = api.addPanel({
      ...panelOptions(PanelIds.content),
      position: below
        ? { referencePanel: CONTENT_RETURN_BELOW, direction: 'below' }
        : { direction: 'right' },
      // Not activated: `addPanel` would otherwise make the new group the active group.
      inactive: true,
    });
    // `inactive` leaves a brand-new group without a visible tab (it renders blank
    // until something activates it); make Content its visible tab, still without
    // activating the group.
    panel.group.model.openPanel(panel, { skipSetGroupActive: true });
    return 'added';
  } finally {
    unpin();
  }
}

/**
 * Put the Content panel on screen without moving keyboard focus or activating
 * anything. Synchronous; see the module doc for the rules.
 */
export function revealContentWithoutFocus(api: DockviewApi): RevealOutcome {
  const panel = api.getPanel(PanelIds.content);

  // While another group is maximized Content cannot be on screen without leaving
  // that state, which is the user's explicit choice (and would resize the terminal).
  if (api.hasMaximizedGroup() && !panel?.api.isMaximized()) return 'withheld-maximized';

  if (!panel) return addContentAtReturnSlot(api);

  const group = panel.group;
  if (group.activePanel === panel) return 'already-visible';

  if (group.activePanel?.id === PanelIds.terminal) return 'withheld-terminal';
  // The group in use: Dockview's active group, or the one holding the focused element
  // (the two can briefly disagree, e.g. after a programmatic activation).
  if (
    group === api.activeGroup ||
    group.element.contains(group.element.ownerDocument.activeElement)
  ) {
    return 'withheld-active-group';
  }

  group.model.openPanel(panel, { skipSetGroupActive: true });
  return 'revealed';
}
