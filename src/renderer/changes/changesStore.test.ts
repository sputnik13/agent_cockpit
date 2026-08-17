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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    await Promise.resolve();
  }
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

describe('changesStore refresh coordination', () => {
  it('coalesces a burst into one active read and one trailing latest read', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    let active = 0;
    let maxActive = 0;
    const track = (request: Promise<Changeset>): Promise<Changeset> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return request.finally(() => {
        active -= 1;
      });
    };
    mockGetChangeset
      .mockImplementationOnce(() => track(first.promise))
      .mockImplementationOnce(() => track(trailing.promise));

    const initial = useChangesStore.getState().refresh('project-a');
    const queued = [
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
      useChangesStore.getState().refresh('project-a'),
    ];
    let queuedSettled = false;
    void queued[0]!.then(() => {
      queuedSettled = true;
    });

    expect(mockGetChangeset).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);

    first.resolve(CS_A);
    await flushAsyncWork();

    expect(mockGetChangeset).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(queuedSettled).toBe(false);
    expect(useChangesStore.getState().byProject['project-a']!.loading).toBe(true);

    trailing.resolve({ ...CS_A, generatedAt: 'trailing' });
    await Promise.all([initial, ...queued]);

    expect(mockGetChangeset).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      changeset: { generatedAt: 'trailing' },
      loading: false,
    });
  });

  it('starts a new drain from a synchronous final loading update', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);

    let subscriberRefresh: Promise<void> | undefined;
    let requestedFromFinalLoadingUpdate = false;
    const unsubscribe = useChangesStore.subscribe((state, previous) => {
      const currentSlice = state.byProject['project-a'];
      const previousSlice = previous.byProject['project-a'];
      if (
        !requestedFromFinalLoadingUpdate &&
        previousSlice?.loading === true &&
        currentSlice?.loading === false
      ) {
        requestedFromFinalLoadingUpdate = true;
        subscriberRefresh = state.refresh('project-a');
      }
    });

    try {
      const initial = useChangesStore.getState().refresh('project-a');
      let initialSettled = false;
      void initial.then(() => {
        initialSettled = true;
      });

      first.resolve(CS_A);
      await flushAsyncWork();

      expect(requestedFromFinalLoadingUpdate).toBe(true);
      expect(subscriberRefresh).toBeDefined();
      expect(mockGetChangeset).toHaveBeenCalledTimes(2);
      expect(subscriberRefresh).not.toBe(initial);
      expect(initialSettled).toBe(true);
      expect(useChangesStore.getState().byProject['project-a']!.loading).toBe(true);

      trailing.resolve({ ...CS_A, generatedAt: 'subscriber-trailing' });
      await Promise.all([initial, subscriberRefresh]);

      expect(initialSettled).toBe(true);
      expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
        changeset: { generatedAt: 'subscriber-trailing' },
        loading: false,
      });
    } finally {
      unsubscribe();
    }
  });

  it('starts a fresh drain when final loading=false queues a microtask refresh', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);

    let subscriberRefresh: Promise<void> | undefined;
    let queuedFromFinalLoadingUpdate = false;
    const unsubscribe = useChangesStore.subscribe((state, previous) => {
      const currentSlice = state.byProject['project-a'];
      const previousSlice = previous.byProject['project-a'];
      if (
        !queuedFromFinalLoadingUpdate &&
        previousSlice?.loading === true &&
        currentSlice?.loading === false
      ) {
        queuedFromFinalLoadingUpdate = true;
        queueMicrotask(() => {
          subscriberRefresh = state.refresh('project-a');
        });
      }
    });

    try {
      const initial = useChangesStore.getState().refresh('project-a');
      let initialSettled = false;
      void initial.then(() => {
        initialSettled = true;
      });

      first.resolve(CS_A);
      await flushAsyncWork();

      expect(queuedFromFinalLoadingUpdate).toBe(true);
      expect(subscriberRefresh).toBeDefined();
      expect(subscriberRefresh).not.toBe(initial);
      expect(initialSettled).toBe(true);
      expect(mockGetChangeset).toHaveBeenCalledTimes(2);
      expect(useChangesStore.getState().byProject['project-a']!.loading).toBe(true);

      trailing.resolve({ ...CS_A, generatedAt: 'microtask-trailing' });
      await Promise.all([initial, subscriberRefresh]);

      expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
        changeset: { generatedAt: 'microtask-trailing' },
        loading: false,
      });
    } finally {
      unsubscribe();
    }
  });

  it('runs different project refreshes independently', async () => {
    const CS_B: Changeset = { ...CS_A, worktree: '/repo-b' };
    seedWorktree('project-a', WT_A, '/repo-a');
    seedWorktree('project-b', WT_A, '/repo-b');
    const a = deferred<Changeset>();
    const b = deferred<Changeset>();
    let active = 0;
    let maxActive = 0;
    const track = (request: Promise<Changeset>): Promise<Changeset> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return request.finally(() => {
        active -= 1;
      });
    };
    mockGetChangeset
      .mockImplementationOnce(() => track(a.promise))
      .mockImplementationOnce(() => track(b.promise));

    const refreshA = useChangesStore.getState().refresh('project-a');
    const refreshB = useChangesStore.getState().refresh('project-b');

    expect(mockGetChangeset).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
    a.resolve(CS_A);
    b.resolve(CS_B);
    await Promise.all([refreshA, refreshB]);

    expect(useChangesStore.getState().byProject['project-a']!.changeset).toEqual(CS_A);
    expect(useChangesStore.getState().byProject['project-b']!.changeset).toEqual(CS_B);
  });

  it('drops a stale target completion and runs the trailing request with the latest target', async () => {
    const BP: BranchPoint = {
      parentRef: 'origin/main',
      parentKind: 'upstream',
      mergeBase: 'latest-base',
    };
    const CS_BP: Changeset = {
      ...CS_A,
      baseline: BP.mergeBase,
      baselineKind: 'commit',
      generatedAt: 'branch-point',
    };
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const branchPoint = deferred<BranchPoint | null>();
    const trailing = deferred<Changeset>();
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);
    mockResolveBranchPoint.mockReturnValueOnce(branchPoint.promise);

    const initial = useChangesStore.getState().refresh('project-a');
    const latest = useChangesStore.getState().setTarget('project-a', 'branchPoint');
    first.resolve(CS_A);
    await flushAsyncWork();

    const staleSlice = useChangesStore.getState().byProject['project-a']!;
    expect(staleSlice).toMatchObject({
      target: 'branchPoint',
      changeset: null,
      selectedPath: null,
      loading: true,
    });
    expect(staleSlice.baseline).toBeUndefined();
    expect(staleSlice.branchPoint).toBeUndefined();
    expect(mockGetChangeset).toHaveBeenCalledTimes(1);

    branchPoint.resolve(BP);
    await flushAsyncWork();
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', BP.mergeBase, 'project-a');

    trailing.resolve(CS_BP);
    await Promise.all([initial, latest]);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      target: 'branchPoint',
      branchPoint: BP,
      baseline: BP.mergeBase,
      changeset: CS_BP,
      loading: false,
    });
  });

  it('rejects a head-to-branchPoint-to-head ABA completion before the latest refresh', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    const latest: Changeset = { ...CS_A, generatedAt: 'target-aba-latest' };
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);

    const initial = useChangesStore.getState().refresh('project-a');
    const branchPoint = useChangesStore.getState().setTarget('project-a', 'branchPoint');
    const head = useChangesStore.getState().setTarget('project-a', 'head');
    first.resolve({ ...CS_A, generatedAt: 'stale-target-aba' });
    await flushAsyncWork();

    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      target: 'head',
      changeset: null,
      loading: true,
    });
    expect(mockResolveBranchPoint).not.toHaveBeenCalled();
    expect(mockGetChangeset).toHaveBeenCalledTimes(2);

    trailing.resolve(latest);
    await Promise.all([initial, branchPoint, head]);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      target: 'head',
      changeset: latest,
      loading: false,
    });
  });

  it('rejects a worktree A-to-B-to-A ABA completion before the latest refresh', async () => {
    const WT_B: WorktreeRecord[] = [
      { path: '/repo-b', branch: 'feature', head: 'def', locked: false, prunable: false, detached: false },
    ];
    const latest: Changeset = { ...CS_A, generatedAt: 'worktree-aba-latest' };
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);

    const initial = useChangesStore.getState().refresh('project-a');
    seedWorktree('project-a', WT_B, '/repo-b');
    const worktreeB = useChangesStore.getState().refresh('project-a');
    seedWorktree('project-a', WT_A, '/repo-a');
    const worktreeA = useChangesStore.getState().refresh('project-a');
    first.resolve({ ...CS_A, generatedAt: 'stale-worktree-aba' });
    await flushAsyncWork();

    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      changeset: null,
      loading: true,
    });
    expect(mockGetChangeset).toHaveBeenLastCalledWith('/repo-a', undefined, 'project-a');
    expect(mockGetChangeset).toHaveBeenCalledTimes(2);

    trailing.resolve(latest);
    await Promise.all([initial, worktreeB, worktreeA]);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      changeset: latest,
      loading: false,
    });
  });

  it('invalidates queued work on disconnect and eviction without resurrecting state', async () => {
    for (const action of ['clearForDisconnect', 'evict'] as const) {
      seedWorktree('project-a', WT_A, '/repo-a');
      const active = deferred<Changeset>();
      mockGetChangeset.mockReturnValueOnce(active.promise);

      const first = useChangesStore.getState().refresh('project-a');
      const queued = useChangesStore.getState().refresh('project-a');
      useChangesStore.getState()[action]('project-a');
      active.resolve(CS_A);
      await Promise.all([first, queued]);

      expect(mockGetChangeset).toHaveBeenCalledTimes(1);
      if (action === 'clearForDisconnect') {
        expect(useChangesStore.getState().byProject['project-a']).toEqual(changesSlice());
      } else {
        expect(useChangesStore.getState().byProject['project-a']).toBeUndefined();
      }
      resetStores();
      vi.clearAllMocks();
    }
  });

  it('keeps last-good data through an error before running a pending refresh', async () => {
    seedWorktree('project-a', WT_A, '/repo-a');
    const first = deferred<Changeset>();
    const trailing = deferred<Changeset>();
    const CS_B: Changeset = { ...CS_A, generatedAt: 'recovered' };
    useChangesStore.setState({ byProject: { 'project-a': changesSlice({ changeset: CS_A }) } });
    mockGetChangeset
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise);

    const initial = useChangesStore.getState().refresh('project-a');
    const queued = useChangesStore.getState().refresh('project-a');
    first.reject(new Error('transient'));
    await flushAsyncWork();

    expect(mockGetChangeset).toHaveBeenCalledTimes(2);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      changeset: CS_A,
      loading: true,
    });

    trailing.resolve(CS_B);
    await Promise.all([initial, queued]);
    expect(useChangesStore.getState().byProject['project-a']).toMatchObject({
      changeset: CS_B,
      loading: false,
    });
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
