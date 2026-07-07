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

import { useChangesStore, type ChangesSlice } from './changesStore';
import { useWorktreeStore } from '@renderer/worktree/worktreeStore';

const WT_A: WorktreeRecord[] = [
  { path: '/repo-a', branch: 'main', head: 'abc', locked: false, prunable: false, detached: false },
];

const CS_A: Changeset = {
  worktree: '/repo-a',
  baseline: 'HEAD',
  baselineKind: 'HEAD',
  files: [],
  generatedAt: new Date().toISOString(),
};

/** Build a full Changes slice from partial overrides. */
function changesSlice(over: Partial<ChangesSlice> = {}): ChangesSlice {
  return {
    baseline: undefined,
    changeset: null,
    loading: false,
    selectedPath: null,
    target: 'head',
    branchPoint: undefined,
    ...over,
  };
}

/** Seed the worktree store so `changesStore.refresh` sees a selection. */
function seedWorktree(projectId: string, worktrees: WorktreeRecord[], active: string | null): void {
  useWorktreeStore.setState((s) => ({
    byProject: { ...s.byProject, [projectId]: { worktrees, activeWorktree: active, loading: false } },
  }));
}

function resetStores(): void {
  useChangesStore.setState({ byProject: {} });
  useWorktreeStore.setState({ byProject: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();
  _activeId = 'project-a';
});

describe('changesStore refresh reads the worktree from worktreeStore (T2)', () => {
  it('loads the changeset for the worktree selected in worktreeStore', async () => {
    mockListWorktrees.mockResolvedValue(WT_A);
    mockGetChangeset.mockResolvedValue(CS_A);

    await useWorktreeStore.getState().loadWorktrees('project-a');
    await useChangesStore.getState().refresh('project-a');

    expect(useWorktreeStore.getState().byProject['project-a']!.activeWorktree).toBe('/repo-a');
    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.changeset).toEqual(CS_A);
    expect(slice.loading).toBe(false);
    // Reads are addressed by projectId.
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
  });

  it('is a no-op changeset when no worktree is selected', async () => {
    seedWorktree('project-a', [], null);
    await useChangesStore.getState().refresh('project-a');

    expect(mockGetChangeset).not.toHaveBeenCalled();
    expect(useChangesStore.getState().byProject['project-a']!.changeset).toBeNull();
  });

  it('isolates changeset slices per project (no cross-project bleed)', async () => {
    const CS_B: Changeset = { ...CS_A, worktree: '/repo-b' };
    seedWorktree('project-a', WT_A, '/repo-a');
    seedWorktree('project-b', WT_A, '/repo-b');
    mockGetChangeset.mockResolvedValueOnce(CS_A).mockResolvedValueOnce(CS_B);

    await useChangesStore.getState().refresh('project-a');
    await useChangesStore.getState().refresh('project-b');

    expect(useChangesStore.getState().byProject['project-a']!.changeset).toEqual(CS_A);
    expect(useChangesStore.getState().byProject['project-b']!.changeset).toEqual(CS_B);
  });

  it('drops a changeset selection when the worktree changed (picker switch)', async () => {
    // Slice holds repo-a's changeset + selection; worktreeStore now points at repo-b.
    useChangesStore.setState({
      byProject: { 'project-a': changesSlice({ changeset: CS_A, selectedPath: 'foo.ts' }) },
    });
    seedWorktree('project-a', WT_A, '/repo-b');
    const CS_B: Changeset = { ...CS_A, worktree: '/repo-b' };
    mockGetChangeset.mockResolvedValue(CS_B);

    await useChangesStore.getState().refresh('project-a');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.changeset).toEqual(CS_B);
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-b', undefined, 'project-a');
  });

  it('keeps last-good changeset on a transient refresh error', async () => {
    useChangesStore.setState({ byProject: { 'project-a': changesSlice({ changeset: CS_A }) } });
    seedWorktree('project-a', WT_A, '/repo-a');
    mockGetChangeset.mockRejectedValue(new Error('transient'));

    await useChangesStore.getState().refresh('project-a');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.changeset).toEqual(CS_A); // last-good retained
    expect(slice.loading).toBe(false);
  });

  it('drops a stale refresh when the slice was evicted mid-load', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    let resolveCS!: (v: Changeset) => void;
    mockGetChangeset.mockReturnValue(new Promise<Changeset>((r) => { resolveCS = r; }));

    const p = useChangesStore.getState().refresh('project-a');
    useChangesStore.getState().evict('project-a');
    resolveCS(CS_A);
    await p;

    expect(useChangesStore.getState().byProject['project-a']).toBeUndefined();
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

  async function selectWorktree(): Promise<void> {
    mockListWorktrees.mockResolvedValue(WT_A);
    await useWorktreeStore.getState().loadWorktrees('project-a');
  }

  it('default target is head; refresh does not call resolveBranchPoint', async () => {
    mockGetChangeset.mockResolvedValue(CS_A);
    await selectWorktree();
    await useChangesStore.getState().refresh('project-a');

    expect(mockResolveBranchPoint).not.toHaveBeenCalled();
    expect(useChangesStore.getState().byProject['project-a']!.target).toBe('head');
  });

  it('switching to branchPoint calls resolveBranchPoint and sets baseline', async () => {
    mockGetChangeset.mockResolvedValue(CS_BP);
    mockResolveBranchPoint.mockResolvedValue(BP);
    await selectWorktree();
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.target).toBe('branchPoint');
    expect(slice.branchPoint).toEqual(BP);
    expect(slice.baseline).toBe(BP.mergeBase);
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', BP.mergeBase, 'project-a');
  });

  it('refresh re-resolves the branch-point each time (live tracking)', async () => {
    mockGetChangeset.mockResolvedValue(CS_BP);
    mockResolveBranchPoint.mockResolvedValue(BP);
    await selectWorktree();
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');
    // Simulate HEAD advancing: a new merge-base on next resolve.
    const BP2: BranchPoint = { ...BP, mergeBase: 'cafebabe00000000000000000000000000000000' };
    mockResolveBranchPoint.mockResolvedValue(BP2);
    await useChangesStore.getState().refresh('project-a');

    expect(useChangesStore.getState().byProject['project-a']!.branchPoint).toEqual(BP2);
    expect(useChangesStore.getState().byProject['project-a']!.baseline).toBe(BP2.mergeBase);
  });

  it('switching back to head clears baseline and branchPoint', async () => {
    mockGetChangeset.mockResolvedValue(CS_A);
    mockResolveBranchPoint.mockResolvedValue(BP);
    await selectWorktree();
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');
    await useChangesStore.getState().setTarget('project-a', 'head');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.target).toBe('head');
    expect(slice.baseline).toBeUndefined();
    expect(slice.branchPoint).toBeUndefined();
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
  });

  it('branchPoint null (no parent) stays null and falls back to HEAD diff', async () => {
    mockGetChangeset.mockResolvedValue(CS_A);
    mockResolveBranchPoint.mockResolvedValue(null);
    await selectWorktree();
    await useChangesStore.getState().setTarget('project-a', 'branchPoint');

    const slice = useChangesStore.getState().byProject['project-a']!;
    expect(slice.branchPoint).toBeNull();
    expect(slice.baseline).toBeUndefined();
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
  });
});

describe('changesStore clearForDisconnect / evict (D3/FR4/FR7)', () => {
  function seed(): void {
    useChangesStore.setState({
      byProject: {
        'project-a': changesSlice({ changeset: CS_A, selectedPath: '/repo-a/foo.ts' }),
      },
    });
  }

  it('clearForDisconnect() resets the slice to empty but keeps the key', () => {
    seed();
    useChangesStore.getState().clearForDisconnect('project-a');
    const slice = useChangesStore.getState().byProject['project-a']!;
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
