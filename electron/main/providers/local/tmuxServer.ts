/**
 * Starting the shared LOCAL tmux server, and the environment of the client that
 * attaches to it (requirements 6, 7 and 13 of
 * docs/requirements/terminal-callback-socket.md).
 *
 * A pane inherits its SESSION environment: tmux copies the global environment of
 * the process that STARTED the server, then the `update-environment` variables
 * of the attaching client. Two consequences drive this module:
 *
 *  - The process that starts the server (`start-server`) is spawned WITHOUT the
 *    callback variables, always. Its environment becomes the global environment
 *    of every project's panes, so a value stamped there would leak one project's
 *    socket into all of them.
 *  - The attaching (node-pty) client carries the project's values, and the
 *    local-only `update-environment[100..102]` entries copy them into THAT
 *    session on create and on `-A` attach, and strip them when the client lacks
 *    them.
 *
 * This is also the one place the server-start spawn exists for both local
 * openers (control-mode and session-per-tab), so the two cannot drift apart.
 */
import { spawnSync } from 'node:child_process';
import {
  CALLBACK_TMUX_ENV_NAMES,
  callbackUpdateEnvironmentOption,
  type CallbackEnvironment,
} from '@shared/callback/env';
import { terminalPaneEnv, tmuxServerOptionArgs } from '@shared/tmux';
import { withoutCallbackEnv } from '../../callback/envScrub';
import { logger } from '../../logger';
import { withNativeArch } from './nativeArch';

const LOG_CONTEXT = 'callback';

/**
 * Upper bound for every tmux process spawned here (the server start and the
 * diagnostic probes alike): these run synchronously on the main thread, and a
 * wedged server must not be able to hang it.
 */
export const TMUX_SPAWN_TIMEOUT_MS = 5_000;

export interface TmuxRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The process was killed for exceeding its timeout. */
  timedOut?: boolean;
}

/** Runs tmux to completion within `timeoutMs`. `capture: false` discards output (the happy path). */
export type TmuxRun = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; capture: boolean; timeoutMs: number },
) => TmuxRunResult;

export const spawnTmux: TmuxRun = (file, args, { env, capture, timeoutMs }) => {
  if (!capture) {
    // `start-server` forks the long-lived server: never hand it a pipe to hold open.
    const res = spawnSync(file, args, { env, stdio: 'ignore', timeout: timeoutMs });
    return { status: res.status, stdout: '', stderr: '', timedOut: isTimeout(res.error) };
  }
  const res = spawnSync(file, args, { env, encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    timedOut: isTimeout(res.error),
  };
};

const isTimeout = (error: Error | undefined): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';

/** Diagnostics already reported (once per reason and socket per process, not once per terminal open). */
const reported = new Set<string>();

/** Test-only: forget which diagnostics were reported. */
export function __resetTmuxServerDiagnosticsForTests(): void {
  reported.clear();
}

/**
 * What tmux says when it does not accept the indexed form: an option it does not
 * know (`invalid option` on 3.x, `unknown option` on older releases, `ambiguous
 * option` for an unusable index) or one that is not an array. Anything else
 * (server unreachable, killed, wedged) says nothing about this tmux's version.
 */
const OPTION_REJECTED = /\b(?:invalid|unknown|ambiguous) option\b|\bnot an array\b/i;

export interface TmuxServerStart {
  socket: string;
  /** tmux `-f` config file (tests pass a private one so they never read the user's). */
  configPath?: string;
  /**
   * Apply the callback `update-environment` entries. False for a naming object
   * that shares its tmux sessions across installs (`deterministicSessionNames`
   * captured at its creation): it sets no entry of its own, so it enables no
   * stripping. Entries are server-global, though: ones a non-gated object set
   * earlier on this server still apply to its attaches (see
   * `callback/sharedSessions.ts`).
   */
  callbackEnvironment: boolean;
  /** Base environment of the server-start process; callback variables are removed from it regardless. */
  env: NodeJS.ProcessEnv;
}

export type TmuxServerStartResult = 'disabled' | 'applied' | 'unsupported' | 'failed';

/**
 * Start (or reach) the shared server and apply the shared server options in one
 * `start-server ; set … ; …` chain, spawned variable-free.
 *
 * `start-server` MATERIALIZES the long-lived shared server (the process that
 * forks every pane), so it goes through `withNativeArch` like the session
 * creating spawns: under Rosetta an x86_64 server would make every pane run
 * translated whatever the client's arch.
 *
 * `exit-empty` stays `off` (see {@link tmuxServerOptionArgs}), in isolated runs
 * too.
 *
 * The callback entries are last in the chain. If the chain fails and they are
 * enabled, they are retried alone so the cause is exact, and ONE structured
 * diagnostic is logged per reason and socket (never a silently absent feature):
 *  - `unsupported`: tmux rejected the indexed form (an unknown or invalid option,
 *    not an array). The diagnostic names the tmux version. Only the callback
 *    variables are lost, since the entries are last in the chain.
 *  - `failed`: any other failure (server unreachable, wedged, killed). The raw
 *    failure is logged and no claim is made about the tmux version.
 */
export function startTmuxServer(
  opts: TmuxServerStart,
  run: TmuxRun = spawnTmux,
): TmuxServerStartResult {
  const env = withoutCallbackEnv(opts.env);
  const timeoutMs = TMUX_SPAWN_TIMEOUT_MS;
  const configArgs = opts.configPath ? ['-f', opts.configPath] : [];
  const srv = withNativeArch('tmux', [
    ...configArgs,
    '-L',
    opts.socket,
    'start-server',
    ...tmuxServerOptionArgs({ callbackEnvironment: opts.callbackEnvironment }),
  ]);
  const started = run(srv.file, srv.args, { env, capture: false, timeoutMs });
  if (!opts.callbackEnvironment) return 'disabled';
  if (started.status === 0) return 'applied';

  for (const name of CALLBACK_TMUX_ENV_NAMES) {
    const option = callbackUpdateEnvironmentOption(name);
    const retry = run('tmux', ['-L', opts.socket, 'set', '-g', option, name], {
      env,
      capture: true,
      timeoutMs,
    });
    if (retry.status === 0) continue;
    const detail =
      retry.stderr.trim().split('\n')[0] ||
      (retry.timedOut ? `timed out after ${timeoutMs}ms` : `exit status ${retry.status}`);
    const rejected = OPTION_REJECTED.test(retry.stderr);
    const reason = rejected ? 'update-environment-set-failed' : 'tmux-command-failed';
    // Every terminal open re-runs this chain: say it once, not once per tab.
    const key = `${reason}:${opts.socket}`;
    if (!reported.has(key)) {
      reported.add(key);
      const version = rejected
        ? ` tmux=${JSON.stringify(run('tmux', ['-V'], { env, capture: true, timeoutMs }).stdout.trim() || 'unknown')}`
        : '';
      logger.warn(
        `callback env unavailable socket=${opts.socket} reason=${reason}${version} ` +
          `option=${JSON.stringify(option)} detail=${JSON.stringify(detail)}; ` +
          (rejected
            ? 'panes on this server will not receive COCKPIT_CALLBACK_* or COCKPIT_CLI'
            : 'the callback variables may not reach panes on this server'),
        LOG_CONTEXT,
      );
    }
    return rejected ? 'unsupported' : 'failed';
  }
  return 'applied';
}

/**
 * Environment of the node-pty client that attaches to the shared server: modern
 * TERM/COLORTERM plus, when the project has them, its callback variables. The
 * inherited environment is stripped of callback variables first, so a value is
 * only ever the project's own. With no `callback`, the client carries none and
 * (when the entries are enabled) tmux strips them from the attached session.
 */
export function tmuxClientEnv(
  base: NodeJS.ProcessEnv,
  callback?: CallbackEnvironment,
): Record<string, string> {
  return terminalPaneEnv({ ...withoutCallbackEnv(base), ...callback?.vars });
}
