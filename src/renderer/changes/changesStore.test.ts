// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BranchPoint, Changeset, WorktreeRecord } from '@shared/ipc/channels';

const mockListWorktrees = vi.fn<() => Promise<WorktreeRecord[]>>();
const mockGetChangeset = vi.fn<() => Promise<Changeset>>();
const mockResolveBranchPoint = vi.fn<() => Promise<BranchPoint | null>>();

vi.stubGlobal('window', {
  api: {
    provider: {
      listWorktrees: mockListWorktrees,
      getChangeset: mockGetChangeset,
      resolveBranchPoint: mockResolveBranchPoint,
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
      resolveBranchPoint: (...args: unknown[]) => mockResolveBranchPoint(...args),
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
          target: 'head',
          branchPoint: undefined,
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
          target: 'head',
          branchPoint: undefined,
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

describe('changesStore target / branchPoint (diff-target selector)', () => {
  const BP: BranchPoint = {
    parentRef: 'origin/main',
    parentKind: 'upstream',
    mergeBase: 'deadbeef00000000000000000000000000000000',
  };
  const CS_BP: Changeset = {
    worktree: '/repo-a',
    baseline: BP.mergeBase,
    baselineKind: 'commit',
    files: [{ status: 'added', newPath: 'new.ts', oldPath: null, isBinary: false, isGenerated: false, sizeBytes: null, staged: false }],
    generatedAt: new Date().toISOString(),
  };

  it('default target is head; refresh does not call resolveBranchPoint', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_A);

    await useChangesStore.getState().loadWorktrees('project-a');

    expect(mockResolveBranchPoint).not.toHaveBeenCalled();
    expect(useChangesStore.getState().byProject['project-a']!.target).toBe('head');
  });

  it('switching to branchPoint calls resolveBranchPoint and sets baseline', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_BP);
    mockResolveBranchPoint.mockResolvedValue(BP);

    await useChangesStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.target).toBe('branchPoint');
    expect(slice.branchPoint).toEqual(BP);
    expect(slice.baseline).toBe(BP.mergeBase);
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', BP.mergeBase, 'project-a');
  });

  it('refresh re-resolves the branch-point each time (live tracking)', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_BP);
    mockResolveBranchPoint.mockResolvedValue(BP);

    await useChangesStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');
    // Simulate HEAD advancing: a new merge-base on next resolve.
    const BP2: BranchPoint = { ...BP, mergeBase: 'cafebabe00000000000000000000000000000000' };
    mockResolveBranchPoint.mockResolvedValue(BP2);
    await useChangesStore.getState().refresh('project-a');

    expect(useChangesStore.getState().byProject['project-a']!.branchPoint).toEqual(BP2);
    expect(useChangesStore.getState().byProject['project-a']!.baseline).toBe(BP2.mergeBase);
  });

  it('switching back to head clears baseline and branchPoint', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_A);
    mockResolveBranchPoint.mockResolvedValue(BP);

    await useChangesStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');
    await useChangesStore.getState().setTarget('project-a', 'head');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.target).toBe('head');
    expect(slice.baseline).toBeUndefined();
    // branchPoint undefined means "not in branchPoint mode" (cleared).
    expect(slice.branchPoint).toBeUndefined();
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
  });

  it('branchPoint null (no parent) stays null and falls back to HEAD diff', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_A);
    mockResolveBranchPoint.mockResolvedValue(null);

    await useChangesStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.branchPoint).toBeNull();
    // baseline is undefined when mergeBase is not available -> falls back to HEAD diff.
    expect(slice.baseline).toBeUndefined();
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
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
          target: 'head',
          branchPoint: undefined,
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
