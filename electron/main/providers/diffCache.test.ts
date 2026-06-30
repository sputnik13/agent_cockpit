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
});
