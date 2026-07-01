/**
 * LocalTmuxControlManager — a per-project tmux control-mode (`-CC`) session for
 * the LocalProvider. Spawns
 *   `tmux -L agent-cockpit -CC new-session -A -s agent-cockpit-<projectId>`
 * via node-pty, drives the shared {@link TmuxControlParser}, exposes typed
 * notifications to subscribers, and serializes reply-correlated commands and
 * pane input back onto the control stream.
 *
 * This is ADDITIVE: it does not replace {@link import('./terminal').LocalTerminalManager}
 * and is not yet wired as the active terminal path. The dedicated socket
 * (`-L agent-cockpit`) is the same one the existing terminals use; `-CC` only
 * changes how this *client* renders, so the two coexist on the same server.
 *
 * The parser and command builders live in `src/shared/tmux` (pure); this module
 * owns only the node-pty transport, command sequencing, and lifecycle.
 */
import { spawnSync } from 'node:child_process';
import * as pty from 'node-pty';
import { withNativeArch } from './nativeArch';
import { tmuxSocket } from '../../instanceConfig';
import {
  TERMINAL_TERM,
  tmuxServerOptionArgs,
  terminalPaneEnv,
  TmuxControlParser,
  buildSendKeysCommands,
  capturePane as capturePaneCmd,
  classifyResponsiveness,
  killPane as killPaneCmd,
  killWindow as killWindowCmd,
  newWindow as newWindowCmd,
  refreshClientSize,
  renameWindow as renameWindowCmd,
  RESPONSIVENESS_POLL_MS,
  resizePane as resizePaneCmd,
  selectPane as selectPaneCmd,
  selectWindow as selectWindowCmd,
  splitWindow as splitWindowCmd,
} from '@shared/tmux';
import type { TmuxNotification, UnresponsiveInfo } from '@shared/tmux';

const SOCKET = tmuxSocket();

/** tmux session names cannot contain '.' or ':'. */
const sanitize = (s: string): string => s.replace(/[.:\s]/g, '-');

let tmuxChecked = false;
let tmuxPresent = false;
/** Whether `tmux` is on PATH (cached). Mirrors LocalTerminalManager. */
export function hasTmux(): boolean {
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

/** Result of a reply-correlated command: the body lines and error flag. */
export interface CommandReply {
  num: number;
  error: boolean;
  lines: string[];
}

type NotificationHandler = (n: TmuxNotification) => void;

interface PendingCommand {
  resolve: (reply: CommandReply) => void;
  reject: (err: Error) => void;
  /** When false, a tmux `%error` reply rejects instead of resolving. */
  tolerateErrors: boolean;
  /** Epoch ms the command was written, for the unresponsiveness watchdog. */
  enqueuedAt: number;
}

/** Options for {@link LocalTmuxControlManager.command}. */
export interface CommandOptions {
  /** Resolve (rather than reject) even when tmux returns `%error`. Default true
   *  to preserve the resolve-with-error contract the renderer reconcile/seed
   *  paths rely on; structural mutation wrappers pass false to surface failures. */
  tolerateErrors?: boolean;
}

/** Resolve or reject a pending command from its reply, honoring its tolerance. */
function settleCommand(cmd: PendingCommand, reply: CommandReply): void {
  if (reply.error && !cmd.tolerateErrors) {
    cmd.reject(new Error(`tmux command error: ${reply.lines.join('; ') || 'tmux returned %error'}`));
  } else {
    cmd.resolve(reply);
  }
}

/**
 * Drives one control-mode connection. Commands are sequenced: each command is
 * tagged with an incrementing client-side number, and tmux echoes that number
 * in the `%begin`/`%end`/`%error` block so replies correlate in FIFO order.
 */
export class LocalTmuxControlManager {
  private proc: pty.IPty | null = null;
  private readonly parser = new TmuxControlParser();
  private readonly handlers = new Set<NotificationHandler>();
  /** FIFO of in-flight commands awaiting their reply block. */
  private readonly pending: PendingCommand[] = [];
  private commandSeq = 0;
  private opened = false;
  /** Monotonic per-manager attach counter, emitted as an `attached` notification
   *  on each successful open so the renderer drives its re-init off a fresh
   *  channel uniformly with the remote transport (see CLAUDE.md "control-mode
   *  reconnect"). The local pty does not silently reattach, so in practice this
   *  bumps once per open()/re-open. */
  private epoch = 0;
  /** tmux emits one unsolicited `%begin/%end` block on attach (its own output);
   *  it is not a reply to a client command and must not consume a pending slot. */
  private sawInitialBlock = false;

  /**
   * Optional activity tap fired once per control-mode `%output` notification.
   * Used by the idle reaper to count a backgrounded agent's output as "use"
   * (keeps its session alive). Structural/reply notifications never call this:
   * replies are consumed in ingest() before emit(), and other notification
   * types are filtered out below.
   */
  onOutputActivity?: () => void;
  /**
   * Optional hook fired once per episode when the oldest in-flight command
   * crosses the unresponsive WARN threshold. Wire to the ConnectionMachine to
   * surface a degraded state instead of an indefinite spinner. On the FAIL
   * threshold the manager rejects all pending and kills the control pty.
   */
  onUnresponsive?: (info: UnresponsiveInfo) => void;
  /** Polls the oldest-pending age; runs while the control pty is open. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** True once the current stall episode has fired onUnresponsive (warn-once). */
  private unresponsiveWarned = false;

  constructor(
    private readonly sessionToken: string,
    private readonly rootPath: string,
  ) {}

  /** Control-session name for this project (distinct from per-key sessions).
   *  `sessionToken` is the project id (default) or a sha of the project root
   *  when deterministic session names are enabled — resolved by the caller. */
  sessionName(): string {
    return `agent-cockpit-${sanitize(this.sessionToken)}`;
  }

  /** Whether the control pty is live. */
  isOpen(): boolean {
    return this.opened && this.proc != null;
  }

  /**
   * Spawn (or attach to) the project's control session. Idempotent: a second
   * call while open is a no-op. Throws if tmux is unavailable.
   */
  open(opts?: { cols?: number; rows?: number }): void {
    if (this.opened) return;
    if (!hasTmux()) throw new Error('tmux is not available');
    const cols = opts?.cols ?? 80;
    const rows = opts?.rows ?? 24;
    const env = terminalPaneEnv(process.env);
    // Set the GLOBAL history-limit on the socket BEFORE the first new-session.
    // `new-session -A` creates the initial pane as part of session creation
    // (there is no pre-pane command slot), and `set-option` does NOT resize
    // already-created panes — so the option must precede pane creation for the
    // auto-created pane (and every later pane) to inherit it. `set -g` needs a
    // running server, so `start-server` first; `set -g exit-empty off` keeps that
    // empty server alive so the `history-limit` persists to the `-CC new-session`
    // spawned below (whose pane then inherits it). `;` is a literal argv element
    // here — no shell — so tmux treats it as its command separator. See FR3.
    //
    // NOTE: unlike the remote opener these are SEPARATE invocations (not one
    // `&&`-chained shell command), so even a failing option never blocks the
    // `-CC new-session` — local never had the remote "No such file or directory"
    // connect bug; this only restores the cold-start scrollback.
    //
    // CRITICAL: `start-server` MATERIALIZES the long-lived shared `agent-cockpit`
    // server — the process that forks every pane/shell beneath it. It is NOT a
    // server-query; it must run through withNativeArch too, or under Rosetta the
    // server is born x86_64 and the arch-wrapped `-CC new-session -A` below just
    // ATTACHES to that x86_64 server, so every pane runs translated and reports
    // `uname -m` = x86_64 despite the arm64 client wrapper. Wrapping the
    // `set -g` sub-commands chained after it via the literal `;` is harmless (they
    // target the server it just started).
    const srv = withNativeArch('tmux', [
      '-L', SOCKET,
      'start-server',
      ...tmuxServerOptionArgs(),
    ]);
    spawnSync(srv.file, srv.args, { stdio: 'ignore' });
    // Wrap with arch -arm64 when translated under Rosetta (no-op otherwise) so
    // the control-mode tmux client attaches native; the server above is already
    // born native via the same wrapper.
    const ctl = withNativeArch('tmux', [
      '-L', SOCKET, '-CC', 'new-session', '-A', '-s', this.sessionName(), '-c', this.rootPath,
    ]);
    this.proc = pty.spawn(
      ctl.file,
      ctl.args,
      // encoding:null delivers raw Buffer chunks instead of UTF-8 strings. tmux's
      // %output escapes only control bytes and backslash — non-ASCII bytes
      // (UTF-8 sequences for Unicode glyphs: powerline arrows, box-drawing, etc.)
      // are emitted verbatim. If node-pty UTF-8-decodes the chunk into a JS
      // string, those bytes become Unicode codepoints and `decodeOutput`'s
      // `c & 0xff` truncates each codepoint to its low byte, breaking any rich
      // TUI (claude, htop, vim, …). Raw bytes preserve the wire faithfully.
      { name: TERMINAL_TERM, cols, rows, cwd: this.rootPath, env, encoding: null },
    );
    this.opened = true;
    this.sawInitialBlock = false;
    // Announce the fresh channel to the renderer (parity with the remote
    // manager). The onNotification forwarder is wired in activeControl() before
    // this synchronous open() runs, so the first `attached` is not missed.
    this.epoch += 1;
    this.emit({ type: 'attached', epoch: this.epoch });
    // Isolate handler throws so a listener error can never reach node-pty's
    // N-API layer (which would SIGABRT the process).
    this.proc.onData((chunk) => {
      try {
        // With encoding:null the runtime chunk is a Buffer (a Uint8Array
        // subclass); the parser handles Uint8Array via latin1Decode. node-pty's
        // typing still claims `string`, so cast.
        this.ingest(chunk as unknown as Uint8Array);
      } catch (e) {
        console.error('[tmux-control] ingest threw', e);
      }
    });
    this.proc.onExit(() => {
      this.opened = false;
      this.proc = null;
      this.clearWatchdog();
      // Fail any outstanding commands so callers do not hang.
      const drained = this.pending.splice(0);
      for (const p of drained) p.reject(new Error('tmux control session exited'));
      this.emit({ type: 'exit', reason: null });
    });
    this.startWatchdog();
  }

  /** Start the unresponsiveness watchdog (idempotent; runs while open). */
  private startWatchdog(): void {
    if (this.watchdogTimer != null) return;
    this.watchdogTimer = setInterval(() => this.checkResponsiveness(), RESPONSIVENESS_POLL_MS);
    this.watchdogTimer.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer != null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.unresponsiveWarned = false;
  }

  /**
   * Poll the oldest in-flight command's age. `warn` surfaces onUnresponsive once
   * per episode; `fail` rejects ALL pending and kills the control pty (its
   * onExit drains the now-empty FIFO and emits exit) so promises don't hang and
   * a late reply can't desync the FIFO. The tmux session survives on the socket.
   */
  private checkResponsiveness(): void {
    const oldest = this.pending[0];
    const age = oldest ? Date.now() - oldest.enqueuedAt : null;
    const action = classifyResponsiveness(age);
    if (action === 'none') {
      this.unresponsiveWarned = false;
      return;
    }
    if (action === 'warn') {
      if (!this.unresponsiveWarned) {
        this.unresponsiveWarned = true;
        console.warn(
          `[tmux-control] unresponsive: oldest command ${Math.round(age!)}ms with no reply (${this.pending.length} pending)`,
        );
        try {
          this.onUnresponsive?.({ pendingCount: this.pending.length, oldestAgeMs: age! });
        } catch (e) {
          console.error('[tmux-control] onUnresponsive hook threw', e);
        }
      }
      return;
    }
    // action === 'fail'
    console.error(
      `[tmux-control] unresponsive ${Math.round(age!)}ms — failing ${this.pending.length} pending and killing the control pty`,
    );
    const drained = this.pending.splice(0);
    for (const p of drained) p.reject(new Error('tmux control unresponsive'));
    this.clearWatchdog();
    try {
      this.proc?.kill(); // onExit drains the now-empty FIFO and emits exit.
    } catch {
      /* already exited */
    }
  }

  /** Feed raw control-stream text into the parser and dispatch notifications. */
  private ingest(chunk: string | Uint8Array): void {
    for (const n of this.parser.feed(chunk)) {
      if (n.type === 'reply') {
        // Skip tmux's initial unsolicited attach block so command replies stay
        // FIFO-correlated with the commands the client actually sent.
        if (!this.sawInitialBlock) {
          this.sawInitialBlock = true;
          continue;
        }
        const cmd = this.pending.shift();
        if (cmd) settleCommand(cmd, { num: n.num, error: n.error, lines: n.lines });
        continue;
      }
      this.emit(n);
    }
  }

  private emit(n: TmuxNotification): void {
    // Background %output counts as session activity (idle aging-out). Only
    // `output` notifications — structural notifications (layout-change,
    // window-add, …) must NOT keep a quiet session alive.
    if (n.type === 'output' && this.onOutputActivity) {
      try {
        this.onOutputActivity();
      } catch (e) {
        console.error('[tmux-control] output-activity tap threw', e);
      }
    }
    for (const h of this.handlers) {
      try {
        h(n);
      } catch (e) {
        console.error('[tmux-control] notification handler threw', e);
      }
    }
  }

  /** Subscribe to typed notifications; returns an unsubscribe function. */
  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Issue a tmux command (the argument string, e.g. `new-window`). Resolves with
   * the correlated reply block. Rejects if the session is not open or exits
   * before replying.
   */
  command(args: string, opts?: CommandOptions): Promise<CommandReply> {
    if (!this.proc) return Promise.reject(new Error('tmux control session is not open'));
    this.commandSeq += 1;
    const tolerateErrors = opts?.tolerateErrors ?? true;
    return new Promise<CommandReply>((resolve, reject) => {
      this.pending.push({ resolve, reject, tolerateErrors, enqueuedAt: Date.now() });
      this.proc!.write(`${args}\n`);
    });
  }

  // ---- Structure commands (thin, reply-correlated) ----
  // These are mutations where a tmux `%error` is a real failure, not a tolerable
  // "not ready" — so they reject (tolerateErrors:false) rather than resolving
  // with an empty/garbage reply the caller would silently accept.
  newWindow(opts?: { name?: string; cwd?: string }): Promise<CommandReply> {
    return this.command(newWindowCmd(opts), { tolerateErrors: false });
  }
  splitWindow(paneId: string, dir: 'lr' | 'tb', opts?: { cwd?: string }): Promise<CommandReply> {
    return this.command(splitWindowCmd(paneId, dir, opts), { tolerateErrors: false });
  }
  killPane(paneId: string): Promise<CommandReply> {
    return this.command(killPaneCmd(paneId), { tolerateErrors: false });
  }
  killWindow(windowId: string): Promise<CommandReply> {
    return this.command(killWindowCmd(windowId), { tolerateErrors: false });
  }
  selectWindow(windowId: string): Promise<CommandReply> {
    return this.command(selectWindowCmd(windowId), { tolerateErrors: false });
  }
  selectPane(paneId: string): Promise<CommandReply> {
    return this.command(selectPaneCmd(paneId), { tolerateErrors: false });
  }
  renameWindow(windowId: string, name: string): Promise<CommandReply> {
    return this.command(renameWindowCmd(windowId, name), { tolerateErrors: false });
  }
  resizePane(paneId: string, size: { x?: number; y?: number }): Promise<CommandReply> {
    return this.command(resizePaneCmd(paneId, size), { tolerateErrors: false });
  }

  /** Report the client size so tmux recomputes and re-emits layout. */
  resizeClient(cols: number, rows: number): Promise<CommandReply> {
    return this.command(refreshClientSize(cols, rows));
  }

  /**
   * Send input bytes (or a pre-built hex string) to a pane. Encoding-classified
   * and chunked into one or more `send-keys` commands (printable ASCII via `-l`,
   * the rest via `-H` raw hex) so a large paste can't exceed tmux's control-
   * command line limit and get dropped. Commands are issued in order; resolves
   * with the last reply (a no-op reply for empty input).
   */
  async input(paneId: string, hexOrInput: string | Uint8Array): Promise<CommandReply> {
    let last: CommandReply = { num: -1, error: false, lines: [] };
    for (const cmd of buildSendKeysCommands(paneId, hexOrInput)) last = await this.command(cmd);
    return last;
  }

  /** Seed scrollback for a pane via `capture-pane -peJ`; returns body lines. */
  async capturePane(paneId: string, opts?: { startLine?: number }): Promise<string[]> {
    const reply = await this.command(capturePaneCmd(paneId, opts));
    return reply.lines;
  }

  /**
   * Detach the control client (the tmux session keeps running on the socket).
   * Idempotent.
   */
  close(): void {
    const proc = this.proc;
    this.opened = false;
    this.proc = null;
    this.clearWatchdog();
    try {
      proc?.kill(); // detaches the control client
    } catch {
      /* already exited */
    }
  }

  /** Kill the underlying tmux session entirely (ends all panes). */
  killSession(): void {
    this.close();
    if (hasTmux()) {
      spawnSync('tmux', ['-L', SOCKET, 'kill-session', '-t', this.sessionName()], { stdio: 'ignore' });
    }
  }
}
