// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const api = vi.hoisted(() => {
  const tmuxHandlers = new Set<(e: { projectId: string; notification: unknown }) => void>();
  const tmuxControl = {
    open: vi.fn().mockResolvedValue('agent-cockpit-test'),
    close: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue({ num: 1, error: false, lines: [] }),
    input: vi.fn().mockResolvedValue(undefined),
    resize: vi.fn().mockResolvedValue(undefined),
    capturePane: vi.fn().mockResolvedValue([]),
  };
  const events = {
    onTmux: (h: (e: { projectId: string; notification: unknown }) => void) => {
      tmuxHandlers.add(h);
      return () => tmuxHandlers.delete(h);
    },
  };
  const fake = { tmuxControl, events, emitTmux: (e: unknown) => tmuxHandlers.forEach((h) => h(e as never)) };
  const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
  w.api = fake;
  w.matchMedia ??= (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  });
  w.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  return fake;
});

import { ControlTerminalPanel } from './ControlTerminalPanel';
import { useTmuxStore, emptyView, selectActiveView, type WindowState } from './tmuxStore';
import { resetControlSession } from './controlSession';
import * as paneRegistry from './controlPaneRegistry';
import { useProjectsStore, useSessionStore } from '@renderer/providerClient';

const ACTIVE = 'proj-1';
const leaf = (paneId: string): WindowState['layout'] => ({ type: 'leaf', paneId, w: 80, h: 24, x: 0, y: 0 });

/** Replace the active project's view slice (the panel renders the active slice). */
function setActiveSlice(partial: Partial<ReturnType<typeof emptyView>>): void {
  useTmuxStore.setState((st) => ({
    activeProjectId: ACTIVE,
    byProject: { ...st.byProject, [ACTIVE]: { ...emptyView(), isOpen: true, ...partial } },
  }));
}

beforeEach(() => {
  resetControlSession(); // clear the module-level subscription/opened set between tests
  api.tmuxControl.open.mockClear();
  useTmuxStore.getState().reset();
  useTmuxStore.getState().setActiveProject(ACTIVE);
  useProjectsStore.setState({ activeId: ACTIVE });
  // The panel acquire effect now requires providerConnected=true (FR3/FR4).
  // Set the active project to 'connected' so the terminal panel acquires the session.
  useSessionStore.getState().setStatus(ACTIVE, { state: 'connected', since: new Date().toISOString() });
});
afterEach(() => {
  cleanup();
  paneRegistry.disposeAll();
  paneRegistry.stopReaper();
});

describe('ControlTerminalPanel', () => {
  it('shows the no-project state when there is no active project', () => {
    useProjectsStore.setState({ activeId: null });
    render(<ControlTerminalPanel />);
    expect(screen.getByText('No active project')).toBeInTheDocument();
  });

  it('opens the control session and subscribes to tmux notifications on mount', async () => {
    render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalledTimes(1));
    // Before any window arrives it shows the connecting/empty state.
    expect(screen.getByText(/Connecting to tmux|No panes yet/)).toBeInTheDocument();
  });

  it('renders a window tab and a pane host when a window has a layout', async () => {
    const { container } = render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());

    act(() => {
      setActiveSlice({
        windowOrder: ['@0'],
        windows: { '@0': { windowId: '@0', name: 'shell', layout: leaf('%0') } },
        activeWindowId: '@0',
        panes: { '%0': { paneId: '%0', windowId: '@0' } },
      });
    });

    expect(screen.getByText('shell')).toBeInTheDocument();
    // The registry-owned xterm container (.ac-term) is reparented into the host.
    await waitFor(() => expect(container.querySelector('.ac-term')).not.toBeNull());
  });

  it('re-seeds the active tab on a silent control-channel reattach (attached epoch, no status change)', async () => {
    const { container } = render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());
    act(() => {
      setActiveSlice({
        windowOrder: ['@0'],
        windows: { '@0': { windowId: '@0', name: 'shell', layout: leaf('%0') } },
        activeWindowId: '@0',
        panes: { '%0': { paneId: '%0', windowId: '@0' } },
      });
    });
    await waitFor(() => expect(container.querySelector('.ac-term')).not.toBeNull());

    // list-windows returns a populated session so the reinit's ensureWindows does
    // not bail and fires the reinit notification the panel listens for.
    api.tmuxControl.command.mockImplementation(async (args: string) =>
      args.startsWith('list-windows')
        ? { num: 1, error: false, lines: ['@0 shell'] }
        : { num: 1, error: false, lines: [] },
    );
    const hardSpy = vi.spyOn(paneRegistry, 'hardRecoverTab').mockResolvedValue(undefined);

    // A silent `-CC` reattach announces a fresh channel epoch with NO connection
    // status transition — the case that previously left the display stale.
    act(() => api.emitTmux({ projectId: ACTIVE, notification: { type: 'attached', epoch: 7 } }));

    await waitFor(() => expect(hardSpy).toHaveBeenCalledWith(ACTIVE, '@0'));
    hardSpy.mockRestore();
    api.tmuxControl.command.mockReset();
    api.tmuxControl.command.mockResolvedValue({ num: 1, error: false, lines: [] });
  });

  it('routes notifications to the addressed project and only renders the active one', async () => {
    render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());

    // A notification for another project lands in that project's slice, not the
    // active view.
    act(() => api.emitTmux({ projectId: 'other', notification: { type: 'window-add', windowId: '@9' } }));
    expect(selectActiveView(useTmuxStore.getState()).windows['@9']).toBeUndefined();
    expect(useTmuxStore.getState().byProject['other']?.windows['@9']).toBeDefined();

    // The active project's notification appears in the active view.
    act(() => api.emitTmux({ projectId: ACTIVE, notification: { type: 'window-add', windowId: '@9' } }));
    expect(selectActiveView(useTmuxStore.getState()).windows['@9']).toBeDefined();
  });

  it('hides the reserved persistent/run-1 windows from the tab strip', async () => {
    render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());
    act(() => {
      setActiveSlice({
        windowOrder: ['@0', '@1', '@2'],
        windows: {
          '@0': { windowId: '@0', name: 'persistent', layout: leaf('%0') },
          '@1': { windowId: '@1', name: 'run-1', layout: leaf('%1') },
          '@2': { windowId: '@2', name: 'zsh', layout: leaf('%2') },
        },
        panes: {
          '%0': { paneId: '%0', windowId: '@0' },
          '%1': { paneId: '%1', windowId: '@1' },
          '%2': { paneId: '%2', windowId: '@2' },
        },
      });
    });
    expect(screen.queryByText('persistent')).not.toBeInTheDocument();
    expect(screen.queryByText('run-1')).not.toBeInTheDocument();
    expect(screen.getByText('zsh')).toBeInTheDocument();
  });

  it('does not render a window without a layout as a clickable tab (issue: stray "No panes yet" tab)', async () => {
    render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());
    act(() => {
      setActiveSlice({
        windowOrder: ['@5'],
        windows: { '@5': { windowId: '@5', name: 'mid-creation', layout: null } },
      });
    });
    // No tab for the layout-less window; the empty body is shown instead of a
    // clickable tab that opens "No panes yet".
    expect(screen.queryByText('mid-creation')).not.toBeInTheDocument();
    expect(screen.getByText('No panes yet')).toBeInTheDocument();
  });
});

describe('post-split focus (FR4: new pane gets visual + keyboard focus)', () => {
  const split = (paneA: string, paneB: string): WindowState['layout'] => ({
    type: 'split',
    dir: 'lr',
    w: 80,
    h: 24,
    x: 0,
    y: 0,
    children: [leaf(paneA), leaf(paneB)],
  });

  it('prefers the new split pane id once it appears in the layout, and focuses it', async () => {
    const { Terminal } = await import('@xterm/xterm');
    const focusSpy = vi.spyOn(Terminal.prototype, 'focus');

    const { container } = render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());

    // Start with a single pane laid out.
    act(() => {
      setActiveSlice({
        windowOrder: ['@0'],
        windows: { '@0': { windowId: '@0', name: 'shell', layout: leaf('%0') } },
        activeWindowId: '@0',
        activePaneId: '%0',
        panes: { '%0': { paneId: '%0', windowId: '@0' } },
      });
    });
    await waitFor(() => expect(container.querySelector('.ac-term')).not.toBeNull());
    focusSpy.mockClear();

    // The split reply yields the new pane id deterministically.
    api.tmuxControl.command.mockResolvedValueOnce({ num: 2, error: false, lines: ['%1'] });

    // ⌘D issues split-window -h with -P -F '#{pane_id}'; capture the new pane id.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true }));
      await Promise.resolve();
    });
    expect(api.tmuxControl.command).toHaveBeenCalledWith(
      expect.stringContaining("split-window -h -t %0 -P -F '#{pane_id}'"),
    );

    // Layout-change now reports BOTH panes; the pending id (%1) must win and be
    // focused even though storeActivePaneId still points at the old pane.
    act(() => {
      setActiveSlice({
        windowOrder: ['@0'],
        windows: { '@0': { windowId: '@0', name: 'shell', layout: split('%0', '%1') } },
        activeWindowId: '@0',
        activePaneId: '%0',
        panes: {
          '%0': { paneId: '%0', windowId: '@0' },
          '%1': { paneId: '%1', windowId: '@0' },
        },
      });
    });

    // Visual focus: the new pane's host carries the active ring.
    await waitFor(() => {
      const active = container.querySelector('.ac-term-host.ring-accent');
      expect(active).not.toBeNull();
    });
    // Keyboard focus: the new pane's xterm.focus() was invoked.
    await waitFor(() => expect(focusSpy).toHaveBeenCalled());
    focusSpy.mockRestore();
  });
});

describe('per-project view (no reset on switch)', () => {
  it('preserves a project’s windows when switching away and back', () => {
    const store = useTmuxStore.getState();
    store.applyNotification('proj-a', { type: 'window-add', windowId: '@1' });
    store.applyNotification('proj-b', { type: 'window-add', windowId: '@2' });

    store.setActiveProject('proj-a');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@1']);
    store.setActiveProject('proj-b');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@2']);
    store.setActiveProject('proj-a');
    expect(selectActiveView(useTmuxStore.getState()).windowOrder).toEqual(['@1']);
  });
});

// Wiring test for local_repo_explorer-bvni: proves the refresh toolbar button
// actually issues the per-pane row-nudge command triples for a multi-leaf
// split — not just that the isolated nudgePaneRows function is correct in
// unit tests (covered separately in controlSession.test.ts).
describe('refresh button issues the per-pane row-nudge on a multi-pane split (bvni wiring)', () => {
  const tbSplit = (paneA: string, paneB: string): WindowState['layout'] => ({
    type: 'split',
    dir: 'tb',
    w: 80,
    h: 49,
    x: 0,
    y: 0,
    children: [
      { type: 'leaf', paneId: paneA, w: 80, h: 24, x: 0, y: 0 },
      { type: 'leaf', paneId: paneB, w: 80, h: 24, x: 0, y: 25 },
    ],
  });

  it('a normal-click refresh on a TB split sends the resize-pane/run-shell triple for BOTH panes', async () => {
    const { container } = render(<ControlTerminalPanel />);
    await waitFor(() => expect(api.tmuxControl.open).toHaveBeenCalled());

    act(() => {
      setActiveSlice({
        windowOrder: ['@0'],
        windows: { '@0': { windowId: '@0', name: 'shell', layout: tbSplit('%0', '%1') } },
        activeWindowId: '@0',
        panes: {
          '%0': { paneId: '%0', windowId: '@0' },
          '%1': { paneId: '%1', windowId: '@0' },
        },
      });
    });
    // Both split panes must be mounted (each PaneXterm acquires on mount)
    // before the refresh click, matching real usage.
    await waitFor(() => expect(container.querySelectorAll('.ac-term').length).toBe(2));

    api.tmuxControl.command.mockClear();
    const btn = screen.getByRole('button', { name: /Refresh tab/ });
    fireEvent.click(btn);

    await waitFor(() => {
      const nudgeCmds = api.tmuxControl.command.mock.calls
        .map((c) => c[0] as string)
        .filter((a) => a.startsWith('resize-pane') || a.startsWith('run-shell'));
      expect(nudgeCmds).toEqual([
        'resize-pane -t %0 -y 23',
        'run-shell -d 0.05',
        'resize-pane -t %0 -y 24',
        'resize-pane -t %1 -y 23',
        'run-shell -d 0.05',
        'resize-pane -t %1 -y 24',
      ]);
    });
  });
});
