// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc/channels';

// `agentCockpit` captures `window.api` at import time, so the fake bridge must be
// installed before the registry/view are imported (mirrors beads.test.tsx).
const api = vi.hoisted(() => {
  const dataHandlers = new Set<(e: TerminalDataEvent) => void>();
  const exitHandlers = new Set<(e: TerminalExitEvent) => void>();
  const terminal = {
    open: vi.fn().mockResolvedValue('t1'),
    write: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    scrollback: vi.fn().mockResolvedValue([]),
  };
  const events = {
    onTerminalData: (h: (e: TerminalDataEvent) => void) => {
      dataHandlers.add(h);
      return () => dataHandlers.delete(h);
    },
    onTerminalExit: (h: (e: TerminalExitEvent) => void) => {
      exitHandlers.add(h);
      return () => exitHandlers.delete(h);
    },
  };
  const fake = {
    terminal,
    events,
    emitData: (e: TerminalDataEvent) => dataHandlers.forEach((h) => h(e)),
    dataHandlerCount: () => dataHandlers.size,
  };
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.api = fake;
  // jsdom lacks these; xterm.open() needs matchMedia and XtermView uses ResizeObserver.
  w.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  w.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  return fake;
});

import * as registry from './terminalRegistry';
import { XtermView } from './XtermView';
import { useSettingsStore } from '../settings';
import { XtermPaneRenderer } from '../tmux/paneRenderer/xtermAdapter';
import { muxWindowCloseTarget, orderedMuxWindows } from './TerminalPanel';

beforeEach(() => {
  api.terminal.open.mockClear();
  api.terminal.write.mockReset().mockResolvedValue(undefined);
  api.terminal.close.mockClear();
  api.terminal.scrollback.mockReset().mockResolvedValue([]);
});

async function settleRendererOpen(): Promise<void> {
  // `ready()` is shared with async WTerm. Wait for the provider boundary rather
  // than encoding a renderer-specific promise-chain depth.
  await vi.waitFor(() => expect(api.terminal.open).toHaveBeenCalled());
}

afterEach(() => {
  cleanup();
  registry.stopReaper(); // acquire() starts a real interval; clear it between tests
});

describe('terminalRegistry', () => {
  it('never retargets a deferred window close to a surviving window', () => {
    const delayedTopology = [
      {
        sessionId: 'session-1',
        windowOrder: ['window-b'],
        activeWindowId: 'window-b',
        windows: [
          {
            windowId: 'window-b',
            activePaneId: 'pane-b',
            zoomedPaneId: null,
            layout: null,
            panes: [{ sessionId: 'session-1', paneId: 'pane-b', key: 'b', exited: false }],
          },
        ],
      },
    ];

    // The user clicked window-a, but it disappeared before the fresh topology
    // response arrived. The live survivor must not become a substitute target.
    expect(muxWindowCloseTarget(delayedTopology, 'session-1', 'window-a')).toBeNull();
  });

  it('uses daemon window placement rather than the incidental snapshot array order', () => {
    const pane = (paneId: string) => ({ sessionId: paneId, paneId, key: paneId, exited: false });
    const windows = [
      { windowId: 'window-10', activePaneId: 'pane-10', zoomedPaneId: null, layout: null, panes: [pane('pane-10')] },
      { windowId: 'window-9', activePaneId: 'pane-9', zoomedPaneId: null, layout: null, panes: [pane('pane-9')] },
    ];
    expect(orderedMuxWindows({
      sessionId: 'session-1',
      windowOrder: ['window-9', 'window-10'],
      activeWindowId: 'window-9',
      windows,
    }).map((window) => window.windowId)).toEqual(['window-9', 'window-10']);
  });

  it('acquire is idempotent per (projectId, kind, key) and opens the PTY once', async () => {
    const a = registry.acquire('projA', 'terminal', 'idem1');
    const b = registry.acquire('projA', 'terminal', 'idem1');
    expect(b).toBe(a);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    registry.dispose('projA', 'terminal', 'idem1');
  });

  it('announces provider-open completion with its terminal identity', async () => {
    const opened = vi.fn();
    window.addEventListener(registry.TERMINAL_OPENED_EVENT, opened);

    registry.acquire('projOpened', 'terminal', 'open1');
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect((opened.mock.calls[0]![0] as CustomEvent<registry.TerminalOpenedDetail>).detail).toEqual(
      {
        projectId: 'projOpened',
        kind: 'terminal',
        key: 'open1',
      },
    );
    window.removeEventListener(registry.TERMINAL_OPENED_EVENT, opened);
    registry.dispose('projOpened', 'terminal', 'open1');
  });

  it('writes only events whose projectId AND terminalId match', () => {
    const entry = registry.acquire('projX', 'terminal', 'filt1');
    const write = vi.spyOn(entry.renderer, 'write');

    api.emitData({ projectId: 'projX', terminalId: 'filt1', data: 'yes' });
    api.emitData({ projectId: 'other', terminalId: 'filt1', data: 'wrong-project' });
    api.emitData({ projectId: 'projX', terminalId: 'other', data: 'wrong-id' });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(new TextEncoder().encode('yes'));
    registry.dispose('projX', 'terminal', 'filt1');
  });

  it('uses the xterm adapter for a Cockpit mux session when the renderer is dom', async () => {
    const previous = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...previous, terminalBackend: 'cockpit-mux', terminalRenderer: 'dom' },
    });
    const entry = registry.acquire('projMuxXterm', 'terminal', 'mux-xterm');
    await settleRendererOpen();

    expect(entry.renderer).toBeInstanceOf(XtermPaneRenderer);
    expect(api.terminal.open).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'mux-xterm', hydrateScrollback: true }),
      'projMuxXterm',
    );

    registry.dispose('projMuxXterm', 'terminal', 'mux-xterm');
    useSettingsStore.setState({ settings: previous });
  });

  it('rehydrates a retained mux renderer from daemon history without replaying legacy terminals', async () => {
    const previous = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: { ...previous, terminalBackend: 'cockpit-mux', terminalRenderer: 'dom' },
    });
    const entry = registry.acquire('projMuxHistory', 'terminal', 'history-pane');
    await settleRendererOpen();
    api.terminal.open.mockClear();
    const write = vi.spyOn(entry.renderer, 'write');

    await registry.rehydrateMuxTerminal(entry);

    expect(write).toHaveBeenCalledWith(new TextEncoder().encode('\x1b[3J\x1b[2J\x1b[H'));
    expect(api.terminal.open).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'history-pane', hydrateScrollback: true }),
      'projMuxHistory',
    );
    registry.dispose('projMuxHistory', 'terminal', 'history-pane');

    useSettingsStore.setState({ settings: { ...previous, terminalBackend: 'control-mode' } });
    const legacy = registry.acquire('projLegacyHistory', 'terminal', 'legacy-pane');
    await settleRendererOpen();
    api.terminal.open.mockClear();
    await registry.rehydrateMuxTerminal(legacy);
    expect(api.terminal.open).not.toHaveBeenCalled();
    registry.dispose('projLegacyHistory', 'terminal', 'legacy-pane');
    useSettingsStore.setState({ settings: previous });
  });

  it('serializes per-terminal writes so rapid input cannot overtake itself', async () => {
    let finishFirst: (() => void) | undefined;
    api.terminal.write
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const entry = registry.acquire('projOrdered', 'terminal', 'ordered');
    await settleRendererOpen();

    entry.renderer.onData(() => {});
    // Drive the renderer-neutral subscription through a fake adapter callback
    // by calling the public terminal bridge through its registered source.
    // The first request stays in flight; the second must wait for it.
    (entry.renderer as unknown as { term?: { input(data: string): void } }).term?.input('a');
    (entry.renderer as unknown as { term?: { input(data: string): void } }).term?.input('b');
    await vi.waitFor(() => expect(api.terminal.write).toHaveBeenCalledTimes(1));
    finishFirst?.();
    await vi.waitFor(() => expect(api.terminal.write).toHaveBeenCalledTimes(2));
    expect(api.terminal.write.mock.calls.map((call: unknown[]) => call[1])).toEqual(['a', 'b']);
    registry.dispose('projOrdered', 'terminal', 'ordered');
  });

  it('dispose tears down the subscription and removes the instance', async () => {
    const entry = registry.acquire('projD', 'terminal', 'disp1');
    const write = vi.spyOn(entry.renderer, 'write');
    expect(api.dataHandlerCount()).toBeGreaterThan(0);

    registry.dispose('projD', 'terminal', 'disp1');

    // Subscription is gone: a matching event no longer reaches the disposed term.
    api.emitData({ projectId: 'projD', terminalId: 'disp1', data: 'after-dispose' });
    expect(write).not.toHaveBeenCalled();

    // Re-acquiring builds a fresh instance (PTY opened again).
    api.terminal.open.mockClear();
    const fresh = registry.acquire('projD', 'terminal', 'disp1');
    expect(fresh).not.toBe(entry);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    registry.dispose('projD', 'terminal', 'disp1');
  });

  it('never lets a disposed late open close a same-key successor', async () => {
    let resolveFirstOpen: (() => void) | undefined;
    api.terminal.open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstOpen = resolve;
        }),
    );
    const first = registry.acquire('projLate', 'terminal', 'reused-key');
    const firstFocus = vi.spyOn(first.renderer, 'focus');
    await vi.waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(1));

    // A reopened renderer can reuse this daemon key before the former client's
    // in-flight open resolves. The former client must neither focus nor destroy
    // the new renderer's pane.
    registry.dispose('projLate', 'terminal', 'reused-key');
    const successor = registry.acquire('projLate', 'terminal', 'reused-key');
    await vi.waitFor(() => expect(api.terminal.open).toHaveBeenCalledTimes(2));
    resolveFirstOpen?.();
    await vi.waitFor(() => expect(successor.opened).toBe(true));

    expect(firstFocus).not.toHaveBeenCalled();
    expect(api.terminal.close).not.toHaveBeenCalled();
    registry.dispose('projLate', 'terminal', 'reused-key');
  });

  it('tracks one renderer-neutral focused terminal per project and kind', () => {
    const first = registry.acquire('projFocus', 'terminal', 'one');
    const second = registry.acquire('projFocus', 'terminal', 'two');

    registry.focus(first);
    expect(first.container).toHaveClass('focused');
    registry.focus(second);
    expect(first.container).not.toHaveClass('focused');
    expect(second.container).toHaveClass('focused');

    registry.dispose('projFocus', 'terminal', 'one');
    registry.dispose('projFocus', 'terminal', 'two');
  });
});

describe('terminalRegistry reset + reaping', () => {
  it('reset detaches the host PTY (no kill) then re-acquire reopens a fresh one', async () => {
    const entry = registry.acquire('projR', 'terminal', 'rst1');
    await settleRendererOpen();
    api.terminal.open.mockClear();
    api.terminal.close.mockClear();

    await registry.reset('projR', 'terminal', 'rst1');
    // Detach the old node-pty (kill:false keeps the tmux session) before re-open,
    // so the reattach is a single clean client like a fresh app launch.
    expect(api.terminal.close).toHaveBeenCalledWith('rst1', false, 'projR');

    const fresh = registry.acquire('projR', 'terminal', 'rst1');
    expect(fresh).not.toBe(entry);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(1); // reopened -> reattaches tmux
    registry.dispose('projR', 'terminal', 'rst1');
  });

  it('sweepIdle reaps detached idle terminals but keeps connected ones', () => {
    // Detached: freshly acquired containers are not in the document.
    const idle = registry.acquire('projS', 'terminal', 'reapIdle');
    idle.lastTouched = 0;
    expect(idle.container.isConnected).toBe(false);

    // Connected + recently touched: attached into the live document.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const live = registry.acquire('projS', 'terminal', 'reapLive');
    registry.attach(live, host);
    expect(live.container.isConnected).toBe(true);

    const reaped = registry.sweepIdle(1000, 5000); // now=5000, threshold=1000ms
    expect(reaped).toBe(1); // only the detached, stale one
    expect(live.container.isConnected).toBe(true);

    registry.dispose('projS', 'terminal', 'reapLive');
    host.remove();
  });
});

describe('XtermView', () => {
  it('reuses the registry instance across remounts (no second open, no dispose)', async () => {
    const props = { projectId: 'projV', terminalKey: 'view1', visible: true } as const;
    const first = render(<XtermView {...props} />);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);

    // Unmount must detach, not dispose: the instance and its subscription persist.
    first.unmount();
    expect(api.dataHandlerCount()).toBeGreaterThan(0);

    render(<XtermView {...props} />);
    expect(api.terminal.open).toHaveBeenCalledTimes(1); // still once: reused

    registry.dispose('projV', 'terminal', 'view1');
  });

  it('re-acquires (reattaches) when resetToken changes after a reset', async () => {
    const base = { projectId: 'projT', terminalKey: 'rtok', visible: true } as const;
    const view = render(<XtermView {...base} resetToken={0} />);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(1);

    // Mirror the panel's reset flow: await the detach, then bump the token.
    await registry.reset('projT', 'terminal', 'rtok');
    view.rerender(<XtermView {...base} resetToken={1} />);
    await settleRendererOpen();
    expect(api.terminal.open).toHaveBeenCalledTimes(2); // reopened -> reattached

    registry.dispose('projT', 'terminal', 'rtok');
  });
});
