import { create } from 'zustand';
import { useProjectsStore } from '../providerClient';
import {
  EMPTY_TABS,
  activateTab,
  activeSelection,
  clearAllPersistedTabs,
  closeTab,
  loadTabs,
  openTab,
  saveTabs,
  tabIdFor,
  type ContentTabsSlice,
} from './tabState';

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
  /** Per-project open tabs, keyed by projectId. A project with no entry here
   *  reads through to its persisted tabs (see `sliceFor`). */
  slices: Record<string, ContentTabsSlice>;
  /** Open `selection` in the project's Content panel: activate the existing tab
   *  for the same fully-qualified path, or add a new tab. */
  select: (projectId: string, selection: ContentSelection) => void;
  activate: (projectId: string, tabId: string) => void;
  close: (projectId: string, tabId: string) => void;
  /** Close every tab for the project. */
  clear: (projectId: string) => void;
  /** The active tab's selection (what the viewer renders), or null. */
  selectionFor: (projectId: string) => ContentSelection | null;
  /** Drop all in-memory and persisted tabs (tests, full reset). */
  resetAll: () => void;
}

// Persisted tabs are read once per project and cached so selectors return a
// referentially-stable slice (a fresh object per read would loop zustand).
const persisted = new Map<string, ContentTabsSlice>();

function persistedFor(projectId: string): ContentTabsSlice {
  let slice = persisted.get(projectId);
  if (!slice) {
    slice = loadTabs(projectId) ?? EMPTY_TABS;
    persisted.set(projectId, slice);
  }
  return slice;
}

/** The project's current slice: live state, else its persisted tabs. */
export function sliceFor(
  slices: Record<string, ContentTabsSlice>,
  projectId: string | null,
): ContentTabsSlice {
  if (!projectId) return EMPTY_TABS;
  return slices[projectId] ?? persistedFor(projectId);
}

/** The per-project open content tabs rendered by the Content viewer. Changes,
 *  Explorer and in-project links all write here via `select`; the viewer reads
 *  the slice for the currently active project. Tabs persist across restarts. */
export const useContentSelection = create<ContentSelectionState>((set, get) => {
  const update = (projectId: string, next: (s: ContentTabsSlice) => ContentTabsSlice): void => {
    const current = sliceFor(get().slices, projectId);
    const slice = next(current);
    if (slice === current) return;
    saveTabs(projectId, slice);
    set((s) => ({ slices: { ...s.slices, [projectId]: slice } }));
  };
  return {
    slices: {},
    select: (projectId, selection) => {
      const project =
        (useProjectsStore.getState().projects ?? []).find((p) => p.id === projectId) ?? null;
      update(projectId, (s) => openTab(s, tabIdFor(selection, project), selection));
    },
    activate: (projectId, tabId) => update(projectId, (s) => activateTab(s, tabId)),
    close: (projectId, tabId) => update(projectId, (s) => closeTab(s, tabId)),
    clear: (projectId) => update(projectId, (s) => (s.tabs.length === 0 ? s : EMPTY_TABS)),
    selectionFor: (projectId) => activeSelection(sliceFor(get().slices, projectId)),
    resetAll: () => {
      persisted.clear();
      clearAllPersistedTabs();
      set({ slices: {} });
    },
  };
});

/** Zustand selector: the project's tabs slice (stable between unrelated updates). */
export const selectTabs =
  (projectId: string | null) =>
  (s: ContentSelectionState): ContentTabsSlice =>
    sliceFor(s.slices, projectId);

/** Zustand selector: the project's active selection (stable between updates). */
export const selectActive =
  (projectId: string | null) =>
  (s: ContentSelectionState): ContentSelection | null =>
    activeSelection(sliceFor(s.slices, projectId));
