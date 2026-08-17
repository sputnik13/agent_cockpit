import { create } from 'zustand';
import type { BranchPoint, Changeset } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '@renderer/providerClient';
import { useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { readFocus, writeFocus } from '@renderer/workspace/focusMemory';

/** Diff target for the Changes view. `head` = working tree vs HEAD (default);
 *  `branchPoint` = working tree vs the merge-base with the parent branch. */
export type DiffTarget = 'head' | 'branchPoint';

/**
 * Renderer store for the Changes panel, keyed per project (`byProject`). Each
 * live session owns an isolated slice that stays resident and warm until the
 * session ends, so switching projects renders the selected project's slice
 * instantly and never bleeds another project's data (FR1–FR3). All IPC lives in
 * actions; load/refresh/clear are orchestrated externally by `panelDataSync`
 * off per-session connection status + watch events — never panel mount.
 *
 * The worktree currently being inspected is owned by `worktreeStore` (the single
 * authoritative owner of `(worktrees, activeWorktree)`); `refresh` reads the
 * active worktree from there. `baseline` is an optional ref/commit passed to
 * `getChangeset` (undefined == provider default, typically HEAD). `selectedPath`
 * tracks the focused file row so the detail/diff streams can react to selection.
 * Every read is addressed by the slice's `projectId`, so a backgrounded project's
 * refresh hits its own session.
 */
export interface ChangesSlice {
  baseline: string | undefined;
  changeset: Changeset | null;
  loading: boolean;
  selectedPath: string | null;
  /** The selected diff target (default: 'head'). */
  target: DiffTarget;
  /**
   * The resolved branch-point from the last refresh when target === branchPoint.
   * null = no parent resolvable (orphan, no upstream + no remote default).
   * undefined = not yet resolved / not in branchPoint mode.
   */
  branchPoint: BranchPoint | null | undefined;
}

function emptySlice(): ChangesSlice {
  return {
    baseline: undefined,
    changeset: null,
    loading: false,
    selectedPath: null,
    target: 'head',
    branchPoint: undefined,
  };
}

interface ChangesState {
  byProject: Record<string, ChangesSlice>;

  refresh: (projectId: string) => Promise<void>;
  select: (projectId: string, path: string) => void;
  /** Set the diff target and trigger a refresh. */
  setTarget: (projectId: string, target: DiffTarget) => Promise<void>;
  /** Reset a project's slice to the disconnected (empty) state, keeping the key
   *  so its panel shows an explicit disconnected affordance (FR4). */
  clearForDisconnect: (projectId: string) => void;
  /** Delete a project's slice entirely (the project was removed) (FR7). */
  evict: (projectId: string) => void;
}

/**
 * Refresh scheduling is deliberately kept outside the Zustand state: it is
 * transient control flow, not panel data. Each project gets one active drain
 * plus one coalesced follow-up request, so a watch burst cannot create a queue
 * of full provider reads.
 */
interface RefreshCoordinator {
  lifecycle: number;
  requestGeneration: number;
  pending: boolean;
  drain: Promise<void> | null;
}

interface RefreshRun {
  lifecycle: number;
  requestGeneration: number;
  activeWorktree: string | null;
  target: DiffTarget;
}

export const useChangesStore = create<ChangesState>((set, get) => {
  const refreshCoordinators = new Map<string, RefreshCoordinator>();

  const coordinatorFor = (projectId: string): RefreshCoordinator => {
    const existing = refreshCoordinators.get(projectId);
    if (existing) return existing;
    const coordinator: RefreshCoordinator = {
      lifecycle: 0,
      requestGeneration: 0,
      pending: false,
      drain: null,
    };
    refreshCoordinators.set(projectId, coordinator);
    return coordinator;
  };

  /** Patch a single project's slice immutably; absent slices start empty. */
  const patch = (projectId: string, p: Partial<ChangesSlice>): void =>
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...(s.byProject[projectId] ?? emptySlice()), ...p },
      },
    }));

  const invalidateRefresh = (projectId: string): void => {
    const coordinator = coordinatorFor(projectId);
    coordinator.lifecycle += 1;
    coordinator.requestGeneration += 1;
    // A request made before the lifecycle transition must not cause a rerun
    // after disconnect/eviction. A later refresh can still join the active
    // drain and will execute against this new lifecycle.
    coordinator.pending = false;
  };

  const isCurrentRun = (
    projectId: string,
    coordinator: RefreshCoordinator,
    run: RefreshRun,
  ): boolean =>
    coordinator.lifecycle === run.lifecycle &&
    coordinator.requestGeneration === run.requestGeneration &&
    (useWorktreeStore.getState().byProject[projectId]?.activeWorktree ?? null) === run.activeWorktree &&
    (get().byProject[projectId]?.target ?? 'head') === run.target;

  const runRefresh = async (
    projectId: string,
    coordinator: RefreshCoordinator,
  ): Promise<RefreshRun> => {
    // The active worktree is owned by `worktreeStore` (single owner of
    // `(worktrees, activeWorktree)`); read the current selection from there.
    const activeWorktree =
      useWorktreeStore.getState().byProject[projectId]?.activeWorktree ?? null;
    const slice = get().byProject[projectId];
    const target: DiffTarget = slice?.target ?? 'head';
    const run: RefreshRun = {
      lifecycle: coordinator.lifecycle,
      requestGeneration: coordinator.requestGeneration,
      activeWorktree,
      target,
    };
    const isCurrent = (): boolean => isCurrentRun(projectId, coordinator, run);

    if (activeWorktree === null) {
      if (isCurrent()) patch(projectId, { changeset: null });
      return run;
    }

    // If the last changeset belonged to a DIFFERENT worktree, the selection
    // just changed (picker / cwd-follow): drop the stale changeset + selection
    // so the panel shows a spinner instead of another worktree's files. A
    // same-worktree refresh (a watch event) keeps last-good — no flicker.
    if (slice?.changeset && slice.changeset.worktree !== activeWorktree && isCurrent()) {
      patch(projectId, { changeset: null, selectedPath: null });
    }
    if (isCurrent()) patch(projectId, { loading: true });

    try {
      // Re-resolve the branch-point on every refresh so it tracks new commits.
      let baseline: string | undefined;
      let branchPoint: BranchPoint | null | undefined = get().byProject[projectId]?.branchPoint;
      if (target === 'branchPoint') {
        const resolved = await agentCockpit.provider.resolveBranchPoint(activeWorktree, projectId);
        if (!isCurrent()) return run;
        branchPoint = resolved;
        baseline = resolved?.mergeBase;
        patch(projectId, { branchPoint });
      } else {
        // HEAD mode: clear any stale branch-point and use the provider default.
        baseline = undefined;
        branchPoint = undefined;
      }

      const changeset = await agentCockpit.provider.getChangeset(activeWorktree, baseline, projectId);
      if (!isCurrent()) return run;
      patch(projectId, { changeset, baseline, branchPoint });
      // Restore the per-project selected file, but only when nothing is
      // selected yet (don't clobber an active selection) and it still exists.
      if (get().byProject[projectId]?.selectedPath == null) {
        const saved = readFocus('ch-sel', projectId);
        if (saved && changeset.files.some((f) => f.newPath === saved) && isCurrent()) {
          patch(projectId, { selectedPath: saved });
        }
      }
    } catch {
      if (!isCurrent()) return run;
      // Keep last-good changeset on transient errors. The drain owns clearing
      // loading so it remains true while a coalesced trailing run is pending.
    }
    return run;
  };

  const drainRefreshes = async (
    projectId: string,
    coordinator: RefreshCoordinator,
    drain: Promise<void>,
    resolveDrain: () => void,
  ): Promise<void> => {
    while (true) {
      coordinator.pending = false;
      const completedRun = await runRefresh(projectId, coordinator);
      if (coordinator.pending) continue;

      // Clear ownership before either notifying loading=false subscribers or
      // resolving callers. A refresh queued in a later microtask therefore
      // starts a new drain instead of attaching to one that has already ended.
      // Identity prevents an old drain's finalizer from clearing a replacement.
      if (coordinator.drain !== drain) return;
      coordinator.drain = null;
      resolveDrain();

      // Never let a stale run's finalizer mutate newer target/worktree/lifecycle
      // state. Evicted slices are intentionally not recreated.
      if (get().byProject[projectId] && isCurrentRun(projectId, coordinator, completedRun)) {
        patch(projectId, { loading: false });
      }
      return;
    }
  };

  const scheduleRefresh = (projectId: string): Promise<void> => {
    const coordinator = coordinatorFor(projectId);
    coordinator.requestGeneration += 1;
    if (coordinator.drain) {
      coordinator.pending = true;
      return coordinator.drain;
    }

    // An idle project with no active worktree has no provider pipeline to
    // coordinate; preserve the existing no-op behavior.
    if (useWorktreeStore.getState().byProject[projectId]?.activeWorktree == null) {
      patch(projectId, { changeset: null, loading: false });
      return Promise.resolve();
    }

    let resolveDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    coordinator.drain = drain;
    void drainRefreshes(projectId, coordinator, drain, resolveDrain);
    return drain;
  };

  return {
    byProject: {},

    refresh: scheduleRefresh,

    select: (projectId, path) => {
      writeFocus('ch-sel', projectId, path);
      patch(projectId, { selectedPath: path });
    },

    setTarget: async (projectId, target) => {
      patch(projectId, { target, changeset: null, selectedPath: null });
      await get().refresh(projectId);
    },

    clearForDisconnect: (projectId) => {
      invalidateRefresh(projectId);
      set((s) => ({ byProject: { ...s.byProject, [projectId]: emptySlice() } }));
    },

    evict: (projectId) => {
      invalidateRefresh(projectId);
      set((s) => {
        if (!(projectId in s.byProject)) return s;
        const next = { ...s.byProject };
        delete next[projectId];
        return { byProject: next };
      });
    },
  };
});

/** The active project's Changes slice (empty when none/cold), as a pure
 *  derivation of `(activeId, byProject)` — never another project's data. */
export function useActiveChanges(): ChangesSlice {
  const activeId = useProjectsStore((s) => s.activeId);
  return useChangesStore((s) => (activeId ? s.byProject[activeId] : undefined) ?? EMPTY_SLICE);
}

const EMPTY_SLICE: ChangesSlice = emptySlice();
