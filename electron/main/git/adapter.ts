import { existsSync } from 'node:fs';
import { join } from 'node:path';
import simpleGit, { type SimpleGit } from 'simple-git';

export interface GitAdapter {
  raw: SimpleGit;
  headCommit(): Promise<string>;
  listRefs(): Promise<string[]>;
  status(): Promise<{ current: string | null; isClean: boolean; ahead: number; behind: number }>;
}

export function openRepo(repoPath: string): GitAdapter {
  if (!existsSync(repoPath)) throw new Error(`repo path missing: ${repoPath}`);
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`not a git repository (no .git): ${repoPath}`);
  }
  const git = simpleGit({ baseDir: repoPath });
  return {
    raw: git,
    async headCommit() {
      const out = await git.revparse(['HEAD']);
      return out.trim();
    },
    async listRefs() {
      const out = await git.raw(['for-each-ref', '--format=%(refname:short)']);
      return out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    },
    async status() {
      const s = await git.status();
      return {
        current: s.current ?? null,
        isClean: s.isClean(),
        ahead: s.ahead,
        behind: s.behind,
      };
    },
  };
}
