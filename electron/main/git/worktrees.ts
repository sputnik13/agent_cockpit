import simpleGit from 'simple-git';
import type { WorktreeRecord } from '@shared/ipc/channels';

export async function listWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
  const git = simpleGit({ baseDir: repoPath });
  const out = await git.raw(['worktree', 'list', '--porcelain']);
  return parseWorktreePorcelain(out);
}

export function parseWorktreePorcelain(text: string): WorktreeRecord[] {
  const blocks = text.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const result: WorktreeRecord[] = [];
  for (const block of blocks) {
    let path = '';
    let head = '';
    let branch: string | null = null;
    let locked = false;
    let prunable = false;
    let detached = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length).trim();
      else if (line === 'detached') detached = true;
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line.startsWith('locked')) locked = true;
      else if (line.startsWith('prunable')) prunable = true;
    }
    if (path) result.push({ path, head, branch, locked, prunable, detached });
  }
  return result;
}
