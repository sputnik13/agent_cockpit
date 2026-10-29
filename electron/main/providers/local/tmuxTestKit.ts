/**
 * Test kit for the real-tmux integration tests of callback injection. Everything
 * runs on a PRIVATE `-L` socket with a private config file (`-f`), in a private
 * temp directory, and never touches the persistent `agent-cockpit` server, the
 * user's tmux config, the Electron profile or a mux home.
 *
 * Panes are made observable by a `default-command` that dumps the pane's real
 * process environment to `<dir>/env.<pane id>` and then idles (`exec cat`), so a
 * test asserts what a pane's PROCESS actually received, not what tmux says it
 * would pass.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmuxInstalled = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

/** The environment tmux commands run with: the caller's, minus any outer tmux. */
export function isolatedEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env['TMUX'];
  delete env['TMUX_PANE'];
  return env;
}

/** The file tmux uses for `-L <name>`: `$TMUX_TMPDIR` (else `/tmp`) / `tmux-<uid>` / name. */
export function tmuxSocketFile(socket: string): string {
  return join(process.env['TMUX_TMPDIR'] || '/tmp', `tmux-${process.getuid?.() ?? 0}`, socket);
}

export interface TmuxSandbox {
  readonly socket: string;
  /** The socket's file, which `dispose()` removes along with the server. */
  readonly socketFile: string;
  readonly dir: string;
  /** The private tmux config (`-f`): deterministic panes that dump their environment. */
  readonly conf: string;
  /** Run a tmux command on the private server; returns stdout. Throws on failure. */
  tmux(...args: string[]): string;
  /** Like {@link tmux} but returns the exit status and output instead of throwing. */
  tmuxTry(...args: string[]): { status: number | null; stdout: string; stderr: string };
  /** The environment (name -> value) of the pane process, once it has started. */
  paneEnv(paneId: string): Promise<Map<string, string>>;
  /** Forget a pane's dump so a respawn can be observed afresh. */
  forgetPane(paneId: string): void;
  /** `show-environment` of a session (`-t =name`) or the global one, as raw lines. */
  sessionEnv(sessionName: string): string[];
  globalEnv(): string[];
  /** Element values of tmux's `update-environment` option, keyed by index. */
  updateEnvironment(): Map<number, string>;
  /** Session names on the private server. */
  sessions(): string[];
  /** All pane ids on the private server, in creation order. */
  panes(): string[];
  dispose(): void;
}

/**
 * A fresh sandbox. `dispose()` kills ONLY its own server and removes its directory
 * and its socket file (tmux can leave the file behind when its server is killed).
 */
export function createTmuxSandbox(label: string): TmuxSandbox {
  const socket = `ac-test-${label}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'accb-inj-'));
  const conf = join(dir, 'tmux.conf');
  // Single quotes: tmux expands $VAR inside double quotes at config-parse time.
  writeFileSync(
    conf,
    [
      'set -g default-shell /bin/sh',
      `set -g default-command 'env > ${dir}/tmp.$TMUX_PANE && mv ${dir}/tmp.$TMUX_PANE ${dir}/env.$TMUX_PANE; exec cat'`,
      '',
    ].join('\n'),
  );
  const run = (...args: string[]) =>
    spawnSync('tmux', ['-L', socket, ...args], { env: isolatedEnv(), encoding: 'utf8' });
  const tmux = (...args: string[]): string =>
    execFileSync('tmux', ['-L', socket, ...args], {
      env: isolatedEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const lines = (out: string): string[] => out.split('\n').filter((l) => l.length > 0);
  const envFile = (paneId: string): string => join(dir, `env.${paneId}`);

  return {
    socket,
    socketFile: tmuxSocketFile(socket),
    dir,
    conf,
    tmux,
    tmuxTry: (...args) => {
      const res = run(...args);
      return { status: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    async paneEnv(paneId) {
      // The dump is renamed into place when complete, so a present file is whole.
      const deadline = Date.now() + 8_000;
      while (!existsSync(envFile(paneId))) {
        if (Date.now() > deadline) throw new Error(`no environment dump for pane ${paneId}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const env = new Map<string, string>();
      for (const line of readFileSync(envFile(paneId), 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
      }
      return env;
    },
    forgetPane: (paneId) => rmSync(envFile(paneId), { force: true }),
    sessionEnv: (sessionName) => lines(tmux('show-environment', '-t', `=${sessionName}`)),
    globalEnv: () => lines(tmux('show-environment', '-g')),
    updateEnvironment: () => {
      const elements = new Map<number, string>();
      for (const line of lines(tmux('show-options', '-g', 'update-environment'))) {
        const m = /^update-environment\[(\d+)\] (.*)$/.exec(line);
        if (m) elements.set(Number(m[1]), m[2]!);
      }
      return elements;
    },
    sessions: () => lines(tmux('list-sessions', '-F', '#{session_name}')),
    panes: () => lines(tmux('list-panes', '-a', '-F', '#{pane_id}')),
    dispose() {
      try {
        execFileSync('tmux', ['-L', socket, 'kill-server'], {
          env: isolatedEnv(),
          stdio: 'ignore',
        });
      } catch {
        /* the server never started, or is already gone */
      }
      rmSync(tmuxSocketFile(socket), { force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
