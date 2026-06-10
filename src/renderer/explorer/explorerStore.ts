import { create } from 'zustand';

/** Ancestor directory paths of a project-relative file/dir path. For
 *  `a/b/c.ts` → `['a', 'a/b']` (POSIX separators; the provider returns relPath
 *  POSIX-normalized). */
export function ancestorDirs(relPath: string): string[] {
  const parts = relPath.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    out.push(parts.slice(0, i + 1).join('/'));
  }
  return out;
}

interface ExplorerState {
  /** Expanded directory paths per project. */
  expanded: Record<string, Set<string>>;
  /** The file path the tree should scroll to, per project (cleared by the
   *  FileNode once it scrolls into view). */
  revealTarget: Record<string, string | null>;
  isExpanded: (projectId: string, dirPath: string) => boolean;
  setExpanded: (projectId: string, dirPath: string, open: boolean) => void;
  toggle: (projectId: string, dirPath: string) => void;
  /** Expand every ancestor of `relPath` and mark it as the scroll target. */
  reveal: (projectId: string, relPath: string) => void;
  consumeRevealTarget: (projectId: string) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  expanded: {},
  revealTarget: {},
  isExpanded: (projectId, dirPath) => get().expanded[projectId]?.has(dirPath) ?? false,
  setExpanded: (projectId, dirPath, open) =>
    set((s) => {
      const next = new Set(s.expanded[projectId] ?? []);
      if (open) next.add(dirPath);
      else next.delete(dirPath);
      return { expanded: { ...s.expanded, [projectId]: next } };
    }),
  toggle: (projectId, dirPath) =>
    get().setExpanded(projectId, dirPath, !get().isExpanded(projectId, dirPath)),
  reveal: (projectId, relPath) =>
    set((s) => {
      const next = new Set(s.expanded[projectId] ?? []);
      for (const dir of ancestorDirs(relPath)) next.add(dir);
      return {
        expanded: { ...s.expanded, [projectId]: next },
        revealTarget: { ...s.revealTarget, [projectId]: relPath },
      };
    }),
  consumeRevealTarget: (projectId) =>
    set((s) => ({ revealTarget: { ...s.revealTarget, [projectId]: null } })),
}));
