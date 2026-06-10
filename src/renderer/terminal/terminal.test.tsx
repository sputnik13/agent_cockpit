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

beforeEach(() => {
  api.terminal.open.mockClear();
  api.terminal.close.mockClear();
});

afterEach(() => {
  cleanup();
  registry.stopReaper(); // acquire() starts a real interval; clear it between tests
});

describe('terminalRegistry', () => {
  it('acquire is idempotent per (projectId, kind, key) and opens the PTY once', () => {
    const a = registry.acquire('projA', 'terminal', 'idem1');
    const b = registry.acquire('projA', 'terminal', 'idem1');
    expect(b).toBe(a);
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    registry.dispose('projA', 'terminal', 'idem1');
  });

  it('writes only events whose projectId AND terminalId match', () => {
    const entry = registry.acquire('projX', 'terminal', 'filt1');
    const write = vi.spyOn(entry.term, 'write');

    api.emitData({ projectId: 'projX', terminalId: 'filt1', data: 'yes' });
    api.emitData({ projectId: 'other', terminalId: 'filt1', data: 'wrong-project' });
    api.emitData({ projectId: 'projX', terminalId: 'other', data: 'wrong-id' });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('yes');
    registry.dispose('projX', 'terminal', 'filt1');
  });

  it('dispose tears down the subscription and removes the instance', () => {
    const entry = registry.acquire('projD', 'terminal', 'disp1');
    const write = vi.spyOn(entry.term, 'write');
    expect(api.dataHandlerCount()).toBeGreaterThan(0);

    registry.dispose('projD', 'terminal', 'disp1');

    // Subscription is gone: a matching event no longer reaches the disposed term.
    api.emitData({ projectId: 'projD', terminalId: 'disp1', data: 'after-dispose' });
    expect(write).not.toHaveBeenCalled();

    // Re-acquiring builds a fresh instance (PTY opened again).
    api.terminal.open.mockClear();
    const fresh = registry.acquire('projD', 'terminal', 'disp1');
    expect(fresh).not.toBe(entry);
    expect(api.terminal.open).toHaveBeenCalledTimes(1);
    registry.dispose('projD', 'terminal', 'disp1');
  });
});

describe('terminalRegistry reset + reaping', () => {
  it('reset detaches the host PTY (no kill) then re-acquire reopens a fresh one', async () => {
    const entry = registry.acquire('projR', 'terminal', 'rst1');
    api.terminal.open.mockClear();
    api.terminal.close.mockClear();

    await registry.reset('projR', 'terminal', 'rst1');
    // Detach the old node-pty (kill:false keeps the tmux session) before re-open,
    // so the reattach is a single clean client like a fresh app launch.
    expect(api.terminal.close).toHaveBeenCalledWith('rst1', false);

    const fresh = registry.acquire('projR', 'terminal', 'rst1');
    expect(fresh).not.toBe(entry);
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
  it('reuses the registry instance across remounts (no second open, no dispose)', () => {
    const props = { projectId: 'projV', terminalKey: 'view1', visible: true } as const;
    const first = render(<XtermView {...props} />);
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
    expect(api.terminal.open).toHaveBeenCalledTimes(1);

    // Mirror the panel's reset flow: await the detach, then bump the token.
    await registry.reset('projT', 'terminal', 'rtok');
    view.rerender(<XtermView {...base} resetToken={1} />);
    expect(api.terminal.open).toHaveBeenCalledTimes(2); // reopened -> reattached

    registry.dispose('projT', 'terminal', 'rtok');
  });
});
