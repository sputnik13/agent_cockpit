/**
 * Test-only client for a callback socket: what the `cockpit` CLI does, in
 * TypeScript (connect, write one request frame, read one reply frame). Imported
 * by this directory's tests; nothing in the app imports it.
 */
import { connect, type Socket } from 'node:net';
import {
  createCallbackFrameDecoder,
  encodeCallbackFrame,
  type CallbackRequest,
} from '@shared/callback/protocol';

export function connectTo(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    // A later write to a connection the server already closed must not crash the test.
    socket.on('error', () => undefined);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export interface ReadResult {
  /** The first decoded reply frame, or null when the connection ended without one. */
  reply: unknown;
  /** Whether the server closed the connection (always true unless `timeoutMs` elapsed first). */
  closed: boolean;
}

/** Read until the server closes the connection (or `timeoutMs` elapses), decoding the first frame. */
export function readReply(socket: Socket, timeoutMs = 3_000): Promise<ReadResult> {
  return new Promise((resolve) => {
    const decoder = createCallbackFrameDecoder();
    let reply: unknown = null;
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ reply, closed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('data', (chunk) => {
      try {
        const [first] = decoder.push(chunk);
        if (first !== undefined && reply === null) reply = first;
      } catch {
        /* a garbled reply is reported as no reply */
      }
    });
    socket.on('close', () => finish(true));
    socket.on('error', () => finish(true));
  });
}

/** Send one request and return the first reply (null if the server closed without one). */
export async function callbackRequest(
  socketPath: string,
  request: CallbackRequest | Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const socket = await connectTo(socketPath);
  socket.write(encodeCallbackFrame(request as CallbackRequest));
  const { reply } = await readReply(socket, timeoutMs);
  socket.destroy();
  return reply;
}

/** A valid `open` request. */
export function openRequest(
  path: string,
  extra: Partial<Pick<CallbackRequest, 'id' | 'pane'>> & { canonicalPath?: string } = {},
): CallbackRequest {
  const { canonicalPath, ...envelope } = extra;
  return {
    v: 1,
    id: 1,
    op: 'open',
    ...envelope,
    args: { path, ...(canonicalPath !== undefined ? { canonicalPath } : {}) },
  };
}
