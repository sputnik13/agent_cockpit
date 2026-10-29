/**
 * The remote reply path on main's side (scenario 13, TS side): a `callback` event
 * from a project's helper is answered with the SAME decision function as the local
 * listener (real CallbackBroker here), gated on THAT project's status, replying
 * `dispatched` before the path is classified asynchronously.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';
import type { ConnectionState } from '@shared/providers/types';
import { errorReply, okReply, type CallbackReply } from '@shared/callback/protocol';
import { logger } from '../logger';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { bridgeRemoteCallbacks, type RemoteCallbackClient } from './remoteBridge';
import { openRequest } from './testClient';

const worktree = (path: string): WorktreeRecord => ({
  path,
  branch: 'main',
  head: 'abc',
  locked: false,
  prunable: false,
  detached: false,
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A helper RPC client double: events in, callback.reply calls out. */
function fakeClient(): {
  client: RemoteCallbackClient;
  emit: (data: unknown) => void;
  replies: Array<{ connId: number; reply: CallbackReply }>;
  subscribers: () => number;
  failReplies: (error: Error) => void;
} {
  const handlers = new Set<(data: unknown) => void>();
  const replies: Array<{ connId: number; reply: CallbackReply }> = [];
  let failure: Error | null = null;
  return {
    client: {
      onEvent: (event, handler) => {
        if (event !== 'callback') return () => undefined;
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      callbackReply: async (connId, reply) => {
        replies.push({ connId, reply });
        if (failure) throw failure;
        return { delivered: true };
      },
    },
    emit: (data) => {
      for (const handler of [...handlers]) handler(data);
    },
    replies,
    subscribers: () => handlers.size,
    failReplies: (error) => {
      failure = error;
    },
  };
}

interface World {
  broker: CallbackBroker;
  opens: CallbackOpenEvent[];
  status: Map<string, ConnectionState>;
  statusReads: string[];
  listWorktrees: ReturnType<typeof vi.fn>;
}

function world(): World {
  const status = new Map<string, ConnectionState>([
    ['A', 'connected'],
    ['B', 'connected'],
  ]);
  const statusReads: string[] = [];
  const listWorktrees = vi.fn(async () => [worktree('/srv/repo')]);
  const provider = { kind: 'remote' as const, listWorktrees };
  const broker = new CallbackBroker({
    statusOf: (id) => {
      statusReads.push(id);
      return status.has(id) ? { state: status.get(id)!, since: '' } : undefined;
    },
    providerOf: () => provider,
    projectRootOf: () => '/srv/repo',
    userDataDir: () => '/unused',
    realpath: async (p) => p,
  });
  const opens: CallbackOpenEvent[] = [];
  broker.onOpen((e) => opens.push(e));
  return { broker, opens, status, statusReads, listWorktrees };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('remote callback bridge', () => {
  it("answers a forwarded open with dispatched under the helper's connection id, then emits the classified selection", async () => {
    const w = world();
    const c = fakeClient();
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (request) => w.broker.handle('A', request),
    });
    c.emit({ connId: 41, request: openRequest('/srv/repo/src/a.ts', { id: 9 }) });

    expect(c.replies).toEqual([{ connId: 41, reply: okReply(9, { status: 'dispatched' }) }]);
    await vi.waitFor(() => expect(w.opens).toHaveLength(1));
    expect(w.opens[0]).toEqual({
      projectId: 'A',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/srv/repo' },
    });
  });

  it('replies dispatched BEFORE classification, whose provider RPCs may queue behind slow helper methods', async () => {
    const w = world();
    let release: (w: WorktreeRecord[]) => void = () => undefined;
    w.listWorktrees.mockImplementation(
      () => new Promise<WorktreeRecord[]>((resolve) => (release = resolve)),
    );
    const c = fakeClient();
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    c.emit({ connId: 1, request: openRequest('/srv/repo/a.ts') });
    await flush();
    expect(c.replies).toHaveLength(1); // answered already
    expect(c.replies[0]!.reply).toMatchObject({ ok: true, result: { status: 'dispatched' } });
    expect(w.opens).toEqual([]); // not classified yet
    release([worktree('/srv/repo')]);
    await vi.waitFor(() => expect(w.opens).toHaveLength(1));
  });

  it('addresses the project that owns the helper stream, never an ambient one', async () => {
    const w = world();
    const a = fakeClient();
    const b = fakeClient();
    bridgeRemoteCallbacks({
      client: a.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    bridgeRemoteCallbacks({
      client: b.client,
      projectId: 'B',
      handle: (r) => w.broker.handle('B', r),
    });

    // B is disconnected; A is connected. A request on A's stream must succeed and a
    // request on B's stream must be refused — whatever the other project's state.
    w.status.set('B', 'disconnected');
    w.statusReads.length = 0;
    a.emit({ connId: 1, request: openRequest('/srv/repo/a.ts') });
    expect(w.statusReads).toEqual(['A']);
    expect(a.replies[0]!.reply).toMatchObject({ ok: true });

    w.statusReads.length = 0;
    b.emit({ connId: 1, request: openRequest('/srv/repo/b.ts') });
    expect(w.statusReads).toEqual(['B']);
    expect(b.replies[0]!.reply).toMatchObject({
      ok: false,
      error: { code: 'not-connected' },
    });
    await flush();
    expect(w.opens.map((e) => e.projectId)).toEqual(['A']); // nothing opened for B
  });

  it('refuses while the project is not connected: not-connected, no event', async () => {
    const w = world();
    w.status.set('A', 'connecting');
    const c = fakeClient();
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    c.emit({ connId: 3, request: openRequest('/srv/repo/a.ts', { id: 5 }) });
    expect(c.replies).toEqual([
      { connId: 3, reply: errorReply(5, 'not-connected', 'project is not connected') },
    ]);
    await flush();
    expect(w.opens).toEqual([]);
  });

  it('shares the local decision function: bounds, allowlist and the burst limit apply to remote requests', async () => {
    const w = world();
    const c = fakeClient();
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    c.emit({ connId: 1, request: { ...openRequest('/srv/repo/a.ts'), op: 'delete' } });
    c.emit({ connId: 2, request: openRequest('relative/path.ts') });
    expect(c.replies[0]!.reply).toMatchObject({ error: { code: 'unsupported-op' } });
    expect(c.replies[1]!.reply).toMatchObject({ error: { code: 'bad-request' } });
    // The limiter is per project and burst-limited (10): the 11th rapid open is refused.
    for (let i = 0; i < 10; i += 1) {
      c.emit({ connId: 10 + i, request: openRequest('/srv/repo/a.ts', { id: 20 + i }) });
    }
    const last = c.replies[c.replies.length - 1]!;
    expect(last.reply).toMatchObject({ error: { code: 'rate-limited' } });
  });

  it('does not answer an event without a usable connection id', () => {
    const w = world();
    const c = fakeClient();
    const handle = vi.fn((r: unknown) => w.broker.handle('A', r));
    bridgeRemoteCallbacks({ client: c.client, projectId: 'A', handle });
    for (const data of [
      null,
      'x',
      {},
      { request: openRequest('/srv/repo/a.ts') },
      { connId: 0, request: {} },
      { connId: -3, request: {} },
      { connId: 1.5, request: {} },
      { connId: '7', request: {} },
    ]) {
      c.emit(data);
    }
    expect(handle).not.toHaveBeenCalled();
    expect(c.replies).toEqual([]);
  });

  it('turns a throwing decision function into an internal error reply', () => {
    const c = fakeClient();
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: () => {
        throw new Error('boom');
      },
    });
    c.emit({ connId: 2, request: {} });
    expect(c.replies).toEqual([{ connId: 2, reply: errorReply(0, 'internal', 'internal error') }]);
  });

  it('logs and survives a callback.reply that cannot be delivered', async () => {
    const w = world();
    const c = fakeClient();
    c.failReplies(new Error('helper stream is closed'));
    const warn = vi.spyOn(logger, 'warn');
    bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    c.emit({ connId: 1, request: openRequest('/srv/repo/a.ts') });
    await flush();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('callback reply not delivered project=A connId=1'),
      'callback',
    );
  });

  it('stops answering once stopped, and stopping twice is harmless', () => {
    const w = world();
    const c = fakeClient();
    const stop = bridgeRemoteCallbacks({
      client: c.client,
      projectId: 'A',
      handle: (r) => w.broker.handle('A', r),
    });
    expect(c.subscribers()).toBe(1);
    stop();
    stop();
    expect(c.subscribers()).toBe(0);
    c.emit({ connId: 1, request: openRequest('/srv/repo/a.ts') });
    expect(c.replies).toEqual([]);
  });
});
