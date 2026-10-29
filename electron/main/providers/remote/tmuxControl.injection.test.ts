/**
 * Scenario 8, remote control-mode half: the session-environment injection of
 * RemoteTmuxControlManager against a FAKE control channel (no live SSH host).
 * It proves ordering (wire the stream, apply, THEN `attached`), the bounded wait
 * and the pending-reply FIFO on timeout, per-attach re-application, explicit
 * per-project addressing, and that nothing is ever stripped remotely.
 *
 * What a real host adds (the real tmux `set-environment -t` over a real control
 * channel and the brand-new-session first pane) is a listed verification gap
 * (docs/test/terminal-callback-socket.md, scenarios 8 and 18); the same command lines
 * are proven against a REAL tmux in callbackInjection.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { setSessionEnvironment, type TmuxNotification } from '@shared/tmux';
import { subscribe, type LogEntry } from '../../logger';
import {
  acceptFirstPaneLimitation,
  RemoteTmuxControlManager,
  SESSION_ENVIRONMENT_TIMEOUT_MS,
  type ControlChannel,
  type FirstPaneContext,
  type FirstPaneStrategy,
  type SessionEnvironmentInjection,
} from './tmuxControl';

const ENV_A = buildCallbackEnvironment({
  sock: "/run/user/1000/agent-cockpit/callback/h-aaaaaaaaaaaa.sock with 'quote' $HOME; ~ #",
  cli: '/home/u/.agent-cockpit/bin/linux-amd64/cockpit',
})!;
const ENV_B = buildCallbackEnvironment({
  sock: '/run/user/1000/agent-cockpit/callback/h-bbbbbbbbbbbb.sock',
  cli: '/home/u/.agent-cockpit/bin/linux-amd64/cockpit',
})!;
const SESSION = 'agent-cockpit-proj-a';

/**
 * A scripted control channel. `auto` answers every command at once (like a healthy
 * tmux), `manual` answers only when the test says so, `silent` never does. It logs
 * the order of everything the manager does to it into a shared log.
 */
class ScriptedChannel implements ControlChannel {
  readonly written: string[] = [];
  closed = false;
  mode: 'auto' | 'manual' | 'silent' = 'auto';
  replyError = false;
  private dataHandlers: Array<(c: Buffer) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private queued: string[] = [];
  private seq = 1;

  constructor(
    readonly log: string[],
    readonly name = 'ch',
    /** Like a real attach, tmux emits one unsolicited %begin/%end block first. */
    initialBlock = true,
  ) {
    if (initialBlock) this.queued.push('%begin 1699999999 1 0\r\n%end 1699999999 1 0\r\n');
  }

  write(data: string): void {
    const line = data.replace(/\n$/, '');
    this.written.push(line);
    this.log.push(`${this.name}:write:${line}`);
    if (this.mode === 'auto') this.reply();
  }
  onData(handler: (c: Buffer) => void): void {
    this.log.push(`${this.name}:onData`);
    this.dataHandlers.push(handler);
    for (const text of this.queued.splice(0)) handler(Buffer.from(text, 'latin1'));
  }
  onClose(handler: () => void): void {
    this.log.push(`${this.name}:onClose`);
    this.closeHandlers.push(handler);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }
  /** Answer the oldest unanswered command (or emit one more reply block). */
  reply(lines: string[] = []): void {
    this.seq += 1;
    const tag = this.replyError ? '%error' : '%end';
    const body = lines.map((l) => `${l}\r\n`).join('');
    this.push(`%begin 1700000000 ${this.seq} 1\r\n${body}${tag} 1700000000 ${this.seq} 1\r\n`);
  }
  /** Hold back the unsolicited block queued at construction, to deliver it later via {@link phantomBlock}. */
  withholdInitialBlock(): void {
    this.queued.length = 0;
  }
  /** tmux's own unsolicited block, delivered NOW (to reproduce it racing a command). */
  phantomBlock(): void {
    this.push('%begin 1699999999 1 0\r\n%end 1699999999 1 0\r\n');
  }
  push(text: string): void {
    for (const h of this.dataHandlers) h(Buffer.from(text, 'latin1'));
  }
  /** An unexpected drop. */
  drop(): void {
    this.close();
  }
}

let logs: LogEntry[];
let unsubscribe: () => void;
const managers: RemoteTmuxControlManager[] = [];

beforeEach(() => {
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
  unsubscribe();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface Rig {
  mgr: RemoteTmuxControlManager;
  channels: ScriptedChannel[];
  log: string[];
  attached: number[];
}

/** A manager over scripted channels; `configure` tweaks each channel as it is opened. */
function rig(
  injection: SessionEnvironmentInjection | undefined,
  configure: (ch: ScriptedChannel, index: number) => void = () => undefined,
  log: string[] = [],
  name = 'ch',
): Rig {
  const channels: ScriptedChannel[] = [];
  const mgr = new RemoteTmuxControlManager(async () => {
    const ch = new ScriptedChannel(log, `${name}${channels.length}`);
    configure(ch, channels.length);
    channels.push(ch);
    return ch;
  }, injection);
  managers.push(mgr);
  const attached: number[] = [];
  mgr.onNotification((n: TmuxNotification) => {
    if (n.type === 'attached') {
      attached.push(n.epoch);
      log.push(`${name}${channels.length - 1}:attached:${n.epoch}`);
    }
  });
  return { mgr, channels, log, attached };
}

const inject = (
  source: CallbackEnvironmentSource,
  extra: Partial<SessionEnvironmentInjection> = {},
): SessionEnvironmentInjection => ({
  projectId: 'proj-a',
  sessionName: SESSION,
  environment: source,
  ...extra,
});

const EXPECTED_A = [
  setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_SOCK', ENV_A.vars.COCKPIT_CALLBACK_SOCK),
  setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_VERSION', '1'),
  setSessionEnvironment(SESSION, 'COCKPIT_CLI', ENV_A.vars.COCKPIT_CLI),
];

describe('RemoteTmuxControlManager session-environment injection (fake channel)', () => {
  it('wires the control stream, applies each variable with its own exact-session set-environment, THEN emits attached', async () => {
    const r = rig(inject(() => ENV_A));
    await r.mgr.open();

    expect(r.channels[0]!.written).toEqual(EXPECTED_A);
    // The order of everything the manager did, from the channel's point of view.
    expect(r.log).toEqual([
      'ch0:onData',
      'ch0:onClose',
      ...EXPECTED_A.map((c) => `ch0:write:${c}`),
      'ch0:attached:1',
    ]);
    expect(r.attached).toEqual([1]);
  });

  it('targets the session by exact name (=name) and quotes awkward values for tmux', async () => {
    const r = rig(inject(() => ENV_A));
    await r.mgr.open();
    for (const line of r.channels[0]!.written) {
      expect(line.startsWith(`set-environment -t '=${SESSION}' COCKPIT_`)).toBe(true);
      // Never `;`-sequenced (one reply block per command line): outside the quoted
      // arguments there is no separator, even though a VALUE may contain one.
      expect(line.replace(/'[^']*'/g, "''")).not.toContain(';');
    }
    expect(r.channels[0]!.written[0]).toBe(
      `set-environment -t '=${SESSION}' COCKPIT_CALLBACK_SOCK ` +
        `'/run/user/1000/agent-cockpit/callback/h-aaaaaaaaaaaa.sock with '\\''quote'\\'' $HOME; ~ #'`,
    );
  });

  it('does not announce the channel until every reply has arrived (open() waits too)', async () => {
    const r = rig(
      inject(() => ENV_A),
      (ch) => {
        ch.mode = 'manual';
      },
    );
    let opened = false;
    const opening = r.mgr.open().then(() => {
      opened = true;
    });
    await flush();
    const ch = r.channels[0]!;
    expect(ch.written).toEqual(EXPECTED_A); // all three are in flight at once
    expect(r.attached).toEqual([]);
    expect(opened).toBe(false);

    ch.reply();
    ch.reply();
    await flush();
    expect(r.attached).toEqual([]); // two of three
    ch.reply();
    await opening;
    expect(r.attached).toEqual([1]);
    expect(opened).toBe(true);
  });

  it("keeps tmux's unsolicited initial block from counting as a reply when it races the commands", async () => {
    // Realistic order: the commands are written right after the channel opens, and
    // tmux's own initial %begin/%end block (not a reply to anything we sent) arrives
    // AFTER them. If it were taken for a reply, `attached` would fire after only two
    // real replies and the FIFO would be off by one for the channel's whole life.
    const r = rig(
      inject(() => ENV_A),
      (ch) => {
        ch.mode = 'manual';
        ch.withholdInitialBlock();
      },
    );
    const opening = r.mgr.open();
    await flush();
    const ch = r.channels[0]!;
    expect(ch.written).toEqual(EXPECTED_A);
    ch.phantomBlock(); // swallowed
    ch.reply();
    ch.reply();
    await flush();
    expect(r.attached).toEqual([]); // two of three REAL replies
    ch.reply();
    await opening;
    expect(r.attached).toEqual([1]);

    // And the FIFO is still aligned afterwards.
    const user = r.mgr.command("list-windows -F '#{window_id}'");
    ch.reply(['@3']);
    await expect(user).resolves.toMatchObject({ lines: ['@3'] });
  });

  it('joins a concurrent open() to the attach in flight instead of returning early', async () => {
    const r = rig(
      inject(() => ENV_A),
      (ch) => {
        ch.mode = 'manual';
      },
    );
    const first = r.mgr.open();
    await flush();
    let second = false;
    const joined = r.mgr.open().then(() => {
      second = true;
    });
    await flush();
    expect(r.channels).toHaveLength(1);
    expect(second).toBe(false); // the channel is assigned, but not yet announced
    for (let i = 0; i < 3; i += 1) r.channels[0]!.reply();
    await Promise.all([first, joined]);
    expect(second).toBe(true);
    expect(r.attached).toEqual([1]);
  });

  describe('bounded wait', () => {
    it('stops waiting after the timeout, announces the channel, and leaves the entries in the FIFO', async () => {
      vi.useFakeTimers();
      const r = rig(
        inject(() => ENV_A),
        (ch) => {
          ch.mode = 'silent';
        },
      );
      const opening = r.mgr.open();
      await vi.advanceTimersByTimeAsync(SESSION_ENVIRONMENT_TIMEOUT_MS - 1);
      expect(r.attached).toEqual([]); // still within the bound
      await vi.advanceTimersByTimeAsync(1);
      await opening;
      expect(r.attached).toEqual([1]);
      const warning = logs.find(
        (l) => l.level === 'warn' && /not confirmed within/.test(l.message),
      );
      expect(warning?.message).toContain('project=proj-a');
      expect(warning?.message).toContain(`session="${SESSION}"`);

      // The three abandoned entries are STILL pending. A user command now queues behind
      // them, and when the late replies finally arrive each settles ITS OWN command.
      const ch = r.channels[0]!;
      const user = r.mgr.command("list-windows -F '#{window_id}'");
      ch.reply(); // late: set-environment #1
      ch.reply(); // late: set-environment #2
      ch.reply(); // late: set-environment #3
      ch.reply(['@7']); // the user's command
      await expect(user).resolves.toMatchObject({ error: false, lines: ['@7'] });
    });

    it('would mis-correlate the user command if the entries had been dropped (the invariant under test)', async () => {
      vi.useFakeTimers();
      const r = rig(
        inject(() => ENV_A),
        (ch) => {
          ch.mode = 'silent';
        },
      );
      const opening = r.mgr.open();
      await vi.advanceTimersByTimeAsync(SESSION_ENVIRONMENT_TIMEOUT_MS);
      await opening;
      const ch = r.channels[0]!;
      const user = r.mgr.command("list-windows -F '#{window_id}'");
      // Only ONE late reply has arrived: it belongs to the first abandoned command, so
      // the user's command must still be waiting rather than resolve with it.
      ch.reply(['late-for-set-environment']);
      const settled = await Promise.race([
        user.then(() => 'settled'),
        flush().then(() => 'pending'),
      ]);
      expect(settled).toBe('pending');
    });

    it('treats a rejection by tmux as non-fatal: logged, never failing the attach', async () => {
      const r = rig(
        inject(() => ENV_A),
        (ch) => {
          ch.replyError = true;
        },
      );
      await r.mgr.open();
      expect(r.attached).toEqual([1]);
      expect(
        logs.some(
          (l) =>
            l.level === 'warn' && /tmux rejected set-environment project=proj-a/.test(l.message),
        ),
      ).toBe(true);
    });

    it('does not announce a channel that was lost while waiting; the reattach announces the next epoch', async () => {
      vi.useFakeTimers();
      const r = rig(
        inject(() => ENV_A),
        (ch, index) => {
          ch.mode = index === 0 ? 'silent' : 'auto';
        },
      );
      const opening = r.mgr.open();
      await flush();
      r.channels[0]!.drop(); // the link dies before tmux answered
      await opening;
      expect(r.attached).toEqual([]); // the dead channel was never announced
      await vi.advanceTimersByTimeAsync(600); // first backoff step
      expect(r.channels).toHaveLength(2);
      expect(r.attached).toEqual([1]); // the next channel is epoch 1: epochs only count announcements
      expect(r.channels[1]!.written).toEqual(EXPECTED_A);
    });
  });

  describe('every attach and reattach', () => {
    it('re-applies the CURRENT values before the next attached', async () => {
      vi.useFakeTimers();
      let current = ENV_A;
      const r = rig(inject(() => current));
      await r.mgr.open();
      expect(r.attached).toEqual([1]);

      current = ENV_B; // e.g. the helper reconnected and returned a new socket
      r.channels[0]!.drop();
      await vi.advanceTimersByTimeAsync(600);

      expect(r.channels).toHaveLength(2);
      const expectedB = [
        setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_SOCK', ENV_B.vars.COCKPIT_CALLBACK_SOCK),
        setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_VERSION', '1'),
        setSessionEnvironment(SESSION, 'COCKPIT_CLI', ENV_B.vars.COCKPIT_CLI),
      ];
      expect(r.channels[1]!.written).toEqual(expectedB);
      expect(r.attached).toEqual([1, 2]);
      // Per attach: stream wired, then the three commands, then attached.
      expect(r.log.slice(r.log.indexOf('ch1:onData'))).toEqual([
        'ch1:onData',
        'ch1:onClose',
        ...expectedB.map((c) => `ch1:write:${c}`),
        'ch1:attached:2',
      ]);
    });

    it('applies nothing and strips nothing when the project has no values', async () => {
      vi.useFakeTimers();
      const r = rig(inject(() => undefined));
      await r.mgr.open();
      r.channels[0]!.drop();
      await vi.advanceTimersByTimeAsync(600);
      expect(r.attached).toEqual([1, 2]);
      for (const ch of r.channels) {
        expect(ch.written).toEqual([]); // no set-environment, and no -r/-u removal either
      }
    });

    it('never strips remotely: no removal command is ever written, whatever the values do', async () => {
      vi.useFakeTimers();
      let current: ReturnType<CallbackEnvironmentSource> = ENV_A;
      const r = rig(inject(() => current));
      await r.mgr.open();
      current = undefined;
      r.channels[0]!.drop();
      await vi.advanceTimersByTimeAsync(600);
      expect(r.channels[1]!.written).toEqual([]); // the variable-less reattach wrote nothing
      // Everything ever written is a plain add of one variable to the exact session:
      // no -r/-u (remove/unset), nothing else.
      for (const line of r.channels.flatMap((c) => c.written)) {
        expect(line).toMatch(/^set-environment -t '=[^']+' COCKPIT_[A-Z_]+ '[^]*'$/);
      }
    });
  });

  it('is entirely inert when no injection is configured: no commands, same attached timing', async () => {
    const r = rig(undefined);
    await r.mgr.open();
    expect(r.channels[0]!.written).toEqual([]);
    expect(r.attached).toEqual([1]);
    // The stream is wired before `attached` in every case now.
    expect(r.log).toEqual(['ch0:onData', 'ch0:onClose', 'ch0:attached:1']);
  });

  it('survives a source that throws: logged, nothing applied, the attach still completes', async () => {
    const r = rig(
      inject(() => {
        throw new Error('handshake not ready');
      }),
    );
    await r.mgr.open();
    expect(r.attached).toEqual([1]);
    expect(r.channels[0]!.written).toEqual([]);
    expect(
      logs.some(
        (l) => l.level === 'error' && /callback env source threw project=proj-a/.test(l.message),
      ),
    ).toBe(true);
  });

  it('never fails the attach, whatever goes wrong inside the injection step', async () => {
    const poisoned = {
      get vars(): never {
        throw new Error('unexpected shape');
      },
    } as unknown as ReturnType<CallbackEnvironmentSource>;
    const r = rig(inject(() => poisoned));
    await r.mgr.open();
    expect(r.attached).toEqual([1]);
    expect(
      logs.some(
        (l) =>
          l.level === 'error' && /callback env injection failed project=proj-a/.test(l.message),
      ),
    ).toBe(true);
  });

  describe('explicit per-project addressing', () => {
    it('sends each project its own session and values on its own channel, even when attaches interleave', async () => {
      const log: string[] = [];
      const a = rig(
        { projectId: 'proj-a', sessionName: 'agent-cockpit-proj-a', environment: () => ENV_A },
        (ch) => {
          ch.mode = 'manual';
        },
        log,
        'A',
      );
      const b = rig(
        { projectId: 'proj-b', sessionName: 'agent-cockpit-proj-b', environment: () => ENV_B },
        (ch) => {
          ch.mode = 'manual';
        },
        log,
        'B',
      );
      const openA = a.mgr.open();
      const openB = b.mgr.open();
      await flush();
      // B's replies arrive first; A's later. Nothing is ambient: each manager only
      // ever writes to its own channel, to its own session.
      for (let i = 0; i < 3; i += 1) b.channels[0]!.reply();
      await openB;
      for (let i = 0; i < 3; i += 1) a.channels[0]!.reply();
      await openA;

      expect(
        a.channels[0]!.written.every((c) =>
          c.startsWith("set-environment -t '=agent-cockpit-proj-a' "),
        ),
      ).toBe(true);
      expect(
        b.channels[0]!.written.every((c) =>
          c.startsWith("set-environment -t '=agent-cockpit-proj-b' "),
        ),
      ).toBe(true);
      expect(a.channels[0]!.written.join('\n')).toContain('h-aaaaaaaaaaaa.sock');
      expect(a.channels[0]!.written.join('\n')).not.toContain('h-bbbbbbbbbbbb.sock');
      expect(b.channels[0]!.written.join('\n')).toContain('h-bbbbbbbbbbbb.sock');
      expect(b.channels[0]!.written.join('\n')).not.toContain('h-aaaaaaaaaaaa.sock');
      expect(a.attached).toEqual([1]);
      expect(b.attached).toEqual([1]);
    });
  });

  describe('the brand-new-session first-pane decision (one swappable function)', () => {
    it('defaults to accepting the limitation: no extra command is sent', async () => {
      const r = rig(inject(() => ENV_A));
      await r.mgr.open();
      expect(r.channels[0]!.written).toEqual(EXPECTED_A);
      await expect(
        acceptFirstPaneLimitation({ projectId: 'p', sessionName: 's', command: vi.fn() }),
      ).resolves.toBeUndefined();
    });

    it('runs a swapped-in strategy after the variables and before attached, with explicit project and session', async () => {
      const seen: Array<{ projectId: string; sessionName: string }> = [];
      const strategy: FirstPaneStrategy = async (ctx) => {
        seen.push({ projectId: ctx.projectId, sessionName: ctx.sessionName });
        await ctx.command(`respawn-pane -k -t '=${ctx.sessionName}:'`);
      };
      const r = rig(inject(() => ENV_A, { firstPane: strategy }));
      await r.mgr.open();
      expect(seen).toEqual([{ projectId: 'proj-a', sessionName: SESSION }]);
      expect(r.channels[0]!.written).toEqual([...EXPECTED_A, `respawn-pane -k -t '=${SESSION}:'`]);
      expect(r.log.at(-1)).toBe('ch0:attached:1');
    });

    it('is skipped when the variables could not be applied (a wedged link)', async () => {
      vi.useFakeTimers();
      const strategy = vi.fn<FirstPaneStrategy>(async () => undefined);
      const r = rig(
        inject(() => ENV_A, { firstPane: strategy }),
        (ch) => {
          ch.mode = 'silent';
        },
      );
      const opening = r.mgr.open();
      await vi.advanceTimersByTimeAsync(SESSION_ENVIRONMENT_TIMEOUT_MS);
      await opening;
      expect(strategy).not.toHaveBeenCalled();
      expect(r.attached).toEqual([1]);
    });

    it('cannot block or fail the attach, whether it throws or hangs', async () => {
      const throwing = rig(
        inject(() => ENV_A, {
          firstPane: () => {
            throw new Error('boom');
          },
        }),
      );
      await throwing.mgr.open();
      expect(throwing.attached).toEqual([1]);
      expect(logs.some((l) => /first-pane strategy failed project=proj-a/.test(l.message))).toBe(
        true,
      );

      vi.useFakeTimers();
      const hanging = rig(
        inject(() => ENV_A, { firstPane: () => new Promise<void>(() => undefined) }),
      );
      const opening = hanging.mgr.open();
      await vi.advanceTimersByTimeAsync(SESSION_ENVIRONMENT_TIMEOUT_MS);
      await opening;
      expect(hanging.attached).toEqual([1]);
      expect(logs.some((l) => /first-pane strategy not finished within/.test(l.message))).toBe(
        true,
      );
    });
  });
});

// A channel lost while the attach waited for the session environment.
describe('a channel lost while the attach waits', () => {
  it('re-attaches when a caller re-opened the manager by joining the attach whose channel was closed', async () => {
    // close() makes the loss silent (a deliberate close schedules no reattach), and
    // the open() that follows re-opens the manager by JOINING the attach in flight.
    // That attach must not resolve with nothing open.
    const r = rig(
      inject(() => ENV_A),
      (ch, index) => {
        ch.mode = index === 0 ? 'silent' : 'auto';
      },
    );
    const first = r.mgr.open();
    await flush();
    expect(r.channels).toHaveLength(1);
    r.mgr.close();
    const second = r.mgr.open();
    await Promise.all([first, second]);

    expect(r.channels).toHaveLength(2); // a fresh channel was attached for the second request
    expect(r.mgr.isOpen()).toBe(true);
    expect(r.attached).toEqual([1]); // only the live channel was announced
    expect(r.channels[1]!.written).toEqual(EXPECTED_A);
  });

  it('rejects, instead of resolving with nothing open, when the retry is lost the same way', async () => {
    const r = rig(
      inject(() => ENV_A),
      (ch) => {
        ch.mode = 'silent';
      },
    );
    const opening = r.mgr.open();
    const outcomes = [opening];
    await flush();
    r.mgr.close();
    outcomes.push(r.mgr.open());
    await vi.waitFor(() => expect(r.channels).toHaveLength(2)); // the retry is now waiting
    await flush();
    r.mgr.close();
    outcomes.push(r.mgr.open());
    for (const outcome of outcomes) {
      await expect(outcome).rejects.toThrow(/closed while attaching/);
    }
    expect(r.attached).toEqual([]);
  });

  it('leaves a drop that scheduled a reattach to that reattach (no extra attach)', async () => {
    vi.useFakeTimers();
    const r = rig(
      inject(() => ENV_A),
      (ch, index) => {
        ch.mode = index === 0 ? 'silent' : 'auto';
      },
    );
    const opening = r.mgr.open();
    await flush();
    r.channels[0]!.drop(); // not a close(): onClose schedules the reattach
    await opening;
    expect(r.channels).toHaveLength(1); // nothing was attached on the spot
    await vi.advanceTimersByTimeAsync(600);
    expect(r.channels).toHaveLength(2); // the scheduled reattach, and only it
    expect(r.attached).toEqual([1]);
  });

  it('does not retry a manager that was closed for good while it waited', async () => {
    const r = rig(
      inject(() => ENV_A),
      (ch) => {
        ch.mode = 'silent';
      },
    );
    const opening = r.mgr.open();
    await flush();
    r.mgr.close(); // and nobody re-opens it
    await opening; // resolves quietly: it was closed on purpose
    expect(r.channels).toHaveLength(1);
    expect(r.attached).toEqual([]);
    expect(r.mgr.isOpen()).toBe(false);
  });
});

describe('first-pane strategy commands are tied to their attach channel', () => {
  it('rejects a late command once the channel was replaced, and never writes it to the new channel', async () => {
    vi.useFakeTimers();
    const contexts: FirstPaneContext[] = [];
    const strategy: FirstPaneStrategy = async (ctx) => {
      contexts.push(ctx);
    };
    const r = rig(inject(() => ENV_A, { firstPane: strategy }));
    await r.mgr.open();
    r.channels[0]!.drop(); // the link flaps; the scheduled reattach opens channel 1
    await vi.advanceTimersByTimeAsync(600);
    expect(r.channels).toHaveLength(2);
    expect(contexts).toHaveLength(2);

    const writtenOnNew = r.channels[1]!.written.length;
    await expect(contexts[0]!.command('list-windows')).rejects.toThrow(/channel changed/);
    expect(r.channels[1]!.written).toHaveLength(writtenOnNew); // nothing leaked onto the new channel

    // The current attach's own context still works, on its own channel.
    await expect(contexts[1]!.command('list-windows')).resolves.toMatchObject({ error: false });
    expect(r.channels[1]!.written.at(-1)).toBe('list-windows');
  });

  it('works on its own channel while that channel is current', async () => {
    const strategy: FirstPaneStrategy = async (ctx) => {
      await ctx.command('display-message -p ok');
    };
    const r = rig(inject(() => ENV_A, { firstPane: strategy }));
    await r.mgr.open();
    expect(r.channels[0]!.written).toEqual([...EXPECTED_A, 'display-message -p ok']);
    expect(r.attached).toEqual([1]);
  });
});
