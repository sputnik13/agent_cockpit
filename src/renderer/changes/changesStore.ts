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

export const useChangesStore = create<ChangesState>((set, get) => {
  /** Patch a single project's slice immutably; absent slices start empty. */
  const patch = (projectId: string, p: Partial<ChangesSlice>): void =>
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...(s.byProject[projectId] ?? emptySlice()), ...p },
      },
    }));

  return {
    byProject: {},

    refresh: async (projectId) => {
      // The active worktree is owned by `worktreeStore` (single owner of
      // `(worktrees, activeWorktree)`); read the current selection from there.
      const activeWorktree =
        useWorktreeStore.getState().byProject[projectId]?.activeWorktree ?? null;
      const slice = get().byProject[projectId];
      if (activeWorktree === null) {
        patch(projectId, { changeset: null });
        return;
      }
      // If the last changeset belonged to a DIFFERENT worktree, the selection
      // just changed (picker / cwd-follow): drop the stale changeset + selection
      // so the panel shows a spinner instead of another worktree's files. A
      // same-worktree refresh (a watch event) keeps last-good — no flicker.
      if (slice?.changeset && slice.changeset.worktree !== activeWorktree) {
        patch(projectId, { changeset: null, selectedPath: null });
      }
      const target: DiffTarget = get().byProject[projectId]?.target ?? 'head';
      patch(projectId, { loading: true });
      try {
        // Re-resolve the branch-point on every refresh so it tracks new commits.
        let baseline: string | undefined;
        let branchPoint: BranchPoint | null | undefined = get().byProject[projectId]?.branchPoint;
        if (target === 'branchPoint') {
          const resolved = await agentCockpit.provider.resolveBranchPoint(activeWorktree, projectId);
          // Stale guard: slice may have been evicted while awaiting the RPC.
          if (!get().byProject[projectId]) return;
          branchPoint = resolved;
          baseline = resolved?.mergeBase;
          patch(projectId, { branchPoint });
        } else {
          // HEAD mode: clear any stale branch-point and use the provider default.
          baseline = undefined;
          branchPoint = undefined;
        }

        const changeset = await agentCockpit.provider.getChangeset(activeWorktree, baseline, projectId);
        // Stale-resolution guard: discard if the slice was evicted mid-load.
        if (!get().byProject[projectId]) return;
        patch(projectId, { changeset, baseline, branchPoint, loading: false });
        // Restore the per-project selected file, but only when nothing is
        // selected yet (don't clobber an active selection) and it still exists.
        if (get().byProject[projectId]?.selectedPath == null) {
          const saved = readFocus('ch-sel', projectId);
          if (saved && changeset.files.some((f) => f.newPath === saved)) {
            patch(projectId, { selectedPath: saved });
          }
        }
      } catch {
        if (!get().byProject[projectId]) return;
        // Keep last-good changeset (transient) but clear loading.
        patch(projectId, { loading: false });
      }
    },

    select: (projectId, path) => {
      writeFocus('ch-sel', projectId, path);
      patch(projectId, { selectedPath: path });
    },

    setTarget: async (projectId, target) => {
      patch(projectId, { target, changeset: null, selectedPath: null });
      await get().refresh(projectId);
    },

    clearForDisconnect: (projectId) =>
      set((s) => ({ byProject: { ...s.byProject, [projectId]: emptySlice() } })),

    evict: (projectId) =>
      set((s) => {
        if (!(projectId in s.byProject)) return s;
        const next = { ...s.byProject };
        delete next[projectId];
        return { byProject: next };
      }),
  };
});

/** The active project's Changes slice (empty when none/cold), as a pure
 *  derivation of `(activeId, byProject)` — never another project's data. */
export function useActiveChanges(): ChangesSlice {
  const activeId = useProjectsStore((s) => s.activeId);
  return useChangesStore((s) => (activeId ? s.byProject[activeId] : undefined) ?? EMPTY_SLICE);
}

const EMPTY_SLICE: ChangesSlice = emptySlice();
