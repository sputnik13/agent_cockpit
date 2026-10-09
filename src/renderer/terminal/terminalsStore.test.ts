import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  list: vi.fn<(projectId?: string) => Promise<string[]>>(),
  close: vi.fn<(key: string, kill?: boolean, projectId?: string) => Promise<void>>(),
}));
let activeProjectId: string | null = 'project-a';

vi.mock('../providerClient', () => ({
  agentCockpit: {
    terminal: {
      list: bridge.list,
      close: bridge.close,
    },
  },
  useProjectsStore: {
    getState: () => ({ activeId: activeProjectId }),
  },
}));

import { useTerminalsStore } from './terminalsStore';

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  activeProjectId = 'project-a';
  bridge.list.mockReset();
  bridge.close.mockReset().mockResolvedValue(undefined);
  useTerminalsStore.setState({ projectId: 'project-a', keys: [], activeKey: null });
});

describe('useTerminalsStore project boundaries', () => {
  it('ignores a stale project list after the active project changes', async () => {
    const a = deferred<string[]>();
    const b = deferred<string[]>();
    bridge.list.mockImplementation((projectId) =>
      projectId === 'project-a' ? a.promise : b.promise,
    );

    const pendingA = useTerminalsStore.getState().init();
    activeProjectId = 'project-b';
    const pendingB = useTerminalsStore.getState().init();
    b.resolve(['b1']);
    await pendingB;
    a.resolve(['a1']);
    await pendingA;

    expect(useTerminalsStore.getState()).toMatchObject({ keys: ['b1'], activeKey: 'b1' });
  });

  it('does not synthesize a retired t1 when mux topology has no panes', async () => {
    bridge.list.mockResolvedValue([]);

    await useTerminalsStore.getState().init(false);

    expect(useTerminalsStore.getState()).toMatchObject({ keys: [], activeKey: null });
  });

  it('clears another project’s keys when the newly active project has no terminal inventory', async () => {
    useTerminalsStore.setState({ projectId: 'project-a', keys: ['a1'], activeKey: 'a1' });
    activeProjectId = 'project-b';
    bridge.list.mockResolvedValue([]);

    await useTerminalsStore.getState().init(false);

    expect(useTerminalsStore.getState()).toMatchObject({ projectId: 'project-b', keys: [], activeKey: null });
  });

  it('does not remove a current-project same-key tab when an older close completes', async () => {
    const closeA = deferred<void>();
    bridge.close.mockReturnValue(closeA.promise);
    useTerminalsStore.setState({ keys: ['same-key'], activeKey: 'same-key' });

    const pendingClose = useTerminalsStore.getState().close('same-key');
    activeProjectId = 'project-b';
    useTerminalsStore.setState({ keys: ['same-key'], activeKey: 'same-key' });
    closeA.resolve();
    await pendingClose;

    expect(useTerminalsStore.getState()).toMatchObject({
      keys: ['same-key'],
      activeKey: 'same-key',
    });
    expect(bridge.close).toHaveBeenCalledWith('same-key', true, 'project-a');
  });

  it('retains the tab when daemon destruction is rejected', async () => {
    bridge.close.mockRejectedValue(new Error('daemon rejected close'));
    useTerminalsStore.setState({ keys: ['live'], activeKey: 'live' });

    await expect(useTerminalsStore.getState().close('live')).rejects.toThrow('daemon rejected close');

    expect(useTerminalsStore.getState()).toMatchObject({ keys: ['live'], activeKey: 'live' });
  });
});
