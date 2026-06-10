import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalProvider } from './index';

/** br on PATH? The write round-trip needs it; otherwise the suite is skipped. */
function hasBr(): boolean {
  try {
    return spawnSync('br', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const run = hasBr() ? describe : describe.skip;

run('LocalProvider beads write surface (real br round-trip, FA-6a)', () => {
  let repo: string;
  let provider: LocalProvider;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'cockpit-beads-write-'));
    execFileSync('br', ['init'], { cwd: repo, stdio: 'pipe' });
    provider = new LocalProvider('proj', repo);
  });

  it('creates a child, comments, lists, closes, and reopens through br', async () => {
    const parent = await provider.beadsCreate({ title: 'Parent epic', priority: 1 });
    expect(parent).toBeTruthy();

    const child = await provider.beadsCreate({
      title: 'Child task',
      parent: parent!,
      priority: 2,
      description: 'body',
    });
    expect(child).toBeTruthy();

    // The created issues appear in the graph (read path stays on SQLite).
    const graph = await provider.getTaskGraph();
    expect(graph.issues.some((i) => i.id === child)).toBe(true);

    // Comment round-trips through `br comments add` + `list`.
    await provider.beadsComment(child!, 'first comment');
    const comments = await provider.beadsListComments(child!);
    expect(comments.map((c) => c.text)).toContain('first comment');
    expect(comments[0]?.issueId).toBe(child);

    // Close then reopen flips status (read back from the graph).
    await provider.beadsClose(child!, 'done for now');
    const afterClose = await provider.getTask(child!);
    expect(afterClose?.status).toBe('closed');

    await provider.beadsReopen(child!);
    const afterReopen = await provider.getTask(child!);
    expect(afterReopen?.status).not.toBe('closed');
  });

  it('rejects with br’s message on an invalid operation', async () => {
    await expect(provider.beadsClose('does-not-exist-xyz')).rejects.toThrow();
  });
});
