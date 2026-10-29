/**
 * Scenarios 8 and 10 at the argv level for the two LOCAL tmux openers, with
 * node-pty and the server start replaced by recorders (the real-tmux effect is
 * covered by callbackInjection.test.ts): the server-start spawn happens first and
 * carries none of the project's values; the session-creating client is spawned
 * separately with the project's values in its ENVIRONMENT; and no `-e` flag, typed
 * `NAME=value` or `start-server` ever reaches that client's argv.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';

const rec = vi.hoisted(() => ({
  events: [] as string[],
  spawns: [] as Array<{
    file: string;
    args: string[];
    opts: { env: Record<string, string>; cwd: string; encoding?: unknown };
  }>,
  servers: [] as Array<{
    socket: string;
    configPath?: string;
    callbackEnvironment: boolean;
    env: Record<string, string | undefined>;
  }>,
}));

vi.mock('node-pty', () => ({
  spawn: (
    file: string,
    args: string[],
    opts: { env: Record<string, string>; cwd: string; encoding?: unknown },
  ) => {
    rec.events.push('pty.spawn');
    rec.spawns.push({ file, args, opts });
    return {
      onData: () => undefined,
      onExit: () => undefined,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
    };
  },
}));
vi.mock('./nativeArch', () => ({
  withNativeArch: (file: string, args: string[]) => ({ file, args }),
}));
vi.mock('./tmuxServer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tmuxServer')>();
  return {
    ...actual,
    startTmuxServer: (opts: (typeof rec.servers)[number]) => {
      rec.events.push('startTmuxServer');
      rec.servers.push(opts);
      return 'applied';
    },
  };
});

import { LocalTerminalManager } from './terminal';
import { LocalTmuxControlManager } from './tmuxControl';

const tmuxInstalled = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

const ENV = buildCallbackEnvironment({
  sock: "/tmp/My Apps/it's/aaaaaaaaaaaa.sock",
  cli: '/tmp/My Apps/bin/cock pit',
})!;
const VALUES = { ...ENV.vars };

/** Anything carrying one of the project's (distinctive) values: the server-start env must have none of it. */
const carriesValues = (env: Record<string, string | undefined>): boolean =>
  [VALUES.COCKPIT_CALLBACK_SOCK, VALUES.COCKPIT_CLI].some((v) => Object.values(env).includes(v));

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  rec.events.length = 0;
  rec.spawns.length = 0;
  rec.servers.length = 0;
  for (const name of ['AC_TMUX_EPHEMERAL', 'COCKPIT_CALLBACK_SOCK'])
    saved[name] = process.env[name];
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe.skipIf(!tmuxInstalled)('local session-per-tab opener argv', () => {
  const open = (options: ConstructorParameters<typeof LocalTerminalManager>[2]): void => {
    new LocalTerminalManager('/tmp', 'tok', { socket: 'sock-a', ...options }).open({
      cols: 80,
      rows: 24,
      key: 'k1',
    });
  };

  it('starts the server FIRST, in its own spawn, then spawns the session-creating client', () => {
    open({ callbackEnvironment: () => ENV });
    expect(rec.events).toEqual(['startTmuxServer', 'pty.spawn']);
    expect(rec.servers).toHaveLength(1);
    expect(rec.servers[0]).toMatchObject({ socket: 'sock-a', callbackEnvironment: true });
  });

  it("hands the server-start spawn none of the project's values", () => {
    process.env['COCKPIT_CALLBACK_SOCK'] = '/leak/outer.sock'; // contaminated after the startup scrub
    open({ callbackEnvironment: () => ENV });
    expect(carriesValues(rec.servers[0]!.env)).toBe(false);
    // (The helper additionally strips anything inherited; see tmuxServer.test.ts.)
  });

  it('spawns the client with the values in its ENVIRONMENT, and `new-session -A` alone in its argv', () => {
    open({ callbackEnvironment: () => ENV });
    const client = rec.spawns[0]!;
    expect(client.file).toBe('tmux');
    expect(client.args).toEqual([
      '-L',
      'sock-a',
      'new-session',
      '-A',
      '-s',
      'agent-cockpit-terminal-tok-k1',
      '-c',
      '/tmp',
    ]);
    expect(client.opts.env['COCKPIT_CALLBACK_SOCK']).toBe(VALUES.COCKPIT_CALLBACK_SOCK);
    expect(client.opts.env['COCKPIT_CALLBACK_VERSION']).toBe('1');
    expect(client.opts.env['COCKPIT_CLI']).toBe(VALUES.COCKPIT_CLI);
    expect(client.opts.env['TERM']).toBe('xterm-256color');
  });

  it('never uses -e, a typed NAME=value, a start-server chain or any value in the client argv', () => {
    open({ callbackEnvironment: () => ENV });
    const argv = rec.spawns[0]!.args;
    expect(argv).not.toContain('-e');
    expect(argv).not.toContain('start-server');
    expect(argv).not.toContain(';');
    expect(argv.some((a) => /^COCKPIT_[A-Z_]+=/.test(a) || a.includes('COCKPIT'))).toBe(false);
    expect(argv.some((a) => Object.values(VALUES).includes(a))).toBe(false);
  });

  it('keeps ephemeral runs off exit-empty: no option of any kind depends on AC_TMUX_EPHEMERAL here', () => {
    process.env['AC_TMUX_EPHEMERAL'] = '1';
    open({ callbackEnvironment: () => ENV });
    expect(rec.servers[0]).not.toHaveProperty('exitEmpty');
  });

  it('with injection disabled, still splits the server start but injects nothing and enables nothing', () => {
    open({});
    expect(rec.events).toEqual(['startTmuxServer', 'pty.spawn']);
    expect(rec.servers[0]!.callbackEnvironment).toBe(false);
    expect(Object.keys(rec.spawns[0]!.opts.env).filter((n) => n.startsWith('COCKPIT_'))).toEqual(
      [],
    );
  });

  it('with no values yet (unbound listener), enables the entries and sends a variable-less client', () => {
    open({ callbackEnvironment: () => undefined });
    expect(rec.servers[0]!.callbackEnvironment).toBe(true);
    expect(Object.keys(rec.spawns[0]!.opts.env).filter((n) => n.startsWith('COCKPIT_'))).toEqual(
      [],
    );
  });

  it('passes the private config file to both spawns (tests never read the user config)', () => {
    open({ configPath: '/dev/null', callbackEnvironment: () => ENV });
    expect(rec.servers[0]!.configPath).toBe('/dev/null');
    expect(rec.spawns[0]!.args.slice(0, 2)).toEqual(['-f', '/dev/null']);
  });
});

describe.skipIf(!tmuxInstalled)('local control-mode opener argv', () => {
  const open = (source: (() => typeof ENV | undefined) | undefined, configPath?: string): void => {
    new LocalTmuxControlManager('tok', '/tmp', 'sock-b', configPath, source).open({
      cols: 80,
      rows: 24,
    });
  };

  it('starts the server FIRST, variable-free, then spawns the -CC client with the values in its environment', () => {
    process.env['COCKPIT_CALLBACK_SOCK'] = '/leak/outer.sock';
    open(() => ENV);
    expect(rec.events).toEqual(['startTmuxServer', 'pty.spawn']);
    expect(rec.servers[0]).toMatchObject({ socket: 'sock-b', callbackEnvironment: true });
    expect(carriesValues(rec.servers[0]!.env)).toBe(false);
    const client = rec.spawns[0]!;
    expect(client.args).toEqual([
      '-L',
      'sock-b',
      '-CC',
      'new-session',
      '-A',
      '-s',
      'agent-cockpit-tok',
      '-c',
      '/tmp',
    ]);
    expect(client.opts.env['COCKPIT_CALLBACK_SOCK']).toBe(VALUES.COCKPIT_CALLBACK_SOCK);
    expect(client.opts.env['COCKPIT_CLI']).toBe(VALUES.COCKPIT_CLI);
    expect(client.opts.encoding).toBeNull(); // the raw-byte -CC invariant is untouched
  });

  it('never uses -e, a typed NAME=value, a start-server chain or any value in the client argv', () => {
    open(() => ENV);
    const argv = rec.spawns[0]!.args;
    expect(argv).not.toContain('-e');
    expect(argv).not.toContain('start-server');
    expect(argv.some((a) => a.includes('COCKPIT') || Object.values(VALUES).includes(a))).toBe(
      false,
    );
  });

  it('disabled: enables nothing and sends a client without any callback variable', () => {
    process.env['COCKPIT_CALLBACK_SOCK'] = '/leak/outer.sock';
    open(undefined);
    expect(rec.servers[0]!.callbackEnvironment).toBe(false);
    expect(
      Object.keys(rec.spawns[0]!.opts.env).filter((n) => n.startsWith('COCKPIT_CALLBACK_')),
    ).toEqual([]);
  });

  it('passes the private config file to both spawns', () => {
    open(() => ENV, '/dev/null');
    expect(rec.servers[0]!.configPath).toBe('/dev/null');
    expect(rec.spawns[0]!.args.slice(0, 2)).toEqual(['-f', '/dev/null']);
  });
});
