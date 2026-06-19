/**
 * RemoteTerminalManager — persistent SSH terminals for the RemoteProvider
 * (br h7a.7.4).
 *
 * Each terminal opens an ssh2 PTY **shell** channel that runs
 * `tmux new-session -A -s agent-cockpit-terminal-<projectId>-<key>` (attach-or-create). Running the
 * agent inside tmux means it survives an SSH disconnect: on reconnect we open a
 * fresh shell channel that re-attaches the same session, so scrollback and the
 * running process are preserved on the host.
 *
 * Shell `data` is fanned out to onTerminalData handlers; channel `close` fires
 * onTerminalExit. write/setWindow map to keystrokes/resize. A minimal backoff is
 * modeled for transport drops; full reconnection orchestration (driven by the
 * transport's reconnect logic) is intentionally left thin.
 */
import { randomUUID } from 'node:crypto';
import type {
  TerminalDataHandler,
  TerminalExitHandler,
  TerminalExitInfo,
  TerminalHandle,
  TerminalKind,
  TerminalOpenOptions,
} from '../types';
import type { PtyChannel, RemoteTransport } from './transportTypes';
import { tmuxSocket } from '../../instanceConfig';
import { TERMINAL_TERM, TERMINAL_COLORTERM, tmuxServerOptionShell } from '@shared/tmux';

/** Backoff schedule (ms) for re-attaching after a transport drop. */
const REATTACH_BACKOFF_MS = [500, 1_000, 2_000, 5_000];

/** Dedicated tmux socket, isolated from the user's interactive tmux / byobu. */
const SOCKET = tmuxSocket();

/** tmux session names cannot contain '.' or ':'. */
const sanitize = (s: string): string => s.replace(/[.:\s]/g, '-');

interface RemoteTerminal {
  id: string;
  sessionName: string;
  cwd: string | undefined;
  cols: number;
  rows: number;
  channel: PtyChannel | null;
  dataHandlers: Set<TerminalDataHandler>;
  exitHandlers: Set<TerminalExitHandler>;
  closed: boolean;
  reattachAttempt: number;
}

/** Build the attach-or-create tmux command for a project session. */
function tmuxCommand(sessionName: string, cwd: string | undefined): string {
  const session = shellQuote(sessionName);
  // Apply the shared server options before the session (single source, so the
  // session-per-tab backend gets history-limit/mouse/color too); COLORTERM lets
  // the server advertise truecolor. `new-session -A` attaches if the session
  // exists, else creates it (`-c` sets the start dir for a fresh one). `-L` uses
  // a dedicated socket so cockpit sessions never mix with the user's tmux/byobu.
  const prefix = `COLORTERM=${TERMINAL_COLORTERM} tmux -L ${SOCKET} start-server \\; ${tmuxServerOptionShell()} \\; new-session -A -s ${session}`;
  if (cwd) {
    return `${prefix} -c ${shellQuote(cwd)}`;
  }
  return prefix;
}

/** Single-quote a value for safe interpolation into a remote shell command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class RemoteTerminalManager {
  private readonly terminals = new Map<string, RemoteTerminal>();

  /**
   * @param transport the remote transport; `openShell`/`exec` throw if not connected.
   * @param sessionToken scopes the tmux session name so terminals re-attach the
   *   same persistent session per project. The project id (default) or a sha of
   *   the project root when deterministic session names are enabled — resolved
   *   by the caller.
   */
  constructor(
    private readonly transport: RemoteTransport,
    private readonly sessionToken: string,
  ) {}

  /** Prefix for the `terminal` namespace (used to list/restore terminal tabs). */
  private terminalPrefix(): string {
    return `agent-cockpit-terminal-${sanitize(this.sessionToken)}-`;
  }
  /**
   * tmux session name for a given kind/key. `run` is a single per-project
   * session (key not part of the name); `terminal` is one session per key.
   */
  private sessionName(kind: TerminalKind, key: string): string {
    if (kind === 'run') return `agent-cockpit-run-${sanitize(this.sessionToken)}`;
    return `${this.terminalPrefix()}${sanitize(key)}`;
  }

  async open(opts: TerminalOpenOptions): Promise<TerminalHandle> {
    const id = opts.key ?? randomUUID();
    const term: RemoteTerminal = {
      id,
      sessionName: this.sessionName(opts.kind ?? 'terminal', id),
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      channel: null,
      dataHandlers: new Set(),
      exitHandlers: new Set(),
      closed: false,
      reattachAttempt: 0,
    };
    this.terminals.set(id, term);
    await this.attach(term);
    return { id };
  }

  /** Open a shell channel and (re)attach the tmux session for this terminal. */
  private async attach(term: RemoteTerminal): Promise<void> {
    const channel = await this.transport.openShell({
      term: TERMINAL_TERM,
      cols: term.cols,
      rows: term.rows,
    });
    term.channel = channel;
    term.reattachAttempt = 0;

    channel.onData((chunk: Uint8Array) => {
      const data = Buffer.from(chunk).toString('utf8');
      for (const h of term.dataHandlers) {
        try {
          h(data);
        } catch (e) {
          console.error('[remote-terminal] onData handler threw', e);
        }
      }
    });
    channel.onClose(() => {
      term.channel = null;
      if (term.closed) {
        this.emitExit(term, { code: 0, signal: null });
        return;
      }
      // Unexpected drop: attempt a backoff re-attach (the session lives
      // on in tmux on the host).
      this.scheduleReattach(term);
    });

    // Enter the attach-or-create command so the agent runs inside tmux.
    channel.write(`${tmuxCommand(term.sessionName, term.cwd)}\n`);
  }

  /** Schedule a backoff re-attach after an unexpected channel close. */
  private scheduleReattach(term: RemoteTerminal): void {
    const delay =
      REATTACH_BACKOFF_MS[Math.min(term.reattachAttempt, REATTACH_BACKOFF_MS.length - 1)]!;
    term.reattachAttempt += 1;
    const timer = setTimeout(() => {
      if (term.closed) return;
      this.attach(term).catch(() => {
        // Transport still down; try again unless we've been closed meanwhile.
        if (!term.closed) this.scheduleReattach(term);
      });
    }, delay);
    timer.unref?.();
  }

  private emitExit(term: RemoteTerminal, info: TerminalExitInfo): void {
    for (const h of term.exitHandlers) {
      try {
        h(info);
      } catch (e) {
        console.error('[remote-terminal] onExit handler threw', e);
      }
    }
  }

  write(id: string, data: string): void {
    const term = this.require(id);
    term.channel?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.require(id);
    term.cols = cols;
    term.rows = rows;
    term.channel?.resize(cols, rows);
  }

  onData(id: string, handler: TerminalDataHandler): () => void {
    const term = this.require(id);
    term.dataHandlers.add(handler);
    return () => term.dataHandlers.delete(handler);
  }

  onExit(id: string, handler: TerminalExitHandler): () => void {
    const term = this.require(id);
    term.exitHandlers.add(handler);
    return () => term.exitHandlers.delete(handler);
  }

  close(id: string, opts?: { kill?: boolean }): void {
    const term = this.terminals.get(id);
    const sessionName = term?.sessionName ?? this.sessionName('terminal', id);
    if (term) {
      term.closed = true;
      // Detach from tmux (session keeps running) by closing the channel.
      term.channel?.close();
      this.terminals.delete(id);
    }
    if (opts?.kill) {
      this.exec(`tmux -L ${SOCKET} kill-session -t ${shellQuote(sessionName)}`).catch(() => {});
    }
  }

  /** Close every terminal channel (called on provider disconnect). */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  /**
   * Existing `terminal`-kind tmux session keys for this project (tab restore).
   * The `run` session lives in its own namespace and is excluded.
   */
  async listSessions(): Promise<string[]> {
    const out = await this.exec(`tmux -L ${SOCKET} ls -F '#{session_name}' 2>/dev/null || true`);
    const prefix = this.terminalPrefix();
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((n) => n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
  }

  /** Run a one-shot command over the transport, returning stdout. */
  private async exec(command: string): Promise<string> {
    const res = await this.transport.exec(command);
    return res.stdout;
  }

  private require(id: string): RemoteTerminal {
    const term = this.terminals.get(id);
    if (!term) throw new Error(`RemoteProvider: unknown terminal id "${id}"`);
    return term;
  }
}
