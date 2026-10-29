/**
 * RemoteProvider wiring of the terminal callback socket (scenarios 8 and 13, TS
 * side): the handshake names the project, the helper's reported socket and CLI
 * become the project's injected environment (control-mode `set-environment` and
 * mux operands), forwarded `callback` events are answered through the project's
 * decision function, and everything is torn down with the helper on disconnect.
 * A fake transport and a fake helper process over real framing; no live SSH.
 */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionEnvironment } from '@shared/tmux';
import { errorReply, okReply, type CallbackReply } from '@shared/callback/protocol';
import type { RemoteConnectionSpec } from '../types';
import { subscribe, type LogEntry } from '../../logger';
import { FrameDecoder, HelperRpcClient, encodeFrame, type HandshakeResult } from './rpcClient';
import type { LaunchedHelper } from './helper';

const hoisted = vi.hoisted(() => ({
  settings: {
    deterministicSessionNames: false,
    muxPersistScrollback: true,
    muxScrollbackLines: 10_000,
    terminalBackend: 'tmux',
    devEnv: { mode: 'tmux', memoryMaxMb: 16384 },
  },
  transport: null as unknown,
  nextHelper: null as null | (() => unknown),
  launcherCalls: [] as Array<{ artifacts: unknown; options: unknown }>,
  /** Runs after the launcher's `onClient` hook and before `launch()` resolves, like
   *  the helper's handshake does: an event pushed here overtakes the handshake reply. */
  duringHandshake: null as null | ((helper: unknown) => void),
  /** Fails `launch()` after the hook ran (the handshake was refused). */
  failAfterHook: false,
}));
vi.mock('../../config', () => ({ loadSettings: () => hoisted.settings }));
vi.mock('./transportFactory', () => ({ createRemoteTransport: () => hoisted.transport }));
vi.mock('./helper', () => ({
  RemoteHelperLauncher: class {
    private readonly options: { onClient?: (client: unknown) => void };
    constructor(
      _transport: unknown,
      artifacts: unknown,
      options: { onClient?: (c: unknown) => void },
    ) {
      this.options = options;
      hoisted.launcherCalls.push({ artifacts, options });
    }
    async launch(): Promise<unknown> {
      if (!hoisted.nextHelper) throw new Error('test did not provide a helper');
      const helper = hoisted.nextHelper() as { client: unknown };
      // Like the real launcher: the hook sees the client BEFORE the handshake.
      this.options.onClient?.(helper.client);
      hoisted.duringHandshake?.(helper);
      if (hoisted.failAfterHook) throw new Error('handshake refused');
      return helper;
    }
  },
}));

import { controlSessionName, RemoteProvider } from './index';
import { ProviderRegistry } from '../registry';
import { SessionManager } from '../sessionManager';

const SPEC: RemoteConnectionSpec = {
  kind: 'remote',
  host: 'example.invalid',
  user: 'deploy',
  port: 22,
  remotePath: '/srv/repo',
};
const SOCK = '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock';
const CLI = '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit';
const GOOD: HandshakeResult = { protocolVersion: 2, pid: 9, callbackSock: SOCK, cliPath: CLI };
const SESSION = controlSessionName('proj-r');

interface FakeHelper {
  launched: LaunchedHelper;
  /** Requests the client sent to the (fake) helper process. */
  seen: Array<{ id: number; method: string; params: Record<string, unknown> }>;
  pushEvent: (event: string, data: unknown) => void;
  endStream: () => void;
}

/** A launched helper whose client speaks real framing to an in-memory helper. */
function fakeHelper(handshake: HandshakeResult): FakeHelper {
  const toClient = new PassThrough();
  const toServer = new PassThrough();
  const decoder = new FrameDecoder();
  const seen: FakeHelper['seen'] = [];
  toServer.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as FakeHelper['seen'][number];
      seen.push(req);
      toClient.write(encodeFrame({ id: req.id, result: { delivered: true }, error: null }));
    }
  });
  const client = new HelperRpcClient({ stdin: toServer, stdout: toClient });
  return {
    launched: {
      client,
      handshake,
      channel: { close: vi.fn(() => toServer.end()) },
      remotePath: './.agent-cockpit/helper-0.1.0-linux-amd64',
      version: '0.1.0',
    },
    seen,
    pushEvent: (event, data) => toClient.write(encodeFrame({ event, data })),
    endStream: () => toClient.end(),
  };
}

class FakePty {
  readonly written: string[] = [];
  private onDataCb: ((chunk: Uint8Array) => void) | null = null;
  private seq = 1;
  write(data: string | Uint8Array): void {
    this.written.push(String(data).replace(/\n$/, ''));
    this.seq += 1;
    const block = `%begin 1700000000 ${this.seq} 1\r\n%end 1700000000 ${this.seq} 1\r\n`;
    this.onDataCb?.(new Uint8Array(Buffer.from(block, 'latin1')));
  }
  onData(cb: (chunk: Uint8Array) => void): void {
    this.onDataCb = cb;
    cb(new Uint8Array(Buffer.from('%begin 1699999999 1 0\r\n%end 1699999999 1 0\r\n', 'latin1')));
  }
  onClose(): void {}
  close(): void {}
  resize(): void {}
}

let logs: LogEntry[];
let unsubscribe: () => void;
let ptys: FakePty[];
const providers: RemoteProvider[] = [];

beforeEach(() => {
  hoisted.settings.deterministicSessionNames = false;
  hoisted.launcherCalls.length = 0;
  hoisted.nextHelper = null;
  hoisted.duringHandshake = null;
  hoisted.failAfterHook = false;
  ptys = [];
  let onState: ((state: string) => void) | null = null;
  hoisted.transport = {
    onStateChange: (handler: (state: string) => void) => {
      onState = handler;
      return () => undefined;
    },
    // Like the real transport: connecting, then socket-up (which the provider
    // holds at `connecting` until the helper RPC is proven).
    connect: vi.fn(async () => {
      onState?.('connecting');
      onState?.('connected');
    }),
    disconnect: vi.fn(async () => undefined),
    openPty: vi.fn(async () => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    }),
    exec: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
  };
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

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function make(handleCallback?: (request: unknown) => CallbackReply): RemoteProvider {
  const provider = new RemoteProvider('proj-r', SPEC, handleCallback ? { handleCallback } : {});
  providers.push(provider);
  return provider;
}

/** Connect a provider. `null` configures no callback handler at all. */
async function connected(
  handshake: HandshakeResult,
  handleCallback: ((request: unknown) => CallbackReply) | null = () =>
    okReply(1, { status: 'dispatched' }),
): Promise<{ provider: RemoteProvider; helper: FakeHelper }> {
  const helper = fakeHelper(handshake);
  hoisted.nextHelper = () => helper.launched;
  const provider = make(handleCallback ?? undefined);
  await provider.connect();
  return { provider, helper };
}

const muxArgs = (provider: RemoteProvider, key: string): string[] =>
  (provider as unknown as { muxTerminalManager(): { shellArgs(key: string): string[] } })
    .muxTerminalManager()
    .shellArgs(key);

describe('the handshake names the project only when something can answer it', () => {
  it('sends the project id when a handler is configured', async () => {
    await connected(GOOD);
    expect(hoisted.launcherCalls).toEqual([
      {
        artifacts: undefined,
        // The bridge is registered by the launcher's pre-handshake hook.
        options: { projectId: 'proj-r', onClient: expect.any(Function) },
      },
    ]);
  });

  it('sends no project id without a handler: the provider behaves exactly as before the feature', async () => {
    const { provider, helper } = await connected(GOOD, null);
    expect(hoisted.launcherCalls).toEqual([{ artifacts: undefined, options: {} }]);
    helper.pushEvent('callback', { connId: 1, request: {} });
    await tick();
    expect(helper.seen).toEqual([]); // nothing answered
    expect(
      (provider.tmuxControl() as unknown as { injection?: unknown }).injection,
    ).toBeUndefined();
    expect(muxArgs(provider, 't1')).toEqual([
      'BYOBU_DISABLE=1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });
});

describe('forwarded callback requests', () => {
  it('are answered through the project decision function with callback.reply', async () => {
    const handle = vi.fn((): CallbackReply => okReply(7, { status: 'dispatched' }));
    const { helper } = await connected(GOOD, handle);
    const request = { v: 1, id: 7, op: 'open', args: { path: '/srv/repo/a.md' } };
    helper.pushEvent('callback', { connId: 12, request });
    await tick();
    expect(handle).toHaveBeenCalledWith(request);
    expect(helper.seen).toEqual([
      {
        id: expect.any(Number),
        method: 'callback.reply',
        params: { connId: 12, reply: okReply(7, { status: 'dispatched' }) },
      },
    ]);
  });

  it('relay a refusal the same way', async () => {
    const { helper } = await connected(GOOD, () =>
      errorReply(3, 'not-connected', 'project is not connected'),
    );
    helper.pushEvent('callback', { connId: 1, request: { v: 1, id: 3, op: 'open' } });
    await tick();
    expect(helper.seen[0]!.params).toEqual({
      connId: 1,
      reply: errorReply(3, 'not-connected', 'project is not connected'),
    });
  });

  it('stop being answered when the provider disconnects, which also ends the helper (releasing its socket)', async () => {
    const handle = vi.fn((): CallbackReply => okReply(1, { status: 'dispatched' }));
    const { provider, helper } = await connected(GOOD, handle);
    await provider.disconnect();
    expect(helper.launched.channel.close).toHaveBeenCalledTimes(1);
    helper.pushEvent('callback', { connId: 1, request: {} });
    await tick();
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('a request that arrives before the launcher returns', () => {
  it('is answered: the bridge is registered before the handshake, not after launch() resolves', async () => {
    const handle = vi.fn(
      (): CallbackReply => errorReply(1, 'not-connected', 'project is not connected'),
    );
    const helper = fakeHelper(GOOD);
    hoisted.nextHelper = () => helper.launched;
    // The helper forwards a waiting CLI while its listener is still being started, so
    // the event overtakes the handshake reply.
    hoisted.duringHandshake = () =>
      helper.pushEvent('callback', { connId: 3, request: { v: 1, id: 1, op: 'open' } });
    const provider = make(handle);
    await provider.connect();
    await tick();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(helper.seen).toEqual([
      {
        id: expect.any(Number),
        method: 'callback.reply',
        params: { connId: 3, reply: errorReply(1, 'not-connected', 'project is not connected') },
      },
    ]);
  });

  it('is not answered through a helper whose launch failed after the hook ran', async () => {
    const handle = vi.fn((): CallbackReply => okReply(1, { status: 'dispatched' }));
    const helper = fakeHelper(GOOD);
    hoisted.nextHelper = () => helper.launched;
    hoisted.failAfterHook = true;
    const provider = make(handle);
    await expect(provider.connect()).rejects.toThrow(/handshake refused/);
    helper.pushEvent('callback', { connId: 1, request: { v: 1, id: 1, op: 'open' } });
    await tick();
    expect(handle).not.toHaveBeenCalled();
    expect(helper.seen).toEqual([]);
  });
});

describe('the helper handshake becomes the injected environment', () => {
  it('applies the helper-reported socket and CLI to the control session before attached', async () => {
    const { provider } = await connected(GOOD);
    await provider.tmuxControl().open();
    expect(ptys[0]!.written).toEqual([
      setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_SOCK', SOCK),
      setSessionEnvironment(SESSION, 'COCKPIT_CALLBACK_VERSION', '1'),
      setSessionEnvironment(SESSION, 'COCKPIT_CLI', CLI),
    ]);
  });

  it('gives the mux manager the same values, plus the per-terminal key', async () => {
    const { provider } = await connected(GOOD);
    const args = muxArgs(provider, 't1');
    expect(args).toEqual(
      expect.arrayContaining([
        `COCKPIT_CALLBACK_SOCK=${SOCK}`,
        'COCKPIT_CALLBACK_VERSION=1',
        `COCKPIT_CLI=${CLI}`,
        'COCKPIT_CALLBACK_MUX_KEY=t1',
      ]),
    );
  });

  it('supplies nothing before the helper is up', async () => {
    const provider = make(() => okReply(1, {}));
    await provider.tmuxControl().open();
    expect(ptys[0]!.written).toEqual([]);
    expect(muxArgs(provider, 't1')).toEqual([
      'BYOBU_DISABLE=1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });

  it('supplies nothing, and says why once, when the helper reported no socket', async () => {
    const { provider } = await connected({ protocolVersion: 2, pid: 9 });
    await provider.tmuxControl().open();
    expect(ptys[0]!.written).toEqual([]);
    const unavailable = logs.filter((l) =>
      /callback unavailable project=proj-r reason=helper-reported-none/.test(l.message),
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.level).toBe('warn');
  });

  it('supplies nothing once the helper stream is gone: a dead helper serves nothing', async () => {
    const { provider, helper } = await connected(GOOD);
    helper.endStream();
    await tick();
    await provider.tmuxControl().open();
    expect(ptys[0]!.written).toEqual([]);
    expect(muxArgs(provider, 't1')).toEqual([
      'BYOBU_DISABLE=1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });

  it('never writes to a session shared across installs, but mux injection stays on', async () => {
    hoisted.settings.deterministicSessionNames = true;
    const { provider } = await connected(GOOD);
    await provider.tmuxControl().open();
    expect(ptys[0]!.written).toEqual([]);
    expect(
      logs.some((l) =>
        /callback injection disabled project=proj-r .*reason=deterministic-session-names/.test(
          l.message,
        ),
      ),
    ).toBe(true);
    expect(muxArgs(provider, 't1')).toContain(`COCKPIT_CALLBACK_SOCK=${SOCK}`);
  });
});

describe('connection status', () => {
  it('is connected only after the helper (and so its listener) is up, and the bridge is wired by then', async () => {
    const { provider, helper } = await connected(GOOD);
    expect(provider.status().state).toBe('connected');
    // An event that arrives the instant the status is connected is already answered.
    helper.pushEvent('callback', { connId: 5, request: { v: 1, id: 1, op: 'open' } });
    await tick();
    expect(helper.seen.map((s) => s.method)).toEqual(['callback.reply']);
  });
});

describe('teardown is the one SessionManager already performs for every session', () => {
  const handle = (): CallbackReply => okReply(1, { status: 'dispatched' });

  /** A real SessionManager over real RemoteProviders and fake helpers. */
  function sessions(): { manager: SessionManager; helpers: FakeHelper[] } {
    const helpers: FakeHelper[] = [];
    hoisted.nextHelper = () => {
      const helper = fakeHelper(GOOD);
      helpers.push(helper);
      return helper.launched;
    };
    const registry = new ProviderRegistry();
    registry.register('remote', ({ projectId, spec }) => {
      if (spec.kind !== 'remote') throw new Error('expected a remote spec');
      const provider = new RemoteProvider(projectId, spec, { handleCallback: handle });
      providers.push(provider);
      return provider;
    });
    const manager = new SessionManager(registry, {
      loadSpec: () => SPEC,
      persistActive: () => undefined,
    });
    return { manager, helpers };
  }

  /** Open a session and let its session-owned watch settle (the fake helper answers it). */
  const openSettled = async (manager: SessionManager): Promise<void> => {
    await manager.open('proj-r');
    await vi.waitFor(() => expect(manager.watchSubCount()).toBe(1));
  };

  const answered = async (helper: FakeHelper): Promise<boolean> => {
    const before = helper.seen.length;
    helper.pushEvent('callback', { connId: 1, request: { v: 1, id: 1, op: 'open' } });
    await tick();
    return helper.seen.length > before;
  };

  it('serves a connected session through its helper', async () => {
    const { manager, helpers } = sessions();
    await openSettled(manager);
    expect(manager.statusOf('proj-r')?.state).toBe('connected');
    expect(await answered(helpers[0]!)).toBe(true);
  });

  it('close() stops answering and ends the helper channel, which releases its listener', async () => {
    const { manager, helpers } = sessions();
    await openSettled(manager);
    await manager.close('proj-r');
    expect(helpers[0]!.launched.channel.close).toHaveBeenCalledTimes(1);
    expect(await answered(helpers[0]!)).toBe(false);
  });

  it('reconnect() retires the old helper completely and serves through the new one', async () => {
    const { manager, helpers } = sessions();
    await openSettled(manager);
    await manager.reconnect('proj-r');
    await vi.waitFor(() => expect(manager.watchSubCount()).toBe(1));
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.launched.channel.close).toHaveBeenCalledTimes(1);
    expect(await answered(helpers[0]!)).toBe(false); // the retired helper is never answered through
    expect(await answered(helpers[1]!)).toBe(true);
  });

  it('closeAll() (app quit) tears every session down the same way', async () => {
    const { manager, helpers } = sessions();
    await openSettled(manager);
    await manager.closeAll();
    expect(helpers[0]!.launched.channel.close).toHaveBeenCalledTimes(1);
    expect(await answered(helpers[0]!)).toBe(false);
  });

  it('a failed connect leaves nothing serving', async () => {
    const { manager, helpers } = sessions();
    hoisted.nextHelper = () => {
      const helper = fakeHelper(GOOD);
      helpers.push(helper);
      throw new Error('helper launch failed');
    };
    await expect(manager.open('proj-r')).rejects.toThrow(/helper launch failed/);
    expect(manager.get('proj-r')).toBeUndefined();
    expect(await answered(helpers[0]!)).toBe(false); // never bridged
  });
});
