/**
 * HelperRpcClient changes for the terminal callback socket (scenario 13, TS side):
 * the protocol bump, the handshake that names the project and returns the
 * helper's callbackSock/cliPath, the helper->main event registry (`callback`
 * events; `watch` events keep working), and the `callback.reply` RPC.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { errorReply, okReply } from '@shared/callback/protocol';
import {
  FrameDecoder,
  HelperRpcClient,
  HelperRpcError,
  PROTOCOL_VERSION,
  encodeFrame,
  type RpcStream,
} from './rpcClient';
import { deriveWatchSpec } from '@shared/watch/policy';

interface SeenRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

/** A fake helper: records requests, answers each through `respond`, can push events. */
function fakeHelper(
  respond: (req: SeenRequest) => { result?: unknown; error?: string } = () => ({ result: {} }),
): {
  stream: RpcStream;
  seen: SeenRequest[];
  pushEvent: (event: string, data: unknown) => void;
  end: () => void;
} {
  const toClient = new PassThrough();
  const toServer = new PassThrough();
  const decoder = new FrameDecoder();
  const seen: SeenRequest[] = [];
  toServer.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as SeenRequest;
      seen.push(req);
      const reply = respond(req);
      toClient.write(
        encodeFrame({ id: req.id, result: reply.result ?? null, error: reply.error ?? null }),
      );
    }
  });
  return {
    stream: { stdin: toServer, stdout: toClient },
    seen,
    pushEvent: (event, data) => toClient.write(encodeFrame({ event, data })),
    end: () => toClient.end(),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('protocol version', () => {
  it('is 2: the handshake gained the project id and the callback fields', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe('handshake', () => {
  it('sends only the protocol version without a project id (no listener is asked for)', async () => {
    const helper = fakeHelper(() => ({ result: { protocolVersion: 2, pid: 7 } }));
    const result = await new HelperRpcClient(helper.stream).handshake();
    expect(helper.seen[0]).toMatchObject({ method: 'handshake', params: { protocolVersion: 2 } });
    expect(Object.keys(helper.seen[0]!.params)).toEqual(['protocolVersion']);
    expect(result).toEqual({ protocolVersion: 2, pid: 7 });
  });

  it('names the project so the helper binds its socket, and returns what the helper reports', async () => {
    const helper = fakeHelper(() => ({
      result: {
        protocolVersion: 2,
        pid: 7,
        callbackSock: '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock',
        cliPath: '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit',
      },
    }));
    const result = await new HelperRpcClient(helper.stream).handshake('proj-1');
    expect(helper.seen[0]!.params).toEqual({ protocolVersion: 2, projectId: 'proj-1' });
    expect(result.callbackSock).toBe(
      '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock',
    );
    expect(result.cliPath).toBe('/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit');
  });

  it('leaves the callback fields undefined when the helper reports none', async () => {
    const helper = fakeHelper(() => ({ result: { protocolVersion: 2, pid: 7 } }));
    const result = await new HelperRpcClient(helper.stream).handshake('proj-1');
    expect(result.callbackSock).toBeUndefined();
    expect(result.cliPath).toBeUndefined();
  });
});

describe('callback.reply', () => {
  it("sends main's reply under the helper-chosen connection id and resolves delivered", async () => {
    const helper = fakeHelper(() => ({ result: { delivered: true } }));
    const reply = okReply(4, { status: 'dispatched' });
    await expect(new HelperRpcClient(helper.stream).callbackReply(9, reply)).resolves.toEqual({
      delivered: true,
    });
    expect(helper.seen[0]).toMatchObject({
      method: 'callback.reply',
      params: { connId: 9, reply: { id: 4, ok: true, result: { status: 'dispatched' } } },
    });
  });

  it('resolves delivered:false when nobody was waiting (a late reply is not an error)', async () => {
    const helper = fakeHelper(() => ({ result: { delivered: false } }));
    await expect(
      new HelperRpcClient(helper.stream).callbackReply(9, errorReply(4, 'not-connected', 'x')),
    ).resolves.toEqual({ delivered: false });
  });

  it('rejects with a HelperRpcError when the helper refuses the call', async () => {
    const helper = fakeHelper(() => ({ error: 'callback.reply: connId is required' }));
    await expect(
      new HelperRpcClient(helper.stream).callbackReply(0, okReply(1, {})),
    ).rejects.toBeInstanceOf(HelperRpcError);
  });
});

describe('event registry', () => {
  it('delivers a named server-push event to its handlers', async () => {
    const helper = fakeHelper();
    const client = new HelperRpcClient(helper.stream);
    const got: unknown[] = [];
    client.onEvent('callback', (data) => got.push(data));
    helper.pushEvent('callback', { connId: 3, request: { op: 'open' } });
    await tick();
    expect(got).toEqual([{ connId: 3, request: { op: 'open' } }]);
  });

  it('supports several handlers per event and delivers only the named event', async () => {
    const helper = fakeHelper();
    const client = new HelperRpcClient(helper.stream);
    const a: unknown[] = [];
    const b: unknown[] = [];
    client.onEvent('callback', (d) => a.push(d));
    client.onEvent('callback', (d) => b.push(d));
    client.onEvent('other', () => {
      throw new Error('must not be called for a callback event');
    });
    helper.pushEvent('callback', { connId: 1 });
    await tick();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('stops delivering after unsubscribe (and unsubscribing twice is harmless)', async () => {
    const helper = fakeHelper();
    const client = new HelperRpcClient(helper.stream);
    const got: unknown[] = [];
    const off = client.onEvent('callback', (d) => got.push(d));
    helper.pushEvent('callback', { connId: 1 });
    await tick();
    off();
    off();
    helper.pushEvent('callback', { connId: 2 });
    await tick();
    expect(got).toEqual([{ connId: 1 }]);
  });

  it('drops an event nobody registered for, without disturbing the stream', async () => {
    const helper = fakeHelper(() => ({ result: { ok: true } }));
    const client = new HelperRpcClient(helper.stream);
    helper.pushEvent('callback', { connId: 1 }); // no handler yet
    helper.pushEvent('mystery', {});
    await tick();
    await expect(client.stat('/x')).resolves.toEqual({ ok: true });
  });

  it('a handler that throws neither breaks the stream nor starves the other handlers', async () => {
    const helper = fakeHelper(() => ({ result: { exists: true } }));
    const client = new HelperRpcClient(helper.stream);
    const got: unknown[] = [];
    client.onEvent('callback', () => {
      throw new Error('boom');
    });
    client.onEvent('callback', (d) => got.push(d));
    helper.pushEvent('callback', { connId: 1 });
    await tick();
    expect(got).toEqual([{ connId: 1 }]);
    await expect(client.stat('/x')).resolves.toMatchObject({ exists: true });
  });

  it('still routes watch events to their per-token handler, and also to the registry', async () => {
    const helper = fakeHelper(() => ({ result: { token: 't1' } }));
    const client = new HelperRpcClient(helper.stream);
    const byToken: unknown[] = [];
    const byRegistry: unknown[] = [];
    await client.watchSubscribe('/repo', 't1', deriveWatchSpec(), (d) => byToken.push(d));
    client.onEvent('watch', (d) => byRegistry.push(d));
    helper.pushEvent('watch', { token: 't1', paths: ['a.ts'] });
    helper.pushEvent('watch', { token: 'other', paths: ['b.ts'] });
    await tick();
    expect(byToken).toEqual([{ token: 't1', paths: ['a.ts'] }]);
    expect(byRegistry).toHaveLength(2);
  });

  it('keeps correlating responses by id around events', async () => {
    const helper = fakeHelper(() => ({ result: { size: 1 } }));
    const client = new HelperRpcClient(helper.stream);
    client.onEvent('callback', () => undefined);
    const pending = client.stat('/x');
    helper.pushEvent('callback', { connId: 1 });
    await expect(pending).resolves.toEqual({ size: 1 });
  });
});

describe('isClosed', () => {
  it('is false while the stream is live and true once it ends', async () => {
    const helper = fakeHelper();
    const client = new HelperRpcClient(helper.stream);
    expect(client.isClosed).toBe(false);
    helper.end();
    await tick();
    expect(client.isClosed).toBe(true);
  });
});
