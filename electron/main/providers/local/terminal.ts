/**
 * LocalProvider terminals — each terminal runs inside its own tmux session on a
 * dedicated `cockpit` socket, so terminals persist across IDE restarts (the
 * tmux server keeps them) and multiple coexist per project. node-pty is just
 * the attaching client. The dedicated socket (`tmux -L agent-cockpit`) isolates these
 * from the user's interactive tmux / byobu server. Falls back to a bare shell
 * when tmux is unavailable (no persistence).
 */
import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';
import type { CallbackEnvironmentSource } from '@shared/callback/env';
import { withNativeArch } from './nativeArch';
import { startTmuxServer, tmuxClientEnv } from './tmuxServer';
import { resolveCallbackEnvironment } from '../../callback/resolveEnvironment';
import { tmuxSocket } from '../../instanceConfig';
import { TERMINAL_TERM, terminalPaneEnv } from '@shared/tmux';
import type {
  TerminalDataHandler,
  TerminalExitHandler,
  TerminalHandle,
  TerminalKind,
  TerminalOpenOptions,
} from '../types';

const SOCKET = tmuxSocket();

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

let tmuxChecked = false;
let tmuxPresent = false;
function hasTmux(): boolean {
  if (!tmuxChecked) {
    tmuxChecked = true;
    try {
      tmuxPresent = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
    } catch {
      tmuxPresent = false;
    }
  }
  return tmuxPresent;
}

/** tmux session names cannot contain '.' or ':'. */
const sanitize = (s: string): string => s.replace(/[.:\s]/g, '-');

interface Session {
  proc: pty.IPty;
  /** Resolved tmux session name, so close()/kill target the exact session. */
  name: string;
  data: Set<TerminalDataHandler>;
  exit: Set<TerminalExitHandler>;
}

let counter = 0;

export interface LocalTerminalOptions {
  /** tmux socket; defaults to the app's cockpit socket (tests use a private one). */
  socket?: string;
  /** tmux `-f` config file (tests only, so they never read the user's config). */
  configPath?: string;
  /**
   * Present = callback injection is ENABLED for this manager
   * (docs/design/terminal-callback-socket.md, "Environment injection"): a new
   * session's first pane gets this project's variables through the attaching
   * client's environment and the local-only `update-environment` entries. Absent =
   * DISABLED. The owner decides once, at creation, from the same settings read
   * that chose `sessionToken` (requirement 12), so it is never re-read here.
   */
  callbackEnvironment?: CallbackEnvironmentSource;
}

export class LocalTerminalManager {
  private sessions = new Map<string, Session>();
  private readonly socket: string;

  constructor(
    private readonly rootPath: string,
    private readonly sessionToken: string,
    private readonly options: LocalTerminalOptions = {},
  ) {
    this.socket = options.socket ?? SOCKET;
  }

  /** Prefix for the `terminal` namespace (used to list/restore terminal tabs).
   *  `sessionToken` is the project id (default) or a sha of the project root
   *  when deterministic session names are enabled — resolved by the caller. */
  private terminalPrefix(): string {
    return `agent-cockpit-terminal-${sanitize(this.sessionToken)}-`;
  }
  /**
   * tmux session name for a given kind/key. `run` is a single per-project
   * session (the key is not part of the name); `terminal` is one session per
   * key. The two namespaces never collide.
   */
  private sessionName(kind: TerminalKind, key: string): string {
    if (kind === 'run') return `agent-cockpit-run-${sanitize(this.sessionToken)}`;
    return `${this.terminalPrefix()}${sanitize(key)}`;
  }

  open(opts: TerminalOpenOptions): TerminalHandle {
    const key = opts.key ?? `t${++counter}`;
    const cwd = opts.cwd ?? this.rootPath;
    const name = this.sessionName(opts.kind ?? 'terminal', key);
    const tmux = hasTmux();
    const configArgs = this.options.configPath ? ['-f', this.options.configPath] : [];
    // Apply the shared server options BEFORE the session (single source), so the
    // session-per-tab backend gets history-limit/mouse/color too. This is its own
    // VARIABLE-FREE spawn, split off the session-creating client below: the process
    // that starts the shared server stamps its environment into every project's
    // panes, and the client that creates the session must carry THIS project's
    // callback variables (docs/requirements/terminal-callback-socket.md,
    // requirement 7). The server keeps the TERM/COLORTERM it always got from the
    // one-spawn form.
    if (tmux) {
      startTmuxServer({
        socket: this.socket,
        ...(this.options.configPath ? { configPath: this.options.configPath } : {}),
        callbackEnvironment: this.options.callbackEnvironment !== undefined,
        env: terminalPaneEnv(process.env),
      });
    }
    // The attaching client carries the project's callback variables; tmux copies
    // them into the new session (its first pane included) via the local-only
    // `update-environment` entries. A bare-shell fallback (no tmux) is not a
    // callback backend and keeps the plain terminal environment.
    const env = tmux
      ? tmuxClientEnv(
          process.env,
          resolveCallbackEnvironment(this.options.callbackEnvironment, `session=${name}`),
        )
      : terminalPaneEnv(process.env);

    // Run the session-creating child native arm64 when we're translated under
    // Rosetta on Apple Silicon (no-op elsewhere); the two branches share spawn
    // options, so wrap whichever target applies and spawn once.
    const { file, args } = tmux
      ? withNativeArch('tmux', [
          ...configArgs,
          '-L',
          this.socket,
          'new-session',
          '-A',
          '-s',
          name,
          '-c',
          cwd,
        ])
      : withNativeArch(defaultShell(), []);
    const proc = pty.spawn(file, args, {
      name: TERMINAL_TERM,
      cols: opts.cols,
      rows: opts.rows,
      cwd,
      env,
    });

    const session: Session = { proc, name, data: new Set(), exit: new Set() };
    this.sessions.set(key, session);
    // A throw inside a node-pty onData/onExit callback is rethrown by node-pty's
    // N-API layer as an uncatchable C++ exception that aborts the whole process
    // (SIGABRT). Isolate each handler so a listener error can never reach it.
    proc.onData((chunk) => {
      for (const h of session.data) {
        try {
          h(chunk);
        } catch (e) {
          console.error('[terminal] onData handler threw', e);
        }
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      const info = { code: exitCode, signal: signal != null ? String(signal) : null };
      for (const h of session.exit) {
        try {
          h(info);
        } catch (e) {
          console.error('[terminal] onExit handler threw', e);
        }
      }
      this.sessions.delete(key);
    });
    return { id: key };
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.proc.write(data);
  }
  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.proc.resize(cols, rows);
  }
  onData(id: string, handler: TerminalDataHandler): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => {};
    s.data.add(handler);
    return () => s.data.delete(handler);
  }
  onExit(id: string, handler: TerminalExitHandler): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => {};
    s.exit.add(handler);
    return () => s.exit.delete(handler);
  }

  /** Detach (default) keeps the tmux session alive; kill ends it (and the agent). */
  close(id: string, opts?: { kill?: boolean }): void {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    try {
      s?.proc.kill(); // detaches the tmux client
    } catch {
      /* already exited */
    }
    if (opts?.kill && s && hasTmux()) {
      spawnSync('tmux', ['-L', this.socket, 'kill-session', '-t', s.name], { stdio: 'ignore' });
    }
  }

  /**
   * Existing `terminal`-kind tmux session keys for this project (for tab restore
   * on boot). The `run` session lives in its own namespace and is excluded.
   */
  listSessions(): string[] {
    if (!hasTmux()) return [...this.sessions.keys()];
    const res = spawnSync('tmux', ['-L', this.socket, 'ls', '-F', '#{session_name}'], {
      encoding: 'utf8',
    });
    if (res.status !== 0 || !res.stdout) return [];
    const prefix = this.terminalPrefix();
    return res.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
  }

  /** Detach all attached clients (keep sessions); used on disconnect/quit. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
