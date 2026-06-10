// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Changeset, WorktreeRecord } from '@shared/ipc/channels';

const mockListWorktrees = vi.fn<() => Promise<WorktreeRecord[]>>();
const mockGetChangeset = vi.fn<() => Promise<Changeset>>();

vi.stubGlobal('window', {
  api: {
    provider: {
      listWorktrees: mockListWorktrees,
      getChangeset: mockGetChangeset,
    },
    events: {
      onWatch: vi.fn(() => () => {}),
    },
  },
});

let _activeId: string | null = 'project-a';

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: {
    provider: {
      listWorktrees: (...args: unknown[]) => mockListWorktrees(...args),
      getChangeset: (...args: unknown[]) => mockGetChangeset(...args),
    },
    events: {
      onWatch: vi.fn(() => () => {}),
    },
  },
  useProjectsStore: Object.assign(
    (selector: (s: { activeId: string | null }) => unknown) => selector({ activeId: _activeId }),
    {
      getState: () => ({ activeId: _activeId }),
    },
  ),
}));

import { useChangesStore } from './changesStore';

const WT_A: WorktreeRecord[] = [
  { path: '/repo-a', branch: 'main', head: 'abc', locked: false, prunable: false, detached: false },
];
const WT_B: WorktreeRecord[] = [
  { path: '/repo-b', branch: 'feat', head: 'def', locked: false, prunable: false, detached: false },
];

const CS_A: Changeset = {
  worktree: '/repo-a',
  baseline: 'HEAD',
  baselineKind: 'HEAD',
  files: [],
  generatedAt: new Date().toISOString(),
};

function resetStore(): void {
  useChangesStore.setState({ byProject: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  _activeId = 'project-a';
});

describe('changesStore byProject slices (T4)', () => {
  it('loads worktrees + changeset into the addressed project slice', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_A);

    await useChangesStore.getState().loadWorktrees('project-a');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toEqual(WT_A);
    expect(slice.changeset).toEqual(CS_A);
    expect(slice.loading).toBe(false);
    // Reads are addressed by projectId.
    expect(mockListWorktrees).toHaveBeenCalledWith('project-a');
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
  });

  it('isolates slices per project (no cross-project bleed)', async () => {
    mockListWorktrees.mockResolvedValueOnce(WT_A).mockResolvedValueOnce(WT_B);
    mockGetChangeset.mockResolvedValue(CS_A);

    await useChangesStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().loadWorktrees('project-b');

    expect(useChangesStore.getState().byProject['project-a']!.worktrees).toEqual(WT_A);
    expect(useChangesStore.getState().byProject['project-b']!.worktrees).toEqual(WT_B);
  });

  it('drops a stale resolution when the slice was evicted mid-load', async () => {
    let resolveWT!: (v: WorktreeRecord[]) => void;
    mockListWorktrees.mockReturnValue(new Promise<WorktreeRecord[]>((r) => { resolveWT = r; }));

    const loadPromise = useChangesStore.getState().loadWorktrees('project-a');
    // Evict the slice before the worktrees resolve.
    useChangesStore.getState().evict('project-a');
    resolveWT(WT_A);
    await loadPromise;

    // The stale result must not recreate the slice.
    expect(useChangesStore.getState().byProject['project-a']).toBeUndefined();
  });

  it('clears to empty (not stale data) on load error', async () => {
    useChangesStore.setState({
      byProject: {
        'project-a': {
          worktrees: WT_A,
          activeWorktree: '/repo-a',
          baseline: undefined,
          changeset: CS_A,
          loading: false,
          selectedPath: null,
        },
      },
    });
    mockListWorktrees.mockRejectedValue(new Error('SSH disconnected'));

    await useChangesStore.getState().loadWorktrees('project-a');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toEqual([]);
    expect(slice.changeset).toBeNull();
    expect(slice.loading).toBe(false);
  });

  it('refresh() addresses the project and keeps last-good changeset on transient error', async () => {
    useChangesStore.setState({
      byProject: {
        'project-a': {
          worktrees: WT_A,
          activeWorktree: '/repo-a',
          baseline: undefined,
          changeset: CS_A,
          loading: false,
          selectedPath: null,
        },
      },
    });
    mockGetChangeset.mockRejectedValue(new Error('transient'));

    await useChangesStore.getState().refresh('project-a');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.changeset).toEqual(CS_A); // last-good retained
    expect(slice.loading).toBe(false);
  });
});

describe('changesStore clearForDisconnect / evict (D3/FR4/FR7)', () => {
  function seed(): void {
    useChangesStore.setState({
      byProject: {
        'project-a': {
          worktrees: WT_A,
          activeWorktree: '/repo-a',
          baseline: undefined,
          changeset: CS_A,
          loading: false,
          selectedPath: '/repo-a/foo.ts',
        },
      },
    });
  }

  it('clearForDisconnect() resets the slice to empty but keeps the key', () => {
    seed();
    useChangesStore.getState().clearForDisconnect('project-a');
    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.worktrees).toEqual([]);
    expect(slice.activeWorktree).toBeNull();
    expect(slice.changeset).toBeNull();
    expect(slice.selectedPath).toBeNull();
    expect(slice.loading).toBe(false);
  });

  it('evict() deletes the slice key entirely', () => {
    seed();
    useChangesStore.getState().evict('project-a');
    expect(useChangesStore.getState().byProject['project-a']).toBeUndefined();
  });
});
