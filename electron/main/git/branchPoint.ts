import simpleGit from 'simple-git';
import type { BranchPoint } from '@shared/ipc/channels';

/**
 * Resolve the branch-point for a worktree: the parent branch reference and the
 * merge-base SHA between HEAD and that parent.
 *
 * Parent resolution rule (governing):
 *   1. upstream: `git rev-parse --abbrev-ref @{upstream}` — the configured
 *      tracking branch for the current HEAD (e.g. "origin/main").
 *   2. default: `git symbolic-ref refs/remotes/origin/HEAD` → the repo default
 *      branch pointer (e.g. "refs/remotes/origin/main" → "origin/main"), then
 *      fall back to "main" and finally "master" if that also fails.
 *
 * Returns null when:
 *   - No upstream is configured AND no default branch ref can be resolved.
 *   - The merge-base fails (orphan branch, unrelated histories).
 */
export async function resolveBranchPoint(worktreePath: string): Promise<BranchPoint | null> {
  if (!worktreePath) return null;
  const git = simpleGit({ baseDir: worktreePath });

  // Try upstream (@{upstream}) first.
  let parentRef: string | null = null;
  let parentKind: BranchPoint['parentKind'] = 'upstream';

  try {
    const upstream = (await git.revparse(['--abbrev-ref', '@{upstream}'])).trim();
    if (upstream.length > 0) {
      parentRef = upstream;
    }
  } catch {
    // No upstream configured; fall through to default-branch resolution.
  }

  if (parentRef === null) {
    parentKind = 'default';
    // Try origin/HEAD symbolic ref first.
    try {
      const symref = (await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])).trim();
      // symref is "refs/remotes/origin/main" → strip to "origin/main".
      if (symref.startsWith('refs/remotes/')) {
        parentRef = symref.slice('refs/remotes/'.length);
      } else if (symref.length > 0) {
        parentRef = symref;
      }
    } catch {
      // origin/HEAD not set; try well-known names.
    }

    if (parentRef === null) {
      // Fall back to well-known remote-tracking refs only (not bare "main"/"master",
      // which would match local branches in a repo with no remotes and produce a
      // self-referential merge-base equal to HEAD).
      for (const candidate of ['origin/main', 'origin/master']) {
        try {
          await git.revparse([candidate]);
          parentRef = candidate;
          break;
        } catch {
          // Not available; try next.
        }
      }
    }
  }

  if (parentRef === null) {
    return null;
  }

  // Compute merge-base between HEAD and parentRef.
  let mergeBase: string;
  try {
    mergeBase = (await git.raw(['merge-base', 'HEAD', parentRef])).trim();
  } catch {
    // Orphan branch or unrelated histories.
    return null;
  }

  if (!mergeBase) {
    return null;
  }

  return { parentRef, parentKind, mergeBase };
}
