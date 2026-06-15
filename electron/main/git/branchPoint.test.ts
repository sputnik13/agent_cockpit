/**
 * Unit tests for resolveBranchPoint (electron/main/git/branchPoint.ts).
 * Uses a real git repo created in a temp directory to exercise the parent
 * resolution rule without mocking simple-git.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBranchPoint } from './branchPoint';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execSync(['git', ...args].join(' '), { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

describe('resolveBranchPoint', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'branchpoint-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for empty worktreePath', async () => {
    const result = await resolveBranchPoint('');
    expect(result).toBeNull();
  });

  it('returns null for a fresh repo with no upstream and no remote', async () => {
    git(tmpDir, 'init -b main');
    writeFileSync(join(tmpDir, 'f.txt'), 'hello\n');
    git(tmpDir, 'add f.txt');
    git(tmpDir, 'commit -m initial');

    const result = await resolveBranchPoint(tmpDir);
    expect(result).toBeNull();
  });

  it('returns default kind when origin/main is present but no upstream is set', async () => {
    // Create origin
    const originDir = mkdtempSync(join(tmpdir(), 'branchpoint-origin-'));
    try {
      git(originDir, 'init -b main');
      writeFileSync(join(originDir, 'f.txt'), 'hello\n');
      git(originDir, 'add f.txt');
      git(originDir, 'commit -m initial');

      // Clone into tmpDir; sets origin/HEAD → origin/main.
      git(tmpDir, `clone ${originDir} .`);
      // Create a feature branch with no upstream set.
      git(tmpDir, 'checkout -b feature');
      writeFileSync(join(tmpDir, 'new.txt'), 'new\n');
      git(tmpDir, 'add new.txt');
      git(tmpDir, 'commit -m feature');

      const result = await resolveBranchPoint(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.parentKind).toBe('default');
      expect(result!.parentRef).toBeTruthy();
      expect(result!.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it('returns upstream kind when branch has tracking upstream configured', async () => {
    const originDir = mkdtempSync(join(tmpdir(), 'branchpoint-origin-'));
    try {
      git(originDir, 'init -b main');
      writeFileSync(join(originDir, 'f.txt'), 'hello\n');
      git(originDir, 'add f.txt');
      git(originDir, 'commit -m initial');

      git(tmpDir, `clone ${originDir} .`);
      // Create a feature branch that tracks origin/main explicitly.
      git(tmpDir, 'checkout -b feature --track origin/main');
      writeFileSync(join(tmpDir, 'feature.txt'), 'feature\n');
      git(tmpDir, 'add feature.txt');
      git(tmpDir, 'commit -m feature');

      const result = await resolveBranchPoint(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.parentKind).toBe('upstream');
      expect(result!.parentRef).toBeTruthy();
      expect(result!.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });

  it('returns the merge-base SHA that separates branch from parent', async () => {
    const originDir = mkdtempSync(join(tmpdir(), 'branchpoint-origin-'));
    try {
      git(originDir, 'init -b main');
      writeFileSync(join(originDir, 'base.txt'), 'base\n');
      git(originDir, 'add base.txt');
      git(originDir, 'commit -m initial');

      git(tmpDir, `clone ${originDir} .`);
      git(tmpDir, 'checkout -b feature --track origin/main');
      writeFileSync(join(tmpDir, 'branch.txt'), 'branch\n');
      git(tmpDir, 'add branch.txt');
      git(tmpDir, 'commit -m branch-commit');

      const result = await resolveBranchPoint(tmpDir);
      expect(result).not.toBeNull();

      // The merge-base must be the initial commit on main (where we branched from).
      const expectedMergeBase = git(tmpDir, 'merge-base HEAD origin/main');
      expect(result!.mergeBase).toBe(expectedMergeBase);
    } finally {
      rmSync(originDir, { recursive: true, force: true });
    }
  });
});
