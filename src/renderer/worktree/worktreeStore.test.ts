// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';

const mockListWorktrees = vi.fn<() => Promise<WorktreeRecord[]>>();

vi.stubGlobal('window', {
  api: { provider: { listWorktrees: mockListWorktrees }, events: { onWatch: vi.fn(() => () => {}) } },
});

let _activeId: string | null = 'project-a';

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: {
    provider: { listWorktrees: (...args: unknown[]) => mockListWorktrees(...args) },
    events: { onWatch: vi.fn(() => () => {}) },
  },
  useProjectsStore: Object.assign(
    (selector: (s: { activeId: string | null }) => unknown) => selector({ activeId: _activeId }),
    { getState: () => ({ activeId: _activeId }) },
  ),
}));

import { useWorktreeStore } from './worktreeStore';

function wt(path: string, over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return { path, branch: 'main', head: 'abc', locked: false, prunable: false, detached: false, ...over };
}

const WT_A = [wt('/repo-a')];

function resetStore(): void {
  useWorktreeStore.setState({ byProject: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  _activeId = 'project-a';
});

describe('worktreeStore.loadWorktrees selection resolution (T2)', () => {
  it('defaults the active worktree to the first when none is selected', async () => {
    mockListWorktrees.mockResolvedValue([wt('/repo/A'), wt('/repo/B')]);

    await useWorktreeStore.getState().loadWorktrees('project-a');

    const slice = useWorktreeStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toHaveLength(2);
    expect(slice.activeWorktree).toBe('/repo/A');
    expect(slice.loading).toBe(false);
    expect(mockListWorktrees).toHaveBeenCalledWith('project-a');
  });

  it('keeps a still-valid selection across a reload', async () => {
    mockListWorktrees.mockResolvedValue([wt('/repo/A'), wt('/repo/B')]);
    await useWorktreeStore.getState().loadWorktrees('project-a');
    useWorktreeStore.getState().setWorktree('project-a', '/repo/B');

    await useWorktreeStore.getState().loadWorktrees('project-a');

    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBe('/repo/B');
  });

  it('falls back to the new first worktree when the selection disappears', async () => {
    mockListWorktrees
      .mockResolvedValueOnce([wt('/repo/A')])
      .mockResolvedValueOnce([wt('/repo/B')]); // A no longer present
    await useWorktreeStore.getState().loadWorktrees('project-a');
    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBe('/repo/A');

    await useWorktreeStore.getState().loadWorktrees('project-a');
    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBe('/repo/B');
  });

  it('resolves to null when there are no worktrees', async () => {
    mockListWorktrees.mockResolvedValue([]);
    await useWorktreeStore.getState().loadWorktrees('project-a');
    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBeNull();
  });

  it('isolates slices per project (no cross-project bleed)', async () => {
    mockListWorktrees.mockResolvedValueOnce([wt('/repo-a')]).mockResolvedValueOnce([wt('/repo-b')]);
    await useWorktreeStore.getState().loadWorktrees('project-a');
    await useWorktreeStore.getState().loadWorktrees('project-b');

    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBe('/repo-a');
    expect(useWorktreeStore.getState().byProject['project-b']!.activeWorktree).toBe('/repo-b');
  });

  it('drops a stale resolution when the slice was evicted mid-load', async () => {
    let resolveWT!: (v: WorktreeRecord[]) => void;
    mockListWorktrees.mockReturnValue(new Promise<WorktreeRecord[]>((r) => { resolveWT = r; }));

    const loadPromise = useWorktreeStore.getState().loadWorktrees('project-a');
    useWorktreeStore.getState().evict('project-a');
    resolveWT(WT_A);
    await loadPromise;

    expect(useWorktreeStore.getState().byProject['project-a']).toBeUndefined();
  });

  it('clears to empty (not stale data) on a load error', async () => {
    useWorktreeStore.setState({
      byProject: { 'project-a': { worktrees: WT_A, activeWorktree: '/repo-a', loading: false } },
    });
    mockListWorktrees.mockRejectedValue(new Error('SSH disconnected'));

    await useWorktreeStore.getState().loadWorktrees('project-a');

    const slice = useWorktreeStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toEqual([]);
    expect(slice.activeWorktree).toBeNull();
    expect(slice.loading).toBe(false);
  });
});

describe('worktreeStore setWorktree / clearForDisconnect / evict', () => {
  function seed(): void {
    useWorktreeStore.setState({
      byProject: { 'project-a': { worktrees: WT_A, activeWorktree: '/repo-a', loading: false } },
    });
  }

  it('setWorktree updates only the active worktree', () => {
    useWorktreeStore.setState({
      byProject: { 'project-a': { worktrees: [wt('/repo/A'), wt('/repo/B')], activeWorktree: '/repo/A', loading: false } },
    });
    useWorktreeStore.getState().setWorktree('project-a', '/repo/B');
    const slice = useWorktreeStore.getState().byProject['project-a']!;
    expect(slice.activeWorktree).toBe('/repo/B');
    expect(slice.worktrees).toHaveLength(2);
  });

  it('clearForDisconnect resets the slice to empty but keeps the key', () => {
    seed();
    useWorktreeStore.getState().clearForDisconnect('project-a');
    const slice = useWorktreeStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toEqual([]);
    expect(slice.activeWorktree).toBeNull();
    expect(slice.loading).toBe(false);
  });

  it('evict deletes the slice key entirely', () => {
    seed();
    useWorktreeStore.getState().evict('project-a');
    expect(useWorktreeStore.getState().byProject['project-a']).toBeUndefined();
  });
});
