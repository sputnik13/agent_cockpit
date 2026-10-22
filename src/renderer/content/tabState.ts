import type { ProjectInfo } from '@shared/ipc/channels';
import { resolveAbsolutePath } from '../files/rowMenu';
import type { ContentSelection } from './selectionStore';

/** One open file in the Content panel. `id` is the file's fully-qualified path
 *  (worktree-resolved; absolute for external files), so the same file opened
 *  from Changes, Explorer or a link is one tab. */
export interface ContentTab {
  id: string;
  selection: ContentSelection;
}

/** A project's open tabs and which one is showing. */
export interface ContentTabsSlice {
  tabs: ContentTab[];
  activeId: string | null;
}

export const EMPTY_TABS: ContentTabsSlice = Object.freeze({
  tabs: [],
  activeId: null,
}) as ContentTabsSlice;

/** Tab identity: the fully-qualified path, independent of how it was opened. */
export function tabIdFor(selection: ContentSelection, project: ProjectInfo | null): string {
  return resolveAbsolutePath(selection.path, selection.worktreePath, project);
}

/** Open `selection`: reuse and activate the tab with the same `id` (the latest
 *  opener's selection wins), otherwise append a new tab and activate it. */
export function openTab(
  slice: ContentTabsSlice,
  id: string,
  selection: ContentSelection,
): ContentTabsSlice {
  const existing = slice.tabs.findIndex((t) => t.id === id);
  if (existing < 0) return { tabs: [...slice.tabs, { id, selection }], activeId: id };
  const tabs = slice.tabs.slice();
  tabs[existing] = { id, selection };
  return { tabs, activeId: id };
}

/** Close a tab. Closing the active tab activates its right neighbour, else the
 *  left one; closing the last tab leaves the empty state. */
export function closeTab(slice: ContentTabsSlice, id: string): ContentTabsSlice {
  const index = slice.tabs.findIndex((t) => t.id === id);
  if (index < 0) return slice;
  const tabs = slice.tabs.filter((t) => t.id !== id);
  if (slice.activeId !== id) return { tabs, activeId: slice.activeId };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: next?.id ?? null };
}

/** Select an existing tab; unknown ids are ignored. */
export function activateTab(slice: ContentTabsSlice, id: string): ContentTabsSlice {
  if (slice.activeId === id || !slice.tabs.some((t) => t.id === id)) return slice;
  return { tabs: slice.tabs, activeId: id };
}

export function activeSelection(slice: ContentTabsSlice): ContentSelection | null {
  return slice.tabs.find((t) => t.id === slice.activeId)?.selection ?? null;
}

// ---------------------------------------------------------------------------
// Persistence (per project, localStorage — same best-effort pattern as
// workspace/focusMemory.ts). Stored shape is versioned; anything unreadable or
// malformed degrades to "no tabs" rather than throwing.
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'agent-cockpit:content-tabs:v1:';

export function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`;
}

function isSelection(value: unknown): value is ContentSelection {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['path'] === 'string' &&
    typeof v['worktreePath'] === 'string' &&
    (v['kind'] === 'change' || v['kind'] === 'file' || v['kind'] === 'external-file') &&
    (v['baseline'] === undefined || typeof v['baseline'] === 'string') &&
    (v['oldPath'] === undefined || v['oldPath'] === null || typeof v['oldPath'] === 'string')
  );
}

/** Parse a stored slice; returns null when absent or malformed. */
export function parseTabs(raw: string | null): ContentTabsSlice | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(data.tabs)) return null;
    const seen = new Set<string>();
    const tabs: ContentTab[] = [];
    for (const t of data.tabs) {
      if (typeof t !== 'object' || t === null) continue;
      const { id, selection } = t as { id?: unknown; selection?: unknown };
      if (typeof id !== 'string' || seen.has(id) || !isSelection(selection)) continue;
      seen.add(id);
      tabs.push({ id, selection });
    }
    const activeId =
      typeof data.activeId === 'string' && seen.has(data.activeId)
        ? data.activeId
        : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  } catch {
    return null;
  }
}

export function loadTabs(projectId: string): ContentTabsSlice | null {
  try {
    return parseTabs(localStorage.getItem(storageKey(projectId)));
  } catch {
    return null;
  }
}

export function saveTabs(projectId: string, slice: ContentTabsSlice): void {
  try {
    if (slice.tabs.length === 0) localStorage.removeItem(storageKey(projectId));
    else localStorage.setItem(storageKey(projectId), JSON.stringify(slice));
  } catch {
    // best-effort; ignore quota/access errors
  }
}

/** Remove every persisted tab slice (all projects). */
export function clearAllPersistedTabs(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // best-effort
  }
}
