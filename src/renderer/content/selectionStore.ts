import { create } from 'zustand';

/** Where a content selection came from. 'change' is diff-oriented (from the
 *  Changes panel); 'file' is a plain in-project repo file (from the Explorer or
 *  an in-project link); 'external-file' is a file OUTSIDE the project root
 *  (opened via a link) — `path` is its absolute path and it has no git diff. */
export type ContentKind = 'change' | 'file' | 'external-file';

export interface ContentSelection {
  /** Path relative to the worktree/root (or absolute for 'external-file'). */
  path: string;
  /** Worktree path for diffs ('' lets the provider use the project root). */
  worktreePath: string;
  baseline?: string;
  kind: ContentKind;
  /** Previous path for renames (image-compare). */
  oldPath?: string | null;
}

interface ContentSelectionState {
  /** Per-project selections keyed by projectId. */
  selections: Record<string, ContentSelection | null>;
  select: (projectId: string, selection: ContentSelection) => void;
  clear: (projectId: string) => void;
  selectionFor: (projectId: string) => ContentSelection | null;
}

/** The per-project content target rendered by the Content viewer. Both the
 *  Changes and Explorer panels write here (passing the active projectId); the
 *  viewer reads the slice for the currently active project. */
export const useContentSelection = create<ContentSelectionState>((set, get) => ({
  selections: {},
  select: (projectId, selection) =>
    set((s) => ({ selections: { ...s.selections, [projectId]: selection } })),
  clear: (projectId) =>
    set((s) => ({ selections: { ...s.selections, [projectId]: null } })),
  selectionFor: (projectId) => get().selections[projectId] ?? null,
}));
