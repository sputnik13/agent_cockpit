import {
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALLBACK_MAX_FRAME_BYTES,
  encodeCallbackFrame,
  okReply,
  type CallbackReply,
} from '@shared/callback/protocol';
import { CallbackListener, type CallbackListenerOptions } from './listener';
import { callbackRequest, connectTo, openRequest, readReply } from './testClient';

/**
 * Runs in a child process: connects to the socket one connection at a time, as fast
 * as it can, and counts every connect that fails by error code. Each probe sends a
 * request and waits for the listener to answer or close before the next one, which
 * keeps the probe from outrunning the listener's accept queue (a full queue makes
 * connect() fail with ECONNREFUSED on macOS, which is not the path being unanswered).
 * Post-connect resets are not failures either: a connection a retiring listener drops
 * after accepting it is not a gap. Prints `ready` after the first successful connect
 * and a JSON report once told to stop (any stdin input).
 */
const PROBE_SCRIPT = `
const net = require('node:net');
const path = process.argv[1];
const request = Buffer.from([0, 0, 0, 2, 0x7b, 0x7d]); // a frame holding {}
let attempts = 0;
const failures = {};
let running = true;
let announced = false;
process.stdin.on('data', () => { running = false; });
function probe() {
  if (!running) {
    process.stdout.write(JSON.stringify({ attempts, failures }) + '\\n');
    process.exit(0);
  }
  attempts += 1;
  let connected = false;
  let done = false;
  const next = () => {
    if (done) return;
    done = true;
    socket.destroy();
    setImmediate(probe);
  };
  const socket = net.connect(path);
  socket.setTimeout(1000, next);
  socket.on('connect', () => {
    connected = true;
    if (!announced) { announced = true; process.stdout.write('ready\\n'); }
    socket.resume(); // drain the reply so the connection can end
    socket.write(request);
  });
  socket.on('error', (err) => {
    if (!connected) failures[err.code] = (failures[err.code] || 0) + 1;
    next();
  });
  socket.on('close', next);
}
probe();
`;

let base: string;
let socketPath: string;
const started: CallbackListener[] = [];

beforeEach(() => {
  // A literal /tmp keeps the socket path short; the unique directory isolates this file's runs.
  base = mkdtempSync('/tmp/accb-l-');
  socketPath = join(base, 'a.sock');
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((l) => l.close()));
  rmSync(base, { recursive: true, force: true });
});

function tagged(by: string): CallbackListenerOptions['handle'] {
  return (request) => okReply((request as { id?: number }).id ?? 0, { by });
}

async function start(over: Partial<CallbackListenerOptions> = {}): Promise<CallbackListener> {
  const listener = await CallbackListener.start({ socketPath, handle: tagged('default'), ...over });
  started.push(listener);
  return listener;
}

const header = (length: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
};

describe('CallbackListener binding (scenario 5)', () => {
  it('binds an explicit 0600 socket and leaves no temporary name behind', async () => {
    await start();
    const st = statSync(socketPath);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    expect(readdirSync(base)).toEqual(['a.sock']);
  });

  it('rejects cleanly, leaving nothing behind, when the directory is missing', async () => {
    const failure = await CallbackListener.start({
      socketPath: join(base, 'missing', 'a.sock'),
      handle: tagged('x'),
    }).catch((err: NodeJS.ErrnoException) => err);
    expect(failure).toBeInstanceOf(Error);
    // macOS reports EACCES for a bind into a missing directory, Linux ENOENT.
    expect(['ENOENT', 'EACCES']).toContain((failure as NodeJS.ErrnoException).code);
    expect(readdirSync(base)).toEqual([]);
  });

  it('unlinks the socket synchronously when close() is called', async () => {
    const listener = await start();
    const closing = listener.close();
    expect(() => statSync(socketPath)).toThrow(); // gone before close() resolves
    await closing;
  });

  it('removes the socket file on close, refuses new connections, and close is idempotent', async () => {
    const listener = await start();
    const idle = await connectTo(socketPath);
    await listener.close();
    await listener.close();
    expect((await readReply(idle, 1_000)).closed).toBe(true); // open connections are dropped
    expect(() => statSync(socketPath)).toThrow();
    await expect(connectTo(socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('CallbackListener requests', () => {
  it('answers one request with the handler reply and closes the connection', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle });
    const socket = await connectTo(socketPath);
    socket.write(encodeCallbackFrame(openRequest('/a/b.md', { id: 9 })));
    const { reply, closed } = await readReply(socket);
    expect(reply).toEqual({ id: 9, ok: true, result: { by: 'h' } });
    expect(closed).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(openRequest('/a/b.md', { id: 9 }));
  });

  it('serves a client that half-closes right after writing its request', async () => {
    await start();
    const socket = await connectTo(socketPath);
    socket.end(encodeCallbackFrame(openRequest('/a/b.md', { id: 6 }))); // write, then FIN
    const { reply, closed } = await readReply(socket);
    expect(reply).toMatchObject({ id: 6, ok: true });
    expect(closed).toBe(true);
  });

  it('turns a reply too large for a frame into an internal error instead of throwing', async () => {
    await start({ handle: () => okReply(1, { blob: 'x'.repeat(CALLBACK_MAX_FRAME_BYTES) }) });
    expect(await callbackRequest(socketPath, openRequest('/x'))).toEqual({
      id: 0,
      ok: false,
      error: { code: 'internal', message: 'internal error' },
    });
  });

  it('handles only the first request of a connection', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle });
    const socket = await connectTo(socketPath);
    const first = encodeCallbackFrame(openRequest('/one', { id: 1 }));
    const second = encodeCallbackFrame(openRequest('/two', { id: 2 }));
    socket.write(Buffer.concat([first, second]));
    const { reply } = await readReply(socket);
    expect(reply).toMatchObject({ id: 1 });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('reassembles a request that arrives in pieces', async () => {
    await start();
    const socket = await connectTo(socketPath);
    const frame = encodeCallbackFrame(openRequest('/a/b.md', { id: 4 }));
    socket.write(frame.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 20));
    socket.write(frame.subarray(2, 9));
    await new Promise((r) => setTimeout(r, 20));
    socket.write(frame.subarray(9));
    expect((await readReply(socket)).reply).toMatchObject({ id: 4, ok: true });
  });

  it('turns a handler that throws into an internal error', async () => {
    await start({
      handle: () => {
        throw new Error('boom');
      },
    });
    expect(await callbackRequest(socketPath, openRequest('/x'))).toEqual({
      id: 0,
      ok: false,
      error: { code: 'internal', message: 'internal error' },
    });
  });

  it('serves concurrent clients independently', async () => {
    await start();
    const replies = await Promise.all(
      [1, 2, 3, 4, 5].map((id) => callbackRequest(socketPath, openRequest('/x', { id }))),
    );
    expect(replies.map((r) => (r as CallbackReply).id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('CallbackListener frame limits (scenarios 3 and 15)', () => {
  it('rejects an oversize header with bad-request, before reading any body', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle });
    const socket = await connectTo(socketPath);
    socket.write(header(CALLBACK_MAX_FRAME_BYTES + 1)); // no body follows
    const { reply, closed } = await readReply(socket);
    expect(reply).toEqual({
      id: 0,
      ok: false,
      error: {
        code: 'bad-request',
        message: `frame too large: ${CALLBACK_MAX_FRAME_BYTES + 1} bytes`,
      },
    });
    expect(closed).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON with bad-request', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle });
    const socket = await connectTo(socketPath);
    const body = Buffer.from('{oops');
    socket.write(Buffer.concat([header(body.length), body]));
    expect(((await readReply(socket)).reply as CallbackReply).ok).toBe(false);
    expect(handle).not.toHaveBeenCalled();
  });

  it('gives a truncated request no reply and closes the connection', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle });
    const socket = await connectTo(socketPath);
    const frame = encodeCallbackFrame(openRequest('/a'));
    socket.end(frame.subarray(0, frame.length - 3)); // peer finishes mid-frame
    const { reply, closed } = await readReply(socket);
    expect(reply).toBeNull();
    expect(closed).toBe(true);
    expect(handle).not.toHaveBeenCalled();
  });
});

describe('CallbackListener deadlines and connection cap (scenario 15)', () => {
  it('times out a connection that sends nothing', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle, readDeadlineMs: 80 });
    const socket = await connectTo(socketPath);
    const began = Date.now();
    const { reply, closed } = await readReply(socket, 2_000);
    expect(reply).toEqual({
      id: 0,
      ok: false,
      error: { code: 'timeout', message: 'request not received in time' },
    });
    expect(closed).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(60);
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(handle).not.toHaveBeenCalled();
  });

  it('cuts a slowloris client at the absolute deadline, however steadily it drips', async () => {
    const handle = vi.fn(tagged('h'));
    await start({ handle, readDeadlineMs: 150 });
    const socket = await connectTo(socketPath);
    const frame = encodeCallbackFrame(openRequest('/a/b.md'));
    const drip = setInterval(() => socket.write(frame.subarray(0, 1)), 30); // never completes a frame
    const began = Date.now();
    const { reply } = await readReply(socket, 2_000);
    clearInterval(drip);
    expect((reply as CallbackReply).ok).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(handle).not.toHaveBeenCalled();
  });

  it('serves a request that completes before the deadline', async () => {
    await start({ readDeadlineMs: 400 });
    expect(await callbackRequest(socketPath, openRequest('/x', { id: 3 }))).toMatchObject({
      id: 3,
      ok: true,
    });
  });

  it('drops connections beyond maxConnections and serves again once one frees up', async () => {
    const listener = await start({ maxConnections: 2, readDeadlineMs: 5_000 });
    const idle1 = await connectTo(socketPath);
    const idle2 = await connectTo(socketPath);
    await vi.waitFor(() => expect(listener.connectionCount).toBe(2));

    const dropped = await connectTo(socketPath);
    dropped.write(encodeCallbackFrame(openRequest('/x')));
    const { reply, closed } = await readReply(dropped, 2_000);
    expect(reply).toBeNull();
    expect(closed).toBe(true);

    idle1.destroy();
    await vi.waitFor(async () => {
      expect(await callbackRequest(socketPath, openRequest('/x', { id: 8 }), 500)).toMatchObject({
        id: 8,
        ok: true,
      });
    });
    idle2.destroy();
  });

  it('defaults to a cap of 32 connections', async () => {
    const listener = await start({ readDeadlineMs: 5_000 });
    const idle = await Promise.all(Array.from({ length: 32 }, () => connectTo(socketPath)));
    await vi.waitFor(() => expect(listener.connectionCount).toBe(32));
    const extra = await connectTo(socketPath);
    extra.write(encodeCallbackFrame(openRequest('/x')));
    expect((await readReply(extra, 2_000)).reply).toBeNull();
    for (const s of idle) s.destroy();
  });
});

/** A stale socket file, as a crashed run leaves behind: bound, renamed into place, listener gone. */
async function leaveStaleSocket(path: string): Promise<void> {
  const tmp = `${path}.stale`;
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(tmp, resolve));
  renameSync(tmp, path);
  await new Promise<void>((resolve) => server.close(() => resolve())); // libuv unlinks only the old name
}

describe('CallbackListener newest-wins takeover (scenario 7, Node side)', () => {
  it('lets the newest listener take the path; the stale predecessor is unreachable', async () => {
    const a = await start({ handle: tagged('A') });
    const inodeA = statSync(socketPath).ino;
    const b = await start({ handle: tagged('B') });
    const inodeB = statSync(socketPath).ino;
    expect(inodeB).not.toBe(inodeA);
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({
      result: { by: 'B' },
    });
    expect(a.connectionCount).toBe(0);
    expect(b.socketPath).toBe(socketPath);
  });

  it('never leaves the path unanswered during takeovers, probed continuously from other processes', async () => {
    // The probes are separate processes on purpose: inside the process that performs
    // the takeover, even a bare unlink-then-bind (a window of microseconds with no
    // event-loop turn in it) would be invisible. They spin connect() the whole time and
    // record every connect that fails (ENOENT when the path is missing, ECONNREFUSED
    // when it is bound but not yet listening). Checked against both a synchronous
    // unlink-then-bind and a close-first takeover: each fails this test massively.
    //
    // The loop yields to the event loop after each takeover. Without that the process
    // doing the takeovers never serves the probes (each waits for its reply), they stop
    // issuing connects, and no gap could be seen however large.
    //
    // Predecessors stay open during the probing and are retired afterwards: this test
    // is about the bind-and-rename step. Closing the old listener while a connect() is
    // in flight against it is a separate, benign race (a lookup that resolved just
    // before the rename can reach the old socket after it closed).
    await start({ handle: tagged('t0') });
    const probes = Array.from({ length: 4 }, () => {
      const child = spawn(process.execPath, ['-e', PROBE_SCRIPT, socketPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const probe = {
        child,
        output: '',
        exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
      };
      child.stdout.on('data', (chunk) => (probe.output += chunk));
      return probe;
    });
    const takeovers = 500;
    try {
      await vi.waitFor(
        () => expect(probes.every((probe) => probe.output.includes('ready\n'))).toBe(true),
        { timeout: 5_000 },
      );
      for (let i = 1; i <= takeovers; i += 1) {
        await start({ handle: tagged(`t${i}`) }); // temp bind + chmod + rename over the path
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      for (const probe of probes) probe.child.stdin.write('stop\n');
      await Promise.all(probes.map((probe) => probe.exited));
    }
    const reports = probes.map(
      (probe) =>
        JSON.parse(probe.output.trim().split('\n').pop()!) as {
          attempts: number;
          failures: Record<string, number>;
        },
    );
    expect(reports.reduce((sum, r) => sum + r.attempts, 0)).toBeGreaterThan(200); // really probing throughout
    expect(reports.map((r) => r.failures)).toEqual(reports.map(() => ({})));
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({
      result: { by: `t${takeovers}` },
    });
  });

  it('closing a stale predecessor never deletes the newer socket (inode-checked unlink)', async () => {
    const a = await start({ handle: tagged('A') });
    const b = await start({ handle: tagged('B') });
    const inodeB = statSync(socketPath).ino;
    await a.close();
    expect(statSync(socketPath).ino).toBe(inodeB);
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({
      result: { by: 'B' },
    });
    await b.close();
    expect(() => statSync(socketPath)).toThrow();
  });

  it('closing in the other order is also clean', async () => {
    const a = await start({ handle: tagged('A') });
    const b = await start({ handle: tagged('B') });
    await b.close();
    expect(() => statSync(socketPath)).toThrow();
    await expect(a.close()).resolves.toBeUndefined(); // nothing of A's left to unlink
    expect(readdirSync(base)).toEqual([]);
  });

  it('never unlinks a path that is no longer its own socket', async () => {
    const a = await start();
    unlinkSync(socketPath);
    writeFileSync(socketPath, 'not a socket');
    await a.close();
    expect(statSync(socketPath).isFile()).toBe(true);

    // A fresh listener simply renames over whatever sits there.
    await start({ handle: tagged('C') });
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({
      result: { by: 'C' },
    });
  });

  it('replaces a stale socket file left by a crashed run', async () => {
    await leaveStaleSocket(socketPath);
    await expect(connectTo(socketPath)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await start({ handle: tagged('fresh') });
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({
      result: { by: 'fresh' },
    });
  });

  it('leaves exactly one live socket and no temp files after concurrent starts', async () => {
    await Promise.all([
      start({ handle: tagged('A') }),
      start({ handle: tagged('B') }),
      start({ handle: tagged('C') }),
    ]);
    expect(readdirSync(base)).toEqual(['a.sock']);
    expect(await callbackRequest(socketPath, openRequest('/x'))).toMatchObject({ ok: true });
    await Promise.all(started.splice(0).map((l) => l.close()));
    expect(readdirSync(base)).toEqual([]);
  });

  it('does not touch a neighbouring project socket in the same directory', async () => {
    const other = join(base, 'b.sock');
    const a = await start({ handle: tagged('A') });
    const b = await start({ socketPath: other, handle: tagged('B') });
    await a.close();
    expect(await callbackRequest(other, openRequest('/x'))).toMatchObject({ result: { by: 'B' } });
    await b.close();
  });
});
