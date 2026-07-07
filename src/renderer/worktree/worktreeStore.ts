import { create } from 'zustand';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '@renderer/providerClient';

/**
 * Renderer store for per-project worktree state — the single authoritative owner
 * of `(worktrees, activeWorktree)`, keyed per project (`byProject`). Every panel
 * that needs to know "which worktree is being inspected" (Changes, Explorer)
 * derives from this one store rather than owning a private copy, so the two never
 * disagree.
 *
 * All IPC lives in actions; load/clear/evict are orchestrated externally by
 * `panelDataSync` off per-session connection status + watch events — never panel
 * mount. A worktree selection change (initial default, user picker, cwd-follow)
 * is observed by `panelDataSync`, which drives the dependent Changes refresh; the
 * store itself never reaches into another store (orchestration stays centralized).
 *
 * Each read is addressed by the slice's `projectId`, so a backgrounded project's
 * (re)load hits its own session and never bleeds another project's data.
 */
export interface WorktreeSlice {
  worktrees: WorktreeRecord[];
  activeWorktree: string | null;
  loading: boolean;
}

function emptySlice(): WorktreeSlice {
  return {
    worktrees: [],
    activeWorktree: null,
    loading: false,
  };
}

interface WorktreeState {
  byProject: Record<string, WorktreeSlice>;

  /** (Re)list a project's worktrees, keeping a still-valid selection or falling
   *  back to the first worktree. Does NOT trigger a Changes refresh — that is
   *  orchestrated by `panelDataSync` observing the resulting selection change. */
  loadWorktrees: (projectId: string) => Promise<void>;
  /** Set the active worktree path (worktree state only; downstream Changes state
   *  is reconciled by `panelDataSync`/`changesStore.refresh`). */
  setWorktree: (projectId: string, path: string) => void;
  /** Reset a project's slice to the disconnected (empty) state, keeping the key
   *  so its panel shows an explicit disconnected affordance. */
  clearForDisconnect: (projectId: string) => void;
  /** Delete a project's slice entirely (the project was removed). */
  evict: (projectId: string) => void;
}

export const useWorktreeStore = create<WorktreeState>((set, get) => {
  /** Patch a single project's slice immutably; absent slices start empty. */
  const patch = (projectId: string, p: Partial<WorktreeSlice>): void =>
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...(s.byProject[projectId] ?? emptySlice()), ...p },
      },
    }));

  return {
    byProject: {},

    loadWorktrees: async (projectId) => {
      patch(projectId, { loading: true });
      try {
        const worktrees = await agentCockpit.provider.listWorktrees(projectId);
        // Stale-resolution guard: discard if the slice was evicted mid-flight.
        const slice = get().byProject[projectId];
        if (!slice) return;
        const { activeWorktree } = slice;
        // Keep the active worktree only if it still exists in this project's
        // list; otherwise fall back to the first worktree.
        const stillValid = activeWorktree != null && worktrees.some((w) => w.path === activeWorktree);
        const next = stillValid ? activeWorktree : (worktrees[0]?.path ?? null);
        patch(projectId, { worktrees, activeWorktree: next, loading: false });
      } catch {
        // Discard if evicted mid-flight; otherwise clear to empty so the panel
        // does not show a stale list with loading stuck on.
        if (!get().byProject[projectId]) return;
        patch(projectId, { worktrees: [], activeWorktree: null, loading: false });
      }
    },

    setWorktree: (projectId, path) => {
      patch(projectId, { activeWorktree: path });
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

/** The active project's worktree slice (empty when none/cold), as a pure
 *  derivation of `(activeId, byProject)` — never another project's data. */
export function useActiveWorktree(): WorktreeSlice {
  const activeId = useProjectsStore((s) => s.activeId);
  return useWorktreeStore((s) => (activeId ? s.byProject[activeId] : undefined) ?? EMPTY_SLICE);
}

const EMPTY_SLICE: WorktreeSlice = emptySlice();
