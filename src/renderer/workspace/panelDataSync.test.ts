// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectionStatus } from '@shared/providers/types';

/**
 * Regression coverage for local_repo_explorer-j4p3: a BACKGROUNDED project's
 * control-mode terminal session must be torn down the moment ITS OWN
 * connection status goes disconnected/failed, not deferred until it's next
 * activated. The prior mechanism (a `ControlTerminalPanel` effect gated on
 * `activeId`) could never observe that transition for a project that wasn't
 * active at the time, because `projectsStore.activate()` only updates
 * `activeId` after the reconnect already fully succeeded.
 */

interface FakeStore<T> {
  (selector: (s: T) => unknown): unknown;
  getState: () => T;
  setState: (partial: Partial<T>) => void;
  subscribe: (listener: (s: T) => void) => () => void;
}

function makeStore<T extends object>(initial: T): FakeStore<T> {
  let state = initial;
  const listeners = new Set<(s: T) => void>();
  const store = ((selector: (s: T) => unknown) => selector(state)) as FakeStore<T>;
  store.getState = () => state;
  store.setState = (partial) => {
    state = { ...state, ...partial };
    for (const l of listeners) l(state);
  };
  store.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return store;
}

const {
  sessionStore,
  projectsStore,
  mockWorktreeClear,
  mockWorktreeEvict,
  mockLoadWorktrees,
  mockChangesClear,
  mockChangesEvict,
  mockBeadsClear,
  mockBeadsEvict,
  mockTeardown,
} = vi.hoisted(() => ({
  sessionStore: makeStore<{ statuses: Record<string, ConnectionStatus> }>({ statuses: {} }),
  projectsStore: makeStore<{ projects: { id: string }[] }>({
    projects: [{ id: 'active-project' }, { id: 'bg-project' }],
  }),
  mockWorktreeClear: vi.fn(),
  mockWorktreeEvict: vi.fn(),
  mockLoadWorktrees: vi.fn().mockResolvedValue(undefined),
  mockChangesClear: vi.fn(),
  mockChangesEvict: vi.fn(),
  mockBeadsClear: vi.fn(),
  mockBeadsEvict: vi.fn(),
  mockTeardown: vi.fn(),
}));

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: { watch: { setActiveWorktree: vi.fn() } },
  useSessionStore: sessionStore,
  useProjectsStore: projectsStore,
}));

vi.mock('@renderer/worktree/worktreeStore', () => ({
  useWorktreeStore: {
    getState: () => ({
      byProject: {},
      clearForDisconnect: mockWorktreeClear,
      evict: mockWorktreeEvict,
      loadWorktrees: mockLoadWorktrees,
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('@renderer/changes', () => ({
  useChangesStore: {
    getState: () => ({
      clearForDisconnect: mockChangesClear,
      evict: mockChangesEvict,
      refresh: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('@renderer/beads', () => ({
  useBeadsStore: {
    getState: () => ({
      clearForDisconnect: mockBeadsClear,
      evict: mockBeadsEvict,
      load: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('@renderer/watch/hub', () => ({ subscribeWatch: vi.fn(() => () => {}) }));

vi.mock('@renderer/tmux/controlSession', () => ({ teardownControlSession: mockTeardown }));

import { initPanelDataSync } from './panelDataSync';

function status(state: ConnectionStatus['state']): ConnectionStatus {
  return { state, since: new Date(0).toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStore.setState({ statuses: {} });
  projectsStore.setState({ projects: [{ id: 'active-project' }, { id: 'bg-project' }] });
});

describe('panelDataSync: control-session teardown on disconnect', () => {
  it("tears down a backgrounded project's control session on its OWN disconnect, independent of which project is active", () => {
    const off = initPanelDataSync();
    try {
      sessionStore.setState({ statuses: { 'bg-project': status('connected') } });
      expect(mockTeardown).not.toHaveBeenCalled();

      sessionStore.setState({ statuses: { 'bg-project': status('disconnected') } });
      expect(mockTeardown).toHaveBeenCalledWith('bg-project');
      expect(mockTeardown).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('also tears down on a failed transition', () => {
    const off = initPanelDataSync();
    try {
      sessionStore.setState({ statuses: { p: status('connected') } });
      sessionStore.setState({ statuses: { p: status('failed') } });
      expect(mockTeardown).toHaveBeenCalledWith('p');
    } finally {
      off();
    }
  });

  it('does not tear down on a connect transition, and clears the other panel stores too', () => {
    const off = initPanelDataSync();
    try {
      sessionStore.setState({ statuses: { p: status('connected') } });
      expect(mockTeardown).not.toHaveBeenCalled();
      expect(mockLoadWorktrees).toHaveBeenCalledWith('p');

      sessionStore.setState({ statuses: { p: status('disconnected') } });
      expect(mockWorktreeClear).toHaveBeenCalledWith('p');
      expect(mockChangesClear).toHaveBeenCalledWith('p');
      expect(mockBeadsClear).toHaveBeenCalledWith('p');
      expect(mockTeardown).toHaveBeenCalledWith('p');
    } finally {
      off();
    }
  });
});
