import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { FILE_BYTES_CAP } from '@shared/providers/fileBytesCap';
import { LocalProvider } from './index';
import { localListDir, localReadFile } from './reads';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('LocalProvider reads (temp git repo + jsonl beads)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cockpit-local-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# Title\n\noriginal\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
    // a tracked modification + an untracked file
    writeFileSync(join(repo, 'README.md'), '# Title\n\nchanged\n');
    writeFileSync(join(repo, 'new.txt'), 'hello\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('starts connected (local has no transport) and stays connected after connect()', async () => {
    // Local has no real transport, so the provider is considered connected
    // from construction — prevents a brief 'disconnected' flash for local projects.
    const p = new LocalProvider('proj', repo);
    expect(p.status().state).toBe('connected');
    await p.connect();
    expect(p.status().state).toBe('connected');
  });

  it('lists the worktree and computes the changeset', async () => {
    const p = new LocalProvider('proj', repo);
    const wts = await p.listWorktrees();
    expect(wts.length).toBeGreaterThanOrEqual(1);

    const cs = await p.getChangeset(repo);
    const paths = cs.files.map((f) => f.newPath);
    expect(paths).toContain('README.md');
    expect(paths).toContain('new.txt');
    const readme = cs.files.find((f) => f.newPath === 'README.md');
    expect(readme?.status).toBe('modified');
  });

  it('reads file content and a file diff', async () => {
    const p = new LocalProvider('proj', repo);
    const file = await p.readFile('README.md');
    expect(file.content).toContain('changed');
    const diff = await p.getFileDiff(repo, 'README.md');
    expect(diff).toContain('changed');
  });

  it('reads an absolute path outside the project root (external-file Explorer selection)', async () => {
    // Regression: getFile() used to unconditionally `join(worktreePath,
    // filePath)`, which mangles an already-absolute filePath into a bogus
    // nested path (e.g. /project/root/private/tmp/...) instead of resolving
    // it as-is — the "file not found" bug for an Explorer external-file
    // selection outside the project tree.
    const outside = mkdtempSync(join(tmpdir(), 'cockpit-external-'));
    try {
      const externalFile = join(outside, 'external.txt');
      writeFileSync(externalFile, 'outside content\n');
      const p = new LocalProvider('proj', repo);
      const file = await p.readFile(externalFile, { worktreePath: '' });
      expect(file.content).toContain('outside content');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lists directories (dirs first) relative to the project root', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'a');
    writeFileSync(join(repo, 'src', 'b.ts'), 'b');
    const p = new LocalProvider('proj', repo);
    const root = await p.listDir('');
    const names = root.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).toContain('README.md');
    expect(root.find((e) => e.name === 'src')?.isDir).toBe(true);

    const sub = await p.listDir('src');
    expect(sub.map((e) => e.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(sub.every((e) => !e.isDir)).toBe(true);
  });

  it('resolves reads against a linked worktree root when worktreePath is supplied', async () => {
    // A linked worktree on its own branch, holding a file that exists ONLY there
    // (absent from the main worktree root) — so the base switch is observable.
    const linked = mkdtempSync(join(tmpdir(), 'cockpit-linked-'));
    // git worktree add refuses a pre-existing non-empty dir; remove ours first
    // and let git create it.
    rmSync(linked, { recursive: true, force: true });
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-branch', linked]);
    mkdirSync(join(linked, 'only'), { recursive: true });
    writeFileSync(join(linked, 'only', 'wt.txt'), 'worktree-only\n');

    // With the worktree override, the read resolves against the linked root.
    const inWt = await localReadFile(repo, 'only/wt.txt', { worktreePath: linked });
    expect(inWt.content).toContain('worktree-only');

    // Without it, the same relative path resolves against the project root, where
    // the file does not exist — proving the base actually switched.
    const inRoot = await localReadFile(repo, 'only/wt.txt');
    expect(inRoot.content).toBeNull();

    // listDir with the worktree override lists the worktree-only file.
    const entries = localListDir(repo, 'only', linked);
    expect(entries.map((e) => e.name)).toContain('wt.txt');

    git(repo, ['worktree', 'remove', '--force', linked]);
  });

  it('stats existing and missing paths', async () => {
    const p = new LocalProvider('proj', repo);
    expect((await p.stat('README.md')).exists).toBe(true);
    expect((await p.stat('nope.md')).exists).toBe(false);
  });

  describe('getDiffBundle (default-target old-content, local_repo_explorer-1jpc)', () => {
    it('resolves non-null oldContent for a HEAD-tracked file under the default (no baseline) target', async () => {
      const p = new LocalProvider('proj', repo);
      const bundle = await p.getDiffBundle(repo, 'README.md');
      expect(bundle.oldContent).toContain('original');
      expect(bundle.newContent).toContain('changed');
    });

    it('still resolves null oldContent for a genuinely new (untracked, no HEAD copy) file under the default target', async () => {
      const p = new LocalProvider('proj', repo);
      const bundle = await p.getDiffBundle(repo, 'new.txt');
      expect(bundle.oldContent).toBeNull();
      expect(bundle.newContent).toContain('hello');
    });

    it('leaves explicit-baseline behavior unchanged: an explicit ref resolves old content AT that ref, not HEAD', async () => {
      // Commit the working change so HEAD moves past the original content, then
      // pass the FIRST commit's SHA as an explicit baseline — if the default-
      // to-HEAD fix ever regressed explicit baselines to silently mean HEAD,
      // this would return the (wrong) second commit's content instead of the
      // first's.
      const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'second']);
      writeFileSync(join(repo, 'README.md'), '# Title\n\nchanged again\n');

      const p = new LocalProvider('proj', repo);
      const bundle = await p.getDiffBundle(repo, 'README.md', firstSha);
      expect(bundle.oldContent).toContain('original');
      expect(bundle.newContent).toContain('changed again');
    });
  });

  describe('exportFile (Download capability)', () => {
    let destDir: string;

    beforeEach(() => {
      destDir = mkdtempSync(join(tmpdir(), 'cockpit-export-dest-'));
    });

    afterEach(() => {
      rmSync(destDir, { recursive: true, force: true });
    });

    it('exports a UTF-8 text file byte-identical to the source', async () => {
      const p = new LocalProvider('proj', repo);
      const dest = join(destDir, 'README.md');
      await p.exportFile('README.md', dest);
      expect(readFileSync(dest).equals(readFileSync(join(repo, 'README.md')))).toBe(true);
    });

    it('exports a binary file byte-identical to the source', async () => {
      const bin = Buffer.from([0x00, 0x89, 0xff, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(join(repo, 'image.png'), bin);
      const p = new LocalProvider('proj', repo);
      const dest = join(destDir, 'image.png');
      await p.exportFile('image.png', dest);
      expect(Buffer.compare(readFileSync(dest), bin)).toBe(0);
    });

    it('exports a file larger than the preview maxBytes cap byte-identical', async () => {
      // 3 MiB: bigger than both the local 256 KiB preview cap and the remote
      // helper's 2 MiB readFile cap, proving Download does not go through
      // either capped path.
      const big = randomBytes(1024 * 1024 * 3);
      writeFileSync(join(repo, 'big.bin'), big);
      const p = new LocalProvider('proj', repo);
      const dest = join(destDir, 'big.bin');
      await p.exportFile('big.bin', dest);
      expect(Buffer.compare(readFileSync(dest), big)).toBe(0);
    });

    it('resolves export against a linked worktree root when worktreePath is supplied', async () => {
      // A linked worktree on its own branch, holding a file absent from the
      // main worktree root — so the base switch is observable (mirrors the
      // existing linked-worktree read test above).
      const linked = mkdtempSync(join(tmpdir(), 'cockpit-export-linked-'));
      rmSync(linked, { recursive: true, force: true });
      git(repo, ['worktree', 'add', '-q', '-b', 'wt-export-branch', linked]);
      mkdirSync(join(linked, 'only'), { recursive: true });
      writeFileSync(join(linked, 'only', 'wt.txt'), 'worktree-only-export\n');

      const p = new LocalProvider('proj', repo);
      const dest = join(destDir, 'wt.txt');
      await p.exportFile('only/wt.txt', dest, { worktreePath: linked });
      expect(readFileSync(dest, 'utf8')).toBe('worktree-only-export\n');

      // Without the worktree override, the same relative path does not exist
      // at the project root: the export rejects, and leaves no dest/partial file.
      const destMissing = join(destDir, 'wt-missing.txt');
      await expect(p.exportFile('only/wt.txt', destMissing)).rejects.toThrow();
      expect(existsSync(destMissing)).toBe(false);
      expect(readdirSync(destDir).some((f) => f.includes('.part'))).toBe(false);

      git(repo, ['worktree', 'remove', '--force', linked]);
    });

    it('rejects and leaves no partial file when the destination is unwritable', async () => {
      const p = new LocalProvider('proj', repo);
      const dest = join(destDir, 'nonexistent-subdir', 'out.md');
      await expect(p.exportFile('README.md', dest)).rejects.toThrow();
      expect(existsSync(dest)).toBe(false);
      expect(readdirSync(destDir)).toEqual([]);
    });
  });

  describe('readFileBytes (bounded byte preview)', () => {
    it('round-trips a binary file under the cap byte-identically after base64 decode', async () => {
      const buf = Buffer.from([0x00, 0x89, 0xff, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      writeFileSync(join(repo, 'image.png'), buf);
      const p = new LocalProvider('proj', repo);
      const res = await p.readFileBytes('image.png');
      expect(res.reason).toBeNull();
      expect(res.exists).toBe(true);
      expect(res.sizeBytes).toBe(buf.length);
      expect(Buffer.from(res.bytesBase64!, 'base64').equals(buf)).toBe(true);
    });

    it('refuses an over-cap file with metadata only, never a truncated prefix', async () => {
      const big = Buffer.alloc(FILE_BYTES_CAP + 1);
      writeFileSync(join(repo, 'big.bin'), big);
      const p = new LocalProvider('proj', repo);
      const res = await p.readFileBytes('big.bin');
      expect(res).toEqual({
        bytesBase64: null,
        sizeBytes: FILE_BYTES_CAP + 1,
        exists: true,
        reason: 'too-large',
      });
    });

    it('resolves (does not reject) a not-exists result for a missing path', async () => {
      const p = new LocalProvider('proj', repo);
      const res = await p.readFileBytes('nope.bin');
      expect(res).toEqual({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
    });

    it('reports reason "is-dir" for a directory path, with no bytes', async () => {
      mkdirSync(join(repo, 'adir'), { recursive: true });
      const p = new LocalProvider('proj', repo);
      const res = await p.readFileBytes('adir');
      expect(res.reason).toBe('is-dir');
      expect(res.bytesBase64).toBeNull();
    });

    it('resolves reads against a linked worktree root when worktreePath is supplied', async () => {
      // Mirrors the exportFile/readFile linked-worktree tests above: a file
      // that exists ONLY in the linked worktree, absent from the main root.
      const linked = mkdtempSync(join(tmpdir(), 'cockpit-bytes-linked-'));
      rmSync(linked, { recursive: true, force: true });
      git(repo, ['worktree', 'add', '-q', '-b', 'wt-bytes-branch', linked]);
      mkdirSync(join(linked, 'only'), { recursive: true });
      const buf = Buffer.from('worktree-only-bytes\n');
      writeFileSync(join(linked, 'only', 'wt.bin'), buf);

      const p = new LocalProvider('proj', repo);
      const inWt = await p.readFileBytes('only/wt.bin', { worktreePath: linked });
      expect(inWt.reason).toBeNull();
      expect(Buffer.from(inWt.bytesBase64!, 'base64').equals(buf)).toBe(true);

      // Without the override, the same relative path does not exist at the
      // project root — proving the base actually switched.
      const inRoot = await p.readFileBytes('only/wt.bin');
      expect(inRoot.reason).toBe('missing');

      git(repo, ['worktree', 'remove', '--force', linked]);
    });

    // Git-ref branch (local_repo_explorer-bn8a) — serves the image-diff
    // baseline preview via simpleGit.binaryCatFile, the same plumbing
    // getFile's text-preview ref branch already uses.
    describe('ref (git-object read at a baseline; local_repo_explorer-bn8a)', () => {
      it('reads bytes at a git ref, byte-identical after base64 decode — NOT the working-tree bytes', async () => {
        const baselineBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
        writeFileSync(join(repo, 'photo.png'), baselineBuf);
        git(repo, ['add', 'photo.png']);
        git(repo, ['commit', '-q', '-m', 'add photo']);
        // Modify the working tree AFTER committing — the ref read must still
        // return the COMMITTED bytes, proving it reads the git object, not
        // whatever currently sits on disk.
        writeFileSync(join(repo, 'photo.png'), Buffer.from([0xff, 0xff, 0xff]));

        const p = new LocalProvider('proj', repo);
        const res = await p.readFileBytes('photo.png', { ref: 'HEAD' });
        expect(res.reason).toBeNull();
        expect(res.exists).toBe(true);
        expect(res.sizeBytes).toBe(baselineBuf.length);
        expect(Buffer.from(res.bytesBase64!, 'base64').equals(baselineBuf)).toBe(true);
      });

      it('refuses an over-cap file at a ref with metadata only, never a truncated prefix (same guardrail as the non-ref path)', async () => {
        const big = Buffer.alloc(FILE_BYTES_CAP + 1);
        writeFileSync(join(repo, 'big.bin'), big);
        git(repo, ['add', 'big.bin']);
        git(repo, ['commit', '-q', '-m', 'add big file']);

        const p = new LocalProvider('proj', repo);
        const res = await p.readFileBytes('big.bin', { ref: 'HEAD' });
        expect(res).toEqual({
          bytesBase64: null,
          sizeBytes: FILE_BYTES_CAP + 1,
          exists: true,
          reason: 'too-large',
        });
      });

      it('resolves "missing" (never rejects) for a path absent at the given ref — e.g. an added file with no baseline version', async () => {
        // new.txt exists in the WORKING TREE (beforeEach's untracked file) but
        // was never committed, so it is absent at HEAD.
        const p = new LocalProvider('proj', repo);
        const res = await p.readFileBytes('new.txt', { ref: 'HEAD' });
        expect(res).toEqual({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
      });

      it("a ref read resolves against a linked worktree's own branch (worktreePath selects the git context, not just the fs base)", async () => {
        const linked = mkdtempSync(join(tmpdir(), 'cockpit-bytes-ref-linked-'));
        rmSync(linked, { recursive: true, force: true });
        git(repo, ['worktree', 'add', '-q', '-b', 'wt-ref-branch', linked]);
        const buf = Buffer.from('branch-only-bytes\n');
        writeFileSync(join(linked, 'branch-only.bin'), buf);
        git(linked, ['add', 'branch-only.bin']);
        git(linked, ['commit', '-q', '-m', 'branch-only commit']);

        const p = new LocalProvider('proj', repo);
        const inWt = await p.readFileBytes('branch-only.bin', { worktreePath: linked, ref: 'HEAD' });
        expect(inWt.reason).toBeNull();
        expect(Buffer.from(inWt.bytesBase64!, 'base64').equals(buf)).toBe(true);

        // The primary repo's HEAD never had this file — proves the read
        // actually used the linked worktree's branch, not the main repo's.
        const inRoot = await p.readFileBytes('branch-only.bin', { ref: 'HEAD' });
        expect(inRoot.reason).toBe('missing');

        git(repo, ['worktree', 'remove', '--force', linked]);
      });
    });
  });

  it('detects beads and loads the task graph (jsonl source)', async () => {
    mkdirSync(join(repo, '.beads'), { recursive: true });
    const rec = {
      id: 'demo-1',
      title: 'first task',
      description: 'body',
      status: 'open',
      priority: 2,
      issue_type: 'task',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    writeFileSync(join(repo, '.beads', 'issues.jsonl'), JSON.stringify(rec) + '\n');

    const p = new LocalProvider('proj', repo);
    expect(await p.detectBeads()).toBe(true);
    const graph = await p.getTaskGraph();
    expect(graph.issues.map((i) => i.id)).toContain('demo-1');
    expect((await p.getTask('demo-1'))?.title).toBe('first task');
  });

  it('reports no beads when .beads is absent', async () => {
    const p = new LocalProvider('proj', repo);
    expect(await p.detectBeads()).toBe(false);
  });

  it('runs a keyed terminal in its own tmux session (list + kill)', async () => {
    const pid = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const p = new LocalProvider(pid, repo);
    let handle: { id: string };
    try {
      handle = await p.openTerminal({ cols: 80, rows: 24, key: 'tA' });
    } catch {
      // node-pty native binding unavailable in this runtime (e.g. Electron-ABI)
      return;
    }
    expect(handle.id).toBe('tA');
    const chunks: string[] = [];
    p.onTerminalData('tA', (d) => chunks.push(d));
    await new Promise((r) => setTimeout(r, 400));

    // The terminal is listed for this project (tmux session, or in-memory fallback).
    expect(await p.listTerminals()).toContain('tA');

    await p.writeTerminal('tA', 'echo cockpit-ok\r');
    await new Promise((r) => setTimeout(r, 500));
    expect(chunks.join('').length).toBeGreaterThan(0); // received output

    // Killing ends the session so it no longer lists.
    await p.closeTerminal('tA', { kill: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(await p.listTerminals()).not.toContain('tA');
  });

  it('emits a debounced watch event on file change and stops after unsubscribe', async () => {
    const p = new LocalProvider('proj', repo);
    const events: string[][] = [];
    const sub = await p.subscribeWatch(['.'], (e) => events.push(e.paths));
    // give chokidar a moment to attach before mutating
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(join(repo, 'watched.txt'), 'v1\n');
    await new Promise((r) => setTimeout(r, 500));
    expect(events.length).toBeGreaterThanOrEqual(1);

    await sub.unsubscribe();
    const before = events.length;
    writeFileSync(join(repo, 'watched.txt'), 'v2\n');
    await new Promise((r) => setTimeout(r, 400));
    expect(events.length).toBe(before);
  });

  it('watches git refs so branch/commit changes are detected', async () => {
    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    await new Promise((r) => setTimeout(r, 400));
    // Simulate a branch switch by rewriting .git/HEAD.
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature\n');
    await new Promise((r) => setTimeout(r, 600));
    await sub.unsubscribe();
    expect(paths.some((pth) => pth.includes('.git/HEAD') || pth.endsWith('HEAD'))).toBe(true);
  });

  it('detects an actual git commit via the .git/refs directory watch', async () => {
    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    // fs.watch on macOS uses FSEvents which has a small attach delay.
    await new Promise((r) => setTimeout(r, 400));
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'real commit']);
    // Event-driven: debounce (200ms) plus a generous safety window.
    await new Promise((r) => setTimeout(r, 800));
    await sub.unsubscribe();
    const gitEvent = paths.some(
      (pth) => pth.includes('.git/refs') || pth.includes('.git/HEAD'),
    );
    expect(gitEvent).toBe(true);
  });

  it('detects a linked worktree being added via the .git/worktrees directory watch (local_repo_explorer-rc9n)', async () => {
    // Pre-create one worktree BEFORE subscribing, so `.git/worktrees` already
    // exists at watch-subscribe time — the common real-world case (an agent
    // harness cd's into an EXISTING worktree). This exercises the dedicated
    // `.git/worktrees` watch itself, not just the top-level `.git` watch's
    // fallback coverage of the very first worktree ever created in a repo.
    const wt1 = mkdtempSync(join(tmpdir(), 'cockpit-wt1-'));
    rmSync(wt1, { recursive: true, force: true });
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-detect-1', wt1]);

    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    // fs.watch on macOS uses FSEvents which has a small attach delay.
    await new Promise((r) => setTimeout(r, 400));

    const wt2 = mkdtempSync(join(tmpdir(), 'cockpit-wt2-'));
    rmSync(wt2, { recursive: true, force: true });
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-detect-2', wt2]);

    await new Promise((r) => setTimeout(r, 800));
    await sub.unsubscribe();

    expect(paths.some((pth) => pth.includes('.git/worktrees'))).toBe(true);

    git(repo, ['worktree', 'remove', '--force', wt1]);
    git(repo, ['worktree', 'remove', '--force', wt2]);
  });

  it('does not refresh on churn inside an already-known worktree\'s own metadata (.git/worktrees/<name>/HEAD)', async () => {
    const wt1 = mkdtempSync(join(tmpdir(), 'cockpit-wt-noise-'));
    rmSync(wt1, { recursive: true, force: true });
    git(repo, ['worktree', 'add', '-q', '-b', 'wt-noise', wt1]);
    // git names the `.git/worktrees/<name>` administrative dir after the
    // worktree's own path basename, NOT the branch name (verified against a
    // throwaway repo) — discover the real name rather than assuming.
    const wtName = basename(wt1);
    expect(existsSync(join(repo, '.git', 'worktrees', wtName, 'HEAD'))).toBe(true);

    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    await new Promise((r) => setTimeout(r, 400));

    // Rewrite the worktree's OWN HEAD directly — what a commit made inside it
    // does (real shape verified against a throwaway repo: HEAD/ORIG_HEAD/
    // index/logs/HEAD all live under .git/worktrees/<name>/). Routine
    // per-commit churn, not a worktree-set change, must not wake the panel.
    writeFileSync(
      join(repo, '.git', 'worktrees', wtName, 'HEAD'),
      'ref: refs/heads/wt-noise\n',
    );
    await new Promise((r) => setTimeout(r, 600));
    await sub.unsubscribe();

    expect(paths.some((pth) => pth.includes('.git/worktrees'))).toBe(false);

    git(repo, ['worktree', 'remove', '--force', wt1]);
  });

  it('emits a workgraph refresh on .beads/beads.db change via the directory watch (no per-file FD)', async () => {
    mkdirSync(join(repo, '.beads'), { recursive: true });
    writeFileSync(join(repo, '.beads', 'beads.db'), 'v1');
    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    // fs.watch on macOS uses FSEvents which has a small attach delay.
    await new Promise((r) => setTimeout(r, 400));
    writeFileSync(join(repo, '.beads', 'beads.db'), 'v2-changed');
    await new Promise((r) => setTimeout(r, 700));
    await sub.unsubscribe();
    expect(paths.some((pth) => pth.endsWith('.beads/beads.db'))).toBe(true);
  });

  it('does not refresh on .beads/ backup-tree churn (.br_history)', async () => {
    mkdirSync(join(repo, '.beads', '.br_history'), { recursive: true });
    writeFileSync(join(repo, '.beads', 'beads.db'), 'v1');
    const p = new LocalProvider('proj', repo);
    const paths: string[] = [];
    const sub = await p.subscribeWatch(['.'], (e) => paths.push(...e.paths));
    await new Promise((r) => setTimeout(r, 400));
    // A backup snapshot landing under .beads/.br_history must not wake the panel.
    writeFileSync(
      join(repo, '.beads', '.br_history', 'issues.20260101_000000.jsonl'),
      'snapshot\n',
    );
    await new Promise((r) => setTimeout(r, 600));
    await sub.unsubscribe();
    expect(paths.some((pth) => pth.includes('.br_history'))).toBe(false);
  });

  describe('subscribeWorktreeWatch (active-external-worktree watch; local_repo_explorer-g1je)', () => {
    let linked: string;

    beforeEach(() => {
      // A SIBLING/EXTERNAL worktree — created OUTSIDE `repo` (a mkdtemp dir,
      // never nested under it), the common `git worktree add ../foo` shape
      // this bead adds coverage for (as opposed to the ALREADY-covered
      // nested-under-root shape exercised by the other worktree tests above).
      linked = mkdtempSync(join(tmpdir(), 'cockpit-wt-external-'));
      rmSync(linked, { recursive: true, force: true });
      git(repo, ['worktree', 'add', '-q', '-b', 'wt-external', linked]);
    });

    afterEach(() => {
      git(repo, ['worktree', 'remove', '--force', linked]);
    });

    it('emits paths relative to the WORKTREE root, not the project root, and stops after unsubscribe', async () => {
      const p = new LocalProvider('proj', repo);
      const paths: string[] = [];
      const sub = await p.subscribeWorktreeWatch(linked, (e) => paths.push(...e.paths));
      await new Promise((r) => setTimeout(r, 250));

      writeFileSync(join(linked, 'wt-only.txt'), 'v1\n');
      await new Promise((r) => setTimeout(r, 500));
      // Worktree-relative ('wt-only.txt'), never prefixed with any segment of
      // `repo`'s own path or `linked`'s own absolute path.
      expect(paths).toContain('wt-only.txt');
      expect(paths.some((pth) => pth.includes(repo))).toBe(false);
      expect(paths.some((pth) => pth.startsWith(linked))).toBe(false);

      await sub.unsubscribe();
      const before = paths.length;
      writeFileSync(join(linked, 'wt-only.txt'), 'v2\n');
      await new Promise((r) => setTimeout(r, 400));
      expect(paths.length).toBe(before);
    });

    it("honors the WORKTREE's own .gitignore, not the project root's", async () => {
      // A pattern present ONLY in the worktree's own .gitignore — proves the
      // filter is built from `createGitignoreFilter(worktreePath)`, not the
      // root's, since the root has no .gitignore excluding this name at all.
      writeFileSync(join(linked, '.gitignore'), 'wt-ignored.txt\n');

      const p = new LocalProvider('proj', repo);
      const paths: string[] = [];
      const sub = await p.subscribeWorktreeWatch(linked, (e) => paths.push(...e.paths));
      await new Promise((r) => setTimeout(r, 250));

      writeFileSync(join(linked, 'wt-ignored.txt'), 'v1\n');
      writeFileSync(join(linked, 'wt-tracked.txt'), 'v1\n');
      await new Promise((r) => setTimeout(r, 600));
      await sub.unsubscribe();

      expect(paths).toContain('wt-tracked.txt');
      expect(paths.some((pth) => pth.includes('wt-ignored.txt'))).toBe(false);
    });

    it('excludes node_modules (the standard NEVER_RECURSE segment) inside the worktree', async () => {
      mkdirSync(join(linked, 'node_modules'), { recursive: true });

      const p = new LocalProvider('proj', repo);
      const paths: string[] = [];
      const sub = await p.subscribeWorktreeWatch(linked, (e) => paths.push(...e.paths));
      await new Promise((r) => setTimeout(r, 250));

      writeFileSync(join(linked, 'node_modules', 'pkg.js'), 'v1\n');
      writeFileSync(join(linked, 'wt-real.txt'), 'v1\n');
      await new Promise((r) => setTimeout(r, 600));
      await sub.unsubscribe();

      expect(paths).toContain('wt-real.txt');
      expect(paths.some((pth) => pth.includes('node_modules'))).toBe(false);
    });

    it('does not emit .git-signal-shaped events for the worktree (a linked worktree\'s .git is a pointer FILE, not a directory)', async () => {
      // Sanity check on the design's stated property: a linked worktree's own
      // `.git` is a plain file (`gitdir: ...`), so there is no `.git/HEAD` or
      // `.git/refs` UNDER the worktree root to ever emit as git-state signal
      // shapes in the first place — subscribeWorktree deliberately adds no
      // dedicated signal watchers, and this asserts nothing resembling one
      // shows up even from the plain working-tree mechanism.
      expect(existsSync(join(linked, '.git'))).toBe(true);
      expect(statSync(join(linked, '.git')).isDirectory()).toBe(false);

      const p = new LocalProvider('proj', repo);
      const paths: string[] = [];
      const sub = await p.subscribeWorktreeWatch(linked, (e) => paths.push(...e.paths));
      await new Promise((r) => setTimeout(r, 250));
      writeFileSync(join(linked, 'wt-real.txt'), 'v1\n');
      await new Promise((r) => setTimeout(r, 600));
      await sub.unsubscribe();

      expect(paths.some((pth) => pth.startsWith('.git'))).toBe(false);
    });
  });
});
