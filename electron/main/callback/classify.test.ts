import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { classifyOpenTarget, resolveOpenSelection, type OpenTargetDeps } from './classify';

const wt = (path: string): WorktreeRecord => ({
  path,
  branch: 'main',
  head: 'abc',
  locked: false,
  prunable: false,
  detached: false,
});

describe('classifyOpenTarget (scenario 12)', () => {
  it('opens a file in the primary worktree, relative to it', () => {
    expect(
      classifyOpenTarget({
        path: '/repo/src/a.ts',
        canonicalPath: '/repo/src/a.ts',
        worktrees: ['/repo'],
        projectRoots: ['/repo'],
      }),
    ).toEqual({ kind: 'file', path: 'src/a.ts', worktreePath: '/repo' });
  });

  it('opens a file in a linked worktree with that worktree in its identity', () => {
    expect(
      classifyOpenTarget({
        path: '/wt/feat/docs/x.md',
        canonicalPath: '/wt/feat/docs/x.md',
        worktrees: ['/repo', '/wt/feat'],
        projectRoots: ['/repo'],
      }),
    ).toEqual({ kind: 'file', path: 'docs/x.md', worktreePath: '/wt/feat' });
  });

  it('prefers the deepest worktree when a linked one lives inside the primary', () => {
    const input = {
      worktrees: ['/repo', '/repo/.worktrees/feat'],
      projectRoots: ['/repo'],
    };
    expect(
      classifyOpenTarget({
        ...input,
        path: '/repo/.worktrees/feat/a.md',
        canonicalPath: '/repo/.worktrees/feat/a.md',
      }),
    ).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/repo/.worktrees/feat' });
    expect(
      classifyOpenTarget({ ...input, path: '/repo/other.md', canonicalPath: '/repo/other.md' }),
    ).toEqual({
      kind: 'file',
      path: 'other.md',
      worktreePath: '/repo',
    });
  });

  it('uses the canonical path, so a symlinked logical path is not external', () => {
    // /tmp -> /private/tmp on macOS; git reports the canonical worktree root.
    expect(
      classifyOpenTarget({
        path: '/tmp/proj/a.md',
        canonicalPath: '/private/tmp/proj/a.md',
        worktrees: ['/private/tmp/proj'],
        projectRoots: ['/tmp/proj', '/private/tmp/proj'],
      }),
    ).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/private/tmp/proj' });
    // A symlinked home directory behaves the same.
    expect(
      classifyOpenTarget({
        path: '/home/me/work/repo/n.md',
        canonicalPath: '/data/home/me/work/repo/n.md',
        worktrees: ['/data/home/me/work/repo'],
        projectRoots: ['/home/me/work/repo'],
      }),
    ).toEqual({ kind: 'file', path: 'n.md', worktreePath: '/data/home/me/work/repo' });
  });

  it('opens an unrelated tree as an external file with the LOGICAL path', () => {
    expect(
      classifyOpenTarget({
        path: '/etc/hosts',
        canonicalPath: '/private/etc/hosts',
        worktrees: ['/repo'],
        projectRoots: ['/repo'],
      }),
    ).toEqual({ kind: 'external-file', path: '/etc/hosts', worktreePath: '' });
  });

  it('opens a file in a non-git project relative to the root with worktreePath ""', () => {
    expect(
      classifyOpenTarget({
        path: '/proj/notes/a.md',
        canonicalPath: '/proj/notes/a.md',
        worktrees: [],
        projectRoots: ['/proj'],
      }),
    ).toEqual({ kind: 'file', path: 'notes/a.md', worktreePath: '' });
  });

  it('falls back to a lexical match when the CLI sent no canonical path', () => {
    const input = { worktrees: ['/repo'], projectRoots: ['/repo'] };
    expect(classifyOpenTarget({ ...input, path: '/repo/a.md' })).toEqual({
      kind: 'file',
      path: 'a.md',
      worktreePath: '/repo',
    });
    expect(classifyOpenTarget({ ...input, path: '/elsewhere/a.md' })).toMatchObject({
      kind: 'external-file',
    });
  });

  it('matches whole path components, not string prefixes', () => {
    expect(
      classifyOpenTarget({
        path: '/repo-other/a.md',
        worktrees: ['/repo'],
        projectRoots: ['/repo'],
      }),
    ).toEqual({ kind: 'external-file', path: '/repo-other/a.md', worktreePath: '' });
  });

  it('treats the worktree root itself (a directory) as external, never an empty relative path', () => {
    expect(
      classifyOpenTarget({ path: '/repo', worktrees: ['/repo'], projectRoots: ['/repo'] }),
    ).toMatchObject({
      kind: 'external-file',
      path: '/repo',
    });
    expect(
      classifyOpenTarget({ path: '/repo/', worktrees: ['/repo'], projectRoots: ['/repo'] }),
    ).toMatchObject({
      kind: 'external-file',
      path: '/repo',
    });
  });

  it('normalizes dot segments and repeated slashes', () => {
    expect(
      classifyOpenTarget({
        path: '/repo//src/./x/../a.md',
        worktrees: ['/repo'],
        projectRoots: ['/repo'],
      }),
    ).toEqual({ kind: 'file', path: 'src/a.md', worktreePath: '/repo' });
  });

  it('hands back the worktree path exactly as the provider reported it', () => {
    expect(
      classifyOpenTarget({ path: '/repo/a.md', worktrees: ['/repo/'], projectRoots: [] }),
    ).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/repo/' });
  });

  it('handles spaces, non-ASCII names and a root worktree', () => {
    expect(
      classifyOpenTarget({
        path: '/Users/me/My Repo/日本語 notes/ö.md',
        worktrees: ['/Users/me/My Repo'],
        projectRoots: [],
      }),
    ).toEqual({ kind: 'file', path: '日本語 notes/ö.md', worktreePath: '/Users/me/My Repo' });
    expect(classifyOpenTarget({ path: '/a/b', worktrees: ['/'], projectRoots: [] })).toEqual({
      kind: 'file',
      path: 'a/b',
      worktreePath: '/',
    });
  });

  describe('with no canonical path from the CLI and a symlinked project root', () => {
    // /tmp/proj is a symlink to /private/tmp/proj; git reports the canonical worktree root.
    const alias = { configured: '/tmp/proj', canonical: '/private/tmp/proj' };
    const base = {
      worktrees: ['/private/tmp/proj'],
      projectRoots: ['/tmp/proj', '/private/tmp/proj'],
    };

    it('rewrites the configured-root prefix to its realpath and matches the worktree', () => {
      expect(classifyOpenTarget({ ...base, path: '/tmp/proj/src/a.md', rootAlias: alias })).toEqual(
        {
          kind: 'file',
          path: 'src/a.md',
          worktreePath: '/private/tmp/proj',
        },
      );
    });

    it("would otherwise fall through to the project root and miss the Explorer's worktree identity", () => {
      expect(classifyOpenTarget({ ...base, path: '/tmp/proj/src/a.md' })).toEqual({
        kind: 'file',
        path: 'src/a.md',
        worktreePath: '',
      });
    });

    it('finds a linked worktree nested inside the symlinked root', () => {
      expect(
        classifyOpenTarget({
          path: '/tmp/proj/.worktrees/feat/x.md',
          worktrees: ['/private/tmp/proj', '/private/tmp/proj/.worktrees/feat'],
          projectRoots: base.projectRoots,
          rootAlias: alias,
        }),
      ).toEqual({ kind: 'file', path: 'x.md', worktreePath: '/private/tmp/proj/.worktrees/feat' });
    });

    it('still prefers a lexical match on the logical path itself', () => {
      expect(
        classifyOpenTarget({
          path: '/tmp/proj/wt/a.md',
          worktrees: ['/tmp/proj/wt', '/private/tmp/proj'],
          projectRoots: base.projectRoots,
          rootAlias: alias,
        }),
      ).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/tmp/proj/wt' });
    });

    it('leaves a path outside the configured root alone', () => {
      expect(classifyOpenTarget({ ...base, path: '/etc/hosts', rootAlias: alias })).toEqual({
        kind: 'external-file',
        path: '/etc/hosts',
        worktreePath: '',
      });
    });

    it('is not applied when the CLI did send a canonical path: that one decides', () => {
      expect(
        classifyOpenTarget({
          ...base,
          path: '/tmp/proj/link/x.md',
          canonicalPath: '/elsewhere/x.md',
          rootAlias: alias,
        }),
      ).toEqual({ kind: 'external-file', path: '/tmp/proj/link/x.md', worktreePath: '' });
    });
  });

  it('never carries a baseline (a plain file open must not force a git-ref read)', () => {
    for (const input of [
      { path: '/repo/a.md', worktrees: ['/repo'], projectRoots: ['/repo'] },
      { path: '/proj/a.md', worktrees: [], projectRoots: ['/proj'] },
      { path: '/etc/hosts', worktrees: [], projectRoots: ['/proj'] },
    ]) {
      const selection = classifyOpenTarget(input);
      expect(selection).not.toHaveProperty('baseline');
      expect(Object.keys(selection).sort()).toEqual(['kind', 'path', 'worktreePath']);
    }
  });
});

describe('resolveOpenSelection (scenario 12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync('/tmp/accb-c-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the Go CLI computes: the symlink-resolved PARENT directory joined with the base name. */
  const canonicalLikeCli = (logical: string): string =>
    join(realpathSync(dirname(logical)), basename(logical));

  function local(worktrees: WorktreeRecord[] | Error, projectRoot: string): OpenTargetDeps {
    return {
      provider: {
        kind: 'local',
        listWorktrees: async () => {
          if (worktrees instanceof Error) throw worktrees;
          return worktrees;
        },
      },
      projectRoot,
      realpath: async (p) => realpathSync(p),
    };
  }

  it('classifies a symlinked project root through the real filesystem (non-git)', async () => {
    mkdirSync(join(dir, 'real', 'proj', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'real', 'proj', 'sub', 'a.md'), '# a');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const logical = join(dir, 'link', 'proj', 'sub', 'a.md');
    const selection = await resolveOpenSelection(
      local(new Error('not a git repository'), join(dir, 'link', 'proj')),
      {
        path: logical,
        canonicalPath: canonicalLikeCli(logical),
      },
    );
    expect(selection).toEqual({ kind: 'file', path: 'sub/a.md', worktreePath: '' });
  });

  it("reaches a worktree through a symlinked path using git's canonical roots", async () => {
    mkdirSync(join(dir, 'real', 'proj'), { recursive: true });
    writeFileSync(join(dir, 'real', 'proj', 'a.md'), '# a');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const logical = join(dir, 'link', 'proj', 'a.md');
    const selection = await resolveOpenSelection(
      local([wt(join(dir, 'real', 'proj'))], join(dir, 'link', 'proj')),
      { path: logical, canonicalPath: canonicalLikeCli(logical) },
    );
    expect(selection).toEqual({
      kind: 'file',
      path: 'a.md',
      worktreePath: join(dir, 'real', 'proj'),
    });
  });

  describe('when the CLI could not canonicalize (only the logical path arrives)', () => {
    function symlinkedRoot(): { logical: string; real: string } {
      mkdirSync(join(dir, 'real', 'proj', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'real', 'proj', 'sub', 'a.md'), '# a');
      symlinkSync(join(dir, 'real'), join(dir, 'link'));
      return {
        logical: join(dir, 'link', 'proj', 'sub', 'a.md'),
        real: join(dir, 'real', 'proj'),
      };
    }

    it('uses the realpath of a symlinked root to find the worktree git reports', async () => {
      const { logical, real } = symlinkedRoot();
      const selection = await resolveOpenSelection(local([wt(real)], join(dir, 'link', 'proj')), {
        path: logical,
      });
      expect(selection).toEqual({ kind: 'file', path: 'sub/a.md', worktreePath: real });
    });

    it('is unchanged for a non-git project: root-relative with worktreePath ""', async () => {
      const { logical } = symlinkedRoot();
      const selection = await resolveOpenSelection(
        local(new Error('not a git repository'), join(dir, 'link', 'proj')),
        { path: logical },
      );
      expect(selection).toEqual({ kind: 'file', path: 'sub/a.md', worktreePath: '' });
    });

    it('needs no rewrite when the root is not a symlink', async () => {
      mkdirSync(join(dir, 'plain'), { recursive: true });
      const logical = join(dir, 'plain', 'a.md');
      expect(
        await resolveOpenSelection(local([wt(join(dir, 'plain'))], join(dir, 'plain')), {
          path: logical,
        }),
      ).toEqual({ kind: 'file', path: 'a.md', worktreePath: join(dir, 'plain') });
    });
  });

  it('does not treat a symlinked FILE inside a worktree as external', async () => {
    mkdirSync(join(dir, 'wt'), { recursive: true });
    mkdirSync(join(dir, 'outside'), { recursive: true });
    writeFileSync(join(dir, 'outside', 'real.md'), '# real');
    symlinkSync(join(dir, 'outside', 'real.md'), join(dir, 'wt', 'link.md'));
    const logical = join(dir, 'wt', 'link.md');
    // The CLI resolves only the PARENT, so the link keeps its place inside the worktree...
    expect(canonicalLikeCli(logical)).toBe(join(dir, 'wt', 'link.md'));
    expect(
      await resolveOpenSelection(local([wt(join(dir, 'wt'))], join(dir, 'wt')), {
        path: logical,
        canonicalPath: canonicalLikeCli(logical),
      }),
    ).toEqual({ kind: 'file', path: 'link.md', worktreePath: join(dir, 'wt') });
    // ...whereas resolving the file itself would have misclassified it.
    expect(
      await resolveOpenSelection(local([wt(join(dir, 'wt'))], join(dir, 'wt')), {
        path: logical,
        canonicalPath: realpathSync(logical),
      }),
    ).toMatchObject({ kind: 'external-file' });
  });

  it('opens an unrelated tree as an external file', async () => {
    mkdirSync(join(dir, 'proj'), { recursive: true });
    mkdirSync(join(dir, 'other'), { recursive: true });
    const logical = join(dir, 'other', 'x.md');
    expect(
      await resolveOpenSelection(local([wt(join(dir, 'proj'))], join(dir, 'proj')), {
        path: logical,
        canonicalPath: logical,
      }),
    ).toEqual({ kind: 'external-file', path: logical, worktreePath: '' });
  });

  it('treats a failed worktree listing as "no worktrees", like the renderer worktree store', async () => {
    const selection = await resolveOpenSelection(
      local(new Error('git: not a repository'), '/proj'),
      {
        path: '/proj/a.md',
      },
    );
    expect(selection).toEqual({ kind: 'file', path: 'a.md', worktreePath: '' });
  });

  it('survives an unresolvable local root and still matches it in its configured form', async () => {
    const deps = local([], '/gone/proj');
    deps.realpath = async () => {
      throw new Error('ENOENT');
    };
    expect(await resolveOpenSelection(deps, { path: '/gone/proj/a.md' })).toEqual({
      kind: 'file',
      path: 'a.md',
      worktreePath: '',
    });
  });

  describe('remote projects use no remote realpath, resolvePath or stat', () => {
    function remote(worktrees: WorktreeRecord[]) {
      const probes = {
        realpath: vi.fn(async (p: string) => p),
        resolvePath: vi.fn(),
        stat: vi.fn(),
        readFile: vi.fn(),
        listDir: vi.fn(),
      };
      const listWorktrees = vi.fn(async () => worktrees);
      const deps = {
        provider: { kind: 'remote' as const, listWorktrees, ...probes },
        projectRoot: '/home/u/proj',
        realpath: probes.realpath,
      } satisfies OpenTargetDeps;
      return { deps, probes, listWorktrees };
    }

    it("classifies against the helper's worktree roots and the configured remotePath", async () => {
      const { deps, probes, listWorktrees } = remote([wt('/home/u/proj'), wt('/home/u/feat')]);
      expect(
        await resolveOpenSelection(deps, {
          path: '/home/u/feat/x.md',
          canonicalPath: '/home/u/feat/x.md',
        }),
      ).toEqual({ kind: 'file', path: 'x.md', worktreePath: '/home/u/feat' });
      expect(await resolveOpenSelection(deps, { path: '/etc/hosts' })).toMatchObject({
        kind: 'external-file',
      });
      expect(listWorktrees).toHaveBeenCalledTimes(2);
      for (const probe of Object.values(probes)) expect(probe).not.toHaveBeenCalled();
    });

    it('classifies a symlinked remotePath without worktrees as external (documented limitation)', async () => {
      // remotePath is /home/u/proj but the host's canonical root is /data/u/proj, and
      // main has no remote realpath to learn that: the canonical path does not match.
      const { deps, probes } = remote([]);
      expect(
        await resolveOpenSelection(deps, {
          path: '/home/u/proj/a.md',
          canonicalPath: '/data/u/proj/a.md',
        }),
      ).toEqual({ kind: 'external-file', path: '/home/u/proj/a.md', worktreePath: '' });
      expect(probes.realpath).not.toHaveBeenCalled();
    });

    it("still matches a symlinked remotePath through the helper's canonical worktree roots", async () => {
      const { deps } = remote([wt('/data/u/proj')]);
      expect(
        await resolveOpenSelection(deps, {
          path: '/home/u/proj/a.md',
          canonicalPath: '/data/u/proj/a.md',
        }),
      ).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/data/u/proj' });
    });
  });
});
