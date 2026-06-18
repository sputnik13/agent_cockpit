import { create } from 'zustand';
import type { NoteRecord, ReviewTargetKind } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '../providerClient';

/** Renderer review-notes store, scoped to the active project. */
interface NotesState {
  notes: NoteRecord[];
  loading: boolean;
  load: () => Promise<void>;
  add: (body: string, targetKind?: ReviewTargetKind, targetId?: string) => Promise<void>;
  /** Add a note anchored to a file + 1-based line, snapshotting the line text. */
  addLineNote: (path: string, line: number, anchorText: string, body: string) => Promise<void>;
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

  addLineNote: async (path, line, anchorText, body) => {
    const pid = activeId();
    if (!pid || !body.trim()) return;
    await agentCockpit.notes.create({
      projectId: pid,
      targetKind: 'file',
      targetId: path,
      body,
      line,
      anchorText,
    });
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

/**
 * Group a project's notes that are line-anchored to `path` by their 1-based line
 * number. Non-file, other-file, and non-line notes are excluded. Pure — the
 * content views call this over the store's `notes` to render inline threads.
 */
export function lineNotesByLine(notes: NoteRecord[], path: string): Map<number, NoteRecord[]> {
  const byLine = new Map<number, NoteRecord[]>();
  for (const n of notes) {
    if (n.targetKind !== 'file' || n.targetId !== path || n.line == null) continue;
    const arr = byLine.get(n.line);
    if (arr) arr.push(n);
    else byLine.set(n.line, [n]);
  }
  return byLine;
}
