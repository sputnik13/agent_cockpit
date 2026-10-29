/**
 * RemoteProvider wiring of callback injection (scenarios 8 and 11): the real
 * control-mode opener command is unchanged (start-server, history-limit before
 * the first session, no update-environment, no variable), the provider applies
 * its project's values over the control channel before `attached`, and the
 * `deterministicSessionNames` gate is the value captured with the naming object
 * (the provider), never a later live settings read. Fake transport; no live SSH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { setSessionEnvironment } from '@shared/tmux';
import type { RemoteConnectionSpec } from '../types';
import { subscribe, type LogEntry } from '../../logger';

const hoisted = vi.hoisted(() => ({
  settings: {
    deterministicSessionNames: false,
    muxPersistScrollback: true,
    muxScrollbackLines: 10_000,
  },
  transport: null as unknown,
}));
vi.mock('../../config', () => ({ loadSettings: () => hoisted.settings }));
vi.mock('./transportFactory', () => ({ createRemoteTransport: () => hoisted.transport }));

import { controlSessionName, RemoteProvider } from './index';
import { sessionKey } from '../sessionKey';

const SPEC: RemoteConnectionSpec = {
  kind: 'remote',
  host: 'example.invalid',
  user: 'deploy',
  port: 22,
  remotePath: '/srv/repo',
};
const ENV = buildCallbackEnvironment({
  sock: '/run/user/1000/agent-cockpit/callback/h-aaaaaaaaaaaa.sock',
  cli: '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit',
})!;

/** A PTY channel that behaves like a healthy tmux control stream and records the order of events. */
class FakePty {
  readonly written: string[] = [];
  private onDataCb: ((chunk: Uint8Array) => void) | null = null;
  private seq = 1;
  constructor(private readonly log: string[]) {}
  write(data: string | Uint8Array): void {
    const line = String(data).replace(/\n$/, '');
    this.written.push(line);
    this.log.push(`write:${line}`);
    this.seq += 1;
    const block = `%begin 1700000000 ${this.seq} 1\r\n%end 1700000000 ${this.seq} 1\r\n`;
    this.onDataCb?.(new Uint8Array(Buffer.from(block, 'latin1')));
  }
  onData(cb: (chunk: Uint8Array) => void): void {
    this.onDataCb = cb;
    // tmux's own initial block, delivered as soon as the stream is wired.
    cb(new Uint8Array(Buffer.from('%begin 1699999999 1 0\r\n%end 1699999999 1 0\r\n', 'latin1')));
  }
  onClose(): void {}
  close(): void {}
  resize(): void {}
}

function installTransport(log: string[]): {
  commands: string[];
  pty: () => FakePty;
  shell: () => FakePty;
} {
  const commands: string[] = [];
  let pty: FakePty | null = null;
  let shell: FakePty | null = null;
  hoisted.transport = {
    onStateChange: () => () => undefined,
    openPty: vi.fn(async (command: string) => {
      commands.push(command);
      pty = new FakePty(log);
      return pty;
    }),
    openShell: vi.fn(async () => {
      shell = new FakePty([]);
      return shell;
    }),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
  };
  return { commands, pty: () => pty!, shell: () => shell! };
}

let logs: LogEntry[];
let unsubscribe: () => void;
const providers: RemoteProvider[] = [];

beforeEach(() => {
  hoisted.settings.deterministicSessionNames = false;
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  for (const p of providers.splice(0)) p.tmuxControl().close();
  unsubscribe();
  vi.restoreAllMocks();
});

const make = (callbackEnvironment?: CallbackEnvironmentSource): RemoteProvider => {
  const provider = new RemoteProvider(
    'proj-r',
    SPEC,
    callbackEnvironment ? { callbackEnvironment } : {},
  );
  providers.push(provider);
  return provider;
};

const SESSION = controlSessionName('proj-r');
const expectedWrites = [
  setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_SOCK', ENV.vars.COCKPIT_CALLBACK_SOCK),
  setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_VERSION', '1'),
  setSessionEnvironment(SESSION, 'COCKPIT_CLI', ENV.vars.COCKPIT_CLI),
];

async function openAndLog(provider: RemoteProvider, log: string[]): Promise<void> {
  provider.tmuxControl().onNotification((n) => {
    if (n.type === 'attached') log.push(`attached:${n.epoch}`);
  });
  await provider.tmuxControl().open();
}

describe('RemoteProvider remote control-mode opener', () => {
  it('is unchanged: variable-free start-server, shared options, history-limit before the session, no update-environment', async () => {
    const log: string[] = [];
    const { commands } = installTransport(log);
    await openAndLog(
      make(() => ENV),
      log,
    );

    const opener = commands[0]!;
    expect(opener).toMatch(
      /^COLORTERM=truecolor BYOBU_DISABLE=1 tmux -L [A-Za-z0-9._-]+ start-server \\; set -g exit-empty 'off' \\; /,
    );
    expect(opener).toContain("set -g exit-empty 'off'");
    expect(opener).toContain("set -g automatic-rename 'off'");
    // history-limit is applied by the server start, strictly BEFORE the -CC new-session
    // that creates the first pane (the remote `&&` chain).
    const historyAt = opener.indexOf("set -g history-limit '");
    const sessionAt = opener.indexOf('-CC new-session');
    expect(historyAt).toBeGreaterThan(opener.indexOf('start-server'));
    expect(sessionAt).toBeGreaterThan(historyAt);
    expect(opener.slice(historyAt, sessionAt)).toContain('&&');
    // Nothing of the callback feature travels in the remote shell command.
    expect(opener).not.toContain('update-environment');
    expect(opener).not.toContain('COCKPIT_CALLBACK');
    expect(opener).not.toContain('COCKPIT_CLI');
    expect(opener).not.toMatch(/\s-e\s/); // no `new-session -e` (a hard usage error on older tmux)
    expect(opener).toContain(`-s '${SESSION}'`);
  });
});

describe('remote session-per-tab (out of scope for v1)', () => {
  it('gets nothing: the typed attach command carries no update-environment, set-environment or variable', async () => {
    const { shell } = installTransport([]);
    const provider = make(() => ENV);
    await provider.openTerminal({ cols: 80, rows: 24, key: 'k1', cwd: '/srv/repo' });
    const typed = shell().written.join('\n');
    expect(typed).toContain('start-server');
    expect(typed).toContain('new-session -A -s');
    expect(typed).not.toContain('update-environment');
    expect(typed).not.toContain('set-environment');
    expect(typed).not.toContain('COCKPIT_');
    expect(typed).not.toMatch(/\s-e\s/);
  });

  it('gets nothing with shared session names either', async () => {
    const { shell } = installTransport([]);
    hoisted.settings.deterministicSessionNames = true;
    const provider = make(() => ENV);
    await provider.openTerminal({ cols: 80, rows: 24, key: 'k1', cwd: '/srv/repo' });
    expect(shell().written.join('\n')).not.toContain('COCKPIT_');
  });
});

describe('RemoteProvider remote control-mode injection', () => {
  it("applies its project's values to its own session before attached", async () => {
    const log: string[] = [];
    const { pty } = installTransport(log);
    await openAndLog(
      make(() => ENV),
      log,
    );
    expect(pty().written).toEqual(expectedWrites);
    expect(log).toEqual([...expectedWrites.map((c) => `write:${c}`), 'attached:1']);
  });

  it('applies nothing for a provider with neither a callback handler nor a source', async () => {
    const log: string[] = [];
    const { pty } = installTransport(log);
    const provider = make();
    await openAndLog(provider, log);
    expect(pty().written).toEqual([]);
    expect(log).toEqual(['attached:1']);
    // The manager is built without an injection at all, so the remote attach path
    // is exactly what it was before the feature (nothing awaits between wiring and
    // `attached`).
    expect(
      (provider.tmuxControl() as unknown as { injection?: unknown }).injection,
    ).toBeUndefined();
  });

  it('never applies to a session shared across installs, whatever the setting says later', async () => {
    const log: string[] = [];
    const { pty } = installTransport(log);
    hoisted.settings.deterministicSessionNames = true;
    const provider = make(() => ENV);
    // The session is the shared, machine-independent one...
    expect(provider.tmuxControlSessionName()).toBe(`agent-cockpit-${sessionKey('/srv/repo')}`);
    // ...and the setting is turned off before the control channel is ever opened.
    hoisted.settings.deterministicSessionNames = false;
    await openAndLog(provider, log);
    expect(pty().written).toEqual([]);
    expect(log).toEqual(['attached:1']);
    expect(
      logs.some((l) =>
        /callback injection disabled project=proj-r .*reason=deterministic-session-names/.test(
          l.message,
        ),
      ),
    ).toBe(true);
  });

  it('records no disabled-injection note for a shared-session provider that has no source anyway', () => {
    installTransport([]);
    hoisted.settings.deterministicSessionNames = true;
    make(); // nothing is injected for it either way, so there is nothing to explain
    expect(logs.filter((l) => /callback injection disabled/.test(l.message))).toEqual([]);
  });

  it('keeps injecting for a provider created unshared, even if the setting is turned on later', async () => {
    const log: string[] = [];
    const { pty } = installTransport(log);
    const provider = make(() => ENV);
    hoisted.settings.deterministicSessionNames = true; // a later toggle must not reach this provider
    await openAndLog(provider, log);
    expect(pty().written).toEqual(expectedWrites);
    expect(provider.tmuxControlSessionName()).toBe(SESSION);
  });

  it('reads the values at each attach, not at construction', async () => {
    const log: string[] = [];
    installTransport(log);
    const source = vi.fn(() => ENV);
    const provider = make(source);
    expect(source).not.toHaveBeenCalled();
    await openAndLog(provider, log);
    expect(source).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteProvider mux injection', () => {
  const muxOf = (provider: RemoteProvider): { shellArgs(key: string): string[] } =>
    (
      provider as unknown as { muxTerminalManager(): { shellArgs(key: string): string[] } }
    ).muxTerminalManager();

  it("gives its mux manager the provider's environment", () => {
    installTransport([]);
    const args = muxOf(make(() => ENV)).shellArgs('t1');
    expect(args).toContain(`COCKPIT_CALLBACK_SOCK=${ENV.vars.COCKPIT_CALLBACK_SOCK}`);
    expect(args).toContain('COCKPIT_CALLBACK_MUX_KEY=t1');
  });

  it('is NOT gated by deterministicSessionNames: mux sessions are namespaced by the raw project id', () => {
    installTransport([]);
    hoisted.settings.deterministicSessionNames = true;
    const args = muxOf(make(() => ENV)).shellArgs('t1');
    expect(args).toContain(`COCKPIT_CALLBACK_SOCK=${ENV.vars.COCKPIT_CALLBACK_SOCK}`);
    expect(args).toContain('COCKPIT_CALLBACK_MUX_KEY=t1');
  });

  it('injects nothing for a provider with neither a callback handler nor a source', () => {
    installTransport([]);
    expect(muxOf(make()).shellArgs('t1')).toEqual([
      'BYOBU_DISABLE=1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });
});
