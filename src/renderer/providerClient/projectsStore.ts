import { create } from 'zustand';
import type { ProjectInfo } from '@shared/ipc/channels';
import type { ConnectionSpec } from '@shared/providers/types';

/**
 * Renderer projects/active-session store. Mirrors the SQLite project list and
 * the single active project; switching goes through the provider IPC. Panels
 * select narrow slices so background changes don't re-render the active view.
 */
interface ProjectsState {
  projects: ProjectInfo[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  add: (input: { label: string; connection: ConnectionSpec }) => Promise<ProjectInfo>;
  remove: (id: string) => Promise<void>;
  /** Update a project's label and/or connection spec. Kind is immutable. */
  update: (id: string, patch: { label?: string; connection?: ConnectionSpec }) => Promise<ProjectInfo>;
  activate: (id: string) => Promise<void>;
  /** Persist a new left-to-right order (full ordered id list); optimistic. */
  reorder: (orderedIds: string[]) => Promise<void>;
  /** Set (or clear) a project's Run-panel command, then refresh the list. */
  setRunCommand: (id: string, command: string | null) => Promise<void>;
  /** Disconnect a remote project's provider, keeping it selected (state=disconnected). */
  disconnect: (id: string) => Promise<void>;
  /** Evict cached provider and reconnect from scratch (re-provisions helper). */
  reconnect: (id: string) => Promise<void>;
}

export const useProjectsStore = create<ProjectsState>((set, get) => ({
  projects: [],
  activeId: null,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true });
    try {
      const [projects, activeId] = await Promise.all([
        window.api.projects.list(),
        window.api.projects.getActive(),
      ]);
      set({ projects, activeId, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  add: async (input) => {
    const project = await window.api.projects.add(input);
    await get().refresh();
    return project;
  },

  remove: async (id) => {
    await window.api.projects.remove(id);
    await get().refresh();
  },

  update: async (id, patch) => {
    const project = await window.api.projects.update(id, patch);
    await get().refresh();
    return project;
  },

  activate: async (id) => {
    // On error, the set({activeId}) and refresh() below are skipped (exception
    // propagates). activeId stays unchanged — no phantom project switch on failure.
    // The connection state (failed + detail) propagates via evtStatus so the UI
    // reflects the failure. Re-throwing lets call sites suppress or observe.
    await window.api.projects.activate(id);
    set({ activeId: id });
    await get().refresh();
  },

  reorder: async (orderedIds) => {
    // Optimistically apply the new order so the tab strip reflects the drag
    // immediately; the IPC persist + change event reconcile the canonical list.
    const byId = new Map(get().projects.map((p) => [p.id, p]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter((p): p is ProjectInfo => !!p);
    set({ projects: reordered });
    await window.api.projects.reorder(orderedIds);
  },

  setRunCommand: async (id, command) => {
    await window.api.projects.setRunCommand(id, command);
    await get().refresh();
  },

  disconnect: async (id) => {
    await window.api.projects.disconnect(id);
    // Status update arrives via evtStatus; no store refresh needed.
  },

  reconnect: async (id) => {
    await window.api.projects.reconnect(id);
    // Status updates arrive via evtStatus during the reconnect sequence.
  },
}));

/**
 * Wire live refresh on project changes. Call once at app start; returns an
 * unsubscribe. Kept out of the store so the store stays a pure state container.
 */
export function initProjectsSync(): () => void {
  void useProjectsStore.getState().refresh();
  return window.api.events.onProjectsChanged(() => {
    void useProjectsStore.getState().refresh();
  });
}

export const selectActiveProject = (s: ProjectsState): ProjectInfo | null =>
  s.projects.find((p) => p.id === s.activeId) ?? null;
