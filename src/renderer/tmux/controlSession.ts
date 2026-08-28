import type { LayoutNode } from '@shared/tmux';
import { tryParseLayout } from '@shared/tmux';
import { agentCockpit } from '../providerClient';
import { selectActiveView, useTmuxStore } from './tmuxStore';
import { useSettingsStore } from '../settings/settingsStore';
import * as paneRegistry from './controlPaneRegistry';

/** Pixel width of the React-side separator drawn between sibling panes
 *  (matches the `w-[3px]` / `h-[3px]` Tailwind class in PaneXterm:SplitNode).
 *  Subtract per-separator from the available host pixels before dividing by
 *  cellW/H so the cols/rows pushed to tmux match what xterm actually renders
 *  across the split layout. */
const REACT_SEPARATOR_PX = 3;

/** Recursively compute how many cells/pixels of chrome the current layout
 *  reserves. For an lr (horizontal) split: widths sum + separators between
 *  children, heights take the max child. For tb (vertical): widths max,
 *  heights sum + separators. A leaf contributes one chrome each axis. The
 *  returned object also reports the count of tmux pane separators (1-cell
 *  vertical lines between horizontally-split panes; 1-row horizontal lines
 *  between vertically-split panes) which must be added to client cells so
 *  tmux's internal layout math reconciles. */
function chromeForLayout(
  node: LayoutNode,
  perPane: { w: number; h: number },
): { px: { w: number; h: number }; tmuxSep: { cols: number; rows: number } } {
  if (node.type === 'leaf') {
    return { px: { w: perPane.w, h: perPane.h }, tmuxSep: { cols: 0, rows: 0 } };
  }
  const parts = node.children.map((c) => chromeForLayout(c, perPane));
  if (node.dir === 'lr') {
    return {
      px: {
        w: parts.reduce((s, p) => s + p.px.w, 0) + (parts.length - 1) * REACT_SEPARATOR_PX,
        h: parts.reduce((m, p) => Math.max(m, p.px.h), 0),
      },
      tmuxSep: {
        cols: parts.reduce((s, p) => s + p.tmuxSep.cols, 0) + (parts.length - 1),
        rows: parts.reduce((m, p) => Math.max(m, p.tmuxSep.rows), 0),
      },
    };
  }
  return {
    px: {
      w: parts.reduce((m, p) => Math.max(m, p.px.w), 0),
      h: parts.reduce((s, p) => s + p.px.h, 0) + (parts.length - 1) * REACT_SEPARATOR_PX,
    },
    tmuxSep: {
      cols: parts.reduce((m, p) => Math.max(m, p.tmuxSep.cols), 0),
      rows: parts.reduce((s, p) => s + p.tmuxSep.rows, 0) + (parts.length - 1),
    },
  };
}

/**
 * Shared lifecycle + window helpers for the per-project tmux control sessions.
 *
 * Each project has its own control session (`agent-cockpit-<projectId>` on the
 * shared socket); a `-CC` client attaches to exactly one session and reports
 * only that session's windows. The renderer keeps all visited projects' views in
 * one store, namespaced by projectId, so this module owns a single `onTmux`
 * subscription that routes every notification to the store slice for its
 * `e.projectId`. Switching projects only moves the active slice
 * (`setActiveProject`) — it never resets state — so a project's windows and the
 * live xterms bound to them are preserved and shown instantly on return. See the
 * lifecycle-decoupling invariant in docs/ARCHITECTURE.md.
 */

export const PERSISTENT_WINDOW = 'persistent';
export const RUN_WINDOW = 'run-1';
const RUN_RE = /^run-\d+$/;

/** Reserved windows hidden from the terminal tab strip. */
export function isHiddenWindow(name: string | undefined): boolean {
  return name === PERSISTENT_WINDOW || RUN_RE.test(name ?? '');
}

/** A reserved-window class name that reconcile may create. */
type ReservedName = typeof PERSISTENT_WINDOW | typeof RUN_WINDOW;

/**
 * Decision produced by {@link reconcile}.
 *
 * `bail` (true) is kept distinct from the steady-state no-op
 * (`{ bail:false, toCreate:[], toKill:[], toRename:[], createFirstTerminal:false }`)
 * so the attach-race branch and the idempotent branch never alias — only the
 * former must avoid consuming the per-project init guard.
 */
export type ReconcilePlan =
  | { bail: true }
  | {
      bail: false;
      toCreate: ReservedName[];
      toKill: string[];
      toRename: { id: string; to: typeof RUN_WINDOW }[];
      createFirstTerminal: boolean;
    };

/** Parse a tmux window id (`@N`) into its numeric component for stable ordering;
 *  unparseable ids sort last so a malformed row never displaces a real `@N`. */
function windowIdNum(id: string): number {
  const n = Number.parseInt(id.replace(/^@/, ''), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/**
 * Pure decision function (no I/O): given the current `list-windows` rows, decide
 * how to reconcile the reserved windows to exactly one of each class.
 *
 * - Empty list ⇒ `{ bail: true }` (a live session always has ≥1 window, so an
 *   empty reply is an attach race, never grounds to create — FR4).
 * - Candidates within each reserved class are ordered by NUMERIC window-id
 *   ascending, so "keep the first" is stable across reconnects.
 * - `toKill` = every reserved-class window beyond the first of its class. Real
 *   (non-reserved) windows are never killed.
 * - `toRename` = the surviving `run-N` renamed to `run-1` if it isn't already
 *   (the Run panel binds the literal name `run-1`).
 * - `toCreate` = the reserved classes with no survivor at all. Creating `run-1`
 *   is gated on `opts.createRun` (the `showRunPanel` setting): when false, an
 *   absent `run-1` is NOT created. Dedup of duplicate `run-N` and `persistent`
 *   handling are unaffected — an existing single `run-1` is always kept, so the
 *   setting never reaps one.
 * - `createFirstTerminal` = the (pre-create) snapshot is non-empty and every
 *   window is hidden — i.e. there is no real terminal tab yet.
 */
export function reconcile(
  windows: { id: string; name: string }[],
  opts: { createRun: boolean } = { createRun: true },
): ReconcilePlan {
  if (windows.length === 0) return { bail: true };

  const byId = [...windows].sort((a, b) => windowIdNum(a.id) - windowIdNum(b.id));
  const persistents = byId.filter((w) => w.name === PERSISTENT_WINDOW);
  const runs = byId.filter((w) => RUN_RE.test(w.name));

  const toKill: string[] = [
    ...persistents.slice(1).map((w) => w.id),
    ...runs.slice(1).map((w) => w.id),
  ];

  const toCreate: ReservedName[] = [];
  if (persistents.length === 0) toCreate.push(PERSISTENT_WINDOW);
  // Gate ONLY creation of an absent run-1 on the setting; dedup above is
  // independent so an existing single run-1 is still kept when createRun=false.
  if (runs.length === 0 && opts.createRun) toCreate.push(RUN_WINDOW);

  const toRename: { id: string; to: typeof RUN_WINDOW }[] = [];
  const runSurvivor = runs[0];
  if (runSurvivor && runSurvivor.name !== RUN_WINDOW) {
    toRename.push({ id: runSurvivor.id, to: RUN_WINDOW });
  }

  const createFirstTerminal = windows.every((w) => isHiddenWindow(w.name));

  return { bail: false, toCreate, toKill, toRename, createFirstTerminal };
}

const store = () => useTmuxStore.getState();

/**
 * Cheap early-bail check: true when `projectId` still matches the RENDERER's
 * own belief of which project is active. This is a fast pre-check only — it
 * cannot see main's independently-tracked `SessionManager.activeId`, so a
 * cross-process desync between the two is invisible to it. The AUTHORITATIVE
 * fix is explicit addressing: every command in a project-scoped async
 * sequence (`ensureWindows`, `syncFromTmux`, `restoreActiveWindow`) now passes
 * its own `projectId` through to `store().command(args, projectId)`, so main
 * resolves and executes it against THAT specific live session
 * (`providerFor(projectId)`) regardless of whichever project is ambiently
 * active by the time the command actually runs. Without explicit addressing,
 * a project switch that lands while one of these sequences is still in
 * flight could silently redirect its LATER commands to the NEW active
 * project's tmux session while the results were still written into the
 * ORIGINAL project's store slice (or, for the reconcile mutations, issued as
 * kill/rename/create commands against the wrong session entirely) — a
 * cross-project data-corruption bug, not just a stale read
 * (local_repo_explorer-0255). This helper stays as a cheap, redundant-but-
 * harmless skip for the common case; it is not what prevents the bug anymore.
 */
function isActiveProject(projectId: string): boolean {
  return store().activeProjectId === projectId;
}

/** `list-windows` rows split on the first space (id + the rest of the format).
 *  `projectId` explicitly addresses the command at that project's live
 *  session (local_repo_explorer-0255) — see {@link isActiveProject}'s doc. */
async function listWindows(format: string, projectId: string): Promise<{ id: string; rest: string }[]> {
  const reply = await store().command(`list-windows -F "${format}"`, projectId);
  return reply.lines
    .map((l) => {
      const sp = l.indexOf(' ');
      return sp > 0 ? { id: l.slice(0, sp), rest: l.slice(sp + 1) } : null;
    })
    .filter((w): w is { id: string; rest: string } => w != null);
}

/** Create a hidden, fixed-name window (automatic-rename off so the name — used
 *  for filtering — never drifts to the running command). Exported so the Run
 *  panel can create `run-1` on demand when opened while the setting is off and
 *  no `run-1` exists yet (reconcile then keeps that single survivor).
 *  `projectId` is omitted for direct user-triggered creation (targets
 *  whichever project is active now, the correct semantic there) and passed
 *  explicitly when called from a project-scoped sequence like
 *  {@link ensureWindows} (local_repo_explorer-0255). */
export async function createReservedWindow(name: string, projectId?: string): Promise<void> {
  const reply = await store().command(`new-window -dP -n ${name} -F "#{window_id}"`, projectId);
  const id = reply.lines[0]?.trim();
  if (id) await store().command(`set-window-option -t ${id} automatic-rename off`, projectId);
}

/**
 * Create a VISIBLE terminal window (a real tab) and give it a stable default
 * title: the basename of its creation-time working directory. The new window is
 * selected by tmux (no `-d`). The name is set via `rename-window … '#{b:pane_
 * current_path}'`, whose format expands to the cwd basename at that instant and
 * is stored as a static literal — and because `automatic-rename` is off globally
 * (TMUX_SERVER_OPTIONS), it never drifts afterward. The user can override it by
 * double-clicking the tab (rename-window with their text). Transport-agnostic:
 * tmux computes the basename, so no project-path plumbing is needed and remote
 * behaves identically. Returns the new window id (or null on failure).
 *
 * The single creation seam for real terminal tabs — used by `ensureWindows`
 * (first tab) and every renderer new-window affordance (+, ⌘T, last-tab respawn)
 * so the naming rule lives in exactly one place. `projectId` is omitted by the
 * direct user affordances (targets whichever project is active now, the
 * correct semantic there) and passed explicitly by {@link ensureWindows}
 * (local_repo_explorer-0255).
 */
export async function createTerminalWindow(projectId?: string): Promise<string | null> {
  const reply = await store().command('new-window -P -F "#{window_id}"', projectId);
  const id = reply.lines[0]?.trim() ?? null;
  if (id) await store().command(`rename-window -t ${id} '#{b:pane_current_path}'`, projectId);
  return id;
}

/**
 * Re-read all windows (ids, names, layouts) for `projectId` and fold them into
 * its store slice as synthetic notifications. Needed because re-attaching to an
 * already-open control client emits nothing — this repopulates the slice from
 * the authoritative `list-windows` output, including each window's
 * `#{window_layout}`. Commands target the active provider, which matches the
 * active project.
 */
export async function syncFromTmux(projectId: string): Promise<boolean> {
  try {
    const apply = (wire: Parameters<ReturnType<typeof store>['applyNotification']>[1]): void =>
      store().applyNotification(projectId, wire);
    const nameRows = await listWindows('#{window_id} #{window_name}', projectId);
    // listWindows() now explicitly addresses projectId's own session
    // (local_repo_explorer-0255), so this reply can never belong to a
    // different project. The cheap pre-check stays as a fast bail for the
    // common "already moved on" case.
    if (!isActiveProject(projectId)) return false;
    // A live tmux session ALWAYS has >=1 window, so an empty read is an
    // attach-race / not-ready signal (the -CC channel just attached but the
    // session isn't queryable yet), never a real state. Report it as "not
    // synced" so the caller retries instead of marking the channel initialized
    // against nothing (the "window list wrong until a manual switch" bug).
    if (nameRows.length === 0) return false;
    const liveIds = new Set(nameRows.map((w) => w.id));
    // Authoritative prune: a window closed while the channel was down (a silent
    // reattach re-syncs from `list-windows`, but tmux replays no `%window-close`
    // for what is already gone) must be dropped from the slice, or the tab strip
    // shows a phantom window until the next manual switch. Reserved windows
    // (persistent/run-1) are in `list-windows` too, so they are never pruned.
    const slice = store().byProject[projectId];
    if (slice) {
      for (const id of [...slice.windowOrder]) {
        if (!liveIds.has(id)) apply({ type: 'window-close', windowId: id });
      }
    }
    for (const w of nameRows) {
      apply({ type: 'window-add', windowId: w.id });
      apply({ type: 'window-renamed', windowId: w.id, name: w.rest });
    }
    const layoutRows = await listWindows('#{window_id} #{window_layout}', projectId);
    if (!isActiveProject(projectId)) return false;
    for (const w of layoutRows) {
      const wl = tryParseLayout(w.rest);
      if (wl) apply({ type: 'layout-change', windowId: w.id, layout: wl, visibleLayout: wl, flags: null });
    }
    return true;
  } catch {
    return false; // channel error mid-sync — treat as not-ready so the caller retries
  }
}

/**
 * Adopt tmux's active window for `projectId` on re-init so a reconnect focuses
 * the window the user was last working in, not the first tab. tmux preserves the
 * session's current window across a detach; `display-message -p '#{session_id}
 * #{window_id}'` returns both for the attached `-CC` client. Applied as
 * synthetic `session-changed` + `session-window-changed` notifications (the
 * same reducer paths a real attach/window-switch use), so the panel selects
 * the window and its existing focus effect restores keyboard focus.
 *
 * The `session-changed` half also (re-)learns `state.sessionId`
 * (local_repo_explorer-0255) for re-init paths that run WITHOUT a fresh `-CC`
 * attach — e.g. `switchTerminalRenderer`'s `teardownControlSession` clears the
 * slice (including `sessionId`) and forces a re-init via `resetControlSession`,
 * but main's control manager stays open the whole time, so no real
 * `%session-changed` ever replays. Without re-deriving it here, the
 * cross-session `session-window-changed` guard would stay disarmed for that
 * project until its next genuine reattach — a live relapse window for the
 * exact symptom this bead exists to fix. A silent reattach where the session
 * id hasn't changed is a no-op for the reducer's existing idempotent handling.
 *
 * Only called from the re-init path — NOT from the general {@link syncFromTmux}
 * that `afterStructural` runs, so it never fights live `%window-pane-changed`
 * during normal use. A silent reattach where the user never switched re-asserts
 * the SAME window (a no-op for the panel), so the current selection is preserved.
 * Best-effort: a failed/empty query leaves the current selection untouched.
 */
export async function restoreActiveWindow(projectId: string): Promise<void> {
  try {
    const reply = await store().command(`display-message -p '#{session_id} #{window_id}'`, projectId);
    // Explicitly addressed at projectId's own session (local_repo_explorer-0255),
    // so this reply can't belong to a different project's tmux session. The
    // cheap pre-check stays as a fast bail for the common "already moved on"
    // case, matching this function's existing best-effort contract.
    if (!isActiveProject(projectId)) return;
    const [sessionId, id] = (reply.lines[0]?.trim() ?? '').split(' ');
    if (sessionId) {
      // Preserve the existing sessionName (this query doesn't ask for it) so
      // this synthetic event only ever ADDS the sessionId, never clobbers a
      // name already learned from a real %session-changed.
      const existingName = store().byProject[projectId]?.sessionName ?? '';
      store().applyNotification(projectId, { type: 'session-changed', sessionId, name: existingName });
    }
    // Only adopt a real, non-reserved window (never steal focus to persistent/
    // run-1). Reserved windows are hidden from the tab strip, so selecting one
    // would render an empty body.
    if (!id) return;
    const view = store().byProject[projectId];
    const name = view?.windows[id]?.name;
    if (isHiddenWindow(name)) return;
    store().applyNotification(projectId, {
      type: 'session-window-changed',
      sessionId: sessionId ?? '',
      windowId: id,
    });
  } catch {
    /* best effort — leave the current selection */
  }
}

/**
 * Reconcile the startup roles to exactly one of each reserved class —
 * `persistent` (hidden holder so the session never exits) and `run-1`
 * (dedicated run-tty) — reaping any accumulated duplicates, renaming the run
 * survivor to `run-1`, and creating the first terminal window when none exists,
 * then sync.
 *
 * Self-healing: safe to run on every attach. An empty `list-windows` reply is
 * treated as an attach race (a live session always has ≥1 window) — the
 * function bails without issuing any command and returns `{ bailed: true }` so
 * the caller leaves the project uninitialized and a later acquire/sync retries.
 *
 * `synced` reports whether the trailing {@link syncFromTmux} actually read a live
 * (non-empty) window list. A transient channel error during the initial attach
 * makes the reconcile read throw (swallowed here) AND `syncFromTmux` fail — in
 * that case `synced` is false, so the caller must NOT mark the channel
 * initialized (doing so stranded the window list until a manual switch).
 *
 * Reaped windows leave the renderer model when tmux emits `%window-close` over
 * the live `-CC` stream after `kill-window`; reconcile does not prune the store
 * directly.
 */
export async function ensureWindows(projectId: string): Promise<{ bailed: boolean; synced: boolean }> {
  try {
    const wins = await listWindows('#{window_id} #{window_name}', projectId);
    // listWindows() now explicitly addresses projectId's own session
    // (local_repo_explorer-0255), so `wins` and every mutation issued below
    // (all passed the same explicit projectId) can never land on a
    // different project's tmux session. The cheap pre-check stays as a fast
    // bail for the common "already moved on" case.
    if (!isActiveProject(projectId)) return { bailed: true, synced: false };
    const createRun = useSettingsStore.getState().settings.showRunPanel;
    const plan = reconcile(wins.map((w) => ({ id: w.id, name: w.rest })), { createRun });
    if (plan.bail) {
      // Attach race: do not create reserved windows from an empty list, and do
      // not mark the project initialized — a later acquire/sync retries.
      return { bailed: true, synced: false };
    }
    for (const id of plan.toKill) await store().command(`kill-window -t ${id}`, projectId);
    for (const r of plan.toRename) await store().command(`rename-window -t ${r.id} ${r.to}`, projectId);
    for (const name of plan.toCreate) await createReservedWindow(name, projectId);
    if (plan.createFirstTerminal) await createTerminalWindow(projectId); // first terminal tab (dir-named)
    if (plan.toKill.length > 0 || plan.toCreate.length > 0 || plan.toRename.length > 0) {
      console.info(
        `[control-session] reap pass for ${projectId}: killed ${plan.toKill.length} ` +
          `(${plan.toKill.join(', ') || 'none'}), created ${plan.toCreate.length}, ` +
          `renamed ${plan.toRename.length}`,
      );
    }
  } catch {
    /* best effort */
  }
  const synced = await syncFromTmux(projectId);
  return { bailed: false, synced };
}

/** Overall client size in tmux cells from a panel's pixel size. Uses the cell
 *  metrics measured from a live (fit) pane in {@link paneRegistry} when one
 *  exists, so the value tracks the current font; falls back to an estimate sized
 *  for ~13px monospace when there is no live pane yet (first acquire). Subtracts
 *  per-pane chrome (xterm padding + scrollbar gutter) from the host width so
 *  the cols pushed to tmux match what xterm actually renders. */
export function clientCells(host: HTMLElement): { cols: number; rows: number } {
  // Preferred path: derive the client size from each pane's ACTUAL term.cols
  // and term.rows. This bypasses any chrome math (whose accuracy degrades
  // for small panes due to React flex rounding + xterm floor truncation
  // and would leave tmux thinking a pane has 1-2 more cells than xterm
  // really renders → ghost % on Enter). Walk the active window's layout
  // and sum/max per orientation, adding 1 cell per gap for tmux's
  // internal pane separator.
  const view = selectActiveView(useTmuxStore.getState());
  const projectId = view !== null ? useTmuxStore.getState().activeProjectId : null;
  // Size from the VISIBLE (zoom-aware) layout — the tree the renderer actually
  // mounts and fits (renderLayout). When a pane is zoomed, tmux shows only that
  // pane at full window size, so only it is mounted + fit; summing the FULL split
  // layout would double-count — the zoomed pane fit to full height PLUS the
  // detached split-sibling's stale term.rows — pushing an oversized window to
  // tmux and clipping the zoomed pane's bottom. visibleLayout mirrors the full
  // layout when not zoomed, so this is a no-op outside zoom.
  const win = view.activeWindowId ? (view.windows[view.activeWindowId] ?? null) : null;
  const layout = win?.visibleLayout ?? win?.layout ?? null;
  if (projectId && layout) {
    const fromPanes = clientCellsFromLayout(layout, projectId);
    if (fromPanes) return fromPanes;
  }
  // Fallback: chrome-subtracted division when no live pane sizes are
  // available yet (e.g. very first push before any PaneXterm has fit).
  const m = paneRegistry.getCellSize();
  const perPaneChrome = paneRegistry.getChromeSize();
  const cellW = m?.w ?? 8;
  const cellH = m?.h ?? 17;
  const total = layout && perPaneChrome
    ? chromeForLayout(layout, perPaneChrome)
    : { px: perPaneChrome ?? { w: 0, h: 0 }, tmuxSep: { cols: 0, rows: 0 } };
  const usableW = Math.max(0, host.clientWidth - total.px.w);
  const usableH = Math.max(0, host.clientHeight - total.px.h);
  return {
    cols: Math.max(1, Math.floor(usableW / cellW) + total.tmuxSep.cols),
    rows: Math.max(1, Math.floor(usableH / cellH) + total.tmuxSep.rows),
  };
}

/** Compute (cols, rows) for the whole client by summing each live pane's
 *  actual term.cols/rows along the orientation of every split, plus 1
 *  cell per gap for tmux's internal pane separator. Returns null if any
 *  leaf's pane isn't in the registry yet. */
function clientCellsFromLayout(
  node: LayoutNode,
  projectId: string,
): { cols: number; rows: number } | null {
  if (node.type === 'leaf') {
    return paneRegistry.getPaneTermSize(projectId, node.paneId);
  }
  const parts: { cols: number; rows: number }[] = [];
  for (const c of node.children) {
    const v = clientCellsFromLayout(c, projectId);
    if (!v) return null;
    parts.push(v);
  }
  if (node.dir === 'lr') {
    return {
      cols: parts.reduce((s, p) => s + p.cols, 0) + (parts.length - 1),
      rows: parts.reduce((m, p) => Math.max(m, p.rows), 0),
    };
  }
  return {
    cols: parts.reduce((m, p) => Math.max(m, p.cols), 0),
    rows: parts.reduce((s, p) => s + p.rows, 0) + (parts.length - 1),
  };
}

/** Report the panel's size so tmux recomputes pane geometry for splits.
 *  Addresses the resize at the project active RIGHT NOW (captured
 *  synchronously, before the IPC round-trip) rather than leaving main to
 *  resolve it ambiently at execution time (local_repo_explorer-0255). */
export function pushClientSize(host: HTMLElement | null): void {
  if (!host) return;
  const { cols, rows } = clientCells(host);
  const projectId = useTmuxStore.getState().activeProjectId ?? undefined;
  if (cols > 0 && rows > 0) void store().resize(cols, rows, projectId);
}

/**
 * Force a real client-size round-trip so tmux re-emits `%output` and SIGWINCHes
 * the pane apps. tmux only re-emits when the client size actually CHANGES — a
 * same-size push is a no-op, which is why a plain repaint+push rarely fixes
 * reflow/size desync. This shrinks the client by one row NOW (synchronously, so
 * it targets the project active at call time — a deferred push could resize the
 * wrong project after a fast switch, see CLAUDE.md), then restores the true size
 * on the next frame, but only if the same project is still active. Equivalent to
 * nudging the window border and back; one-shot + user-initiated, so it cannot
 * self-loop the way layout-ack-driven nudges did.
 *
 * The shrink base and restore target are read from tmux's OWN current size —
 * the active window's layout root `w`/`h` (the same `LayoutNode` tree
 * {@link nudgePaneRows} already reads; a live probe confirmed a control-mode
 * client's `window_layout` root height equals the pushed client rows 1:1, with
 * no status-line subtraction) — captured ONCE here at click time, falling back
 * to the pixel-derived {@link clientCells} estimate only when no layout exists
 * yet (e.g. before the first window). The rAF restore pushes that captured
 * value VERBATIM. It deliberately does NOT call {@link pushClientSize} or
 * otherwise recompute {@link clientCells} for the restore: `clientCells` sums
 * each pane's LIVE, independently `fit()`-floored `term.rows`, a real
 * cross-layer rounding authority — and the shrink's own `%layout-change` side
 * effects (flex reweight → per-pane refits) perturb that sum before a
 * recompute would re-read it, which produced a deterministic ±1-row
 * `window_layout` oscillation on repeated clicks against an otherwise-settled
 * split (local_repo_explorer-ppjp). See CLAUDE.md "Control-mode tab refresh is
 * three-tier" before changing this: do NOT reintroduce a restore-time
 * recompute, and do NOT change {@link clientCells}/{@link clientCellsFromLayout}
 * themselves to source from the layout root — their OTHER callers (via
 * `pushClientSize`, from real pixel/font/resize events) need a genuinely
 * pixel-derived size, not tmux's current one.
 */
export function nudgeClientSize(host: HTMLElement | null, windowId?: string | null): void {
  if (!host) return;
  const st = useTmuxStore.getState();
  const view = selectActiveView(st);
  // `windowId`, when given, lets a caller that already knows exactly which
  // window it means (e.g. the queued-refresh-on-focus effect, right after a
  // LOCAL `currentWindow` change) read that window's own layout instead of
  // `view.activeWindowId` — which the STORE only updates once tmux's
  // `%session-window-changed` reply for a just-issued `select-window` lands,
  // a reply that can still be in flight at the exact moment a queued refresh
  // fires. Every window in a session shares the same client-driven viewport
  // size in this app's usage model, so the two sources normally agree; the
  // parameter removes the theoretical staleness rather than relying on that.
  const targetWindowId = windowId ?? view.activeWindowId;
  const win = targetWindowId ? (view.windows[targetWindowId] ?? null) : null;
  const root = win?.visibleLayout ?? win?.layout ?? null; // both roots carry window size
  const { cols, rows } = root ? { cols: root.w, rows: root.h } : clientCells(host);
  if (cols <= 0 || rows <= 0) return;
  const projectId = st.activeProjectId;
  void store().resize(cols, Math.max(1, rows - 1), projectId ?? undefined);
  requestAnimationFrame(() => {
    if (useTmuxStore.getState().activeProjectId !== projectId) return;
    // identity restore of the CAPTURED size — never a recompute; addressed at
    // the SAME projectId captured above, not re-read (local_repo_explorer-0255).
    void store().resize(cols, rows, projectId ?? undefined);
  });
}

/** Per-(project, window) single-flight guard for {@link nudgePaneRows}, keyed
 *  `${projectId}:${windowId}`. A rapid second nudge of the SAME window must not
 *  read TRANSIENT heights from the store while the first nudge's shrink/restore
 *  commands are still in flight — a layout-change notification from the first
 *  nudge landing mid-flight could make a second call "restore" to the wrong
 *  (already-shrunken) height permanently. Different windows' leaves are
 *  independent geometry unaffected by each other's resize-pane calls, so
 *  keying per-window (not just per-project) lets a reconnect refresh every tab
 *  concurrently without the guard falsely serializing unrelated windows.
 *  Cleared once every command from the run has settled (or been swallowed by
 *  its own `.catch`), or immediately on a pre-send bail (see
 *  {@link nudgePaneRows}). */
const paneNudgeInFlight = new Set<string>();

/** Leaf `{paneId, h}` pairs of a layout tree, depth-first left to right — the
 *  same traversal `collectLayoutPaneIds` in controlPaneRegistry.ts uses, plus
 *  each leaf's current cell height (needed for the absolute-height round-trip
 *  below). Local to this module so {@link nudgePaneRows} needs no new imports. */
function collectLeafHeights(node: LayoutNode | null): { paneId: string; h: number }[] {
  if (!node) return [];
  if (node.type === 'leaf') return [{ paneId: node.paneId, h: node.h }];
  return node.children.flatMap(collectLeafHeights);
}

/**
 * Force EVERY pane in a window's split layout to visibly redraw — not just the
 * first. Companion to {@link nudgeClientSize}, which forces exactly ONE real
 * client-size round-trip (tmux only re-emits `%output`/SIGWINCHes panes on an
 * actual size change). ROOT CAUSE this closes: tmux's `layout_resize_adjust`
 * distributes a same-axis +-1 cell change to ONLY THE FIRST child of a split
 * (live tmux 3.7b probe: a stacked/top-bottom window's 1-row client nudge
 * SIGWINCHes just the first pane; a side-by-side split is unaffected because
 * rows are the perpendicular axis there — see CLAUDE.md "Control-mode tab
 * refresh is three-tier"). The fix is a per-pane ABSOLUTE-height round-trip:
 * shrink each leaf pane by 1 row, let a server-side delay give the pane app a
 * chance to observe the shrunken size, then restore the EXACT original height
 * read from tmux's own layout. Every pane either has a TB ancestor (its height
 * changes, so it SIGWINCHes) or has only-LR ancestors (already reached by the
 * client nudge) — so uniform iteration over every leaf covers any topology,
 * including nested same-direction stacks, with no topology-specific targeting
 * needed. The absolute-height restore is an identity round-trip on tmux's own
 * integers (no pixel/FitAddon math), so the final layout is unchanged
 * (probe-verified checksum-identical across TB2/LR2/nested-TB-LR/TB3/h=2/h=1
 * cases) — this is a ONE-SHOT user/reattach-triggered action, not a
 * layout-ack-driven loop, so it does not reintroduce the every-resize-drag
 * cascade hazard the ghost-% ("tight-split ghost %") ADR entry rejected
 * per-pane resize for.
 *
 * ADDITIVE alongside `nudgeClientSize`, which keeps its untouched per-window
 * semantics. Callers MUST invoke this IMMEDIATELY AFTER `nudgeClientSize` in
 * the same synchronous code path (load-bearing ordering — do not change): both
 * defer to a single `requestAnimationFrame`, rAF callbacks run in registration
 * order, so this one's rAF fires after `nudgeClientSize`'s own restore push was
 * SENT, and the command channel's FIFO ordering then guarantees every pane
 * command EXECUTES after the client shrink+restore completes, at the window's
 * true (already-restored) size — eliminating any need to reason about
 * client/pane resize interleaving.
 */
export function nudgePaneRows(projectId: string, windowId: string): void {
  const win = useTmuxStore.getState().byProject[projectId]?.windows[windowId];
  if (!win) return;
  // Zoomed: resize-pane -y on a zoomed window silently UNZOOMS it and can
  // corrupt sizes read from the (single-pane) zoomed layout — probe-proven
  // hazard. A zoomed window is a single visible full-window pane, already
  // covered by nudgeClientSize.
  if (win.isZoomed) return;
  const leaves = collectLeafHeights(win.layout);
  if (leaves.length < 2) return; // single pane: nudgeClientSize already covers it
  const guardKey = `${projectId}:${windowId}`;
  if (paneNudgeInFlight.has(guardKey)) return; // a rapid second nudge of this window must not read transient heights
  paneNudgeInFlight.add(guardKey);

  requestAnimationFrame(() => {
    if (useTmuxStore.getState().activeProjectId !== projectId) {
      // Every command below is EXPLICITLY addressed at `projectId`
      // (local_repo_explorer-0255), so it can no longer land on the wrong
      // project's tmux session — but this function's own contract is to
      // touch only the project the user is currently looking at, so still
      // bail rather than resize a backgrounded project's panes.
      paneNudgeInFlight.delete(guardKey);
      return;
    }
    const sent: Promise<unknown>[] = [];
    for (const { paneId, h } of leaves) {
      if (h < 2) continue; // resize-pane -y 0 clamps silently; nothing to nudge
      // Three SEPARATE command() calls, sent back-to-back with no await between
      // them (the channel's FIFO ordering preserves send order regardless).
      // MUST NOT be collapsed into one ';'-sequenced command line: a live probe
      // showed control mode emits a SEPARATE %begin/%end reply block per
      // sub-command of a sequence, which would desync the manager's
      // pending-reply FIFO correlation (each command() call expects exactly one
      // reply block).
      sent.push(store().command(`resize-pane -t ${paneId} -y ${h - 1}`, projectId).catch(() => {}));
      // Server-side pure delay (no shell command) so the pane app OBSERVES the
      // shrunken size before the restore arrives — guards against SIGWINCH
      // coalescing / an app like ncurses not redrawing on a same-size no-op. On
      // tmux < 3.2 (the `-d` flag was added in 3.2) this %errors harmlessly: the
      // shrink and restore are separate command lines and both still execute,
      // degrading to at-worst today's (first-pane-only) behavior, never worse.
      sent.push(store().command('run-shell -d 0.05', projectId).catch(() => {}));
      // Absolute-height restore: the exact original height read from tmux's own
      // layout, written back verbatim. No pixel/FitAddon math is involved, so
      // this cannot introduce a new rounding-mismatch bug class.
      sent.push(store().command(`resize-pane -t ${paneId} -y ${h}`, projectId).catch(() => {}));
    }
    // Clear the single-flight guard once every reply (or its swallowed
    // rejection) has landed.
    void Promise.allSettled(sent).finally(() => paneNudgeInFlight.delete(guardKey));
  });
}

/** The ONE definition of "real, visible terminal tab": not a hidden/reserved
 *  window, and past mid-creation (has a layout). A window without a layout
 *  yet would otherwise render the empty "No panes yet" body behind a
 *  clickable tab. Pure — takes plain `windowOrder`/`windows` rather than a
 *  projectId, so `ControlTerminalPanel` can feed it its own React-subscribed,
 *  reactively-updating values for the rendered tab strip (`tabWindows`),
 *  while {@link visibleTabWindowIds} below feeds it a fresh store read for
 *  imperative (non-render) call sites. One filter, two callers — do not
 *  reintroduce a second inline copy of this predicate. */
export function filterVisibleTabs(
  windowOrder: readonly string[],
  windows: Record<string, { name: string; layout: unknown } | undefined>,
): string[] {
  return windowOrder.filter((id) => !isHiddenWindow(windows[id]?.name) && windows[id]?.layout != null);
}

/** Real (non-hidden) terminal tabs for a project that currently have a
 *  layout — {@link filterVisibleTabs} over a FRESH store read, for imperative
 *  call sites outside React render (reinit, resize/font-change) that can't
 *  depend on the component's rendered `tabWindows`. */
export function visibleTabWindowIds(projectId: string): string[] {
  const view = useTmuxStore.getState().byProject[projectId];
  return filterVisibleTabs(view?.windowOrder ?? [], view?.windows ?? {});
}

/**
 * Lazy refresh-on-focus queue for background tabs (local_repo_explorer:
 * reconnect refresh should not race the whole window/pane inventory).
 *
 * A tab that isn't on screen right now can't be safely hard-refreshed the
 * instant its window/pane inventory goes stale (reconnect) or its geometry
 * goes stale (host resize, font change): doing so for every background tab at
 * once — the previous approach — fires `hardRecoverTab` concurrently across
 * many windows while tmux may still be replaying the `%layout-change`/
 * `%window-add` catch-up stream, so a tab's capture-pane reply can land
 * against layout that's already stale by the time it arrives (the "tab
 * doesn't match its panel" symptom). Instead, a stale window is only ever
 * QUEUED here; the refresh itself runs once — and only once — that window
 * actually becomes the visible tab (see `ControlTerminalPanel`'s
 * queued-refresh-on-focus effect, the sole consumer of
 * {@link takePendingWindowRefresh}). At most one window is ever being
 * refreshed at a time this way, well after tmux's own inventory has settled.
 *
 * `projectId -> Set<windowId>`, matching this file's other per-project state
 * (`channelEpoch`, `reinitPending`, etc.) rather than a flat
 * `${projectId}:${windowId}` composite-key Set: a per-project bulk clear (see
 * `resetControlSession`) is then a direct O(1) `.delete(projectId)`, not a
 * full-Set prefix scan. The inner `Set<windowId>` still gives per-window dedup
 * for free — queuing an already-pending window is a no-op, so a resize drag or
 * a burst of reattach retries never queues more than one pending refresh per
 * window.
 */
const pendingWindowRefresh = new Map<string, Set<string>>();

/** Queue a lazy refresh for one window. Idempotent. */
export function queueWindowRefresh(projectId: string, windowId: string): void {
  let windows = pendingWindowRefresh.get(projectId);
  if (!windows) {
    windows = new Set();
    pendingWindowRefresh.set(projectId, windows);
  }
  windows.add(windowId);
}

/** Queue a lazy refresh for every window in `windowIds` except
 *  `exceptWindowId` — typically the currently-visible window, which the
 *  caller refreshes eagerly instead of queuing. */
export function queueRefreshForOtherWindows(
  projectId: string,
  windowIds: readonly string[],
  exceptWindowId: string | null,
): void {
  for (const id of windowIds) {
    if (id === exceptWindowId) continue;
    queueWindowRefresh(projectId, id);
  }
}

/** {@link visibleTabWindowIds} + {@link queueRefreshForOtherWindows} in one
 *  call — the common case all three background-tab-refresh triggers want
 *  (reattach, host resize, font change): queue every visible tab of a project
 *  except one. Use this directly unless the caller also needs the resolved
 *  tab list itself for something else (e.g. a diagnostic log), in which case
 *  call {@link visibleTabWindowIds} once and pass its result to
 *  {@link queueRefreshForOtherWindows} instead of duplicating the read. */
export function queueRefreshForOtherVisibleTabs(projectId: string, exceptWindowId: string | null): void {
  queueRefreshForOtherWindows(projectId, visibleTabWindowIds(projectId), exceptWindowId);
}

/** If `windowId` has a queued refresh, clears it and returns true (the caller
 *  should now run the refresh); otherwise a no-op returning false. */
export function takePendingWindowRefresh(projectId: string, windowId: string): boolean {
  const windows = pendingWindowRefresh.get(projectId);
  if (!windows || !windows.has(windowId)) return false;
  windows.delete(windowId);
  if (windows.size === 0) pendingWindowRefresh.delete(projectId);
  return true;
}

/** Drop every pending refresh queued for a project (disconnect/full reset) —
 *  see {@link resetControlSession}. */
function clearPendingWindowRefreshForProject(projectId: string): void {
  pendingWindowRefresh.delete(projectId);
}

// ---- Project-scoped lifecycle (single shared subscription) ----
let subscription: (() => void) | null = null;
/** Latest channel-attach epoch announced by the main-process control manager for
 *  a project (via an `attached` notification). Bumped on the first open AND every
 *  silent `-CC` reattach. This is the trigger for re-init — NOT the connection
 *  status, which never transitions on a silent reattach (CLAUDE.md "control-mode
 *  reconnect"). */
const channelEpoch = new Map<string, number>();
/** The channel epoch the renderer has already re-initialized (authoritative
 *  window sync + pane re-seed) for a project. A reinit runs whenever
 *  `channelEpoch !== initializedEpoch` — any change, since a hard reconnect
 *  builds a fresh manager whose epoch restarts at 1 (i.e. can go "backwards"
 *  relative to the prior manager). Replaces the old boolean `initialized` guard,
 *  whose one-shot nature skipped re-init on reattach. */
const initializedEpoch = new Map<string, number>();
/** Per-project single-flight for reinit, so a burst of `attached` events (or an
 *  acquire racing an `attached`) runs exactly one reinit at a time. */
const reinitInFlight = new Map<string, Promise<void>>();
/** Projects for which a reinit was requested while one was already in flight, so
 *  a newer channel epoch that arrives mid-sync is re-drained on settle (rather
 *  than dropped) — WITHOUT re-running a bare empty-list bail on a loop. */
const reinitPending = new Set<string>();
/** Bounded retry for a reinit that could not read the window list yet (the -CC
 *  channel attached but the session isn't queryable — `list-windows` came back
 *  empty/errored). A live session becomes listable within a few hundred ms, so a
 *  short capped retry converges without a user action; the cap prevents spinning
 *  on a genuinely dead session. */
const reinitRetry = new Map<string, ReturnType<typeof setTimeout>>();
const reinitRetryAttempts = new Map<string, number>();
const REINIT_RETRY_DELAY_MS = 200;
const REINIT_RETRY_MAX = 15; // ~3s of retries; well past a normal attach-to-listable gap

function clearReinitRetry(projectId: string): void {
  const t = reinitRetry.get(projectId);
  if (t !== undefined) clearTimeout(t);
  reinitRetry.delete(projectId);
  reinitRetryAttempts.delete(projectId);
}

function scheduleReinitRetry(projectId: string): void {
  const attempts = (reinitRetryAttempts.get(projectId) ?? 0) + 1;
  const existing = reinitRetry.get(projectId);
  if (existing !== undefined) clearTimeout(existing);
  if (attempts > REINIT_RETRY_MAX) {
    console.warn(`[control-session] reinit gave up after ${REINIT_RETRY_MAX} retries for ${projectId}`);
    clearReinitRetry(projectId);
    return;
  }
  reinitRetryAttempts.set(projectId, attempts);
  reinitRetry.set(
    projectId,
    setTimeout(() => {
      reinitRetry.delete(projectId);
      if (store().activeProjectId !== projectId) return; // deactivated; a re-acquire will retry
      maybeReinit(projectId);
    }, REINIT_RETRY_DELAY_MS),
  );
}
/** Listeners fired after a successful reinit for a project, so panel-owned
 *  concerns (pane re-seed + resize round-trip) can restore live displays. The
 *  window-list rebuild is done here; pane display is the subscriber's job. */
const reinitListeners = new Set<(projectId: string) => void>();
/** Per-project single-flight: the in-flight open promise. Stored synchronously
 *  before awaiting so concurrent acquires (the two mount sites fire in the same
 *  tick) await the same promise rather than each opening. Cleared on settle. */
const inFlight = new Map<string, Promise<void>>();
/** Per-project readiness: resolves once the session is open. Pane seeding awaits
 *  this so `capture-pane` never targets a not-yet-open session. */
const ready = new Map<string, Promise<void>>();

/** Subscribe to per-project reinit completions (a fresh channel finished its
 *  authoritative window sync). Used by the terminal panel to re-seed visible
 *  panes and force a resize round-trip. Returns an unsubscribe. */
export function subscribeReinit(fn: (projectId: string) => void): () => void {
  reinitListeners.add(fn);
  return () => reinitListeners.delete(fn);
}

function notifyReinit(projectId: string): void {
  for (const fn of reinitListeners) {
    try {
      fn(projectId);
    } catch (e) {
      // Isolate listener errors so one bad subscriber can't break the reinit.
      console.error('[control-session] reinit listener threw', e);
    }
  }
}

/**
 * Record a channel-attach epoch and re-initialize if it differs from what the
 * renderer last initialized for this project. Commands issued during re-init
 * (`list-windows`, `capture-pane`) target the ACTIVE provider on the main side,
 * so a re-init is only safe for the currently-active project; a backgrounded
 * project's flap is deferred and picked up by {@link acquireControlSession} when
 * it is next activated (channelEpoch is retained until then).
 */
function onAttached(projectId: string, epoch: number): void {
  channelEpoch.set(projectId, epoch);
  maybeReinit(projectId);
}

function maybeReinit(projectId: string): void {
  if (store().activeProjectId !== projectId) return; // commands target active project only
  const target = channelEpoch.get(projectId);
  if (target === undefined || initializedEpoch.get(projectId) === target) return; // caught up
  if (reinitInFlight.has(projectId)) {
    // A reinit is already running; record that a (possibly newer) epoch is
    // pending so the in-flight run re-drains on settle instead of dropping it.
    reinitPending.add(projectId);
    return;
  }
  const run = async (): Promise<void> => {
    const { synced } = await ensureWindows(projectId); // reconcile + authoritative sync
    // `synced` is false when `list-windows` came back empty or errored — the
    // -CC channel attached but the session isn't queryable yet (attach race), a
    // state a live session leaves within a few hundred ms. Do NOT mark this
    // epoch initialized (that stranded the window list until a manual switch);
    // schedule a bounded retry so it converges on its own.
    if (!synced) {
      scheduleReinitRetry(projectId);
      return;
    }
    clearReinitRetry(projectId);
    await restoreActiveWindow(projectId); // focus the window the user last worked in
    initializedEpoch.set(projectId, target);
    notifyReinit(projectId); // panel re-seeds panes + resize round-trip
  };
  const p = run()
    .catch((e: unknown) => {
      // Leave initializedEpoch behind the channel epoch so a later acquire /
      // attached retries; do not strand the project on a transient sync error.
      console.error(`[control-session] reinit failed for ${projectId}:`, e);
    })
    .finally(() => {
      if (reinitInFlight.get(projectId) === p) reinitInFlight.delete(projectId);
      // Re-drain only when a reinit was explicitly requested mid-run (a newer
      // epoch arrived) OR we made progress and the channel has since moved on.
      // A bare bail with no new request does not re-drain (no spin).
      const requested = reinitPending.delete(projectId);
      const advanced =
        initializedEpoch.get(projectId) !== undefined &&
        channelEpoch.get(projectId) !== initializedEpoch.get(projectId);
      if (requested || advanced) maybeReinit(projectId);
    });
  reinitInFlight.set(projectId, p);
}

/** Whether the tmux IPC bridge is present (false on a stale dev preload). */
export function controlBridgeReady(): boolean {
  return typeof agentCockpit.events.onTmux === 'function';
}

/** Register the single notification subscription (idempotent). It routes every
 *  project's stream into its own store slice, so all visited projects stay live
 *  and switching back is instant. */
function ensureSubscription(): void {
  if (subscription) return;
  subscription = agentCockpit.events.onTmux((e) => {
    // `attached` is a synthetic (non-tmux) signal that a fresh `-CC` channel is
    // live; it drives re-init rather than folding into the view. Everything else
    // is a real notification for the store slice.
    if (e.notification.type === 'attached') {
      onAttached(e.projectId, e.notification.epoch);
      return;
    }
    store().applyNotification(e.projectId, e.notification);
  });
}

/**
 * Make `projectId` the active control session: ensure the shared subscription,
 * select its store slice, and open it. `open()` is idempotent on the main side
 * (a no-op if already open) and self-healing (re-spawns if the session died —
 * e.g. after a dev main restart), so it is called on every acquire. Window
 * initialization runs once per project. Switching projects never resets state:
 * the previous project's slice and xterms are preserved. Safe to call from
 * multiple panels.
 *
 * Failures are recorded in the store (openError) so the UI can surface them
 * instead of hanging in "Connecting…" forever.
 * Re-calling acquireControlSession after a failure is the retry path: it
 * clears the failed state (via store().open's 'connecting' transition) and
 * attempts to open again.
 */
export function acquireControlSession(projectId: string): void {
  if (!controlBridgeReady()) return;
  ensureSubscription();
  store().setActiveProject(projectId);

  // Single-flight: if an open+ensure is already running for this project (the
  // two mount sites fire in the same tick), await it instead of launching a
  // second ensure that could create duplicate reserved windows.
  const existing = inFlight.get(projectId);
  if (existing) {
    ready.set(projectId, existing);
    return;
  }

  const p = store()
    .open(projectId)
    .then(() => {
      // Re-init is driven by the `attached` epoch (fired during open() on the
      // first attach, and on every silent reattach). This call is the backstop
      // that catches (a) an `attached` that raced ahead of open() resolving and
      // (b) switching TO a project whose channel flapped while backgrounded.
      maybeReinit(projectId);
    })
    .catch((err: unknown) => {
      // Record the failure so the UI can surface it with a Retry affordance
      // instead of leaving the user staring at "Connecting to tmux…" forever.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[control-session] open failed for project ${projectId}:`, err);
      store().setOpenError(projectId, message);
    })
    .finally(() => {
      // Clear the slot on settle (success or failure) so a future retry is
      // allowed, but two concurrent opens never run.
      if (inFlight.get(projectId) === p) inFlight.delete(projectId);
    });

  inFlight.set(projectId, p);
  ready.set(projectId, p);
}

/** Resolves once `projectId`'s control session is open (and initialized on first
 *  acquire); resolves immediately if it was never acquired. */
export function whenReady(projectId: string): Promise<void> {
  return ready.get(projectId) ?? Promise.resolve();
}

/** Counterpart to {@link acquireControlSession}. The subscription and all
 *  per-project slices are kept across remounts/view toggles and project
 *  switches; control clients are left attached (idle reaping handles cleanup). */
export function releaseControlSession(): void {
  /* intentionally a no-op: state is decoupled from mount lifecycle */
}

/**
 * Reset control-session lifecycle state.
 *
 * With a `projectId`: PER-PROJECT teardown (a single project's disconnect, or a
 * renderer backend switch). Clears only that project's lifecycle so a re-acquire
 * re-initializes — but KEEPS its `channelEpoch` (the channel identity is
 * unchanged) so a re-acquire that does NOT cause a fresh attach (e.g. a backend
 * switch with tmux still open, which emits no new `attached`) still re-inits,
 * because `initializedEpoch` is now behind `channelEpoch`. The shared `onTmux`
 * subscription and every OTHER project's state are left intact — disconnecting
 * one project must never clobber another live one.
 *
 * Without a `projectId`: FULL teardown (tests / global reset) — also drops the
 * shared subscription.
 *
 * Never clears `reinitListeners`: those are component-owned subscriptions whose
 * lifecycle is the component's, not this reset's.
 */
export function resetControlSession(projectId?: string): void {
  if (projectId !== undefined) {
    initializedEpoch.delete(projectId);
    reinitInFlight.delete(projectId);
    reinitPending.delete(projectId);
    clearReinitRetry(projectId);
    inFlight.delete(projectId);
    ready.delete(projectId);
    clearPendingWindowRefreshForProject(projectId);
    return;
  }
  subscription?.();
  subscription = null;
  channelEpoch.clear();
  initializedEpoch.clear();
  reinitInFlight.clear();
  reinitPending.clear();
  for (const t of reinitRetry.values()) clearTimeout(t);
  reinitRetry.clear();
  reinitRetryAttempts.clear();
  inFlight.clear();
  ready.clear();
  pendingWindowRefresh.clear();
}

/**
 * Full per-project control-session teardown to a clean slate: dispose the
 * project's persistent xterm pane instances, then reset control-session
 * lifecycle state and its tmux view. The one shared implementation for every
 * caller that needs this — `panelDataSync` (on that project's connection
 * status going disconnected/failed, regardless of which project is active)
 * and `switchTerminalRenderer` (a renderer backend switch on the active
 * project). Disposing panes before resetting is load-bearing: `paneRegistry.
 * acquire()` only (re)binds a pane's output sink when it CREATES the entry,
 * so a later re-acquire of a cached, un-disposed entry would skip that
 * binding and the rebuilt session would show no live output.
 */
export function teardownControlSession(projectId: string): void {
  paneRegistry.disposeProject(projectId);
  releaseControlSession();
  resetControlSession(projectId);
  useTmuxStore.getState().resetProject(projectId);
}
