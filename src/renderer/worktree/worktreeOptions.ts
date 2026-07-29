import type { WorktreeRecord } from '@shared/ipc/channels';

export interface WorktreeOption {
  value: string;
  label: string;
}

/** Last path segment (the workspace/directory name), tolerant of both POSIX and
 *  Windows separators since worktree paths are absolute filesystem paths. */
export function workspaceName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/** The branch a worktree is on, or a short HEAD for a detached/unnamed worktree
 *  so the entry stays identifiable. */
function branchLabel(w: WorktreeRecord): string {
  if (w.branch) return w.branch;
  return w.head ? w.head.slice(0, 7) : 'detached';
}

/**
 * Build the worktree dropdown options shared by the Explorer and Changes panels.
 * Each entry is labelled `"<workspace> - <branch>"` (value = the worktree path).
 * `git worktree list --porcelain` emits the main worktree first, so index 0 is
 * the **primary** workspace: it is pinned at the top, and the remaining worktrees
 * are sorted by workspace (directory) name, tie-broken by branch.
 */
export function worktreeSelectOptions(worktrees: WorktreeRecord[]): WorktreeOption[] {
  if (worktrees.length === 0) return [];
  const toOption = (w: WorktreeRecord): WorktreeOption => ({
    value: w.path,
    label: `${workspaceName(w.path)} - ${branchLabel(w)}`,
  });
  const [primary, ...rest] = worktrees;
  rest.sort((a, b) => {
    const byWorkspace = workspaceName(a.path).localeCompare(workspaceName(b.path));
    return byWorkspace !== 0 ? byWorkspace : (a.branch ?? '').localeCompare(b.branch ?? '');
  });
  return [toOption(primary), ...rest.map(toOption)];
}
