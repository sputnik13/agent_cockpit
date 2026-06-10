// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TmuxWireNotification } from '@shared/tmux';

// `agentCockpit` captures `window.api` at import time, so the fake bridge must
// be installed before the store is imported (mirrors terminal.test.tsx).
const api = vi.hoisted(() => {
  const tmuxControl = {
    open: vi.fn().mockResolvedValue('agent-cockpit-proj'),
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({ num: 1, error: false, lines: [] }),
    input: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue([]),
  };
  const fake = { tmuxControl };
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.api = fake;
  return fake;
});

import {
  collectPaneIds,
  emptyView,
  reduce,
  selectActiveView,
  useTmuxStore,
  type TmuxViewState,
} from './tmuxStore';

// A single full-window pane and a two-pane horizontal split layout.
const singleLayout = (winId: string, paneId: string): TmuxWireNotification => ({
  type: 'layout-change',
  windowId: winId,
  layout: { checksum: 'aaaa', root: { type: 'leaf', paneId, w: 80, h: 24, x: 0, y: 0 } },
  visibleLayout: null,
  flags: null,
});

const splitLayout = (winId: string, a: string, b: string): TmuxWireNotification => ({
  type: 'layout-change',
  windowId: winId,
  layout: {
    checksum: 'bbbb',
    root: {
      type: 'split',
      dir: 'lr',
      w: 80,
      h: 24,
      x: 0,
      y: 0,
      children: [
        { type: 'leaf', paneId: a, w: 40, h: 24, x: 0, y: 0 },
        { type: 'leaf', paneId: b, w: 39, h: 24, x: 41, y: 0 },
      ],
    },
  },
  visibleLayout: null,
  flags: null,
});

function fold(view: TmuxViewState, ns: TmuxWireNotification[]): TmuxViewState {
  // Use the pure reducer directly (these are not %output).
  return ns.reduce((s, wire) => reduce(s, wire as never), view);
}

describe('tmuxStore reducer (pure)', () => {
  it('adds a window on window-add (idempotent)', () => {
    let v = reduce(emptyView(), { type: 'window-add', windowId: '@1' });
    expect(v.windowOrder).toEqual(['@1']);
    // Re-applying the same add is a no-op (reconnect resync safety).
    v = reduce(v, { type: 'window-add', windowId: '@1' });
    expect(v.windowOrder).toEqual(['@1']);
  });

  it('maps a layout-change into the pane index', () => {
    const v = fold(emptyView(), [singleLayout('@1', '%5')]);
    expect(v.windows['@1']?.layout?.type).toBe('leaf');
    expect(v.panes['%5']).toEqual({ paneId: '%5', windowId: '@1' });
    expect(collectPaneIds(v.windows['@1']!.layout)).toEqual(['%5']);
  });

  it('maps a split layout into a two-leaf tree and both panes', () => {
    const v = fold(emptyView(), [splitLayout('@1', '%1', '%2')]);
    const root = v.windows['@1']!.layout!;
    expect(root.type).toBe('split');
    expect(collectPaneIds(root)).toEqual(['%1', '%2']);
    expect(Object.keys(v.panes).sort()).toEqual(['%1', '%2']);
  });

  it('records zoom state + visible layout from a zoomed layout-change (FA-1)', () => {
    // A zoomed window: full split layout, but tmux reports the single visible
    // pane as visible-layout and `Z` in the window flags.
    const zoomed: TmuxWireNotification = {
      type: 'layout-change',
      windowId: '@1',
      layout: (splitLayout('@1', '%1', '%2') as { layout: unknown }).layout as never,
      visibleLayout: { checksum: 'cccc', root: { type: 'leaf', paneId: '%1', w: 80, h: 24, x: 0, y: 0 } } as never,
      flags: '*Z',
    };
    const v = fold(emptyView(), [zoomed]);
    expect(v.windows['@1']?.isZoomed).toBe(true);
    // Full layout still indexes BOTH panes (so nothing is lost while zoomed).
    expect(collectPaneIds(v.windows['@1']!.layout)).toEqual(['%1', '%2']);
    // Visible layout is the single zoomed pane the renderer draws.
    expect(collectPaneIds(v.windows['@1']!.visibleLayout)).toEqual(['%1']);
  });

  it('clears zoom state when an unzoomed layout-change arrives', () => {
    const v0 = fold(emptyView(), [
      { ...splitLayout('@1', '%1', '%2'), flags: 'Z', visibleLayout: { checksum: 'cccc', root: { type: 'leaf', paneId: '%1', w: 80, h: 24, x: 0, y: 0 } } } as never,
    ]);
    expect(v0.windows['@1']?.isZoomed).toBe(true);
    const v1 = fold(v0, [splitLayout('@1', '%1', '%2')]);
    expect(v1.windows['@1']?.isZoomed).toBe(false);
    expect(v1.windows['@1']?.visibleLayout).toBeNull();
  });

  it('initializes a fresh window as not zoomed', () => {
    const v = reduce(emptyView(), { type: 'window-add', windowId: '@1' });
    expect(v.windows['@1']?.isZoomed).toBe(false);
    expect(v.windows['@1']?.visibleLayout).toBeNull();
  });

  it('renames a window', () => {
    let v = reduce(emptyView(), { type: 'window-add', windowId: '@1' });
    v = reduce(v, { type: 'window-renamed', windowId: '@1', name: 'editor' });
    expect(v.windows['@1']?.name).toBe('editor');
  });

  it('closes a window and drops its panes', () => {
    let v = fold(emptyView(), [splitLayout('@1', '%1', '%2'), singleLayout('@2', '%9')]);
    expect(v.windowOrder).toEqual(['@1', '@2']);
    v = reduce(v, { type: 'window-close', windowId: '@1' });
    expect(v.windowOrder).toEqual(['@2']);
    expect(v.windows['@1']).toBeUndefined();
    expect(v.panes['%1']).toBeUndefined();
    expect(v.panes['%2']).toBeUndefined();
    expect(v.panes['%9']).toBeDefined();
  });

  it('synthesizes a window when layout-change arrives before window-add', () => {
    const v = fold(emptyView(), [singleLayout('@7', '%3')]);
    expect(v.windowOrder).toEqual(['@7']);
    expect(v.windows['@7']).toBeDefined();
  });

  it('tracks the active window from window-pane-changed', () => {
    let v = fold(emptyView(), [singleLayout('@1', '%1'), singleLayout('@2', '%2')]);
    v = reduce(v, { type: 'window-pane-changed', windowId: '@2', paneId: '%2' });
    expect(v.activeWindowId).toBe('@2');
  });

  it('records the session name on session-changed', () => {
    const v = reduce(emptyView(), { type: 'session-changed', sessionId: '$0', name: 'sess' });
    expect(v.sessionName).toBe('sess');
  });

  it('clears the view on exit', () => {
    let v = fold(emptyView(), [singleLayout('@1', '%1')]);
    v = reduce(v, { type: 'exit', reason: null });
    expect(v.windowOrder).toEqual([]);
    expect(Object.keys(v.windows)).toEqual([]);
  });
});

describe('tmuxStore output routing + input (per-project)', () => {
  const P = 'proj-1';
  beforeEach(() => {
    useTmuxStore.getState().reset();
    api.tmuxControl.input.mockClear();
    api.tmuxControl.open.mockClear();
  });

  it('routes %output bytes only to the bound (project, pane) sink', () => {
    const store = useTmuxStore.getState();
    const got1: number[][] = [];
    const got2: number[][] = [];
    const off1 = store.bindPaneSink(P, '%1', (b) => got1.push(Array.from(b)));
    store.bindPaneSink(P, '%2', (b) => got2.push(Array.from(b)));

    store.applyNotification(P, { type: 'output', paneId: '%1', bytes: [104, 105] }); // "hi"
    store.applyNotification(P, { type: 'output', paneId: '%2', bytes: [121, 111] }); // "yo"

    expect(got1).toEqual([[104, 105]]);
    expect(got2).toEqual([[121, 111]]);

    // After unbinding, %1 no longer receives output.
    off1();
    store.applyNotification(P, { type: 'output', paneId: '%1', bytes: [1] });
    expect(got1).toEqual([[104, 105]]);
  });

  it('does not bleed %output across projects sharing a pane id', () => {
    const store = useTmuxStore.getState();
    const a: number[][] = [];
    const b: number[][] = [];
    store.bindPaneSink('proj-a', '%0', (x) => a.push(Array.from(x)));
    store.bindPaneSink('proj-b', '%0', (x) => b.push(Array.from(x)));

    store.applyNotification('proj-a', { type: 'output', paneId: '%0', bytes: [65] });
    expect(a).toEqual([[65]]);
    expect(b).toEqual([]); // proj-b's %0 is a different sink
  });

  it('reduces non-output notifications into the addressed project slice', () => {
    const store = useTmuxStore.getState();
    store.applyNotification('proj-a', { type: 'window-add', windowId: '@1' });
    store.applyNotification('proj-b', { type: 'window-add', windowId: '@2' });
    expect(useTmuxStore.getState().byProject['proj-a']?.windowOrder).toEqual(['@1']);
    expect(useTmuxStore.getState().byProject['proj-b']?.windowOrder).toEqual(['@2']);
  });

  it('setActiveProject switches the active view without resetting other slices', () => {
    const store = useTmuxStore.getState();
    store.applyNotification('proj-a', { type: 'window-add', windowId: '@1' });
    store.applyNotification('proj-b', { type: 'window-add', windowId: '@2' });

    store.setActiveProject('proj-a');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@1']);
    store.setActiveProject('proj-b');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@2']);
    // Switching back still shows proj-a's preserved windows (no rebuild).
    store.setActiveProject('proj-a');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@1']);
  });

  it('resetProject drops only the named slice', () => {
    const store = useTmuxStore.getState();
    store.applyNotification('proj-a', { type: 'window-add', windowId: '@1' });
    store.applyNotification('proj-b', { type: 'window-add', windowId: '@2' });
    store.resetProject('proj-a');
    expect(useTmuxStore.getState().byProject['proj-a']).toBeUndefined();
    expect(useTmuxStore.getState().byProject['proj-b']?.windowOrder).toEqual(['@2']);
  });

  it('sendInput encodes data to space-separated hex pairs', async () => {
    await useTmuxStore.getState().sendInput(P, '%3', 'echo');
    // 'echo' -> 65 63 68 6f
    expect(api.tmuxControl.input).toHaveBeenCalledWith('%3', '65 63 68 6f');
  });

  it('sendInput encodes control bytes (Enter = 0d)', async () => {
    await useTmuxStore.getState().sendInput(P, '%3', '\r');
    expect(api.tmuxControl.input).toHaveBeenCalledWith('%3', '0d');
  });

  it('open records the session name and open flag on the project slice', async () => {
    await useTmuxStore.getState().open(P, { cols: 80, rows: 24 });
    expect(api.tmuxControl.open).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    const slice = useTmuxStore.getState().byProject[P];
    expect(slice?.isOpen).toBe(true);
    expect(slice?.sessionName).toBe('agent-cockpit-proj');
    expect(slice?.openError).toBeNull();
  });

  it('open clears openError before the IPC call (connecting phase)', async () => {
    // Verify openError is null (connecting phase) during the in-flight open.
    let openErrorDuringOpen: string | null | undefined;
    api.tmuxControl.open.mockImplementationOnce(async () => {
      openErrorDuringOpen = useTmuxStore.getState().byProject[P]?.openError;
      return 'agent-cockpit-proj';
    });
    useTmuxStore.getState().setActiveProject(P);
    // Pre-set an error to verify it gets cleared.
    useTmuxStore.getState().setOpenError(P, 'prior error');
    await useTmuxStore.getState().open(P);
    expect(openErrorDuringOpen).toBeNull(); // cleared during open
  });

  it('setOpenError records failure with an error message', () => {
    useTmuxStore.getState().setActiveProject(P);
    useTmuxStore.getState().setOpenError(P, 'SSH timeout');
    const slice = useTmuxStore.getState().byProject[P];
    expect(slice?.openError).toBe('SSH timeout');
  });

  it('open clears openError on retry (failed -> connecting -> open)', async () => {
    useTmuxStore.getState().setActiveProject(P);
    useTmuxStore.getState().setOpenError(P, 'prior error');
    await useTmuxStore.getState().open(P);
    const slice = useTmuxStore.getState().byProject[P];
    expect(slice?.isOpen).toBe(true);
    expect(slice?.openError).toBeNull();
  });

});
