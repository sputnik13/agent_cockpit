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
  const events = { onTmux: vi.fn(() => () => {}) };
  const fake = { tmuxControl, events };
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.api = fake;
  return fake;
});

import {
  acquireControlSession,
  ensureWindows,
  reconcile,
  resetControlSession,
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
    expect(res).toEqual({ bailed: false });
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
    expect(res).toEqual({ bailed: true });
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
    expect(res).toEqual({ bailed: false });
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
    expect(res).toEqual({ bailed: false });
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

  it('runs ONE ensure when two acquires fire in the same tick', async () => {
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
    // Exactly one ensure ran: 1 reconcile-snapshot read + 2 syncFromTmux reads.
    const lists = api.tmuxControl.command.mock.calls
      .map((c) => c[0] as string)
      .filter((a) => a.startsWith('list-windows'));
    expect(lists.length).toBe(3);
  });

  it('marks initialized on success so a later acquire is a no-op ensure', async () => {
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    const firstLists = api.tmuxControl.command.mock.calls.filter((c) =>
      (c[0] as string).startsWith('list-windows'),
    ).length;
    expect(firstLists).toBe(3); // one ensure: reconcile read + 2 sync reads

    // A second acquire after settle must not re-run ensure (already initialized).
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    const totalLists = api.tmuxControl.command.mock.calls.filter((c) =>
      (c[0] as string).startsWith('list-windows'),
    ).length;
    expect(totalLists).toBe(3); // unchanged — no second ensure
  });

  it('does NOT mark initialized on an empty-list bail; a later acquire retries', async () => {
    withWindows([]); // first ensure sees an empty list → bail
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    expect(
      api.tmuxControl.command.mock.calls.some((c) => (c[0] as string).startsWith('kill-window')),
    ).toBe(false);

    // Now the session is populated; the retry must re-run ensure.
    api.tmuxControl.command.mockClear();
    withWindows([
      ['@1', 'persistent'],
      ['@2', 'run-1'],
      ['@3', 'zsh'],
    ]);
    acquireControlSession(PROJ);
    await whenReady(PROJ);
    const lists = api.tmuxControl.command.mock.calls.filter((c) =>
      (c[0] as string).startsWith('list-windows'),
    ).length;
    expect(lists).toBe(3); // ensure ran again on retry (reconcile read + 2 sync reads)
  });
});
