import { describe, expect, it } from 'vitest';
import { DiffBundleCache, isGitStateSignal } from './diffCache';
import type { DiffBundle } from '@shared/providers/types';

const bundle = (patch: string): DiffBundle => ({ patch, newContent: null, oldContent: null });

describe('DiffBundleCache', () => {
  it('returns a stored bundle on a matching (project, worktree, path, baseline)', () => {
    const c = new DiffBundleCache();
    c.set('p1', '/wt', 'src/a.ts', 'HEAD', bundle('A'));
    expect(c.get('p1', '/wt', 'src/a.ts', 'HEAD')?.patch).toBe('A');
    // Different baseline / path / project all miss.
    expect(c.get('p1', '/wt', 'src/a.ts', 'main')).toBeUndefined();
    expect(c.get('p1', '/wt', 'src/b.ts', 'HEAD')).toBeUndefined();
    expect(c.get('p2', '/wt', 'src/a.ts', 'HEAD')).toBeUndefined();
  });

  it('drops only the changed path on a file watch batch', () => {
    const c = new DiffBundleCache();
    c.set('p1', '/wt', 'src/a.ts', 'HEAD', bundle('A'));
    c.set('p1', '/wt', 'src/b.ts', 'HEAD', bundle('B'));
    c.onWatch('p1', ['src/a.ts']);
    expect(c.get('p1', '/wt', 'src/a.ts', 'HEAD')).toBeUndefined(); // invalidated
    expect(c.get('p1', '/wt', 'src/b.ts', 'HEAD')?.patch).toBe('B'); // untouched
  });

  it('clears the whole project on a git-state (baseline) change', () => {
    const c = new DiffBundleCache();
    c.set('p1', '/wt', 'src/a.ts', 'HEAD', bundle('A'));
    c.set('p1', '/wt', 'src/b.ts', 'HEAD', bundle('B'));
    c.onWatch('p1', ['.git/HEAD']); // branch switch → every diff baseline changed
    expect(c.get('p1', '/wt', 'src/a.ts', 'HEAD')).toBeUndefined();
    expect(c.get('p1', '/wt', 'src/b.ts', 'HEAD')).toBeUndefined();
  });

  it('isGitStateSignal matches HEAD / packed-refs / refs/* only', () => {
    expect(isGitStateSignal('.git/HEAD')).toBe(true);
    expect(isGitStateSignal('.git/packed-refs')).toBe(true);
    expect(isGitStateSignal('.git/refs/heads/main')).toBe(true);
    expect(isGitStateSignal('src/a.ts')).toBe(false);
    expect(isGitStateSignal('.git/index')).toBe(false);
  });

  it('evictProject and a watch on another project do not cross-invalidate', () => {
    const c = new DiffBundleCache();
    c.set('p1', '/wt', 'src/a.ts', 'HEAD', bundle('A'));
    c.set('p2', '/wt', 'src/a.ts', 'HEAD', bundle('A2'));
    c.onWatch('p1', ['.git/HEAD']);
    expect(c.get('p2', '/wt', 'src/a.ts', 'HEAD')?.patch).toBe('A2'); // p2 untouched
    c.evictProject('p2');
    expect(c.get('p2', '/wt', 'src/a.ts', 'HEAD')).toBeUndefined();
  });

  it('bounds entries per project (oldest evicted)', () => {
    const c = new DiffBundleCache();
    for (let i = 0; i < 70; i += 1) c.set('p1', '/wt', `f${i}.ts`, 'HEAD', bundle(String(i)));
    expect(c.get('p1', '/wt', 'f0.ts', 'HEAD')).toBeUndefined(); // evicted (cap 64)
    expect(c.get('p1', '/wt', 'f69.ts', 'HEAD')?.patch).toBe('69'); // newest kept
  });

  describe('worktreePath-tagged invalidation (active-external-worktree watch; local_repo_explorer-g1je)', () => {
    it('a worktreePath-tagged batch drops only entries stored for that SAME worktree, matching by path', () => {
      const c = new DiffBundleCache();
      c.set('p1', '/sibling-wt', 'a.ts', 'HEAD', bundle('sibling-A'));
      c.set('p1', '/repo', 'a.ts', 'HEAD', bundle('root-A')); // same file NAME, different worktree
      c.onWatch('p1', ['a.ts'], '/sibling-wt');
      expect(c.get('p1', '/sibling-wt', 'a.ts', 'HEAD')).toBeUndefined(); // invalidated
      expect(c.get('p1', '/repo', 'a.ts', 'HEAD')?.patch).toBe('root-A'); // untouched — different worktree
    });

    it('a worktreePath-tagged batch never cross-matches an entry for a DIFFERENT worktree, even with an identical changed-path name', () => {
      const c = new DiffBundleCache();
      c.set('p1', '/repo', 'a.ts', 'HEAD', bundle('root-A'));
      c.onWatch('p1', ['a.ts'], '/sibling-wt'); // tagged for a worktree with no cached entries at all
      expect(c.get('p1', '/repo', 'a.ts', 'HEAD')?.patch).toBe('root-A'); // untouched
    });

    it('a worktreePath-tagged batch never clears the whole project on a git-state-shaped path (the active-external-worktree watch never emits git-state signals)', () => {
      const c = new DiffBundleCache();
      c.set('p1', '/sibling-wt', 'a.ts', 'HEAD', bundle('sibling-A'));
      c.set('p1', '/sibling-wt', 'b.ts', 'HEAD', bundle('sibling-B'));
      // Even a git-HEAD-shaped path, if it somehow arrived tagged, must be
      // treated as an ordinary changed path (matched by exact membership),
      // never as a project-wide clear signal — that branch is reserved for
      // UNTAGGED batches only.
      c.onWatch('p1', ['.git/HEAD'], '/sibling-wt');
      expect(c.get('p1', '/sibling-wt', 'a.ts', 'HEAD')?.patch).toBe('sibling-A'); // untouched
      expect(c.get('p1', '/sibling-wt', 'b.ts', 'HEAD')?.patch).toBe('sibling-B'); // untouched
    });

    it('an UNTAGGED batch (worktreePath omitted) keeps its existing untouched-by-worktree-identity behavior — matches by path alone, regardless of stored worktreePath', () => {
      const c = new DiffBundleCache();
      c.set('p1', '/repo', 'a.ts', 'HEAD', bundle('root-A'));
      c.set('p1', '/repo/.worktrees/nested', 'a.ts', 'HEAD', bundle('nested-A'));
      c.onWatch('p1', ['a.ts']); // no worktreePath arg at all — the primary watch's shape
      // Byte-for-byte pre-g1je behavior: an untagged batch matches by path
      // alone, dropping BOTH entries regardless of their own worktreePath.
      expect(c.get('p1', '/repo', 'a.ts', 'HEAD')).toBeUndefined();
      expect(c.get('p1', '/repo/.worktrees/nested', 'a.ts', 'HEAD')).toBeUndefined();
    });
  });
});
