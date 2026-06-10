import { mkdtempSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitignoreFilter } from './gitignoreFilter';

const dirStats = { isDirectory: () => true } as Stats;

describe('createGitignoreFilter', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitignore-filter-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ignores paths matched by the root .gitignore (dir and glob)', () => {
    writeFileSync(join(root, '.gitignore'), 'data/\n*.log\n');
    const ignored = createGitignoreFilter(root);

    // Everything under a `data/` pattern is pruned (this is what avoids EMFILE).
    expect(ignored(join(root, 'data', 'faces'))).toBe(true);
    expect(ignored(join(root, 'data', 'faces', 'face_1.jpg'))).toBe(true);
    expect(ignored(join(root, 'debug.log'))).toBe(true);
    expect(ignored(join(root, 'src', 'index.ts'))).toBe(false);
  });

  it('prunes a `dir/` pattern at the directory itself when stats say it is a dir', () => {
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    const ignored = createGitignoreFilter(root);
    // Bare path with no stats: gitignore `data/` does not match bare `data`.
    expect(ignored(join(root, 'data'))).toBe(false);
    // With directory stats, the dir itself is pruned (no descent at all).
    expect(ignored(join(root, 'data'), dirStats)).toBe(true);
  });

  it('always ignores node_modules even when .gitignore omits it', () => {
    writeFileSync(join(root, '.gitignore'), '# empty\n');
    const ignored = createGitignoreFilter(root);
    expect(ignored(join(root, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('never ignores the root itself or paths outside it', () => {
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    const ignored = createGitignoreFilter(root);
    expect(ignored(root)).toBe(false);
    expect(ignored(join(root, '..', 'elsewhere', 'x.txt'))).toBe(false);
  });

  it('accepts cwd-relative paths as well as absolute', () => {
    writeFileSync(join(root, '.gitignore'), 'data/\n');
    const ignored = createGitignoreFilter(root);
    expect(ignored('data/faces/face_1.jpg')).toBe(true);
    expect(ignored('src/index.ts')).toBe(false);
  });

  it('degrades to node_modules-only when .gitignore is absent', () => {
    const ignored = createGitignoreFilter(root);
    expect(ignored(join(root, 'node_modules', 'x.js'))).toBe(true);
    expect(ignored(join(root, 'data', 'face_1.jpg'))).toBe(false);
  });
});
