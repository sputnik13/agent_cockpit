import { mkdtempSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitignoreFilter } from './gitignoreFilter';

const dirStats = { isDirectory: () => true } as Stats;

/**
 * One case from the shared TS/Go gitignore-matching parity fixture
 * (`remote-helper/testdata/gitignore-parity.json`). `expected` is the
 * correct-per-git-semantics result (verified against real `git check-ignore`
 * -- see the fixture file's own per-case `description`). `knownDivergence`,
 * when present, documents a real, already-discovered mismatch between this
 * TS `ignore`-based filter and the Go `go-gitignore`-based filter for that
 * exact case (local_repo_explorer-wkxb); it is informational only here since
 * this filter is correct on every fixture case today -- the Go test is the
 * one that consults it.
 */
interface GitignoreParityCase {
  id: string;
  description: string;
  patterns: string[];
  path: string;
  isDir: boolean;
  expected: boolean;
  knownDivergence?: { engine: string; actual: boolean; reason: string };
}

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

/**
 * TS/Go gitignore-matching parity fixture (local_repo_explorer-wkxb). Local
 * gitignore matching uses the npm `ignore` package (this file); the remote
 * helper (`remote-helper/watch.go`) uses Go's `github.com/sabhiram/go-gitignore`
 * -- two independently-implemented engines with no prior shared test corpus.
 * `remote-helper/testdata/gitignore-parity.json` is the single shared fixture;
 * `remote-helper/watch_test.go`'s `TestGitignoreParityFixture` runs the SAME
 * file through the Go engine. A future edge-case divergence between the two
 * engines should show up here instead of being discovered silently in the
 * field.
 *
 * Every case's `expected` value is the correct-per-git-semantics result,
 * verified against real `git check-ignore`. This TS filter is correct on
 * every case in the fixture today, so this suite asserts `expected`
 * unconditionally -- it does not need to consult `knownDivergence` (that
 * field documents cases where the GO engine, not this one, has a confirmed
 * gap; see the Go test for how those are handled).
 */
describe('gitignore parity fixture (shared with remote-helper)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitignore-parity-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const fixtureUrl = new URL(
    '../../../remote-helper/testdata/gitignore-parity.json',
    import.meta.url,
  );
  const fixture: GitignoreParityCase[] = JSON.parse(readFileSync(fixtureUrl, 'utf8'));

  it.each(fixture)('$id: $description', ({ patterns, path, isDir, expected }) => {
    writeFileSync(join(root, '.gitignore'), `${patterns.join('\n')}\n`);
    const ignored = createGitignoreFilter(root);
    expect(ignored(join(root, path), isDir ? dirStats : undefined)).toBe(expected);
  });
});
