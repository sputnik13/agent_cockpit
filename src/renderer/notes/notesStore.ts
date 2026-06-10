import { create } from 'zustand';
import type { NoteRecord, ReviewTargetKind } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '../providerClient';

/** Renderer review-notes store, scoped to the active project. */
interface NotesState {
  notes: NoteRecord[];
  loading: boolean;
  load: () => Promise<void>;
  add: (body: string, targetKind?: ReviewTargetKind, targetId?: string) => Promise<void>;
  update: (id: number, body: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  exportMarkdown: () => Promise<string>;
}

function activeId(): string | null {
  return useProjectsStore.getState().activeId;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  loading: false,

  load: async () => {
    const pid = activeId();
    if (!pid) {
      set({ notes: [] });
      return;
    }
    set({ loading: true });
    try {
      set({ notes: await agentCockpit.notes.list(pid), loading: false });
    } catch {
      set({ loading: false });
    }
  },

  add: async (body, targetKind = 'project', targetId) => {
    const pid = activeId();
    if (!pid || !body.trim()) return;
    await agentCockpit.notes.create({ projectId: pid, targetKind, targetId: targetId ?? pid, body });
    await get().load();
  },

  update: async (id, body) => {
    await agentCockpit.notes.update(id, body);
    await get().load();
  },

  remove: async (id) => {
    await agentCockpit.notes.remove(id);
    await get().load();
  },

  exportMarkdown: async () => {
    const pid = activeId();
    return pid ? agentCockpit.notes.exportMarkdown(pid) : '';
  },
}));
