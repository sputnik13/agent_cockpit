/**
 * Scenario 6: the callback listener's lifecycle follows the SessionManager —
 * started when a LOCAL session reaches `connected`, stopped on the edge into
 * `disconnected`/`failed` AND on eviction/closeAll (symmetric teardown), lazy
 * for a project that was never opened, unlinked on project removal.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '@shared/providers/fakeProvider';
import type { ConnectionSpec, ConnectionState, ConnectionStatus } from '@shared/providers/types';
import { logger } from '../logger';
import { ProviderRegistry } from '../providers/registry';
import { SessionManager } from '../providers/sessionManager';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { projectHash } from './socketPath';
import { callbackRequest, openRequest } from './testClient';

/** A provider whose status the test scripts, the way a ConnectionMachine edge would. */
class ScriptedProvider extends FakeProvider {
  private state: ConnectionState = 'connected'; // LocalProvider's machine starts connected
  private readonly subs = new Set<(s: ConnectionStatus) => void>();

  constructor(
    projectId: string,
    kind: 'local' | 'remote',
    private readonly disconnectEmits = false,
  ) {
    super(projectId, kind);
  }

  override status(): ConnectionStatus {
    return { state: this.state, since: new Date().toISOString() };
  }
  override onStatusChange(handler: (s: ConnectionStatus) => void): () => void {
    this.subs.add(handler);
    return () => this.subs.delete(handler);
  }
  override async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.failNextConnect) {
      const err = this.failNextConnect;
      this.failNextConnect = null;
      throw err;
    }
    this.go('connected');
  }
  /** Like LocalProvider, a plain disconnect() leaves the status alone unless told to emit. */
  override async disconnect(): Promise<void> {
    if (this.disconnectEmits) this.go('disconnected');
  }
  go(state: ConnectionState): void {
    this.state = state;
    for (const h of this.subs) h(this.status());
  }
}

let userData: string;
let sessions: SessionManager;
let broker: CallbackBroker;
let providers: Map<string, ScriptedProvider>;
let events: CallbackOpenEvent[];
let startSpy: ReturnType<typeof vi.spyOn>;
let disconnectEmits = false;

const SPECS: Record<string, ConnectionSpec> = {
  a: { kind: 'local', rootPath: '/repo/a' },
  b: { kind: 'local', rootPath: '/repo/b' },
  r: { kind: 'remote', host: 'h', user: 'u', port: 22, remotePath: '/srv/r' },
};

const callbackDir = (): string => join(userData, 'callback');
const socketOf = (projectId: string): string =>
  join(callbackDir(), `${projectHash(projectId)}.sock`);

beforeEach(() => {
  userData = mkdtempSync('/tmp/accb-lc-');
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => undefined);
  disconnectEmits = false;
  providers = new Map();
  events = [];
  const registry = new ProviderRegistry();
  for (const kind of ['local', 'remote'] as const) {
    registry.register(kind, ({ projectId }) => {
      const provider = new ScriptedProvider(projectId, kind, disconnectEmits);
      providers.set(projectId, provider);
      return provider;
    });
  }
  sessions = new SessionManager(registry, {
    loadSpec: (id) => SPECS[id] ?? null,
    persistActive: () => undefined,
    callback: {
      start: (id) => broker.startLocalListener(id),
      stop: (id) => broker.stopListener(id),
    },
  });
  broker = new CallbackBroker({
    statusOf: (id) => sessions.statusOf(id),
    providerOf: (id) => sessions.get(id),
    projectRootOf: (id) => {
      const spec = SPECS[id];
      return spec ? (spec.kind === 'local' ? spec.rootPath : spec.remotePath) : null;
    },
    userDataDir: () => userData,
    realpath: async (p) => p,
  });
  broker.onOpen((e) => events.push(e));
  startSpy = vi.spyOn(broker, 'startLocalListener');
});

afterEach(async () => {
  await sessions.closeAll();
  await broker.stopAll();
  rmSync(userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Wait for the (fire-and-forget) listener start that a session edge triggers. */
const listening = (id: string): Promise<void> =>
  vi.waitFor(() => expect(broker.localSocketPath(id)).toBe(socketOf(id)));
const gone = (id: string): Promise<void> =>
  vi.waitFor(() => {
    expect(broker.localSocketPath(id)).toBeNull();
    expect(existsSync(socketOf(id))).toBe(false);
  });

describe('callback listener lifecycle (scenario 6)', () => {
  it('starts when a local session reaches connected and serves open for that project', async () => {
    await sessions.open('a');
    await listening('a');
    expect(
      await callbackRequest(socketOf('a'), openRequest('/repo/a/src/x.ts', { id: 3 })),
    ).toEqual({
      id: 3,
      ok: true,
      result: { status: 'dispatched' },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({
      projectId: 'a',
      selection: { kind: 'file', path: 'src/x.ts' },
    });
  });

  // Injection reads the socket path when a terminal is CREATED. open()/activate()
  // therefore hand the session out only after the bind, or the first terminal made
  // right after (a restored tab, the first control-mode attach) would race it and
  // start without the variables for the whole life of its tmux session.
  it('has the socket bound by the time open() resolves, so the first terminal can inject its path', async () => {
    await sessions.open('a');
    expect(broker.localSocketPath('a')).toBe(socketOf('a')); // no waiting
    await sessions.activate('b');
    expect(broker.localSocketPath('b')).toBe(socketOf('b'));
  });

  it('also holds back a concurrent open() of the same project until the socket is bound', async () => {
    const first = sessions.open('a');
    const second = sessions.open('a'); // sees the session the first call already created
    const provider = await second; // awaited ALONE: it must not return before the bind
    expect(broker.localSocketPath('a')).toBe(socketOf('a'));
    expect(await first).toBe(provider);
    // A later open() of the live session returns at once.
    expect(await sessions.open('a')).toBe(provider);
  });

  it('does not make open() wait for a socket that cannot be bound', async () => {
    const elsewhere = join(userData, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, callbackDir());
    const provider = await sessions.open('a'); // resolves; the unsafe directory only disables callback
    expect(provider.status().state).toBe('connected');
    expect(broker.localSocketPath('a')).toBeNull();
  });

  it('has nothing to wait for on a remote session (its helper serves the socket)', async () => {
    await sessions.open('r');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('is lazy: a project that was never opened has no listener and no socket', async () => {
    await sessions.open('a');
    await listening('a');
    expect(broker.localSocketPath('b')).toBeNull();
    expect(readdirSync(callbackDir())).toEqual([`${projectHash('a')}.sock`]);
    await expect(callbackRequest(socketOf('b'), openRequest('/repo/b/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('serves each live project on its own socket, never across projects', async () => {
    await sessions.open('a');
    await sessions.open('b');
    await listening('a');
    await listening('b');
    expect(socketOf('a')).not.toBe(socketOf('b'));
    await callbackRequest(socketOf('b'), openRequest('/repo/b/only.ts'));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.projectId).toBe('b');
  });

  it('starts no local listener for a remote session (its helper serves the socket)', async () => {
    await sessions.open('r');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(startSpy).not.toHaveBeenCalled();
    expect(broker.localSocketPath('r')).toBeNull();
    expect(existsSync(callbackDir())).toBe(false);
  });

  it('stops on the edge into disconnected', async () => {
    await sessions.open('a');
    await listening('a');
    providers.get('a')!.go('disconnected');
    await gone('a');
    await expect(callbackRequest(socketOf('a'), openRequest('/repo/a/x'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops on the edge into failed, and starts again when the session reconnects', async () => {
    await sessions.open('a');
    await listening('a');
    providers.get('a')!.go('failed');
    await gone('a');
    providers.get('a')!.go('connected');
    await listening('a');
    expect(await callbackRequest(socketOf('a'), openRequest('/repo/a/x'))).toMatchObject({
      ok: true,
    });
  });

  it('keeps the listener through reconnecting but refuses with not-connected until connected again', async () => {
    await sessions.open('a');
    await listening('a');
    providers.get('a')!.go('reconnecting');
    expect(await callbackRequest(socketOf('a'), openRequest('/repo/a/x'))).toMatchObject({
      ok: false,
      error: { code: 'not-connected' },
    });
    providers.get('a')!.go('connected'); // the edge back into connected rebinds; the newest wins
    await vi.waitFor(async () =>
      expect(await callbackRequest(socketOf('a'), openRequest('/repo/a/x'))).toMatchObject({
        ok: true,
      }),
    );
  });

  it('does not restart on a repeated connected status (edge-gated like the watch)', async () => {
    await sessions.open('a');
    await listening('a');
    startSpy.mockClear();
    providers.get('a')!.go('connected');
    providers.get('a')!.go('connected');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('stops on eviction even though a plain disconnect never reports disconnected', async () => {
    await sessions.open('a');
    await listening('a');
    await sessions.close('a'); // LocalProvider.disconnect() leaves its status connected
    expect(providers.get('a')!.status().state).toBe('connected');
    await gone('a');
  });

  it('unlinks the socket when the project is removed (close + remove, as the IPC does)', async () => {
    await sessions.activate('a');
    await listening('a');
    await sessions.close('a');
    await gone('a');
    expect(readdirSync(callbackDir())).toEqual([]);
  });

  it('tears down on a status-emitting disconnect as well as on the edge (both paths agree)', async () => {
    disconnectEmits = true;
    await sessions.open('a');
    await listening('a');
    await sessions.disconnect('a');
    await gone('a');
  });

  it('rebinds the same path for a reconnected session', async () => {
    await sessions.open('a');
    await listening('a');
    const old = providers.get('a')!;
    await sessions.reconnect('a');
    expect(providers.get('a')).not.toBe(old);
    await listening('a');
    expect(await callbackRequest(socketOf('a'), openRequest('/repo/a/x'))).toMatchObject({
      ok: true,
    });
  });

  it('closeAll stops every listener', async () => {
    await sessions.open('a');
    await sessions.open('b');
    await listening('a');
    await listening('b');
    await sessions.closeAll();
    await gone('a');
    await gone('b');
    expect(readdirSync(callbackDir())).toEqual([]);
  });

  describe('an open still being classified when its session ends delivers nothing', () => {
    /** Send an open through the real socket and hold its classification. */
    async function inFlight(): Promise<{ provider: ScriptedProvider; release: () => void }> {
      await sessions.open('a');
      await listening('a');
      const provider = providers.get('a')!;
      let release: (w: never[]) => void = () => undefined;
      provider.listWorktrees = () => new Promise((resolve) => (release = resolve));
      expect(await callbackRequest(socketOf('a'), openRequest('/repo/a/x.ts'))).toMatchObject({
        ok: true,
        result: { status: 'dispatched' },
      });
      return { provider, release: () => release([]) };
    }

    it('after the status leaves connected', async () => {
      const { provider, release } = await inFlight();
      provider.go('disconnected');
      await gone('a');
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]);
    });

    it('after the session is closed (provider evicted, status still connected)', async () => {
      const { release } = await inFlight();
      await sessions.close('a');
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]);
    });

    it('after a reconnect replaced the session, even though the new session is connected', async () => {
      const { release } = await inFlight();
      await sessions.reconnect('a');
      await listening('a');
      expect(sessions.statusOf('a')?.state).toBe('connected');
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(events).toEqual([]); // the open belonged to the session that no longer exists
    });

    it('but not when the session simply stays connected', async () => {
      const { release } = await inFlight();
      release();
      await vi.waitFor(() => expect(events).toHaveLength(1));
    });
  });

  it('unlinks the sockets synchronously in closeAll, which the app does not await at quit', async () => {
    await sessions.open('a');
    await sessions.open('b');
    await listening('a');
    await listening('b');
    const closing = sessions.closeAll();
    expect(existsSync(socketOf('a'))).toBe(false);
    expect(existsSync(socketOf('b'))).toBe(false);
    await closing;
  });

  it('lets the quit-time stopAll backstop follow closeAll without error or leftovers', async () => {
    await sessions.open('a');
    await listening('a');
    await sessions.closeAll();
    await broker.stopAll();
    await broker.stopAll();
    expect(broker.localSocketPath('a')).toBeNull();
    expect(readdirSync(callbackDir())).toEqual([]);
  });

  it('leaves nothing behind when the connect fails after the listener started', async () => {
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => {
      const provider = new ScriptedProvider(projectId, 'local');
      provider.failNextConnect = new Error('boom');
      providers.set(projectId, provider);
      return provider;
    });
    const failing = new SessionManager(registry, {
      loadSpec: (id) => SPECS[id] ?? null,
      persistActive: () => undefined,
      callback: {
        start: (id) => broker.startLocalListener(id),
        stop: (id) => broker.stopListener(id),
      },
    });
    await expect(failing.open('a')).rejects.toThrow('boom');
    await gone('a');
  });

  it('closes a listener whose start was still in flight when the session ended', async () => {
    await sessions.open('a');
    await sessions.close('a');
    await gone('a');
    await new Promise((resolve) => setTimeout(resolve, 50)); // let any late bind land
    expect(broker.localSocketPath('a')).toBeNull();
    expect(readdirSync(callbackDir())).toEqual([]);
  });

  it('disables callback for the project, without failing the session, when the directory is unsafe', async () => {
    const elsewhere = join(userData, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, callbackDir());
    const warn = vi.spyOn(logger, 'warn');
    const provider = await sessions.open('a');
    expect(provider.status().state).toBe('connected');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^callback disabled project=a reason=unsafe-dir /,
    );
    expect(broker.localSocketPath('a')).toBeNull();
    expect(readdirSync(elsewhere)).toEqual([]); // nothing was bound through the symlink
  });

  it('is absent when the SessionManager is built without callback hooks', async () => {
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => new ScriptedProvider(projectId, 'local'));
    const plain = new SessionManager(registry, {
      loadSpec: (id) => SPECS[id] ?? null,
      persistActive: () => undefined,
    });
    await plain.open('a');
    await plain.close('a');
    expect(startSpy).not.toHaveBeenCalled();
  });
});

// A local session reports `connected` BEFORE its callback socket is bound, and the
// renderer's terminal/control-mode IPC resolves the provider with `get()`, not
// through open(). Whatever creates or attaches a terminal therefore waits on
// `callbackReady()` (the IPC handlers do; see ipc/controlManagerWiring.test.ts),
// without ever delaying the status event.
describe('callbackReady (creation and attach paths wait for the pending bind)', () => {
  /** A SessionManager whose listener start is held open until the test releases it. */
  function heldStart(): {
    manager: SessionManager;
    release: (n: number) => void;
    order: string[];
  } {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => {
      const provider = new ScriptedProvider(projectId, 'local');
      providers.set(projectId, provider);
      return provider;
    });
    const manager = new SessionManager(registry, {
      loadSpec: (id) => SPECS[id] ?? null,
      persistActive: () => undefined,
      onStatus: (id, status) => order.push(`status:${id}:${status.state}`),
      callback: {
        start: (id) => {
          order.push(`start:${id}`);
          return new Promise<void>((resolve) => releases.push(resolve));
        },
        stop: async () => undefined,
      },
    });
    return { manager, release: (n) => releases[n]!(), order };
  }

  const settled = async (promise: Promise<void>): Promise<'ready' | 'pending'> =>
    Promise.race([
      promise.then(() => 'ready' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);

  it('is pending while the bind runs, although connected was already reported', async () => {
    const { manager, release, order } = heldStart();
    const opening = manager.open('a');
    // The status event is NOT delayed: it fired synchronously, ahead of the bind.
    expect(order.slice(0, 2)).toEqual(['status:a:connected', 'start:a']);
    const ready = manager.callbackReady('a');
    expect(await settled(ready)).toBe('pending');
    release(0);
    expect(await settled(ready)).toBe('ready');
    await opening;
  });

  it('is already resolved when nothing is binding (unknown, remote or settled sessions)', async () => {
    const { manager, release } = heldStart();
    expect(await settled(manager.callbackReady('never-opened'))).toBe('ready');
    const opening = manager.open('a');
    release(0);
    await opening;
    expect(await settled(manager.callbackReady('a'))).toBe('ready');
  });

  it('waits again when a flap restarts the listener (failed, then connected)', async () => {
    const { manager, release, order } = heldStart();
    const opening = manager.open('a');
    release(0);
    await opening;

    providers.get('a')!.go('failed'); // the listener stops
    providers.get('a')!.go('connected'); // and starts again
    expect(order.filter((e) => e.startsWith('status:')).slice(-2)).toEqual([
      'status:a:failed',
      'status:a:connected',
    ]);
    expect(order.filter((e) => e === 'start:a')).toHaveLength(2);
    const ready = manager.callbackReady('a');
    expect(await settled(ready)).toBe('pending');
    release(1);
    expect(await settled(ready)).toBe('ready');
  });

  it('is per project: a pending bind of one session does not hold another back', async () => {
    const { manager, release } = heldStart();
    const openA = manager.open('a');
    release(0);
    await openA;
    const openB = manager.open('b'); // b is still binding
    expect(await settled(manager.callbackReady('a'))).toBe('ready');
    expect(await settled(manager.callbackReady('b'))).toBe('pending');
    release(1);
    await openB;
  });
});
