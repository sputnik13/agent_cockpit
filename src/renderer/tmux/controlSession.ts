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

/** `list-windows` rows split on the first space (id + the rest of the format). */
async function listWindows(format: string): Promise<{ id: string; rest: string }[]> {
  const reply = await store().command(`list-windows -F "${format}"`);
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
 *  no `run-1` exists yet (reconcile then keeps that single survivor). */
export async function createReservedWindow(name: string): Promise<void> {
  const reply = await store().command(`new-window -dP -n ${name} -F "#{window_id}"`);
  const id = reply.lines[0]?.trim();
  if (id) await store().command(`set-window-option -t ${id} automatic-rename off`);
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
 * so the naming rule lives in exactly one place.
 */
export async function createTerminalWindow(): Promise<string | null> {
  const reply = await store().command('new-window -P -F "#{window_id}"');
  const id = reply.lines[0]?.trim() ?? null;
  if (id) await store().command(`rename-window -t ${id} '#{b:pane_current_path}'`);
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
    const nameRows = await listWindows('#{window_id} #{window_name}');
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
    for (const w of await listWindows('#{window_id} #{window_layout}')) {
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
 * session's current window across a detach; `display-message -p '#{window_id}'`
 * returns it for the attached `-CC` client. Applied as a synthetic
 * `session-window-changed` (the same reducer path a real window switch uses), so
 * the panel selects it and its existing focus effect restores keyboard focus.
 *
 * Only called from the re-init path — NOT from the general {@link syncFromTmux}
 * that `afterStructural` runs, so it never fights live `%window-pane-changed`
 * during normal use. A silent reattach where the user never switched re-asserts
 * the SAME window (a no-op for the panel), so the current selection is preserved.
 * Best-effort: a failed/empty query leaves the current selection untouched.
 */
export async function restoreActiveWindow(projectId: string): Promise<void> {
  try {
    const reply = await store().command(`display-message -p '#{window_id}'`);
    const id = reply.lines[0]?.trim();
    // Only adopt a real, non-reserved window (never steal focus to persistent/
    // run-1). Reserved windows are hidden from the tab strip, so selecting one
    // would render an empty body.
    if (!id) return;
    const view = store().byProject[projectId];
    const name = view?.windows[id]?.name;
    if (isHiddenWindow(name)) return;
    // sessionId is unused by the reducer (only windowId is read — see tmuxStore
    // `session-window-changed` case); '' matches the parser's own fallback.
    store().applyNotification(projectId, { type: 'session-window-changed', sessionId: '', windowId: id });
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
    const wins = await listWindows('#{window_id} #{window_name}');
    const createRun = useSettingsStore.getState().settings.showRunPanel;
    const plan = reconcile(wins.map((w) => ({ id: w.id, name: w.rest })), { createRun });
    if (plan.bail) {
      // Attach race: do not create reserved windows from an empty list, and do
      // not mark the project initialized — a later acquire/sync retries.
      return { bailed: true, synced: false };
    }
    for (const id of plan.toKill) await store().command(`kill-window -t ${id}`);
    for (const r of plan.toRename) await store().command(`rename-window -t ${r.id} ${r.to}`);
    for (const name of plan.toCreate) await createReservedWindow(name);
    if (plan.createFirstTerminal) await createTerminalWindow(); // first terminal tab (dir-named)
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

/** Report the panel's size so tmux recomputes pane geometry for splits. */
export function pushClientSize(host: HTMLElement | null): void {
  if (!host) return;
  const { cols, rows } = clientCells(host);
  if (cols > 0 && rows > 0) void store().resize(cols, rows);
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
 */
export function nudgeClientSize(host: HTMLElement | null): void {
  if (!host) return;
  const { cols, rows } = clientCells(host);
  if (cols <= 0 || rows <= 0) return;
  const projectId = useTmuxStore.getState().activeProjectId;
  void store().resize(cols, Math.max(1, rows - 1));
  requestAnimationFrame(() => {
    if (useTmuxStore.getState().activeProjectId !== projectId) return;
    pushClientSize(host);
  });
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
}
