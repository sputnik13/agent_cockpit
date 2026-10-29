/**
 * End to end with the REAL Go helper (scenarios 7 Go side, 13 and 14, wired to
 * main's side): the helper binary is built from remote-helper/ into a temp
 * directory and run as a child process whose stdio is the RPC stream; a real
 * HelperRpcClient handshakes with a project id, a real CallbackBroker decides each
 * forwarded request (bridged exactly as RemoteProvider does), and the REAL `cockpit`
 * CLI — invoked through the link the helper made — talks to the helper's real unix
 * socket. Only the SSH hop is absent. Skipped, with a stated reason, when no Go
 * toolchain is available.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';
import type { ConnectionState } from '@shared/providers/types';
import { HelperRpcClient } from '../providers/remote/rpcClient';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { bridgeRemoteCallbacks } from './remoteBridge';
import { callbackRequest } from './testClient';

const HELPER_SRC = fileURLToPath(new URL('../../../remote-helper', import.meta.url));

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const HAVE_GO = goAvailable();
if (!HAVE_GO) {
  console.warn(
    'SKIP remoteHelper.integration: no `go` toolchain on PATH, so the real helper cannot be built; ' +
      'the Go-side behavior is covered by `cd remote-helper && go test ./...`',
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
      const code = error
        ? ((error as NodeJS.ErrnoException & { code?: number | string }).code as number)
        : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

describe.skipIf(!HAVE_GO)('real Go helper, real cockpit CLI, real broker', () => {
  let buildDir: string;
  let helperBin: string;
  let home: string;
  let child: ChildProcess;
  let client: HelperRpcClient;
  let sock: string;
  let cli: string;
  let status: ConnectionState;
  let opens: CallbackOpenEvent[];
  let handled: unknown[];
  let broker: CallbackBroker;
  let stopBridge: () => void;
  let helperStderr = '';
  const children: ChildProcess[] = [];

  beforeAll(() => {
    buildDir = mkdtempSync('/tmp/acrh-bin-');
    helperBin = join(buildDir, 'helper');
    execFileSync('go', ['build', '-trimpath', '-o', helperBin, '.'], {
      cwd: HELPER_SRC,
      stdio: 'pipe',
    });
  }, 180_000);

  afterAll(() => {
    rmSync(buildDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    home = mkdtempSync('/tmp/acrh-h-');
    status = 'connected';
    opens = [];
    handled = [];
    helperStderr = '';

    // The helper exactly as an ssh exec channel runs it: stdio is the RPC stream,
    // its environment is the host's (here: a private HOME and no inherited COCKPIT_*).
    child = spawn(helperBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, SHELL: '/usr/bin/true' },
    });
    children.push(child);
    child.stderr!.on('data', (chunk: Buffer) => {
      helperStderr += chunk.toString('utf8');
    });
    client = new HelperRpcClient({ stdin: child.stdin!, stdout: child.stdout! });

    const provider = {
      kind: 'remote' as const,
      listWorktrees: async () => [worktree('/srv/repo')],
    };
    broker = new CallbackBroker({
      statusOf: () => ({ state: status, since: '' }),
      providerOf: () => provider,
      projectRootOf: () => '/srv/repo',
      userDataDir: () => '/unused',
    });
    broker.onOpen((event) => opens.push(event));
    stopBridge = bridgeRemoteCallbacks({
      client,
      projectId: 'proj-int',
      handle: (request) => {
        handled.push(request);
        return broker.handle('proj-int', request);
      },
    });

    const handshake = await client.handshake('proj-int');
    expect(handshake.callbackSock, `helper stderr:\n${helperStderr}`).toBeTruthy();
    sock = handshake.callbackSock!;
    cli = handshake.cliPath!;
  }, 30_000);

  afterEach(async () => {
    stopBridge();
    for (const proc of children.splice(0)) {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.stdin?.end();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            resolve();
          }, 5_000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // A pane's environment: the socket, and the shell's logical working directory
  // ($PWD, which a shell exports; the kernel's cwd alone would be the physical path).
  const cliEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    COCKPIT_CALLBACK_SOCK: sock,
    PWD: home,
    ...extra,
  });

  it('reports a private socket and a CLI link that points at the helper itself', () => {
    expect(sock.startsWith(home)).toBe(true); // ~/.agent-cockpit/callback/<hosthash>-<h>.sock
    expect(lstatSync(sock).isSocket()).toBe(true);
    expect(lstatSync(sock).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(sock, '..')).mode & 0o777).toBe(0o700);
    expect(cli.startsWith(join(home, '.agent-cockpit', 'bin'))).toBe(true);
    expect(cli.endsWith('/cockpit')).toBe(true);
    expect(realpathSync(cli)).toBe(realpathSync(helperBin));
    // The link targets the very binary the helper runs from (its own path).
    expect(realpathSync(readlinkSync(cli))).toBe(realpathSync(helperBin));
    expect(helperStderr).toContain('callback listening');
  });

  it('opens a file end to end: CLI -> unix socket -> helper -> event -> broker -> callback.reply -> CLI', async () => {
    const result = await runCli(
      cli,
      ['open', '/srv/repo/src/a.ts'],
      cliEnv({ TMUX_PANE: '%5' }),
      home,
    );
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' }); // exit 0, silent on success
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]).toEqual({
      projectId: 'proj-int',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/srv/repo' },
      pane: { kind: 'tmux', id: '%5' },
    });
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      v: 1,
      op: 'open',
      pane: { kind: 'tmux', id: '%5' },
      args: { path: '/srv/repo/src/a.ts' },
    });
  });

  it('classifies a relative path from the logical working directory as an external file', async () => {
    const result = await runCli(cli, ['open', 'notes/../todo.md'], cliEnv(), home);
    expect(result.code).toBe(0);
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]!.selection).toEqual({
      kind: 'external-file',
      path: join(home, 'todo.md'), // the LOGICAL absolute path, lexically cleaned
      worktreePath: '',
    });
    // The CLI also sent the canonical form (symlink-resolved parent + base name).
    const request = handled[0] as { args: { path: string; canonicalPath?: string } };
    expect(request.args.canonicalPath).toBe(join(realpathSync(home), 'todo.md'));
  });

  it("exits 3 and opens nothing while the project is not connected (the status gate is main's)", async () => {
    status = 'disconnected';
    const result = await runCli(cli, ['open', '/srv/repo/src/a.ts'], cliEnv(), home);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('not connected');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opens).toEqual([]);
  });

  it('refuses an unsupported operation at the helper, without forwarding it to main', async () => {
    const reply = await callbackRequest(sock, { v: 1, id: 3, op: 'review', args: {} });
    expect(reply).toMatchObject({ id: 3, ok: false, error: { code: 'unsupported-op' } });
    expect(handled).toEqual([]);
    const bad = await callbackRequest(sock, { v: 2, id: 4, op: 'open', args: { path: '/a' } });
    expect(bad).toMatchObject({ id: 4, ok: false, error: { code: 'bad-request' } });
    expect(handled).toEqual([]);
  });

  it('refuses invalid arguments at the helper too (a relative path is bad-request), without forwarding', async () => {
    const reply = await callbackRequest(sock, {
      v: 1,
      id: 8,
      op: 'open',
      args: { path: 'relative.md' },
    });
    expect(reply).toMatchObject({
      id: 8,
      ok: false,
      error: { code: 'bad-request', message: 'path must be an absolute path' },
    });
    expect(handled).toEqual([]); // default-deny at the edge: main never saw it
  });

  it('forwards a request rebuilt from the validated fields only; nothing else a same-user process sent reaches main', async () => {
    const reply = await callbackRequest(sock, {
      v: 1,
      id: 9,
      op: 'open',
      pane: { kind: 'tmux', id: '%1', note: 'extra' },
      projectId: 'some-other-project',
      junk: { deeply: ['nested'], blob: 'x'.repeat(2_000) },
      args: { path: '/srv/repo/src/a.ts', line: 12, evil: { a: 1 } },
    });
    expect(reply).toMatchObject({ id: 9, ok: true, result: { status: 'dispatched' } });
    // Exactly the validated envelope: unknown envelope fields, unknown pane fields and
    // unknown args are gone; the project is the helper's own, never the request's.
    expect(handled).toEqual([
      {
        v: 1,
        id: 9,
        op: 'open',
        pane: { kind: 'tmux', id: '%1' },
        args: { path: '/srv/repo/src/a.ts' },
      },
    ]);
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]!.projectId).toBe('proj-int');
  });

  it('exits 2 for a usage error without touching the socket', async () => {
    const result = await runCli(cli, ['open'], cliEnv(), home);
    expect(result.code).toBe(2);
    expect(handled).toEqual([]);
  });

  it('releases the socket when the RPC stream ends; a stale environment then exits 3 within seconds', async () => {
    expect(existsSync(sock)).toBe(true);
    child.stdin!.end(); // main went away / the ssh channel closed
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(child.exitCode).toBe(0);
    expect(existsSync(sock)).toBe(false);
    expect(client.isClosed).toBe(true);
    // The CLI link outlives the helper process.
    expect(realpathSync(cli)).toBe(realpathSync(helperBin));

    const start = Date.now();
    const result = await runCli(cli, ['open', '/srv/repo/src/a.ts'], cliEnv(), home);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('not connected');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('a newer helper for the same project takes the path over; the stale one cannot hold it or delete the new socket', async () => {
    // A second helper process (a reconnect) handshakes for the SAME project on the
    // SAME host: the newest listener wins the path.
    const second = spawn(helperBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, SHELL: '/usr/bin/true' },
    });
    children.push(second);
    const secondClient = new HelperRpcClient({ stdin: second.stdin!, stdout: second.stdout! });
    const secondOpens: unknown[] = [];
    bridgeRemoteCallbacks({
      client: secondClient,
      projectId: 'proj-int',
      handle: (request) => {
        secondOpens.push(request);
        return broker.handle('proj-int', request);
      },
    });
    const handshake = await secondClient.handshake('proj-int');
    expect(handshake.callbackSock).toBe(sock); // the path is stable per (host, project)

    const result = await runCli(cli, ['open', '/srv/repo/src/b.ts'], cliEnv(), home);
    expect(result.code).toBe(0);
    await vi.waitFor(() => expect(secondOpens).toHaveLength(1));
    expect(handled).toEqual([]); // the stale predecessor is unreachable

    // The stale helper dying (its stream ends) must not remove the newer socket.
    child.stdin!.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(existsSync(sock)).toBe(true);
    const again = await runCli(cli, ['open', '/srv/repo/src/c.ts'], cliEnv(), home);
    expect(again.code).toBe(0);
    await vi.waitFor(() => expect(secondOpens).toHaveLength(2));
  }, 30_000);
});
