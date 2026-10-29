// @vitest-environment jsdom
/**
 * AppShell owns the `evt:callback-open` subscription's lifetime: one subscription
 * while the shell is mounted, released when it unmounts (a leaked listener would
 * keep opening tabs from a torn-down renderer, and a second mount must not
 * double-handle each open).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render } from '@testing-library/react';

// Everything AppShell wires besides the callback-open sync is out of scope here.
vi.mock('../providerClient', async (importActual) => ({
  ...(await importActual<typeof import('../providerClient')>()),
  initProjectsSync: () => () => undefined,
  initSessionSync: () => () => undefined,
}));
vi.mock('../settings', () => ({
  initSettingsSync: () => () => undefined,
  useSettingsStore: { getState: () => ({ setOpen: () => undefined }) },
  SettingsDialog: () => null,
}));
vi.mock('../workspace/panelDataSync', () => ({ initPanelDataSync: () => () => undefined }));
vi.mock('./ProjectTabs', () => ({ ProjectTabs: () => null }));
vi.mock('./StatusRegion', () => ({ StatusRegion: () => null }));

import { useContentSelection } from '../content/selectionStore';
import { useProjectsStore } from '../providerClient';
import { installFakeLocalStorage, removeFakeLocalStorage } from '../testing/dockviewHarness';
import { AppShell } from './AppShell';

let handlers: Array<(e: unknown) => void>;
let unsubscribe: Mock<() => void>;

beforeEach(() => {
  installFakeLocalStorage();
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ activeId: 'p1', projects: [] });
  handlers = [];
  unsubscribe = vi.fn<() => void>();
  (window as unknown as { api: unknown }).api = {
    events: {
      onCallbackOpen: (h: (e: unknown) => void) => {
        handlers.push(h);
        return () => {
          handlers = handlers.filter((x) => x !== h);
          unsubscribe();
        };
      },
    },
  };
});

afterEach(() => {
  cleanup();
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ activeId: null, projects: [] });
  delete (window as unknown as { api?: unknown }).api;
  removeFakeLocalStorage();
});

describe('AppShell and evt:callback-open', () => {
  it('subscribes once on mount and routes an open into the Content store', () => {
    render(<AppShell>{null}</AppShell>);
    expect(handlers).toHaveLength(1);
    handlers[0]!({
      projectId: 'p1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo' },
    });
    expect(useContentSelection.getState().slices['p1']?.tabs.map((t) => t.id)).toEqual([
      '/repo/src/a.ts',
    ]);
  });

  it('releases the subscription on unmount, and a remount subscribes exactly once more', () => {
    const first = render(<AppShell>{null}</AppShell>);
    expect(unsubscribe).not.toHaveBeenCalled();
    first.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(handlers).toHaveLength(0);

    render(<AppShell>{null}</AppShell>);
    expect(handlers).toHaveLength(1);
  });
});
