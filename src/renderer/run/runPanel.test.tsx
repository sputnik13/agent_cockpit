// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const _api = vi.hoisted(() => {
  const tmuxControl = {
    open: vi.fn().mockResolvedValue('agent-cockpit-test'),
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

import { RunPanel } from './RunPanel';
import { useTmuxStore, emptyView, type WindowState } from '../tmux/tmuxStore';
import { resetControlSession } from '../tmux/controlSession';
import * as paneRegistry from '../tmux/controlPaneRegistry';
import { useProjectsStore } from '../providerClient';
import { useSettingsStore } from '../settings';

const ACTIVE = 'proj-run';
const leaf = (paneId: string): WindowState['layout'] => ({ type: 'leaf', paneId, w: 80, h: 24, x: 0, y: 0 });

/** Replace the active project's view slice (the panel renders the active slice). */
function setActiveSlice(partial: Partial<ReturnType<typeof emptyView>>): void {
  useTmuxStore.setState((st) => ({
    activeProjectId: ACTIVE,
    byProject: { ...st.byProject, [ACTIVE]: { ...emptyView(), isOpen: true, ...partial } },
  }));
}

beforeEach(() => {
  resetControlSession();
  useTmuxStore.getState().reset();
  useTmuxStore.getState().setActiveProject(ACTIVE);
  useProjectsStore.setState({ activeId: ACTIVE });
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, terminalBackend: 'control-mode' } }));
});
afterEach(() => {
  cleanup();
  paneRegistry.disposeAll();
  paneRegistry.stopReaper();
});

describe('RunPanel control-mode binding', () => {
  it('binds the run pane when a window literally named run-1 has a layout', async () => {
    const { container } = render(<RunPanel />);
    act(() => {
      setActiveSlice({
        windowOrder: ['@1'],
        windows: { '@1': { windowId: '@1', name: 'run-1', layout: leaf('%7') } },
        panes: { '%7': { paneId: '%7', windowId: '@1' } },
      });
    });
    // Bound to the run-1 survivor's pane → the pane host (xterm) is mounted,
    // not the "Starting run window…" placeholder.
    expect(screen.queryByText('Starting run window…')).not.toBeInTheDocument();
    expect(container.querySelector('.ac-term')).not.toBeNull();
  });

  it('does NOT bind to a survivor named run-2 (reconcile must rename it to run-1)', () => {
    render(<RunPanel />);
    act(() => {
      setActiveSlice({
        windowOrder: ['@1'],
        // A run survivor that was NOT renamed to run-1 leaves Run dead.
        windows: { '@1': { windowId: '@1', name: 'run-2', layout: leaf('%7') } },
        panes: { '%7': { paneId: '%7', windowId: '@1' } },
      });
    });
    expect(screen.getByText('Starting run window…')).toBeInTheDocument();
  });
});
