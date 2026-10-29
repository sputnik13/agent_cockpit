/**
 * Scenario 8, mux half: the callback variables and the app-chosen terminal key
 * enter a mux pane as `NAME=value` operands of the `/usr/bin/env … /bin/sh -c …`
 * trampoline at ALL THREE creation call sites (`session.create`, `pane.split`,
 * `window.new`), through the per-provider environment of RemoteMuxTerminalManager
 * (the local mux uses the same manager with local values). Argv-level proof, plus
 * a run of the real trampoline with a harmless "shell" to show what the final
 * process receives. No daemon protocol change: the request fields are unchanged.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { RemoteMuxTerminalManager } from './muxTerminal';

const ENV_A = buildCallbackEnvironment({
  sock: '/Users/me/Library/Application Support/Agent Cockpit/callback/aaaaaaaaaaaa.sock',
  cli: '/Users/me/Library/Application Support/Agent Cockpit/callback/bin/cockpit',
})!;
const ENV_B = buildCallbackEnvironment({
  sock: '/run/user/1000/agent-cockpit/callback/h-bbbbbbbbbbbb.sock',
  cli: '/home/u/.agent-cockpit/bin/linux-amd64/cockpit',
})!;

const TRAMPOLINE_TAIL = ['/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}"'];
const operandsFor = (environment: typeof ENV_A, key: string): string[] => [
  'BYOBU_DISABLE=1',
  `COCKPIT_CALLBACK_SOCK=${environment.vars.COCKPIT_CALLBACK_SOCK}`,
  'COCKPIT_CALLBACK_VERSION=1',
  `COCKPIT_CLI=${environment.vars.COCKPIT_CLI}`,
  `COCKPIT_CALLBACK_MUX_KEY=${key}`,
];

function harness(callbackEnvironment?: CallbackEnvironmentSource): {
  manager: RemoteMuxTerminalManager;
  calls: (method: string) => Array<Record<string, unknown>>;
} {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = vi.fn(
    async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      sent.push({ method, params: params ?? {} });
      if (method === 'session.create') return { session_id: 'session-root', pane_id: 'pane-root' };
      if (method === 'pane.split') return { session_id: 'session-split', pane_id: 'pane-split' };
      if (method === 'window.new') return { session_id: 'session-window', pane_id: 'pane-window' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      if (method === 'session.topology') return { sessions: [] }; // a Run terminal reads the selection first
      return {};
    },
  );
  const connection = {
    open: vi.fn(async () => {}),
    current: () => ({ request }),
    close: vi.fn(),
    onAttached: new Set<(epoch: number) => void>(),
  } as unknown as ConstructorParameters<typeof RemoteMuxTerminalManager>[0];
  const manager = new RemoteMuxTerminalManager(
    connection,
    '/workspace',
    'project-a',
    () => true,
    () => 10_000,
    ...(callbackEnvironment ? [callbackEnvironment] : []),
  );
  return {
    manager,
    calls: (method) => sent.filter((s) => s.method === method).map((s) => s.params),
  };
}

describe('mux callback injection: the three creation call sites', () => {
  it('session.create carries the project variables and the terminal key as env operands', async () => {
    const { manager, calls } = harness(() => ENV_A);
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    expect(calls('session.create')).toEqual([
      {
        command: '/usr/bin/env',
        args: [...operandsFor(ENV_A, 't1'), ...TRAMPOLINE_TAIL],
        cwd: '/workspace',
        key: 't1',
        broadcast_group: 'project-a',
      },
    ]);
    await manager.close('t1', { kill: true });
  });

  it('pane.split and window.new carry them too, each with the NEW terminal key', async () => {
    const { manager, calls } = harness(() => ENV_A);
    await manager.open({ key: 'root', cols: 80, rows: 24 });
    await manager.split('root', 'split', 'vertical');
    await manager.newWindow('root', 'window');

    expect(calls('pane.split')).toEqual([
      {
        pane_id: 'pane-root',
        command: '/usr/bin/env',
        args: [...operandsFor(ENV_A, 'split'), ...TRAMPOLINE_TAIL],
        cwd: '/workspace',
        key: 'split',
        direction: 'vertical',
        ratio: 0.5,
      },
    ]);
    expect(calls('window.new')).toEqual([
      {
        session_id: 'session-root',
        command: '/usr/bin/env',
        args: [...operandsFor(ENV_A, 'window'), ...TRAMPOLINE_TAIL],
        cwd: '/workspace',
        key: 'window',
      },
    ]);
  });

  it('keeps the key a per-pane value: every creation passes its own, never the source terminal key', async () => {
    const { manager, calls } = harness(() => ENV_A);
    await manager.open({ key: 'root', cols: 80, rows: 24 });
    await manager.split('root', 'a');
    await manager.split('root', 'b');
    await manager.newWindow('root', 'c');
    const keysSent = [
      ...calls('session.create'),
      ...calls('pane.split'),
      ...calls('window.new'),
    ].map((c) => (c['args'] as string[]).find((a) => a.startsWith('COCKPIT_CALLBACK_MUX_KEY=')));
    expect(keysSent).toEqual([
      'COCKPIT_CALLBACK_MUX_KEY=root',
      'COCKPIT_CALLBACK_MUX_KEY=a',
      'COCKPIT_CALLBACK_MUX_KEY=b',
      'COCKPIT_CALLBACK_MUX_KEY=c',
    ]);
  });

  it('evaluates the per-provider environment at every spawn, so a rebound socket reaches the next pane', async () => {
    let current = ENV_A;
    const { manager, calls } = harness(() => current);
    await manager.open({ key: 'root', cols: 80, rows: 24 });
    current = ENV_B;
    await manager.split('root', 'split');
    expect((calls('session.create')[0]!['args'] as string[]).join('\n')).toContain(
      'aaaaaaaaaaaa.sock',
    );
    const splitArgs = (calls('pane.split')[0]!['args'] as string[]).join('\n');
    expect(splitArgs).toContain('h-bbbbbbbbbbbb.sock');
    expect(splitArgs).not.toContain('aaaaaaaaaaaa.sock');
  });

  it('sends exactly the argv it always sent when the provider has no values', async () => {
    for (const make of [() => harness(), () => harness(() => undefined)]) {
      const { manager, calls } = make();
      await manager.open({ key: 'root', cols: 80, rows: 24 });
      await manager.split('root', 'split');
      await manager.newWindow('root', 'window');
      for (const call of [
        ...calls('session.create'),
        ...calls('pane.split'),
        ...calls('window.new'),
      ]) {
        expect(call['args']).toEqual(['BYOBU_DISABLE=1', ...TRAMPOLINE_TAIL]);
      }
    }
  });

  it('never fails a pane because the source threw: it gets the argv it always got', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { manager, calls } = harness(() => {
      throw new Error('handshake not ready');
    });
    await manager.open({ key: 'root', cols: 80, rows: 24 });
    expect(calls('session.create')[0]!['args']).toEqual(['BYOBU_DISABLE=1', ...TRAMPOLINE_TAIL]);
  });

  it('adds the key only together with the project variables (it is meaningless without a socket)', async () => {
    const { manager, calls } = harness(() => undefined);
    await manager.open({ key: 'root', cols: 80, rows: 24 });
    expect((calls('session.create')[0]!['args'] as string[]).join('\n')).not.toContain('MUX_KEY');
  });

  it('changes nothing else in the request: same command, cwd, key and broadcast group (no daemon protocol change)', async () => {
    const plain = harness();
    const injected = harness(() => ENV_A);
    for (const h of [plain, injected]) await h.manager.open({ key: 't1', cols: 80, rows: 24 });
    const { args: _plainArgs, ...plainRest } = plain.calls('session.create')[0]!;
    const { args: _injectedArgs, ...injectedRest } = injected.calls('session.create')[0]!;
    expect(injectedRest).toEqual(plainRest);
  });

  it('puts the app-chosen key on a Run terminal too (it is a mux pane like any other)', async () => {
    const { manager, calls } = harness(() => ENV_A);
    await manager.open({ key: 'run', kind: 'run', cols: 80, rows: 24 });
    expect(calls('session.create')[0]!['args']).toEqual([
      ...operandsFor(ENV_A, 'run'),
      ...TRAMPOLINE_TAIL,
    ]);
  });

  it('adds no identity operands for a key that cannot be an environment value', async () => {
    const { manager, calls } = harness(() => ENV_A);
    await manager.open({ key: 'bad\nkey', cols: 80, rows: 24 });
    expect(calls('session.create')[0]!['args']).toEqual(['BYOBU_DISABLE=1', ...TRAMPOLINE_TAIL]);
  });
});

describe('mux callback injection: what the final process receives', () => {
  /** Run the REAL trampoline with `env` as the "shell", so the pane process prints its environment. */
  async function paneEnvironment(callbackEnvironment: CallbackEnvironmentSource, key: string) {
    const { manager, calls } = harness(callbackEnvironment);
    await manager.open({ key, cols: 80, rows: 24 });
    const call = calls('session.create')[0]!;
    const out = execFileSync(call['command'] as string, call['args'] as string[], {
      env: { PATH: '/usr/bin:/bin', SHELL: '/usr/bin/env' },
      encoding: 'utf8',
    });
    return new Map(
      out
        .split('\n')
        .flatMap((l) =>
          l.includes('=')
            ? [[l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]]
            : [],
        ),
    );
  }

  it('delivers every value exactly, spaces and quotes included, plus the key and BYOBU_DISABLE', async () => {
    const awkward = buildCallbackEnvironment({
      sock: "/tmp/My Apps/it's $HOME;~#/a b.sock",
      cli: '/tmp/My Apps/bin/cock pit',
    })!;
    const env = await paneEnvironment(() => awkward, 'term-9');
    expect(env.get('COCKPIT_CALLBACK_SOCK')).toBe("/tmp/My Apps/it's $HOME;~#/a b.sock");
    expect(env.get('COCKPIT_CALLBACK_VERSION')).toBe('1');
    expect(env.get('COCKPIT_CLI')).toBe('/tmp/My Apps/bin/cock pit');
    expect(env.get('COCKPIT_CALLBACK_MUX_KEY')).toBe('term-9');
    expect(env.get('BYOBU_DISABLE')).toBe('1');
  });
});
