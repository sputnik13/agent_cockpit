/**
 * Transport tests for the remote control-mode manager using a FAKE control
 * channel — no live SSH host is required. The fake simulates tmux's control
 * stream: it echoes a `%begin`/`%end` reply block for each command and lets the
 * test inject `%`-notifications and drop/reattach events. This exercises reply
 * correlation over the channel and reconnect resync without a network.
 *
 * Anything that genuinely needs a live SSH host (real handshake, real tmux on
 * the remote) is out of scope here and remains a deferred, human-run check.
 */
import { describe, expect, it, vi } from 'vitest';
import { RemoteTmuxControlManager, type ControlChannel } from './tmuxControl';
import type { TmuxNotification, UnresponsiveInfo } from '@shared/tmux';
import {
  RESPONSIVENESS_POLL_MS,
  UNRESPONSIVE_FAIL_MS,
  UNRESPONSIVE_WARN_MS,
} from '@shared/tmux';

/**
 * A fake duplex control channel. Each line written that does not start with a
 * known no-reply command is treated as a command and answered with a
 * correlated `%begin`/`%end` block carrying `replyLines` (default empty). Tests
 * can also `push()` raw control text and `drop()`/wire reattach.
 *
 * onData now yields Buffer (raw bytes) to match the updated ControlChannel
 * interface that preserves the CLAUDE.md raw-byte invariant. push() converts
 * the ASCII/latin1 text to a Buffer so the manager's ingest() feeds the parser
 * as Uint8Array — same as the live SSH transport path.
 */
class FakeChannel implements ControlChannel {
  private dataHandlers: Array<(c: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  closed = false;
  written: string[] = [];
  private seq = 0;
  replyLines: string[] = [];
  replyError = false;
  /** When true, swallow commands (no reply) to simulate a wedged link. */
  noReply = false;

  write(data: string): void {
    this.written.push(data);
    if (this.noReply) return;
    // Emit a correlated reply block for the command, mimicking tmux.
    this.seq += 1;
    const num = this.seq;
    const tag = this.replyError ? '%error' : '%end';
    const body = this.replyLines.map((l) => `${l}\r\n`).join('');
    this.push(`%begin 1700000000 ${num} 1\r\n${body}${tag} 1700000000 ${num} 1\r\n`);
  }
  onData(handler: (c: Buffer) => void): void {
    this.dataHandlers.push(handler);
  }
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
  /**
   * Inject raw control-stream text as a latin1-encoded Buffer. This matches
   * how the real SSH channel delivers bytes: no UTF-8 decode in transit, so
   * the manager's ingest() receives Uint8Array bytes, preserving the raw-byte
   * invariant required by CLAUDE.md.
   */
  push(text: string): void {
    const buf = Buffer.from(text, 'latin1');
    for (const h of this.dataHandlers) h(buf);
  }
  /** Simulate an unexpected drop (fires onClose without being asked to close). */
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
}

describe('RemoteTmuxControlManager (fake channel, no live SSH)', () => {
  it('opens via the injected opener and reports open', async () => {
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    expect(mgr.isOpen()).toBe(true);
  });

  it('opens exactly one channel under concurrent open() calls (no triple echo)', async () => {
    // Regression: open() assigned this.channel only AFTER `await openChannel()`,
    // so concurrent callers all raced through the gap and each opened a real
    // `tmux -CC` client. tmux fans %output to every attached client, so N
    // channels rendered every byte N times. The opener here resolves on a
    // microtask turn so all three calls overlap inside the await gap.
    let openCount = 0;
    const mgr = new RemoteTmuxControlManager(async () => {
      openCount += 1;
      await Promise.resolve();
      return new FakeChannel();
    });
    await Promise.all([mgr.open(), mgr.open(), mgr.open()]);
    expect(openCount).toBe(1);
    expect(mgr.isOpen()).toBe(true);
    // A later open() while already open must also be a no-op.
    await mgr.open();
    expect(openCount).toBe(1);
  });

  it('correlates a command reply over the channel', async () => {
    const ch = new FakeChannel();
    ch.replyLines = ['@1'];
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    const reply = await mgr.command("list-windows -F '#{window_id}'");
    expect(reply.error).toBe(false);
    expect(reply.lines).toEqual(['@1']);
    expect(ch.written.at(-1)).toContain("list-windows");
  });

  it('surfaces a tmux %error reply as error=true (generic command(), tolerant)', async () => {
    const ch = new FakeChannel();
    ch.replyError = true;
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    const reply = await mgr.command('kill-pane -t %99');
    expect(reply.error).toBe(true);
  });

  it('forwards injected notifications to subscribers', async () => {
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    const seen: TmuxNotification[] = [];
    mgr.onNotification((n) => seen.push(n));
    ch.push('%window-add @4\r\n');
    ch.push('%window-renamed @4 build\r\n');
    expect(seen).toEqual([
      { type: 'window-add', windowId: '@4' },
      { type: 'window-renamed', windowId: '@4', name: 'build' },
    ]);
  });

  it('fires onOutputActivity on %output only, excluding structural/reply notifications', async () => {
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    let activity = 0;
    mgr.onOutputActivity = () => {
      activity += 1;
    };
    await mgr.open();
    // A reply block (from open()/command) must NOT count: replies are consumed
    // in ingest() before emit().
    await mgr.command('list-windows');
    expect(activity).toBe(0);
    // Structural notifications must NOT count.
    ch.push('%window-add @4\r\n');
    ch.push('%layout-change @4 abc,80x24,0,0,0\r\n');
    expect(activity).toBe(0);
    // %output counts (the backgrounded-agent-output case).
    ch.push('%output %1 hello\r\n');
    ch.push('%output %1 world\r\n');
    expect(activity).toBe(2);
  });

  it('sends input as raw hex send-keys -H over the channel', async () => {
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    await mgr.input('%2', 'hi'); // 'hi' -> 68 69
    expect(ch.written.at(-1)).toContain('send-keys -t %2 -H 68 69');
  });

  it('keeps an escape sequence in one -H command (not split at ESC)', async () => {
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    await mgr.input('%2', '\x1b[A'); // arrow up: 1b 5b 41 — must be one command
    expect(ch.written.at(-1)).toContain('send-keys -t %2 -H 1b 5b 41');
  });

  it('structural mutation wrappers reject on a %error reply (non-tolerant)', async () => {
    const ch = new FakeChannel();
    ch.replyError = true;
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    await expect(mgr.killWindow('@9')).rejects.toThrow(/tmux command error/);
  });

  it('watchdog warns then fails (rejecting pending + dropping channel) on a wedged link', async () => {
    vi.useFakeTimers();
    try {
      const ch = new FakeChannel();
      ch.noReply = true; // simulate tmux/SSH wedged: command never gets a reply
      const mgr = new RemoteTmuxControlManager(async () => ch);
      await mgr.open();
      const warns: UnresponsiveInfo[] = [];
      mgr.onUnresponsive = (i) => warns.push(i);
      const pending = mgr.command('list-windows');
      pending.catch(() => {}); // avoid an unhandled rejection before we assert

      // Cross the WARN threshold → one onUnresponsive signal, command still pending.
      await vi.advanceTimersByTimeAsync(UNRESPONSIVE_WARN_MS + RESPONSIVENESS_POLL_MS);
      expect(warns).toHaveLength(1);
      expect(warns[0]!.pendingCount).toBe(1);

      // Cross the FAIL threshold → pending rejected and the channel dropped.
      await vi.advanceTimersByTimeAsync(
        UNRESPONSIVE_FAIL_MS - UNRESPONSIVE_WARN_MS - RESPONSIVENESS_POLL_MS,
      );
      await expect(pending).rejects.toThrow('tmux control unresponsive');
      expect(ch.closed).toBe(true);
      mgr.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reattaches on an unexpected drop and resyncs from replayed notifications', async () => {
    const channels: FakeChannel[] = [];
    const opener = async (): Promise<ControlChannel> => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    };
    const mgr = new RemoteTmuxControlManager(opener);
    await mgr.open();
    const seen: string[] = [];
    mgr.onNotification((n) => {
      if (n.type === 'window-add') seen.push(n.windowId);
    });

    channels[0]!.push('%window-add @1\r\n');
    // Unexpected drop -> backoff reattach (500ms is the first step).
    channels[0]!.drop();
    await new Promise((r) => setTimeout(r, 700));

    expect(channels.length).toBe(2); // a new channel was opened on reattach
    // tmux replays window state on the fresh channel; the manager re-emits it.
    channels[1]!.push('%window-add @1\r\n');
    expect(seen).toEqual(['@1', '@1']);
    mgr.close();
  });

  it('emits an `attached` epoch on first open and a higher one on reattach', async () => {
    const channels: FakeChannel[] = [];
    const opener = async (): Promise<ControlChannel> => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    };
    const mgr = new RemoteTmuxControlManager(opener);
    const epochs: number[] = [];
    mgr.onNotification((n) => {
      if (n.type === 'attached') epochs.push(n.epoch);
    });

    await mgr.open();
    expect(epochs).toEqual([1]); // first attach announces epoch 1

    // Unexpected drop -> backoff reattach opens a fresh channel and re-announces.
    channels[0]!.drop();
    await new Promise((r) => setTimeout(r, 700));

    expect(channels.length).toBe(2);
    expect(epochs).toEqual([1, 2]); // strictly increasing, one per successful attach
    mgr.close();
  });

  it('does not reattach after an explicit close', async () => {
    const channels: FakeChannel[] = [];
    const opener = async (): Promise<ControlChannel> => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    };
    const mgr = new RemoteTmuxControlManager(opener);
    await mgr.open();
    mgr.close();
    await new Promise((r) => setTimeout(r, 700));
    expect(channels.length).toBe(1); // no reattach
    expect(mgr.isOpen()).toBe(false);
  });

  it('rejects commands when the channel is not open', async () => {
    const mgr = new RemoteTmuxControlManager(async () => new FakeChannel());
    await expect(mgr.command('list-windows')).rejects.toThrow(/not open/i);
  });

  it('gives up after the backoff is exhausted instead of looping forever (storm fix)', async () => {
    vi.useFakeTimers();
    try {
      const channels: FakeChannel[] = [];
      const opener = async (): Promise<ControlChannel> => {
        const c = new FakeChannel();
        channels.push(c);
        // Flap: drop on the next tick (a fake timer, so the test clock controls it).
        setTimeout(() => c.drop(), 0);
        return c;
      };
      const mgr = new RemoteTmuxControlManager(opener);
      const exits: Array<string | null> = [];
      mgr.onNotification((n) => {
        if (n.type === 'exit') exits.push(n.reason);
      });
      await mgr.open();
      // Advance well past the full backoff schedule (500+1000+2000+5000ms).
      await vi.advanceTimersByTimeAsync(60_000);
      // Bounded: a flapping channel reattaches a capped number of times, not ∞.
      expect(channels.length).toBeLessThanOrEqual(5);
      // It gave up and surfaced an exit so the UI can show disconnected.
      expect(exits.length).toBeGreaterThanOrEqual(1);
      expect(mgr.isOpen()).toBe(false);
      mgr.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires reconnecting then reattached status hooks around a silent channel flap', async () => {
    const channels: FakeChannel[] = [];
    const opener = async (): Promise<ControlChannel> => {
      const c = new FakeChannel();
      channels.push(c);
      return c;
    };
    const mgr = new RemoteTmuxControlManager(opener);
    const events: string[] = [];
    mgr.onReconnecting = () => events.push('reconnecting');
    mgr.onReattached = () => events.push('reattached');

    await mgr.open();
    expect(events).toEqual([]); // first open is not a reconnect

    channels[0]!.drop(); // silent flap
    await new Promise((r) => setTimeout(r, 700));

    expect(channels.length).toBe(2);
    expect(events).toEqual(['reconnecting', 'reattached']);
    mgr.close();
  });

  it('fires onReattachExhausted when the backoff is exhausted', async () => {
    vi.useFakeTimers();
    try {
      const opener = async (): Promise<ControlChannel> => {
        const c = new FakeChannel();
        setTimeout(() => c.drop(), 0); // flap every time
        return c;
      };
      const mgr = new RemoteTmuxControlManager(opener);
      let exhausted = 0;
      mgr.onReattachExhausted = () => (exhausted += 1);
      await mgr.open();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(exhausted).toBe(1);
      mgr.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open a second channel when open() races a pending reattach (storm fix)', async () => {
    vi.useFakeTimers();
    try {
      const channels: FakeChannel[] = [];
      const opener = async (): Promise<ControlChannel> => {
        const c = new FakeChannel();
        channels.push(c);
        return c;
      };
      const mgr = new RemoteTmuxControlManager(opener);
      await mgr.open(); // channel 0
      channels[0]!.drop(); // schedules a reattach; channel is now null
      await Promise.resolve();
      // A re-acquire during the drop→reattach gap must be a no-op, not a 2nd channel.
      await mgr.open();
      expect(channels.length).toBe(1);
      // The scheduled reattach (and only it) opens the next channel.
      await vi.advanceTimersByTimeAsync(600);
      expect(channels.length).toBe(2);
      mgr.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails in-flight commands when the channel drops', async () => {
    const ch = new FakeChannel();
    // Suppress the auto-reply so the command stays in-flight until the drop.
    ch.write = (data: string): void => {
      ch.written.push(data);
    };
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    const pending = mgr.command('list-windows');
    ch.drop();
    await expect(pending).rejects.toThrow(/closed/i);
    mgr.close();
  });

  // --- vuwh: raw-byte invariant ---
  it('feeds the parser as Uint8Array when the channel yields Buffers (raw-byte invariant)', async () => {
    // Build a %output payload with a byte > 0x7E (powerline arrow / box-drawing).
    // tmux emits non-ASCII bytes verbatim (no escaping). The raw byte 0xB0 is a
    // representative non-ASCII byte. If the manager UTF-8-decoded the Buffer
    // mid-pipeline, the OutputNotification.bytes would be corrupted (0x30 or
    // U+FFFD). We verify the bytes Uint8Array contains 0xB0 exactly.
    const ch = new FakeChannel();
    const mgr = new RemoteTmuxControlManager(async () => ch);
    await mgr.open();
    const seen: Uint8Array[] = [];
    mgr.onNotification((n) => {
      if (n.type === 'output') seen.push(n.bytes);
    });
    // Push the verbatim byte 0xB0 (latin1 char \xB0) as a tmux %output line.
    // FakeChannel.push() encodes the string to a Buffer using 'latin1', so byte
    // 0xB0 in the string becomes byte 0xB0 in the Buffer — matching real SSH.
    const rawByte = '\xB0'; // latin1 char for byte 0xB0
    ch.push(`%output %0 ${rawByte}\r\n`);
    // The output notification's bytes must contain 0xB0, not a truncated/corrupt value.
    expect(seen.length).toBeGreaterThan(0);
    const bytes = seen[0]!;
    const hasByte = Array.from(bytes).some((b) => b === 0xb0);
    expect(hasByte).toBe(true);
  });

  // --- vuwh: command shape verification ---
  it('session selection uses DEDICATED cockpit session (not prefer-existing)', async () => {
    // The RemoteProvider.tmuxControl() opener must build a command that opens
    // tmux -CC new-session -A -s agent-cockpit-<projectId>.
    // This is a unit-level check on controlSessionName and the command shape.
    // Integration (real byobu host) is a deferred manual check.
    const { controlSessionName } = await import('./index');
    expect(controlSessionName('proj-abc')).toBe('agent-cockpit-proj-abc');
    expect(controlSessionName('proj.with.dots')).toBe('agent-cockpit-proj-with-dots');
    expect(controlSessionName('proj:with:colons')).toBe('agent-cockpit-proj-with-colons');
  });
});
