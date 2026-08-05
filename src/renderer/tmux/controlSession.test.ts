// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `agentCockpit` captures `window.api` at import time, so the fake bridge must
// be installed before the module under test is imported (mirrors tmuxStore.test.ts).
const api = vi.hoisted(() => {
  const tmuxControl = {
    open: vi.fn().mockResolvedValue('agent-cockpit-proj'),
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({ num: 1, error: false, lines: [] }),
    input: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue([]),
  };
  // Capture live onTmux handlers so tests can fire an `attached` epoch (the
  // signal main emits on every channel (re)attach) and drive the reinit path.
  type TmuxSink = (e: { projectId: string; notification: unknown }) => void;
  const tmuxHandlers: TmuxSink[] = [];
  const events = {
    onTmux: vi.fn((h: TmuxSink) => {
      tmuxHandlers.push(h);
      return () => {
        const i = tmuxHandlers.indexOf(h);
        if (i >= 0) tmuxHandlers.splice(i, 1);
      };
    }),
  };
  const fake = { tmuxControl, events, tmuxHandlers };
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.api = fake;
  return fake;
});

/** Simulate the main-process control manager announcing a fresh channel (first
 *  open or a silent reattach) at `epoch` for `projectId`. */
function emitAttached(projectId: string, epoch: number): void {
  for (const h of [...api.tmuxHandlers]) h({ projectId, notification: { type: 'attached', epoch } });
}

/** Count `list-windows` commands issued so far (1 reconcile read + 2 sync reads
 *  = 3 per completed reinit). */
function listWindowsCount(): number {
  return api.tmuxControl.command.mock.calls.filter((c) => (c[0] as string).startsWith('list-windows'))
    .length;
}

import {
  acquireControlSession,
  ensureWindows,
  nudgeClientSize,
  nudgePaneRows,
  reconcile,
  resetControlSession,
  restoreActiveWindow,
  syncFromTmux,
  whenReady,
} from './controlSession';
import { emptyView, useTmuxStore } from './tmuxStore';
import { useSettingsStore } from '../settings/settingsStore';
import { DEFAULT_SETTINGS } from '@shared/settings';
import * as paneRegistry from './controlPaneRegistry';
import type { LayoutNode } from '@shared/tmux';

const PROJ = 'proj-reap';

/** Build a `list-windows -F "#{window_id} #{window_name}"` reply. */
const lw = (rows: [id: string, name: string][]): { num: number; error: boolean; lines: string[] } => ({
  num: 1,
  error: false,
  lines: rows.map(([id, name]) => `${id} ${name}`),
});

/** Route the next `list-windows` query to `rows`; everything else is a no-op
 *  ok-reply. The layout pass (`#{window_layout}`) returns the same row ids with
 *  empty layouts (best-effort sync ignores unparseable layouts). */
function withWindows(rows: [id: string, name: string][]): void {
  api.tmuxControl.command.mockImplementation(async (args: string) => {
    if (args.startsWith('list-windows -F "#{window_id} #{window_name}"')) return lw(rows);
    return { num: 1, error: false, lines: [] };
  });
}

describe('reconcile (pure)', () => {
  it('bails on an empty window list (attach race), distinct from steady-state no-op', () => {
    expect(reconcile([])).toEqual({ bail: true });
  });

  it('is a no-op for a clean session (one persistent + one run-1 + a real window)', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-1' },
      { id: '@3', name: 'zsh' },
    ]);
    expect(plan).toEqual({
      bail: false,
      toCreate: [],
      toKill: [],
      toRename: [],
      createFirstTerminal: false,
    });
  });

  it('creates the missing reserved windows when only a real window exists', () => {
    const plan = reconcile([{ id: '@5', name: 'zsh' }]);
    expect(plan).toEqual({
      bail: false,
      toCreate: ['persistent', 'run-1'],
      toKill: [],
      toRename: [],
      createFirstTerminal: false,
    });
  });

  it('reaps duplicate persistent windows, keeping the lowest numeric id', () => {
    const plan = reconcile([
      { id: '@10', name: 'persistent' },
      { id: '@2', name: 'persistent' },
      { id: '@7', name: 'persistent' },
      { id: '@3', name: 'run-1' },
      { id: '@4', name: 'zsh' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    // Keep @2 (lowest numeric id), kill @7 and @10.
    expect(plan.toKill.sort()).toEqual(['@10', '@7']);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toRename).toEqual([]);
  });

  it('never kills real windows even when there are many', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-1' },
      { id: '@3', name: 'editor' },
      { id: '@4', name: 'logs' },
      { id: '@5', name: 'shell' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toKill).toEqual([]);
  });

  it('renames a surviving run-N to run-1 (RunPanel binds the literal name)', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-3' },
      { id: '@9', name: 'run-7' },
      { id: '@4', name: 'zsh' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    // Survivor is @2 (lowest numeric id) → renamed to run-1; @9 reaped.
    expect(plan.toRename).toEqual([{ id: '@2', to: 'run-1' }]);
    expect(plan.toKill).toEqual(['@9']);
  });

  it('does not rename a survivor already named run-1', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-1' },
      { id: '@3', name: 'zsh' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toRename).toEqual([]);
  });

  it('flags createFirstTerminal when every window is hidden (pre-create snapshot)', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-1' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.createFirstTerminal).toBe(true);
  });

  it('does not flag createFirstTerminal when a real window already exists', () => {
    const plan = reconcile([
      { id: '@1', name: 'persistent' },
      { id: '@2', name: 'run-1' },
      { id: '@3', name: 'zsh' },
    ]);
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.createFirstTerminal).toBe(false);
  });

  it('defaults to createRun:true (run-1 created when absent and no opts passed)', () => {
    const plan = reconcile([{ id: '@5', name: 'zsh' }]);
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toCreate).toEqual(['persistent', 'run-1']);
  });

  it('with createRun:false, does NOT create an absent run-1 (still creates persistent)', () => {
    const plan = reconcile([{ id: '@5', name: 'zsh' }], { createRun: false });
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toCreate).toEqual(['persistent']);
    expect(plan.toKill).toEqual([]);
  });

  it('with createRun:false, KEEPS an existing single run-1 (setting never reaps it)', () => {
    const plan = reconcile(
      [
        { id: '@1', name: 'persistent' },
        { id: '@2', name: 'run-1' },
        { id: '@3', name: 'zsh' },
      ],
      { createRun: false },
    );
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toCreate).toEqual([]);
    expect(plan.toKill).toEqual([]);
    expect(plan.toRename).toEqual([]);
  });

  it('with createRun:false, still dedups duplicate run-N and renames the survivor', () => {
    const plan = reconcile(
      [
        { id: '@1', name: 'persistent' },
        { id: '@2', name: 'run-3' },
        { id: '@9', name: 'run-7' },
        { id: '@4', name: 'zsh' },
      ],
      { createRun: false },
    );
    if (plan.bail) throw new Error('unexpected bail');
    expect(plan.toRename).toEqual([{ id: '@2', to: 'run-1' }]);
    expect(plan.toKill).toEqual(['@9']);
    expect(plan.toCreate).toEqual([]);
  });
});

describe('ensureWindows (wires reconcile into tmux commands)', () => {
  beforeEach(() => {
    useTmuxStore.getState().reset();
    useTmuxStore.getState().setActiveProject(PROJ);
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    api.tmuxControl.command.mockReset();
    api.tmuxControl.command.mockResolvedValue({ num: 1, error: false, lines: [] });
  });
  afterEach(() => {
    resetControlSession();
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  });

  it('with showRunPanel off (default), does NOT create an absent run-1', async () => {
    withWindows([
      ['@1', 'persistent'],
      ['@3', 'zsh'],
    ]);
    const res = await ensureWindows(PROJ);
    expect(res).toEqual({ bailed: false, synced: true });
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    // No new-window -n run-1 issued; persistent already present so no create at all.
    expect(issued.some((a) => a.startsWith('new-window -dP -n run-1'))).toBe(false);
  });

  it('with showRunPanel on, creates an absent run-1', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showRunPanel: true } });
    withWindows([
      ['@1', 'persistent'],
      ['@3', 'zsh'],
    ]);
    await ensureWindows(PROJ);
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued.some((a) => a.startsWith('new-window -dP -n run-1'))).toBe(true);
  });

  it('with showRunPanel off, KEEPS an existing run-1 (never reaps it)', async () => {
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'run-1'],
      ['@3', 'zsh'],
    ]);
    await ensureWindows(PROJ);
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued.some((a) => a.startsWith('kill-window'))).toBe(false);
  });

  it('bails (no commands, bailed=true) on an empty list', async () => {
    withWindows([]);
    const res = await ensureWindows(PROJ);
    expect(res).toEqual({ bailed: true, synced: false });
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued.some((a) => a.startsWith('kill-window'))).toBe(false);
    expect(issued.some((a) => a.startsWith('new-window'))).toBe(false);
  });

  it('issues kill-window for duplicates and rename for the run survivor', async () => {
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'persistent'],
      ['@3', 'run-2'],
      ['@4', 'zsh'],
    ]);
    const res = await ensureWindows(PROJ);
    expect(res).toEqual({ bailed: false, synced: true });
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toContain('kill-window -t @2');
    expect(issued).toContain('rename-window -t @3 run-1');
    expect(issued.some((a) => a.startsWith('new-window'))).toBe(false);
  });

  it('is idempotent for a clean session (no kill/create/rename commands)', async () => {
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'run-1'],
      ['@3', 'zsh'],
    ]);
    const res = await ensureWindows(PROJ);
    expect(res).toEqual({ bailed: false, synced: true });
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued.some((a) => a.startsWith('kill-window'))).toBe(false);
    expect(issued.some((a) => a.startsWith('rename-window'))).toBe(false);
    // One ensure = 1 reconcile-snapshot read + 2 syncFromTmux reads (name+layout).
    expect(issued.filter((a) => a.startsWith('list-windows')).length).toBe(3);
  });

  it('prunes reaped windows from the store via %window-close over the live stream', async () => {
    // Renderer model has two persistent windows; reaping @2 must remove it once
    // tmux emits %window-close for the killed window.
    const store = useTmuxStore.getState();
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@1' });
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@2' });
    expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder).toEqual(['@1', '@2']);
    // Simulate tmux's %window-close after kill-window.
    store.applyNotification(PROJ, { type: 'window-close', windowId: '@2' });
    expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder).toEqual(['@1']);
  });
});

describe('syncFromTmux (authoritative window sync)', () => {
  beforeEach(() => {
    useTmuxStore.getState().reset();
    useTmuxStore.getState().setActiveProject(PROJ);
    api.tmuxControl.command.mockReset();
  });
  afterEach(() => resetControlSession());

  it('prunes a slice window absent from list-windows (closed while the channel was down)', async () => {
    const store = useTmuxStore.getState();
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@1' });
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@2' });
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@3' });
    expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder).toEqual(['@1', '@2', '@3']);

    // The live session now reports only @1 and @3 — @2 was closed during the
    // channel drop, and a reattach replays no %window-close for what is gone.
    withWindows([
      ['@1', 'persistent'],
      ['@3', 'zsh'],
    ]);
    await syncFromTmux(PROJ);

    expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder).toEqual(['@1', '@3']);
  });
});

describe('restoreActiveWindow (reconnect focuses the last-worked window)', () => {
  beforeEach(() => {
    useTmuxStore.getState().reset();
    useTmuxStore.getState().setActiveProject(PROJ);
    api.tmuxControl.command.mockReset();
  });
  afterEach(() => resetControlSession());

  it('adopts tmux active window as the store active window even when it is not the first', async () => {
    const store = useTmuxStore.getState();
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@1' });
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@3' });
    store.applyNotification(PROJ, { type: 'window-renamed', windowId: '@3', name: 'editor' });

    // tmux reports @3 as the session's active window (the last one focused).
    api.tmuxControl.command.mockImplementation(async (args: string) =>
      args.startsWith('display-message')
        ? { num: 1, error: false, lines: ['@3'] }
        : { num: 1, error: false, lines: [] },
    );
    await restoreActiveWindow(PROJ);

    expect(useTmuxStore.getState().byProject[PROJ]?.activeWindowId).toBe('@3');
  });

  it('does not adopt a reserved (hidden) window — leaves the current selection', async () => {
    const store = useTmuxStore.getState();
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@1' });
    store.applyNotification(PROJ, { type: 'window-renamed', windowId: '@1', name: 'persistent' });
    store.applyNotification(PROJ, { type: 'window-add', windowId: '@2' });
    store.applyNotification(PROJ, { type: 'session-window-changed', windowId: '@2' });

    // tmux's active window is the reserved persistent holder — must be ignored.
    api.tmuxControl.command.mockImplementation(async (args: string) =>
      args.startsWith('display-message')
        ? { num: 1, error: false, lines: ['@1'] }
        : { num: 1, error: false, lines: [] },
    );
    await restoreActiveWindow(PROJ);

    expect(useTmuxStore.getState().byProject[PROJ]?.activeWindowId).toBe('@2');
  });
});

describe('acquireControlSession single-flight', () => {
  beforeEach(() => {
    useTmuxStore.getState().reset();
    api.tmuxControl.open.mockReset();
    api.tmuxControl.open.mockResolvedValue('agent-cockpit-proj');
    api.tmuxControl.command.mockReset();
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'run-1'],
      ['@3', 'zsh'],
    ]);
  });
  afterEach(() => resetControlSession());

  it('opens exactly once when two acquires fire in the same tick', async () => {
    // Defer open so both acquires register before it settles.
    let release!: (s: string) => void;
    api.tmuxControl.open.mockImplementationOnce(
      () => new Promise<string>((res) => (release = res)),
    );

    acquireControlSession(PROJ);
    acquireControlSession(PROJ);

    release('agent-cockpit-proj');
    await whenReady(PROJ);

    // open invoked exactly once (single-flight collapsed the second acquire).
    expect(api.tmuxControl.open).toHaveBeenCalledTimes(1);
  });

  it('runs ONE ensure when the attach epoch arrives and acquire backstops it', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    emitAttached(PROJ, 1); // main announces the fresh channel during/after open
    // Exactly one authoritative window sync runs for the epoch.
    await vi.waitFor(() => expect(listWindowsCount()).toBe(3));
    // Give any duplicate reinit a chance to (wrongly) run, then assert it did not.
    await Promise.resolve();
    expect(listWindowsCount()).toBe(3);
  });

  it('re-runs ensure on a channel reattach (higher epoch) — the reconnect fix', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    emitAttached(PROJ, 1);
    await vi.waitFor(() => expect(listWindowsCount()).toBe(3));

    // Silent reattach: SAME session stays connected, only the channel flapped.
    // A new epoch must re-run the authoritative window sync with no re-acquire.
    emitAttached(PROJ, 2);
    await vi.waitFor(() => expect(listWindowsCount()).toBe(6));
  });

  it('does NOT re-run ensure for a repeated (same) epoch', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    emitAttached(PROJ, 1);
    await vi.waitFor(() => expect(listWindowsCount()).toBe(3));

    emitAttached(PROJ, 1); // duplicate announcement of the same channel
    await Promise.resolve();
    expect(listWindowsCount()).toBe(3); // unchanged — already initialized this epoch
  });

  it('per-project reset keeps the shared subscription; full reset drops it', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    expect(api.tmuxHandlers.length).toBe(1);

    resetControlSession(PROJ); // one project disconnecting
    expect(api.tmuxHandlers.length).toBe(1); // other live projects keep routing

    resetControlSession(); // full teardown (no arg)
    expect(api.tmuxHandlers.length).toBe(0);
  });

  it('per-project reset re-inits on re-acquire even without a fresh attach (backend switch)', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    emitAttached(PROJ, 1);
    await vi.waitFor(() => expect(listWindowsCount()).toBe(3));

    // Backend switch: per-project reset, then re-acquire with tmux still open —
    // open() resolves but emits NO new `attached`. Re-init must still run because
    // the kept channelEpoch is now ahead of the cleared initializedEpoch.
    resetControlSession(PROJ);
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    await vi.waitFor(() => expect(listWindowsCount()).toBe(6));
  });

  it('retries when list-windows races empty and converges once queryable (no manual switch)', async () => {
    // Attach race: the -CC channel is up but the session isn't queryable yet, so
    // list-windows comes back empty. This is exactly the fresh-connect / reconnect
    // window where the old code falsely marked the channel initialized and left the
    // window list wrong until the user switched windows.
    withWindows([]);
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    emitAttached(PROJ, 1);
    // The empty read must NOT mark the epoch initialized (a re-run must still be
    // possible) and must NOT issue reconcile mutations from an empty list.
    await vi.waitFor(() => expect(listWindowsCount()).toBeGreaterThan(0));
    expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder ?? []).toEqual([]);
    expect(
      api.tmuxControl.command.mock.calls.some((c) => (c[0] as string).startsWith('kill-window')),
    ).toBe(false);

    // The session becomes queryable — with NO new attach epoch and NO user action,
    // the bounded retry must re-run and populate the correct window list.
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'run-1'],
      ['@3', 'zsh'],
    ]);
    await vi.waitFor(
      () => expect(useTmuxStore.getState().byProject[PROJ]?.windowOrder).toContain('@3'),
      { timeout: 2000 },
    );
  });
});

/** Deterministic requestAnimationFrame stub: queues callbacks and only runs
 *  them on an explicit `flush()`, so tests never depend on jsdom's real
 *  (timer-based) rAF or race against it. `pending()` lets a test assert
 *  nothing was scheduled at all (the pre-rAF bail conditions). Shared by the
 *  `nudgePaneRows` and `nudgeClientSize` suites below — both defer to a real
 *  `requestAnimationFrame`. */
function stubRaf(): { flush: () => void; pending: () => number } {
  let queued: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    queued.push(cb);
    return queued.length;
  });
  return {
    pending: () => queued.length,
    flush: () => {
      const cbs = queued;
      queued = [];
      for (const cb of cbs) cb(0);
    },
  };
}

/** Seed a window's layout (+ optional zoom flag) directly into the store, and
 *  make it the project's active window — the shape `nudgePaneRows` reads
 *  (`byProject[projectId].windows[windowId]`) plus `activeWindowId`, which
 *  `nudgeClientSize` additionally needs to locate the active window's layout.
 *  Setting `activeWindowId` is inert for `nudgePaneRows`, which takes its
 *  window id as an explicit argument and never reads `activeWindowId`. Shared
 *  by both suites below. */
function seedWindow(
  projectId: string,
  windowId: string,
  layout: LayoutNode | null,
  isZoomed = false,
): void {
  useTmuxStore.setState((st) => ({
    byProject: {
      ...st.byProject,
      [projectId]: {
        ...(st.byProject[projectId] ?? emptyView()),
        activeWindowId: windowId,
        windows: {
          ...(st.byProject[projectId]?.windows ?? {}),
          [windowId]: { windowId, name: windowId, layout, isZoomed, visibleLayout: layout },
        },
      },
    },
  }));
}

/** A single-leaf layout node. Shared by both suites below. */
const leaf = (paneId: string, h: number): LayoutNode => ({
  type: 'leaf',
  paneId,
  w: 80,
  h,
  x: 0,
  y: 0,
});

describe('nudgePaneRows (per-pane row round-trip — local_repo_explorer-bvni)', () => {
  /** A three-pane top/bottom stack — the exact topology the diagnosis
   *  reproduced the bug on (tmux's layout_resize_adjust only reaches the first
   *  child of a same-direction split). */
  const tb3 = (): LayoutNode => ({
    type: 'split',
    dir: 'tb',
    w: 80,
    h: 38,
    x: 0,
    y: 0,
    children: [leaf('%0', 10), leaf('%1', 12), leaf('%2', 14)],
  });

  /** A top leaf over a side-by-side split: TB[leaf, LR{a,b}]. */
  const nestedTbLr = (): LayoutNode => ({
    type: 'split',
    dir: 'tb',
    w: 80,
    h: 36,
    x: 0,
    y: 0,
    children: [
      leaf('%0', 15),
      {
        type: 'split',
        dir: 'lr',
        w: 80,
        h: 20,
        x: 0,
        y: 16,
        children: [leaf('%1', 20), leaf('%2', 20)],
      },
    ],
  });

  /** The exact three-command shrink/delay/restore sequence for one pane. */
  const triple = (paneId: string, h: number): string[] => [
    `resize-pane -t ${paneId} -y ${h - 1}`,
    'run-shell -d 0.05',
    `resize-pane -t ${paneId} -y ${h}`,
  ];

  let raf: { flush: () => void; pending: () => number };

  beforeEach(() => {
    useTmuxStore.getState().reset();
    api.tmuxControl.command.mockReset();
    api.tmuxControl.command.mockResolvedValue({ num: 1, error: false, lines: [] });
    raf = stubRaf();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the exact shrink/delay/restore triple for every pane of a TB-3-stack layout', () => {
    const P = 'proj-nudge-tb3';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb3());

    nudgePaneRows(P, '@0');
    raf.flush();

    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toEqual([...triple('%0', 10), ...triple('%1', 12), ...triple('%2', 14)]);
  });

  it('sends the exact triple for every pane of a nested TB[leaf, LR{a,b}] layout', () => {
    const P = 'proj-nudge-nested';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', nestedTbLr());

    nudgePaneRows(P, '@0');
    raf.flush();

    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toEqual([...triple('%0', 15), ...triple('%1', 20), ...triple('%2', 20)]);
  });

  it('a zoomed window sends zero commands and schedules no rAF (client nudge already covers it)', () => {
    const P = 'proj-nudge-zoomed';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb3(), /* isZoomed */ true);

    nudgePaneRows(P, '@0');

    expect(raf.pending()).toBe(0);
    expect(api.tmuxControl.command).not.toHaveBeenCalled();
  });

  it('a single-pane window sends zero commands and schedules no rAF', () => {
    const P = 'proj-nudge-single';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', leaf('%0', 24));

    nudgePaneRows(P, '@0');

    expect(raf.pending()).toBe(0);
    expect(api.tmuxControl.command).not.toHaveBeenCalled();
  });

  it('a missing window (absent from the store) sends zero commands and schedules no rAF', () => {
    const P = 'proj-nudge-missing';
    useTmuxStore.getState().setActiveProject(P);
    // No seedWindow call: the project slice / window is absent entirely.

    nudgePaneRows(P, '@0');

    expect(raf.pending()).toBe(0);
    expect(api.tmuxControl.command).not.toHaveBeenCalled();
  });

  it('a layout whose every leaf has h < 2 schedules the rAF but sends zero commands', () => {
    const P = 'proj-nudge-h1';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', {
      type: 'split',
      dir: 'tb',
      w: 80,
      h: 2,
      x: 0,
      y: 0,
      children: [leaf('%0', 1), leaf('%1', 1)],
    });

    nudgePaneRows(P, '@0');
    expect(raf.pending()).toBe(1); // the <2-leaves / zoomed checks passed; h<2 is a per-leaf skip inside the rAF
    raf.flush();

    expect(api.tmuxControl.command).not.toHaveBeenCalled();
  });

  it('skips only the h<2 leaf in a mixed-height layout, still nudging its sibling', () => {
    const P = 'proj-nudge-mixed';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', {
      type: 'split',
      dir: 'tb',
      w: 80,
      h: 25,
      x: 0,
      y: 0,
      children: [leaf('%0', 1), leaf('%1', 24)],
    });

    nudgePaneRows(P, '@0');
    raf.flush();

    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toEqual(triple('%1', 24));
  });

  it('bails with nothing sent when the active project switched before the rAF fired', () => {
    const P = 'proj-nudge-switch';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb3());

    nudgePaneRows(P, '@0');
    useTmuxStore.getState().setActiveProject('some-other-project');
    raf.flush();

    expect(api.tmuxControl.command).not.toHaveBeenCalled();

    // The single-flight guard must not be left permanently stuck: switching
    // back and nudging again must still work (the bail clears the guard).
    useTmuxStore.getState().setActiveProject(P);
    nudgePaneRows(P, '@0');
    raf.flush();
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toEqual([...triple('%0', 10), ...triple('%1', 12), ...triple('%2', 14)]);
  });

  it('a second call while one is already in flight for the project sends nothing extra', () => {
    const P = 'proj-nudge-inflight';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb3());

    nudgePaneRows(P, '@0');
    expect(raf.pending()).toBe(1);
    nudgePaneRows(P, '@0'); // rapid second click: must not queue a second rAF
    expect(raf.pending()).toBe(1);

    raf.flush();
    const issued = api.tmuxControl.command.mock.calls.map((c) => c[0] as string);
    expect(issued).toEqual([...triple('%0', 10), ...triple('%1', 12), ...triple('%2', 14)]);
  });
});

describe('nudgeClientSize (client resize round-trip — local_repo_explorer-ppjp)', () => {
  /** A two-pane top/bottom stack whose layout ROOT height is `hA + hB + 1`
   *  (one row for tmux's pane separator) — the exact shape `nudgeClientSize`
   *  now reads (`win.visibleLayout ?? win.layout`, root `w`/`h`). */
  const tb2 = (hA: number, hB: number): LayoutNode => ({
    type: 'split',
    dir: 'tb',
    w: 80,
    h: hA + hB + 1,
    x: 0,
    y: 0,
    children: [leaf('%0', hA), leaf('%1', hB)],
  });

  let raf: { flush: () => void; pending: () => number };

  beforeEach(() => {
    useTmuxStore.getState().reset();
    api.tmuxControl.resize.mockReset();
    api.tmuxControl.resize.mockResolvedValue(undefined);
    raf = stubRaf();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shrinks then restores using the LAYOUT-ROOT size, never a disagreeing pane-summed total', () => {
    const P = 'proj-client-disagree';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb2(26, 26)); // layout root: 80x53 (26 + 26 + 1 separator)

    // Deliberately disagreeing LIVE pane sizes: 26 + 27 (+1 separator) = 54,
    // != the layout root's 53. This is the exact cross-layer rounding
    // disagreement (local_repo_explorer-ppjp) that made the old
    // clientCells-summing restore oscillate; getPaneTermSize must never be
    // consulted by the fixed nudgeClientSize at all (root short-circuits it).
    vi.spyOn(paneRegistry, 'getPaneTermSize').mockImplementation((_projectId, paneId) =>
      paneId === '%0' ? { cols: 80, rows: 26 } : { cols: 80, rows: 27 },
    );

    const host = document.createElement('div');
    nudgeClientSize(host);

    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(1);
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(1, 80, 52);

    raf.flush();

    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(2);
    // Layout-derived (53), never the pane-summed 54 or any value derived from it.
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(2, 80, 53);
  });

  it('does not recompute the restore target from the store — pushes the click-time-captured size', () => {
    const P = 'proj-client-norecompute';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb2(26, 26)); // layout root: 80x53

    const host = document.createElement('div');
    nudgeClientSize(host);
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(1, 80, 52);

    // Mutate the seeded layout root to a DIFFERENT size between the click and
    // the rAF flush. A restore that re-reads the store (instead of using the
    // value captured at click time) would pick this up and restore wrong.
    seedWindow(P, '@0', tb2(19, 20)); // layout root: 80x40

    raf.flush();

    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(2);
    // Still the ORIGINAL click-time capture (80,53), not 80x40-derived.
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(2, 80, 53);
  });

  it('skips the restore when the active project changed before the rAF fired (guard unchanged)', () => {
    const P = 'proj-client-switch';
    useTmuxStore.getState().setActiveProject(P);
    seedWindow(P, '@0', tb2(26, 26));

    const host = document.createElement('div');
    nudgeClientSize(host);
    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(1);
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(1, 80, 52);

    useTmuxStore.getState().setActiveProject('some-other-project');
    raf.flush();

    // No restore push: the click-time shrink remains the only call.
    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(1);
  });

  it('falls back to the pixel-derived clientCells(host) estimate when no layout exists yet, captured once', () => {
    const P = 'proj-client-fallback';
    useTmuxStore.getState().setActiveProject(P);
    // No seedWindow call: no active window, so the layout-root read comes
    // back null and nudgeClientSize must fall back to clientCells(host).
    vi.spyOn(paneRegistry, 'getCellSize').mockReturnValue(null);
    vi.spyOn(paneRegistry, 'getChromeSize').mockReturnValue(null);

    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });

    nudgeClientSize(host);

    // Default fallback cell metrics are 8x17px: floor(800/8)=100, floor(600/17)=35.
    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(1);
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(1, 100, 34);

    // Mutate the host's pixel size between the click and the rAF flush. A
    // restore that recomputes clientCells(host) would pick up the new width
    // (cols=50); the fix must restore the value captured at click time.
    Object.defineProperty(host, 'clientWidth', { value: 400, configurable: true });

    raf.flush();

    expect(api.tmuxControl.resize).toHaveBeenCalledTimes(2);
    expect(api.tmuxControl.resize).toHaveBeenNthCalledWith(2, 100, 35);
  });
});
