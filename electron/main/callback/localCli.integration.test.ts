/**
 * The LOCAL `cockpit` CLI end to end (scenario 14, app side): the real Go binary,
 * reached through the link `ensureLocalCliLink` makes from a helper dist manifest
 * (exactly what a packaged or dev run does), talking to the real `CallbackBroker`
 * listener on a real unix socket — the cross-implementation check that the Go
 * encoder/decoder and the Node listener agree on the wire. Skipped, with a stated
 * reason, when no Go toolchain is available.
 */
import { execFile, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';
import type { ConnectionState } from '@shared/providers/types';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { createLocalCliLinker, manifestPlatform } from './cliLink';
import { localCliPath } from './localEnvironment';

const HELPER_SRC = fileURLToPath(new URL('../../../remote-helper', import.meta.url));

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HOST = manifestPlatform(process.platform, process.arch);
const RUNNABLE = goAvailable() && HOST !== null;
if (!RUNNABLE) {
  console.warn(
    'SKIP localCli.integration: needs a `go` toolchain and a supported host platform to build and run the CLI; ' +
      'the Go side is covered by `cd remote-helper && go test ./...`',
  );
}

const worktree = (path: string): WorktreeRecord => ({
  path,
  branch: 'main',
  head: 'abc',
  locked: false,
  prunable: false,
  detached: false,
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cli: string,
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(cli, args, { env, cwd, timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

describe.skipIf(!RUNNABLE)(
  'local cockpit CLI (real Go binary) against the real broker listener',
  () => {
    let buildDir: string;
    let dist: string;
    let userData: string;
    let project: string;
    let status: ConnectionState;
    let broker: CallbackBroker;
    let opens: CallbackOpenEvent[];
    let sock: string;
    let cli: string;

    beforeAll(() => {
      buildDir = mkdtempSync('/tmp/aclc-bin-');
      const built = join(buildDir, 'helper');
      execFileSync('go', ['build', '-trimpath', '-o', built, '.'], {
        cwd: HELPER_SRC,
        stdio: 'pipe',
      });
      // A dist laid out like remote-helper/dist: a manifest naming this host's build.
      dist = join(buildDir, 'dist');
      mkdirSync(dist);
      const filename = `helper-0.1.0-${HOST!.os}-${HOST!.arch}`;
      copyFileSync(built, join(dist, filename));
      execFileSync('chmod', ['755', join(dist, filename)]);
      writeFileSync(
        join(dist, 'manifest.json'),
        JSON.stringify({
          version: '0.1.0',
          binaries: [{ os: HOST!.os, arch: HOST!.arch, filename }],
        }),
      );
    }, 180_000);

    afterAll(() => {
      rmSync(buildDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      userData = mkdtempSync('/tmp/aclc-u-');
      project = mkdtempSync('/tmp/aclc-p-'); // the "project root"; /tmp is a symlink on macOS
      status = 'connected';
      opens = [];
      const provider = {
        kind: 'local' as const,
        listWorktrees: async () => [worktree(realpathSync(project))],
      };
      broker = new CallbackBroker({
        statusOf: () => ({ state: status, since: '' }),
        providerOf: () => provider,
        projectRootOf: () => project,
        userDataDir: () => userData,
        tmpRoot: join(userData, 'tmp'),
        // A frozen clock: the burst limiter must not refill while 12 slow process
        // launches run one after another (that would make the test timing-dependent).
        now: () => 1_000_000,
        // The production hook: link the CLI from the dist manifest before binding.
        ensureCli: createLocalCliLinker(() => ({ userDataDir: userData, distDir: dist })),
      });
      broker.onOpen((event) => opens.push(event));
      await broker.startLocalListener('p');
      sock = broker.localSocketPath('p')!;
      cli = localCliPath(userData);
    }, 30_000);

    afterEach(async () => {
      await broker.stopAll();
      rmSync(userData, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    const env = (extra: Record<string, string> = {}): Record<string, string> => ({
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      COCKPIT_CALLBACK_SOCK: sock,
      PWD: project,
      ...extra,
    });

    it('has linked COCKPIT_CLI before the listener was bound, to the dist build for this host', () => {
      expect(realpathSync(cli)).toBe(
        realpathSync(join(dist, `helper-0.1.0-${HOST!.os}-${HOST!.arch}`)),
      );
    });

    it('opens a file inside the project as a worktree-relative selection, silently, exit 0', async () => {
      writeFileSync(join(project, 'README.md'), '# hi');
      const result = await runCli(cli, ['open', 'README.md'], env({ TMUX_PANE: '%2' }), project);
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      await vi.waitFor(() => expect(opens).toHaveLength(1));
      expect(opens[0]).toEqual({
        projectId: 'p',
        // The CLI sent the logical path (through the /tmp symlink on macOS) AND the
        // canonical one; classification matched the canonical worktree root.
        selection: { kind: 'file', path: 'README.md', worktreePath: realpathSync(project) },
        pane: { kind: 'tmux', id: '%2' },
      });
    });

    it('classifies a path reached through a symlinked directory by its canonical worktree', async () => {
      mkdirSync(join(project, 'real'));
      writeFileSync(join(project, 'real', 'doc.md'), 'x');
      symlinkSync(join(project, 'real'), join(project, 'alias'));
      const result = await runCli(cli, ['open', 'alias/doc.md'], env(), project);
      expect(result.code).toBe(0);
      await vi.waitFor(() => expect(opens).toHaveLength(1));
      expect(opens[0]!.selection).toEqual({
        kind: 'file',
        path: 'real/doc.md',
        worktreePath: realpathSync(project),
      });
    });

    it('opens a path outside the project as an external file with its logical path', async () => {
      const result = await runCli(cli, ['open', '/etc/hosts'], env(), project);
      expect(result.code).toBe(0);
      await vi.waitFor(() => expect(opens).toHaveLength(1));
      expect(opens[0]!.selection).toEqual({
        kind: 'external-file',
        path: '/etc/hosts',
        worktreePath: '',
      });
    });

    it('exits 3 with a clear message while the project is not connected, opening nothing', async () => {
      status = 'disconnected';
      const result = await runCli(cli, ['open', 'README.md'], env(), project);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain('not connected');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(opens).toEqual([]);
    });

    it('exits 4 when the app rate-limits the burst', async () => {
      const codes: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        codes.push((await runCli(cli, ['open', 'README.md'], env(), project)).code);
      }
      expect(codes.slice(0, 10).every((code) => code === 0)).toBe(true);
      expect(codes.slice(10)).toEqual([4, 4]);
    });

    it('exits 3 fast once the listener is gone (the stale COCKPIT_CALLBACK_SOCK of a pane)', async () => {
      await broker.stopListener('p');
      const start = Date.now();
      const result = await runCli(cli, ['open', 'README.md'], env(), project);
      expect(result.code).toBe(3);
      expect(Date.now() - start).toBeLessThan(5_000);
    });
  },
);
