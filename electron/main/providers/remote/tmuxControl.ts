/**
 * RemoteTmuxControlManager — a per-project tmux control-mode (`-CC`) session
 * for the RemoteProvider, driving the control stream over an SSH shell channel.
 *
 * It mirrors {@link import('../local/tmuxControl').LocalTmuxControlManager} but
 * is parameterized by a {@link ControlChannelOpener} so the SSH-specific bits
 * (opening a shell channel and launching tmux on the remote host) are injected
 * and the manager can be exercised with a fake channel in tests — no live SSH
 * host required. On an unexpected channel drop it reattaches with backoff and
 * resyncs purely from the notifications tmux replays.
 *
 * ADDITIVE: this does not replace {@link import('./tmux').RemoteTerminalManager}
 * and is not yet wired as the active terminal path. The shared parser and
 * command builders (`src/shared/tmux`) are reused verbatim.
 */
import {
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
import { logger } from '../../logger';

/** Backoff schedule (ms) for re-attaching after a control-channel drop. */
const REATTACH_BACKOFF_MS = [500, 1_000, 2_000, 5_000];

/** After the schedule is exhausted (this many consecutive reattaches without a
 *  stable channel), give up and emit `exit` instead of looping forever. */
const MAX_REATTACH = REATTACH_BACKOFF_MS.length;

/** A channel must stay alive this long to count as "stable"; reaching it resets
 *  the backoff so a one-off drop later starts fresh (vs. a tight flap). */
const STABILITY_RESET_MS = 30_000;

/** A channel that closes within this window of opening is "flapping" — logged as
 *  a distinct diagnostic (almost always a duplicate control client on the shared
 *  socket, or the dedicated session being kicked/killed on the host). */
const IMMEDIATE_DROP_MS = 2_000;

/**
 * The minimal duplex channel the manager needs. An ssh2 `ClientChannel`
 * satisfies this; tests provide a fake. `write` feeds the remote tmux stdin;
 * `onData` delivers control-stream bytes as raw Buffers (no UTF-8 decoding —
 * the raw-byte invariant from CLAUDE.md must be preserved end-to-end);
 * `onClose` fires on drop.
 */
export interface ControlChannel {
  write(data: string): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

/** Opens a control channel that already has `tmux -CC attach/new-session` running. */
export type ControlChannelOpener = () => Promise<ControlChannel>;

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

/** Options for {@link RemoteTmuxControlManager.command}. */
export interface CommandOptions {
  /** Resolve (rather than reject) even when tmux returns `%error`. Default true
   *  to preserve the resolve-with-error contract; structural mutation wrappers
   *  pass false to surface failures instead of swallowing them. */
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

export class RemoteTmuxControlManager {
  private channel: ControlChannel | null = null;
  private parser = new TmuxControlParser();
  private readonly handlers = new Set<NotificationHandler>();
  private readonly pending: PendingCommand[] = [];
  private closed = false;
  private reattachAttempt = 0;
  /** Monotonic per-manager attach counter. Bumped on every successful attach
   *  (first open AND each silent reattach) and emitted as an `attached`
   *  notification so the renderer re-inits a fresh channel without needing a
   *  ConnectionMachine status transition — a silent reattach never produces one.
   *  See CLAUDE.md "control-mode reconnect". */
  private epoch = 0;
  /** In-flight attach, cached so concurrent open() calls (and a pending reattach)
   *  share one channel instead of each racing through the pre-assignment await
   *  gap and opening a duplicate `tmux -CC` client. */
  private opening: Promise<void> | null = null;
  /** The single pending reattach timer, if any. Kept so open()/close() can cancel
   *  it and a reattach can never stack a second timer (storm prevention). */
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timer that resets the backoff once a channel proves stable. */
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the current channel opened (epoch ms), for immediate-drop detection. */
  private openedAt = 0;
  /** Last tmux `%exit` reason seen, surfaced on the next close for diagnosis. */
  private lastExitReason: string | null = null;
  /** First bytes received on the current channel (latin1, truncated), captured
   *  so an immediate drop can show the remote's actual stderr/stdout — e.g.
   *  `tmux: invalid option` (old tmux), `command not found` (PATH), a usage
   *  banner, or `%begin …` (control mode actually started). */
  private firstChunk = '';
  /** True once reattach is exhausted; a later explicit open() clears it to retry. */
  private gaveUp = false;
  /**
   * Optional activity tap fired once per control-mode `%output` notification.
   * Mirrors the local manager: lets the idle reaper count a backgrounded agent's
   * output as "use". Structural/reply notifications never call this.
   */
  onOutputActivity?: () => void;
  /**
   * Optional hook fired once per episode when the oldest in-flight command
   * crosses the unresponsive WARN threshold (the link is wedged but not yet
   * failed). Wire to the ConnectionMachine to surface a degraded/reconnecting
   * state instead of an indefinite spinner. On the FAIL threshold the manager
   * rejects all pending commands and drops the channel to reattach (no hook —
   * the dropped channel already drives the connection state).
   */
  onUnresponsive?: (info: UnresponsiveInfo) => void;
  /**
   * Optional status hooks for the control-channel reattach cycle. The `-CC`
   * channel reconnects independently of the SSH transport, so without these the
   * ConnectionMachine would stay `connected` through a silent flap. Wire them to
   * surface an honest `reconnecting`/`connected`/`failed` status. These are
   * observability only — the renderer's re-init is driven by the `attached`
   * epoch, not by these transitions.
   * - `onReconnecting`: the live channel dropped and a reattach is scheduled.
   * - `onReattached`: a reattach (not the first open) re-established the channel.
   * - `onReattachExhausted`: the backoff schedule was exhausted; give up.
   */
  onReconnecting?: () => void;
  onReattached?: () => void;
  onReattachExhausted?: () => void;
  /** Polls the oldest-pending age; runs while a channel is open. */
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** True once the current stall episode has fired onUnresponsive (warn-once). */
  private unresponsiveWarned = false;

  constructor(private readonly openChannel: ControlChannelOpener) {}

  isOpen(): boolean {
    return this.channel != null && !this.closed;
  }

  /**
   * Open the control channel and wire the parser. Concurrency-safe: a second
   * call while a channel is open (or while the first open is still in flight)
   * does NOT open another channel. This matters because `this.channel` is only
   * assigned after `await this.attach()`; without coalescing the in-flight
   * promise, concurrent callers would all observe `channel == null`, each open
   * a real `tmux -CC` client, and tmux would fan every %output to all of them —
   * rendering every byte once per duplicate channel.
   */
  async open(): Promise<void> {
    if (this.channel) return;
    this.closed = false;
    // A reattach is already pending: let it do the work. Without this, a caller
    // that re-acquires during the brief drop→reattach gap (the renderer retries
    // when list-windows comes back empty mid-flap) would start a SECOND attach
    // racing the scheduled one — overlapping `tmux -CC` clients that flap and
    // detach each other, the concurrent-channel storm.
    if (this.opening) return this.opening;
    if (this.reattachTimer != null && !this.gaveUp) return;
    // An explicit open() after we gave up is a deliberate retry: reset backoff.
    if (this.gaveUp) {
      this.gaveUp = false;
      this.reattachAttempt = 0;
    }
    return this.ensureOpen();
  }

  /** Single-flight attach shared by open() and the reattach timer. */
  private ensureOpen(): Promise<void> {
    if (this.opening) return this.opening;
    this.clearReattachTimer();
    this.opening = this.attach().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async attach(): Promise<void> {
    // A fresh parser per attach: tmux replays full state on reattach, so a
    // clean parser avoids carrying a half-buffered line across the drop.
    this.parser = new TmuxControlParser();
    logger.info('tmux control-mode channel opening', 'remote-tmux-control');
    const channel = await this.openChannel();
    // close() may have run while the channel was being opened: don't keep a
    // channel nobody will ever tear down.
    if (this.closed) {
      try {
        channel.close();
      } catch {
        /* already closed */
      }
      return;
    }
    this.channel = channel;
    this.openedAt = Date.now();
    this.lastExitReason = null;
    this.firstChunk = '';
    // Do NOT reset the backoff here: a channel that opens then immediately drops
    // would otherwise loop tight at the first delay forever. Reset only once the
    // channel proves stable (survives STABILITY_RESET_MS).
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.reattachAttempt = 0;
    }, STABILITY_RESET_MS);
    this.stableTimer.unref?.();
    logger.info('tmux control-mode channel open ok', 'remote-tmux-control');
    this.startWatchdog();
    // A successful attach while mid-reattach (reattachAttempt > 0, not the first
    // open) resolves the flap: surface `connected` again. Fire before the epoch
    // emit so status leads the re-init.
    if (this.reattachAttempt > 0) {
      try {
        this.onReattached?.();
      } catch (e) {
        console.error('[remote-tmux-control] onReattached hook threw', e);
      }
    }
    // Announce the fresh channel to the renderer (first open + every reattach).
    // Emitted AFTER the channel/parser are live so a re-init the renderer kicks
    // off in response can immediately issue commands (list-windows, capture-pane)
    // over the new channel.
    this.epoch += 1;
    this.emit({ type: 'attached', epoch: this.epoch });
    channel.onData((chunk) => {
      try {
        // Diagnostic-only: keep a short latin1 preview of the first bytes so an
        // immediate drop can report what the remote actually emitted. This does
        // NOT decode the stream fed to the parser (raw-byte invariant intact).
        if (this.firstChunk.length < 200) {
          this.firstChunk = (this.firstChunk + Buffer.from(chunk).toString('latin1')).slice(0, 200);
        }
        // Preserve the CLAUDE.md raw-byte invariant: feed the parser as
        // Uint8Array (latin1 1:1 mapping) so %output bytes > 0x7E are not
        // corrupted by a UTF-8 decode. Buffer is a Uint8Array subclass, so
        // this cast is safe and avoids a copy.
        this.ingest(chunk as unknown as Uint8Array);
      } catch (e) {
        console.error('[remote-tmux-control] ingest threw', e);
      }
    });
    channel.onClose(() => {
      this.channel = null;
      this.clearStableTimer();
      const aliveMs = Date.now() - this.openedAt;
      // Fail in-flight commands so callers do not hang on a dropped link.
      const drained = this.pending.splice(0);
      for (const p of drained) p.reject(new Error('tmux control channel closed'));
      if (aliveMs < IMMEDIATE_DROP_MS) {
        // Diagnostic: the host kicked the control client almost immediately. The
        // tmux `%exit` reason (if any) is the smoking gun — most commonly a
        // duplicate `-CC` client on the shared `agent-cockpit` socket, or the
        // dedicated session being killed/replaced on the host.
        const preview = this.firstChunk.trim();
        logger.error(
          `tmux control-mode channel dropped ${aliveMs}ms after open` +
            (this.lastExitReason ? ` — tmux %exit reason: ${this.lastExitReason}` : ' — no %exit reason received') +
            (preview ? ` — remote output: ${JSON.stringify(preview)}` : ' — remote emitted no output (command likely exited before tmux ran)'),
          'remote-tmux-control',
        );
      }
      if (this.closed) {
        this.emit({ type: 'exit', reason: this.lastExitReason });
        return;
      }
      this.scheduleReattach();
    });
  }

  private scheduleReattach(): void {
    if (this.reattachAttempt >= MAX_REATTACH) {
      // Exhausted the backoff schedule without a stable channel: stop looping
      // and surface the failure so the UI shows disconnected rather than the
      // app churning forever. A later explicit open() resets and retries.
      this.gaveUp = true;
      logger.error(
        `tmux control-mode giving up after ${this.reattachAttempt} reattach attempts` +
          (this.lastExitReason ? ` (last %exit: ${this.lastExitReason})` : ''),
        'remote-tmux-control',
      );
      try {
        this.onReattachExhausted?.();
      } catch (e) {
        console.error('[remote-tmux-control] onReattachExhausted hook threw', e);
      }
      this.emit({ type: 'exit', reason: this.lastExitReason ?? 'reattach exhausted' });
      return;
    }
    // The live channel dropped and we are about to retry: surface `reconnecting`.
    // Fired each attempt; the ConnectionMachine coalesces repeat transitions.
    try {
      this.onReconnecting?.();
    } catch (e) {
      console.error('[remote-tmux-control] onReconnecting hook threw', e);
    }
    const delay = REATTACH_BACKOFF_MS[Math.min(this.reattachAttempt, REATTACH_BACKOFF_MS.length - 1)]!;
    this.reattachAttempt += 1;
    const attempt = this.reattachAttempt;
    logger.info(`tmux control-mode reattach scheduled (attempt ${attempt}, delay=${delay}ms)`, 'remote-tmux-control');
    this.clearReattachTimer();
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      if (this.closed) return;
      // Route through the single-flight ensureOpen so a racing open() cannot
      // start a second channel.
      this.ensureOpen().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`tmux control-mode reattach failed (attempt ${attempt}): ${msg}`, 'remote-tmux-control');
        if (!this.closed) this.scheduleReattach();
      });
    }, delay);
    this.reattachTimer.unref?.();
  }

  private clearReattachTimer(): void {
    if (this.reattachTimer != null) {
      clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer != null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
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
   * per episode; `fail` rejects ALL pending and drops the channel so promises do
   * not hang forever and the FIFO can't desync from a late reply (the drop also
   * schedules a reattach via the existing onClose path).
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
        logger.error(
          `tmux control unresponsive: oldest command ${Math.round(age!)}ms with no reply (${this.pending.length} pending)`,
          'remote-tmux-control',
        );
        try {
          this.onUnresponsive?.({ pendingCount: this.pending.length, oldestAgeMs: age! });
        } catch (e) {
          console.error('[remote-tmux-control] onUnresponsive hook threw', e);
        }
      }
      return;
    }
    // action === 'fail'
    logger.error(
      `tmux control unresponsive ${Math.round(age!)}ms — failing ${this.pending.length} pending and dropping channel to reattach`,
      'remote-tmux-control',
    );
    this.unresponsiveWarned = false;
    const drained = this.pending.splice(0);
    for (const p of drained) p.reject(new Error('tmux control unresponsive'));
    const ch = this.channel;
    this.channel = null;
    try {
      ch?.close(); // fires onClose (closed=false) → scheduleReattach; pending already drained.
    } catch {
      /* already closed */
    }
  }

  private ingest(chunk: Uint8Array): void {
    for (const n of this.parser.feed(chunk)) {
      if (n.type === 'reply') {
        const cmd = this.pending.shift();
        if (cmd) settleCommand(cmd, { num: n.num, error: n.error, lines: n.lines });
        continue;
      }
      // tmux sends `%exit [reason]` just before detaching the control client;
      // stash it so the imminent channel close can log WHY (diagnosis).
      if (n.type === 'exit') this.lastExitReason = n.reason;
      this.emit(n);
    }
  }

  private emit(n: TmuxNotification): void {
    // Background %output counts as session activity (idle aging-out). Only
    // `output` notifications — structural ones must not keep a quiet session alive.
    if (n.type === 'output' && this.onOutputActivity) {
      try {
        this.onOutputActivity();
      } catch (e) {
        console.error('[remote-tmux-control] output-activity tap threw', e);
      }
    }
    for (const h of this.handlers) {
      try {
        h(n);
      } catch (e) {
        console.error('[remote-tmux-control] notification handler threw', e);
      }
    }
  }

  onNotification(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  command(args: string, opts?: CommandOptions): Promise<CommandReply> {
    const channel = this.channel;
    if (!channel) return Promise.reject(new Error('tmux control channel is not open'));
    const tolerateErrors = opts?.tolerateErrors ?? true;
    return new Promise<CommandReply>((resolve, reject) => {
      this.pending.push({ resolve, reject, tolerateErrors, enqueuedAt: Date.now() });
      channel.write(`${args}\n`);
    });
  }

  // Structure mutations reject on a tmux `%error` (tolerateErrors:false) so a
  // failure surfaces rather than resolving with an empty/garbage reply.
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
  resizeClient(cols: number, rows: number): Promise<CommandReply> {
    return this.command(refreshClientSize(cols, rows));
  }
  /** Send input to a pane, encoding-classified and chunked into ordered
   *  `send-keys` commands (see {@link buildSendKeysCommands}) so a large paste
   *  can't exceed tmux's control-command line limit. Resolves with the last
   *  reply (no-op reply for empty input). */
  async input(paneId: string, hexOrInput: string | Uint8Array): Promise<CommandReply> {
    let last: CommandReply = { num: -1, error: false, lines: [] };
    for (const cmd of buildSendKeysCommands(paneId, hexOrInput)) last = await this.command(cmd);
    return last;
  }
  async capturePane(paneId: string, opts?: { startLine?: number }): Promise<string[]> {
    return (await this.command(capturePaneCmd(paneId, opts))).lines;
  }

  /** Detach the control channel (the remote session keeps running). */
  close(): void {
    this.closed = true;
    this.clearReattachTimer();
    this.clearStableTimer();
    this.clearWatchdog();
    const channel = this.channel;
    this.channel = null;
    try {
      channel?.close();
    } catch {
      /* already closed */
    }
  }
}
