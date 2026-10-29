// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ProjectInfo } from '@shared/ipc/channels';
import { classifyOpenTarget } from '@main/callback/classify';
import type { ContentSelection } from './selectionStore';
import { EMPTY_TABS, openTab, tabIdFor } from './tabState';

/**
 * Scenario 12: a callback `open` must land on the SAME tab the Explorer (or a
 * link) opens for the same file. Tab identity is the fully-qualified path, so
 * the selection main builds has to resolve to the same string the Explorer's
 * selection does — built from the same inputs: the worktree path the Explorer
 * reads from plus the entry path relative to it.
 */
const project = (rootPath: string): ProjectInfo =>
  ({ id: 'p', connection: { kind: 'local', rootPath } }) as unknown as ProjectInfo;

/** What ExplorerPanel's FileNode selects for `rel` listed under `worktreePath` ('' = project root). */
const explorerSelection = (rel: string, worktreePath: string): ContentSelection => ({
  path: rel,
  worktreePath,
  kind: 'file',
});

describe("callback open tab identity equals the Explorer's (scenario 12)", () => {
  it('for a file in the primary worktree', () => {
    const p = project('/repo');
    const fromCallback = classifyOpenTarget({
      path: '/repo/src/a.ts',
      canonicalPath: '/repo/src/a.ts',
      worktrees: ['/repo'],
      projectRoots: ['/repo'],
    });
    expect(tabIdFor(fromCallback, p)).toBe(tabIdFor(explorerSelection('src/a.ts', '/repo'), p));
    expect(tabIdFor(fromCallback, p)).toBe('/repo/src/a.ts');
  });

  it('for a file in a linked worktree outside the project root', () => {
    const p = project('/repo');
    const fromCallback = classifyOpenTarget({
      path: '/wt/feat/docs/x.md',
      canonicalPath: '/wt/feat/docs/x.md',
      worktrees: ['/repo', '/wt/feat'],
      projectRoots: ['/repo'],
    });
    expect(tabIdFor(fromCallback, p)).toBe(tabIdFor(explorerSelection('docs/x.md', '/wt/feat'), p));
    expect(tabIdFor(fromCallback, p)).toBe('/wt/feat/docs/x.md');
  });

  it("for a file reached through a symlinked project root (the Explorer reads from git's canonical root)", () => {
    const p = project('/tmp/proj'); // configured through the /tmp symlink
    const fromCallback = classifyOpenTarget({
      path: '/tmp/proj/a.md',
      canonicalPath: '/private/tmp/proj/a.md',
      worktrees: ['/private/tmp/proj'],
      projectRoots: ['/tmp/proj', '/private/tmp/proj'],
    });
    expect(tabIdFor(fromCallback, p)).toBe(
      tabIdFor(explorerSelection('a.md', '/private/tmp/proj'), p),
    );
  });

  it('for a file whose canonical path the CLI could not compute, under a symlinked project root', () => {
    const p = project('/tmp/proj');
    const fromCallback = classifyOpenTarget({
      path: '/tmp/proj/a.md', // logical only
      worktrees: ['/private/tmp/proj'],
      projectRoots: ['/tmp/proj', '/private/tmp/proj'],
      rootAlias: { configured: '/tmp/proj', canonical: '/private/tmp/proj' },
    });
    expect(tabIdFor(fromCallback, p)).toBe(
      tabIdFor(explorerSelection('a.md', '/private/tmp/proj'), p),
    );
  });

  it('for a file in a non-git project (worktreePath "" and a root-relative path)', () => {
    const p = project('/proj');
    const fromCallback = classifyOpenTarget({
      path: '/proj/notes/a.md',
      canonicalPath: '/proj/notes/a.md',
      worktrees: [],
      projectRoots: ['/proj'],
    });
    expect(fromCallback.worktreePath).toBe('');
    expect(tabIdFor(fromCallback, p)).toBe(tabIdFor(explorerSelection('notes/a.md', ''), p));
    expect(tabIdFor(fromCallback, p)).toBe('/proj/notes/a.md');
  });

  it('for an out-of-project file, matching the external selection a link opens', () => {
    const p = project('/repo');
    const fromCallback = classifyOpenTarget({
      path: '/etc/hosts',
      canonicalPath: '/private/etc/hosts',
      worktrees: ['/repo'],
      projectRoots: ['/repo'],
    });
    const fromLink: ContentSelection = {
      path: '/etc/hosts',
      worktreePath: '',
      kind: 'external-file',
    };
    expect(tabIdFor(fromCallback, p)).toBe(tabIdFor(fromLink, p));
  });

  it("so re-opening the same file from the terminal activates the Explorer's tab instead of adding one", () => {
    const p = project('/repo');
    const explorer = explorerSelection('src/a.ts', '/repo');
    const callback = classifyOpenTarget({
      path: '/repo/src/a.ts',
      canonicalPath: '/repo/src/a.ts',
      worktrees: ['/repo'],
      projectRoots: ['/repo'],
    });
    const once = openTab(EMPTY_TABS, tabIdFor(explorer, p), explorer);
    const twice = openTab(once, tabIdFor(callback, p), callback);
    expect(twice.tabs).toHaveLength(1);
    expect(twice.activeId).toBe(once.activeId);
  });
});
