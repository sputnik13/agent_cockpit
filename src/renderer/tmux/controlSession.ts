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
 * Re-read all windows (ids, names, layouts) for `projectId` and fold them into
 * its store slice as synthetic notifications. Needed because re-attaching to an
 * already-open control client emits nothing — this repopulates the slice from
 * the authoritative `list-windows` output, including each window's
 * `#{window_layout}`. Commands target the active provider, which matches the
 * active project.
 */
export async function syncFromTmux(projectId: string): Promise<void> {
  try {
    const apply = (wire: Parameters<ReturnType<typeof store>['applyNotification']>[1]): void =>
      store().applyNotification(projectId, wire);
    for (const w of await listWindows('#{window_id} #{window_name}')) {
      apply({ type: 'window-add', windowId: w.id });
      apply({ type: 'window-renamed', windowId: w.id, name: w.rest });
    }
    for (const w of await listWindows('#{window_id} #{window_layout}')) {
      const wl = tryParseLayout(w.rest);
      if (wl) apply({ type: 'layout-change', windowId: w.id, layout: wl, visibleLayout: wl, flags: null });
    }
  } catch {
    /* best effort */
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
 * Reaped windows leave the renderer model when tmux emits `%window-close` over
 * the live `-CC` stream after `kill-window`; reconcile does not prune the store
 * directly.
 */
export async function ensureWindows(projectId: string): Promise<{ bailed: boolean }> {
  let bailed = false;
  try {
    const wins = await listWindows('#{window_id} #{window_name}');
    const createRun = useSettingsStore.getState().settings.showRunPanel;
    const plan = reconcile(wins.map((w) => ({ id: w.id, name: w.rest })), { createRun });
    if (plan.bail) {
      // Attach race: do not create reserved windows from an empty list, and do
      // not mark the project initialized — a later acquire/sync retries.
      return { bailed: true };
    }
    for (const id of plan.toKill) await store().command(`kill-window -t ${id}`);
    for (const r of plan.toRename) await store().command(`rename-window -t ${r.id} ${r.to}`);
    for (const name of plan.toCreate) await createReservedWindow(name);
    if (plan.createFirstTerminal) await store().command('new-window'); // first terminal tab
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
  await syncFromTmux(projectId);
  return { bailed };
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
  const layout = view.activeWindowId
    ? (view.windows[view.activeWindowId]?.layout ?? null)
    : null;
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

// ---- Project-scoped lifecycle (single shared subscription) ----
let subscription: (() => void) | null = null;
/** Projects whose windows have been initialized (non-bail `ensureWindows`) this
 *  session. An empty-list bail does NOT mark a project initialized, so a later
 *  acquire/sync retries the ensure against a populated list. */
const initialized = new Set<string>();
/** Per-project single-flight: the in-flight open+ensure promise. Stored
 *  synchronously before awaiting so concurrent acquires (the two mount sites
 *  fire in the same tick) await the same promise rather than each running their
 *  own ensure. Cleared when it settles so a future retry is allowed. */
const inFlight = new Map<string, Promise<void>>();
/** Per-project readiness: resolves once the session is open (and, on first
 *  acquire, its windows initialized). Pane seeding awaits this so `capture-pane`
 *  never targets a not-yet-open session. */
const ready = new Map<string, Promise<void>>();

/** Whether the tmux IPC bridge is present (false on a stale dev preload). */
export function controlBridgeReady(): boolean {
  return typeof agentCockpit.events.onTmux === 'function';
}

/** Register the single notification subscription (idempotent). It routes every
 *  project's stream into its own store slice, so all visited projects stay live
 *  and switching back is instant. */
function ensureSubscription(): void {
  if (subscription) return;
  subscription = agentCockpit.events.onTmux((e) => store().applyNotification(e.projectId, e.notification));
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
    .then(async () => {
      if (initialized.has(projectId)) return;
      const { bailed } = await ensureWindows(projectId);
      // Mark initialized only on a non-bail success so an empty-list bail does
      // not consume the one-shot guard (a later acquire/sync retries).
      if (!bailed) initialized.add(projectId);
    })
    .catch((err: unknown) => {
      // Record the failure so the UI can surface it with a Retry affordance
      // instead of leaving the user staring at "Connecting to tmux…" forever.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[control-session] open failed for project ${projectId}:`, err);
      store().setOpenError(projectId, message);
      initialized.delete(projectId);
    })
    .finally(() => {
      // Clear the slot on settle (success or failure) so a future retry is
      // allowed, but two concurrent ensures never run.
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

/** Tear down the subscription and per-project lifecycle state (teardown/tests). */
export function resetControlSession(): void {
  subscription?.();
  subscription = null;
  initialized.clear();
  inFlight.clear();
  ready.clear();
}
