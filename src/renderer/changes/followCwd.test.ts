// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';

// `@renderer/providerClient` resolves `window.api` at module import time.
// Install a minimal stub before any renderer modules are imported so module
// evaluation succeeds even though these tests only exercise the pure mapper.
beforeAll(() => {
  (globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      provider: { listWorktrees: vi.fn(), getChangeset: vi.fn() },
      events: { onWatch: vi.fn(() => () => {}), onStatus: vi.fn(() => () => {}), onSettingsChanged: vi.fn(() => () => {}) },
      settings: { get: vi.fn(), set: vi.fn(), listFonts: vi.fn() },
    },
  };
});

// Import the function under test after the window stub is in place.
// Dynamic import avoids top-level evaluation ordering issues.
let worktreeForCwd: (worktrees: WorktreeRecord[], cwd: string) => string | null;

beforeAll(async () => {
  const mod = await import('./followCwd');
  worktreeForCwd = mod.worktreeForCwd;
});

function wt(path: string): WorktreeRecord {
  return { path, branch: 'main', head: 'abc', locked: false, prunable: false, detached: false };
}

describe('worktreeForCwd', () => {
  const worktrees = [
    wt('/repo'),
    wt('/repo/worktrees/feat'),
    wt('/other'),
  ];

  it('returns null for an empty cwd', () => {
    expect(worktreeForCwd(worktrees, '')).toBeNull();
  });

  it('returns null when no worktree is a prefix of cwd', () => {
    expect(worktreeForCwd(worktrees, '/unrelated/path')).toBeNull();
  });

  it('does not match on a partial path-segment boundary (/repo-fork is not /repo)', () => {
    expect(worktreeForCwd(worktrees, '/repo-fork/src')).toBeNull();
  });

  it('exact match: cwd equals the worktree path', () => {
    expect(worktreeForCwd(worktrees, '/repo')).toBe('/repo');
  });

  it('prefix match: cwd is inside a worktree', () => {
    expect(worktreeForCwd(worktrees, '/repo/src/foo')).toBe('/repo');
  });

  it('longest-match: nested worktree wins over parent', () => {
    expect(worktreeForCwd(worktrees, '/repo/worktrees/feat/src')).toBe('/repo/worktrees/feat');
  });

  it('exact match on a nested worktree', () => {
    expect(worktreeForCwd(worktrees, '/repo/worktrees/feat')).toBe('/repo/worktrees/feat');
  });

  it('returns null for an empty worktrees list', () => {
    expect(worktreeForCwd([], '/repo/src')).toBeNull();
  });

  it('tolerates a trailing slash on cwd', () => {
    expect(worktreeForCwd(worktrees, '/repo/src/')).toBe('/repo');
  });

  it('tolerates a trailing slash on worktree path', () => {
    const wtTrailing = [wt('/repo/')];
    expect(worktreeForCwd(wtTrailing, '/repo/src')).toBe('/repo/');
  });
});
