import { create } from 'zustand';
import type { Changeset, WorktreeRecord } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '@renderer/providerClient';
import { readFocus, writeFocus } from '@renderer/workspace/focusMemory';

/**
 * Renderer store for the Changes panel, keyed per project (`byProject`). Each
 * live session owns an isolated slice that stays resident and warm until the
 * session ends, so switching projects renders the selected project's slice
 * instantly and never bleeds another project's data (FR1–FR3). All IPC lives in
 * actions; load/refresh/clear are orchestrated externally by `panelDataSync`
 * off per-session connection status + watch events — never panel mount.
 *
 * `activeWorktree` is the worktree path currently being inspected; `baseline`
 * is an optional ref/commit passed to `getChangeset` (undefined == provider
 * default, typically HEAD). `selectedPath` tracks the focused file row so the
 * detail/diff streams can react to selection. Every read is addressed by the
 * slice's `projectId`, so a backgrounded project's refresh hits its own session.
 */
export interface ChangesSlice {
  worktrees: WorktreeRecord[];
  activeWorktree: string | null;
  baseline: string | undefined;
  changeset: Changeset | null;
  loading: boolean;
  selectedPath: string | null;
}

function emptySlice(): ChangesSlice {
  return {
    worktrees: [],
    activeWorktree: null,
    baseline: undefined,
    changeset: null,
    loading: false,
    selectedPath: null,
  };
}

interface ChangesState {
  byProject: Record<string, ChangesSlice>;

  loadWorktrees: (projectId: string) => Promise<void>;
  setWorktree: (projectId: string, path: string) => Promise<void>;
  refresh: (projectId: string) => Promise<void>;
  select: (projectId: string, path: string) => void;
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
        patch(projectId, {
          worktrees,
          activeWorktree: next,
          loading: false,
          // Drop a selection that belonged to the previous worktree.
          ...(next !== activeWorktree ? { selectedPath: null } : {}),
        });
        if (next !== null) await get().refresh(projectId);
      } catch {
        // Discard if evicted mid-flight; otherwise clear to empty so the panel
        // does not show a stale list with loading stuck on.
        if (!get().byProject[projectId]) return;
        patch(projectId, {
          worktrees: [],
          activeWorktree: null,
          changeset: null,
          loading: false,
        });
      }
    },

    setWorktree: async (projectId, path) => {
      patch(projectId, { activeWorktree: path, changeset: null, selectedPath: null });
      await get().refresh(projectId);
    },

    refresh: async (projectId) => {
      const slice = get().byProject[projectId];
      if (!slice) return;
      const { activeWorktree, baseline } = slice;
      if (activeWorktree === null) {
        patch(projectId, { changeset: null });
        return;
      }
      patch(projectId, { loading: true });
      try {
        const changeset = await agentCockpit.provider.getChangeset(activeWorktree, baseline, projectId);
        // Stale-resolution guard: discard if the slice was evicted mid-load.
        if (!get().byProject[projectId]) return;
        patch(projectId, { changeset, loading: false });
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
