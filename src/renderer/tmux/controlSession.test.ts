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
  reconcile,
  resetControlSession,
  restoreActiveWindow,
  syncFromTmux,
  whenReady,
} from './controlSession';
import { useTmuxStore } from './tmuxStore';
import { useSettingsStore } from '../settings/settingsStore';
import { DEFAULT_SETTINGS } from '@shared/settings';

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
