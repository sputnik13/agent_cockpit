/**
 * The whole remote chain from a PANE (scenarios 8 and 13, joined): the values the
 * helper reports at the handshake are applied to a tmux session exactly as the
 * remote control-mode manager does (`set-environment -t '=<session>'`, built by the
 * shared builders), a window created afterwards runs the documented form
 * `"$COCKPIT_CLI" open <path>` in a REAL tmux pane, and the REAL Go CLI reaches the
 * REAL Go helper, whose forwarded event the REAL broker decides. A local tmux
 * server on a private socket stands in for the remote host's; every path contains
 * spaces, the case the default macOS profile path has. Skipped, with a stated
 * reason, when there is no Go toolchain or no tmux.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment, callbackEnvironmentEntries } from '@shared/callback/env';
import { setSessionEnvironment } from '@shared/tmux';
import { createTmuxSandbox, tmuxInstalled, type TmuxSandbox } from '../providers/local/tmuxTestKit';
import { HelperRpcClient } from '../providers/remote/rpcClient';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { bridgeRemoteCallbacks } from './remoteBridge';

const HELPER_SRC = fileURLToPath(new URL('../../../remote-helper', import.meta.url));

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const RUNNABLE = goAvailable() && tmuxInstalled;
if (!RUNNABLE) {
  console.warn(
    'SKIP remoteTmuxPane.integration: needs a `go` toolchain (to build the helper and CLI) and `tmux`; ' +
      'injection is covered separately by the tmux injection tests and the Go side by `go test`',
  );
}

describe.skipIf(!RUNNABLE)('a real tmux pane reaches the real helper through $COCKPIT_CLI', () => {
  let root: string;
  let helperBin: string;
  let home: string;
  let sandbox: TmuxSandbox;
  let child: ChildProcess;
  let opens: CallbackOpenEvent[];
  let handshake: { callbackSock?: string; cliPath?: string };
  const session = 'agent-cockpit-live';

  beforeAll(() => {
    root = mkdtempSync('/tmp/acrt -');
    helperBin = join(root, 'helper bin');
    execFileSync('go', ['build', '-trimpath', '-o', helperBin, '.'], {
      cwd: HELPER_SRC,
      stdio: 'pipe',
    });
  }, 180_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    opens = [];
    home = join(root, `home dir ${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(home);
    child = spawn(helperBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, SHELL: '/usr/bin/true' },
    });
    const client = new HelperRpcClient({ stdin: child.stdin!, stdout: child.stdout! });
    const provider = {
      kind: 'remote' as const,
      listWorktrees: async () => [
        {
          path: '/srv/repo',
          branch: 'main',
          head: 'a',
          locked: false,
          prunable: false,
          detached: false,
        },
      ],
    };
    const broker = new CallbackBroker({
      statusOf: () => ({ state: 'connected', since: '' }),
      providerOf: () => provider,
      projectRootOf: () => '/srv/repo',
      userDataDir: () => '/unused',
    });
    broker.onOpen((event) => opens.push(event));
    bridgeRemoteCallbacks({ client, projectId: 'live', handle: (r) => broker.handle('live', r) });
    handshake = await client.handshake('live');

    sandbox = createTmuxSandbox('cliPane');
    sandbox.tmux('-f', '/dev/null', 'new-session', '-d', '-s', session, '-c', home, 'sleep 120');
  }, 30_000);

  afterEach(() => {
    sandbox?.dispose();
    child?.stdin?.end();
    child?.kill('SIGKILL');
    vi.restoreAllMocks();
  });

  /** Apply the helper's values to the session the way the remote control manager does. */
  function applyHandshakeValues(): void {
    const environment = buildCallbackEnvironment({
      sock: handshake.callbackSock!,
      cli: handshake.cliPath!,
    })!;
    const commands = callbackEnvironmentEntries(environment).map(([name, value]) =>
      setSessionEnvironment(session, name, value),
    );
    const file = join(root, `env-${Math.random().toString(36).slice(2, 8)}.tmux`);
    writeFileSync(file, commands.join('\n') + '\n');
    sandbox.tmux('source-file', file);
  }

  /** Run `command` in a NEW window of the session; resolve with the exit file's content. */
  async function runInPane(command: string): Promise<string> {
    const exitFile = join(root, `exit-${Math.random().toString(36).slice(2, 8)}.txt`);
    sandbox.tmux(
      'new-window',
      '-d',
      '-t',
      `=${session}`,
      '-c',
      home,
      // A subshell, so a `${VAR:?}` failure ends only the subshell and the status is still recorded.
      `sh -c '(${command}); echo $? > "${exitFile}"'`,
    );
    await vi.waitFor(() => expect(existsSync(exitFile)).toBe(true), { timeout: 10_000 });
    return readFileSync(exitFile, 'utf8').trim();
  }

  it('reports host paths with spaces in both values', () => {
    expect(handshake.callbackSock).toContain('home dir');
    expect(handshake.cliPath).toContain('home dir');
  });

  it('opens a file from a pane created after set-environment, with the pane identity from TMUX_PANE', async () => {
    applyHandshakeValues();
    const exit = await runInPane('"$COCKPIT_CLI" open /srv/repo/docs/a.md');
    expect(exit).toBe('0');
    await vi.waitFor(() => expect(opens).toHaveLength(1));
    expect(opens[0]!.selection).toEqual({
      kind: 'file',
      path: 'docs/a.md',
      worktreePath: '/srv/repo',
    });
    expect(opens[0]!.pane).toMatchObject({ kind: 'tmux' });
    expect(opens[0]!.pane!.id).toMatch(/^%\d+$/);
  });

  it('documents the failure when nothing was injected: the guarded form explains it, exit 3 from the CLI', async () => {
    // No set-environment: the pane has no variables, which is what a shared-session
    // install or an injection that never ran leaves behind.
    const guarded = await runInPane(
      '"${COCKPIT_CLI:?cockpit callback unavailable}" open /srv/repo/a.md',
    );
    expect(guarded).not.toBe('0'); // the shell refuses before anything runs
    // With the CLI reached directly but no socket variable, it reports not-connected.
    const direct = await runInPane(`"${handshake.cliPath}" open /srv/repo/a.md`);
    expect(direct).toBe('3');
    expect(opens).toEqual([]);
  });
});
