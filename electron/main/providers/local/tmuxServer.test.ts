/**
 * The server-start spawn and the attaching client's environment (requirements 6,
 * 7 and 13), at the argv/env level with a fake runner. The real-tmux behavior
 * (what a pane process receives) is covered by callbackInjection.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';
import { subscribe, type LogEntry } from '../../logger';

const wrap = vi.hoisted(() => ({ rosetta: false }));
vi.mock('./nativeArch', () => ({
  withNativeArch: (file: string, args: string[]) =>
    wrap.rosetta ? { file: 'arch', args: ['-arm64', file, ...args] } : { file, args },
}));

import {
  __resetTmuxServerDiagnosticsForTests,
  spawnTmux,
  startTmuxServer,
  TMUX_SPAWN_TIMEOUT_MS,
  tmuxClientEnv,
  type TmuxRun,
  type TmuxRunResult,
} from './tmuxServer';

const CONTAMINATED: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/me',
  COCKPIT_CALLBACK_SOCK: '/leak/outer.sock',
  COCKPIT_CALLBACK_VERSION: '9',
  COCKPIT_CALLBACK_MUX_KEY: 'outer-key',
  COCKPIT_CLI: '/leak/cli',
  COCKPIT_MUX_HOME: '/tmp/mux-home',
  AC_TMUX_EPHEMERAL: '1',
};

interface Call {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  capture: boolean;
  timeoutMs: number;
}

/** A runner that records every spawn and answers from a script (default: success). */
function fakeRunner(answer: (call: Call) => Partial<TmuxRunResult> = () => ({})): {
  run: TmuxRun;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: TmuxRun = (file, args, opts) => {
    const call = { file, args, env: opts.env, capture: opts.capture, timeoutMs: opts.timeoutMs };
    calls.push(call);
    return { status: 0, stdout: '', stderr: '', ...answer(call) };
  };
  return { run, calls };
}

const optionsOf = (args: string[]): string[] =>
  args.flatMap((a, i) => (a.startsWith('update-environment[') ? [`${a} ${args[i + 1]}`] : []));

let logs: LogEntry[];
let unsubscribe: () => void;
beforeEach(() => {
  __resetTmuxServerDiagnosticsForTests();
  wrap.rosetta = false;
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe('startTmuxServer', () => {
  it('spawns the server start WITHOUT any callback variable, whatever the base environment carries', () => {
    const { run, calls } = fakeRunner();
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: CONTAMINATED }, run);
    expect(calls).toHaveLength(1);
    const names = Object.keys(calls[0]!.env);
    expect(names.filter((n) => n === 'COCKPIT_CLI' || n.startsWith('COCKPIT_CALLBACK_'))).toEqual(
      [],
    );
    // Deliberate isolation overrides and everything else are kept.
    expect(calls[0]!.env['COCKPIT_MUX_HOME']).toBe('/tmp/mux-home');
    expect(calls[0]!.env['PATH']).toBe('/usr/bin:/bin');
    // The caller's object is not mutated.
    expect(CONTAMINATED['COCKPIT_CALLBACK_SOCK']).toBe('/leak/outer.sock');
  });

  it('is variable-free in an ephemeral run too, and never sets exit-empty on', () => {
    const { run, calls } = fakeRunner();
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: CONTAMINATED }, run);
    const args = calls[0]!.args;
    expect(args.slice(args.indexOf('exit-empty') - 2, args.indexOf('exit-empty') + 2)).toEqual([
      'set',
      '-g',
      'exit-empty',
      'off',
    ]);
    // (`mouse`, `focus-events` and `set-clipboard` are legitimately `on`; only exit-empty must not be.)
  });

  it('chains start-server, the shared options, then the three indexed update-environment elements LAST', () => {
    const { run, calls } = fakeRunner();
    expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
      'applied',
    );
    const args = calls[0]!.args;
    expect(calls[0]!.file).toBe('tmux');
    expect(args.slice(0, 3)).toEqual(['-L', 's1', 'start-server']);
    expect(optionsOf(args)).toEqual([
      'update-environment[100] COCKPIT_CALLBACK_SOCK',
      'update-environment[101] COCKPIT_CALLBACK_VERSION',
      'update-environment[102] COCKPIT_CLI',
    ]);
    expect(args.slice(-15)).toEqual([
      ';',
      'set',
      '-g',
      'update-environment[100]',
      'COCKPIT_CALLBACK_SOCK',
      ';',
      'set',
      '-g',
      'update-environment[101]',
      'COCKPIT_CALLBACK_VERSION',
      ';',
      'set',
      '-g',
      'update-environment[102]',
      'COCKPIT_CLI',
    ]);
    // history-limit is applied before any session can exist: it is in this chain.
    expect(args).toContain('history-limit');
    expect(args).toContain('automatic-rename');
  });

  it('omits the elements for a naming object that shares its sessions, and reports it disabled', () => {
    const { run, calls } = fakeRunner();
    expect(startTmuxServer({ socket: 's1', callbackEnvironment: false, env: {} }, run)).toBe(
      'disabled',
    );
    expect(optionsOf(calls[0]!.args)).toEqual([]);
    expect(calls[0]!.args).toContain('history-limit');
  });

  it('passes the private config file to the server start (tests never read the user config)', () => {
    const { run, calls } = fakeRunner();
    startTmuxServer(
      { socket: 's1', configPath: '/dev/null', callbackEnvironment: true, env: {} },
      run,
    );
    expect(calls[0]!.args.slice(0, 5)).toEqual(['-f', '/dev/null', '-L', 's1', 'start-server']);
  });

  it('goes through the native-arch wrapper: start-server materializes the long-lived server', () => {
    wrap.rosetta = true;
    const { run, calls } = fakeRunner();
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run);
    expect(calls[0]!.file).toBe('arch');
    expect(calls[0]!.args.slice(0, 4)).toEqual(['-arm64', 'tmux', '-L', 's1']);
  });

  it('discards the happy-path output so the forked server never holds a pipe open', () => {
    const { run, calls } = fakeRunner();
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run);
    expect(calls[0]!.capture).toBe(false);
  });

  describe('an old tmux that rejects the indexed update-environment form', () => {
    // The chain stops at the first failing command, so everything before the
    // indexed elements is applied and only they are lost.
    const oldTmux = (call: Call): Partial<TmuxRunResult> => {
      if (call.args.includes('start-server')) return { status: 1 };
      if (call.args[0] === '-V') return { stdout: 'tmux 2.9a\n' };
      if (call.args.some((a) => a.startsWith('update-environment['))) {
        return { status: 1, stderr: 'invalid option: update-environment[100]\n' };
      }
      return {};
    };

    it('reports a defined, structured diagnostic naming the tmux version (never a silent absence)', () => {
      const { run } = fakeRunner(oldTmux);
      expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
        'unsupported',
      );
      const warnings = logs.filter((l) => l.level === 'warn' && l.context === 'callback');
      expect(warnings).toHaveLength(1);
      const message = warnings[0]!.message;
      expect(message).toContain('callback env unavailable');
      expect(message).toContain('socket=s1');
      expect(message).toContain('reason=update-environment-set-failed');
      expect(message).toContain('tmux="tmux 2.9a"');
      expect(message).toContain('option="update-environment[100]"');
      expect(message).toContain('invalid option: update-environment[100]');
      expect(message).toContain('will not receive COCKPIT_CALLBACK_*');
    });

    it('says it once per socket, not once per terminal open', () => {
      const { run } = fakeRunner(oldTmux);
      for (let i = 0; i < 4; i += 1) {
        expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
          'unsupported',
        );
      }
      expect(logs.filter((l) => l.level === 'warn' && l.context === 'callback')).toHaveLength(1);
      // Another server (another socket) is reported on its own.
      startTmuxServer({ socket: 's2', callbackEnvironment: true, env: {} }, run);
      expect(logs.filter((l) => l.level === 'warn' && l.context === 'callback')).toHaveLength(2);
    });

    it('retries the failing entry alone and variable-free to attribute the failure exactly', () => {
      const { run, calls } = fakeRunner(oldTmux);
      startTmuxServer({ socket: 's1', callbackEnvironment: true, env: CONTAMINATED }, run);
      const retry = calls.find((c) => c.args.includes('set') && !c.args.includes('start-server'))!;
      expect(retry.args).toEqual([
        '-L',
        's1',
        'set',
        '-g',
        'update-environment[100]',
        'COCKPIT_CALLBACK_SOCK',
      ]);
      expect(retry.capture).toBe(true);
      for (const call of calls) {
        expect(Object.keys(call.env).filter((n) => n.startsWith('COCKPIT_CALLBACK_'))).toEqual([]);
      }
    });

    it('still falls through to a normal outcome when the chain failed for an unrelated reason', () => {
      // The chain failed, but each indexed element sets fine on its own: applied.
      const { run } = fakeRunner((call) =>
        call.args.includes('start-server') ? { status: 1 } : {},
      );
      expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
        'applied',
      );
      expect(logs.filter((l) => l.level === 'warn')).toEqual([]);
    });

    it('stays silent for a disabled object even if the chain fails', () => {
      const { run, calls } = fakeRunner(() => ({ status: 1 }));
      expect(startTmuxServer({ socket: 's1', callbackEnvironment: false, env: {} }, run)).toBe(
        'disabled',
      );
      expect(calls).toHaveLength(1);
      expect(logs).toEqual([]);
    });
  });
});

describe('every tmux spawn is bounded (a wedged server must not hang the main thread)', () => {
  const oldTmux = (call: Call): Partial<TmuxRunResult> => {
    if (call.args.includes('start-server')) return { status: 1 };
    if (call.args[0] === '-V') return { stdout: 'tmux 2.6\n' };
    return { status: 1, stderr: 'invalid option: update-environment[100]\n' };
  };

  it('gives the happy-path server start the same 5 s bound as the diagnostic probes', () => {
    expect(TMUX_SPAWN_TIMEOUT_MS).toBe(5_000);
    const { run, calls } = fakeRunner();
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ capture: false, timeoutMs: 5_000 });
  });

  it('bounds the retry and the version probe too', () => {
    const { run, calls } = fakeRunner(oldTmux);
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run);
    expect(calls.length).toBeGreaterThanOrEqual(3); // start, retry, -V
    for (const call of calls) expect(call.timeoutMs).toBe(5_000);
  });

  it('really kills a hung process instead of waiting for it (default runner, either mode)', () => {
    for (const capture of [false, true]) {
      const started = Date.now();
      const res = spawnTmux('sh', ['-c', 'sleep 30'], {
        env: process.env,
        capture,
        timeoutMs: 150,
      });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(res.status).toBeNull();
      expect(res.timedOut).toBe(true);
    }
  });

  it('reports a normal process as not timed out, with its output when captured', () => {
    const res = spawnTmux('sh', ['-c', 'echo out; echo err >&2; exit 3'], {
      env: process.env,
      capture: true,
      timeoutMs: 5_000,
    });
    expect(res).toMatchObject({ status: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });
});

describe('the diagnostic is classified from what tmux actually said', () => {
  /** A tmux whose server start fails and whose retried indexed set fails with `stderr`. */
  const failing =
    (stderr: string, extra: Partial<TmuxRunResult> = {}) =>
    (call: Call): Partial<TmuxRunResult> => {
      if (call.args.includes('start-server')) return { status: 1 };
      if (call.args[0] === '-V') return { stdout: 'tmux 3.2a\n' };
      return { status: 1, stderr, ...extra };
    };
  const warnings = (): string[] =>
    logs.filter((l) => l.level === 'warn' && l.context === 'callback').map((l) => l.message);

  it.each([
    'invalid option: update-environment[100]',
    'unknown option: update-environment[100]',
    'not an array: update-environment[100]',
    'ambiguous option: update-environment[abc]',
  ])('blames the tmux version when tmux rejects the option: %s', (stderr) => {
    const { run, calls } = fakeRunner(failing(`${stderr}\n`));
    expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
      'unsupported',
    );
    const [message] = warnings();
    expect(message).toContain('reason=update-environment-set-failed');
    expect(message).toContain('tmux="tmux 3.2a"');
    expect(message).toContain(JSON.stringify(stderr));
    expect(calls.some((c) => c.args[0] === '-V')).toBe(true);
  });

  it.each([
    'error connecting to /private/tmp/tmux-501/s1 (No such file or directory)',
    'no server running on /private/tmp/tmux-501/s1',
    'unknown command: set',
    'permission denied',
  ])('logs the raw failure, claiming nothing about the version, otherwise: %s', (stderr) => {
    const { run, calls } = fakeRunner(failing(`${stderr}\n`));
    expect(startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, run)).toBe(
      'failed',
    );
    const [message] = warnings();
    expect(message).toContain('reason=tmux-command-failed');
    expect(message).not.toContain('update-environment-set-failed');
    expect(message).not.toContain('tmux="'); // no version claim
    expect(message).toContain(JSON.stringify(stderr));
    expect(message).not.toContain('will not receive'); // it may still reach panes
    expect(calls.some((c) => c.args[0] === '-V')).toBe(false); // and no version probe is spent
  });

  it('names a timeout and an empty failure instead of an empty detail', () => {
    const timedOut = fakeRunner(failing('', { timedOut: true, status: null }));
    expect(
      startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, timedOut.run),
    ).toBe('failed');
    expect(warnings()[0]).toContain('detail="timed out after 5000ms"');

    const silent = fakeRunner(failing('', { status: 7 }));
    startTmuxServer({ socket: 's2', callbackEnvironment: true, env: {} }, silent.run);
    expect(warnings()[1]).toContain('detail="exit status 7"');
  });

  it('reports each reason once per socket, so a raw failure never hides a later rejection', () => {
    const raw = fakeRunner(failing('no server running on /tmp/x\n'));
    const rejected = fakeRunner(failing('invalid option: update-environment[100]\n'));
    for (let i = 0; i < 3; i += 1) {
      startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, raw.run);
    }
    expect(warnings()).toHaveLength(1);
    startTmuxServer({ socket: 's1', callbackEnvironment: true, env: {} }, rejected.run);
    expect(warnings()).toHaveLength(2);
    expect(warnings()[1]).toContain('reason=update-environment-set-failed');
  });
});

describe('tmuxClientEnv', () => {
  const environment = buildCallbackEnvironment({
    sock: '/p with space/a.sock',
    cli: '/p with space/cockpit',
  })!;

  it("carries the project's own values plus TERM/COLORTERM, in place of anything inherited", () => {
    const env = tmuxClientEnv(CONTAMINATED, environment);
    expect(env['COCKPIT_CALLBACK_SOCK']).toBe('/p with space/a.sock');
    expect(env['COCKPIT_CALLBACK_VERSION']).toBe('1');
    expect(env['COCKPIT_CLI']).toBe('/p with space/cockpit');
    expect(env['COCKPIT_CALLBACK_MUX_KEY']).toBeUndefined(); // mux-only, never a tmux variable
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
    expect(env['COCKPIT_MUX_HOME']).toBe('/tmp/mux-home');
  });

  it('carries none when the project has none, so an enabled attach strips them', () => {
    const env = tmuxClientEnv(CONTAMINATED, undefined);
    expect(
      Object.keys(env).filter((n) => n === 'COCKPIT_CLI' || n.startsWith('COCKPIT_CALLBACK_')),
    ).toEqual([]);
    expect(env['PATH']).toBe('/usr/bin:/bin');
  });

  it('never writes into process.env', () => {
    const before = { ...process.env };
    tmuxClientEnv(process.env, environment);
    expect(process.env).toEqual(before);
  });
});
