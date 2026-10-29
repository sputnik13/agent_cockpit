/**
 * The unix-socket server behind one project's callback endpoint: bind with
 * newest-wins takeover, accept bounded one-request connections, close with an
 * inode-checked unlink. It knows nothing about operations; every decoded request
 * goes to `handle`, which is the broker's decision function.
 *
 * Takeover (requirement 5): the new owner binds a uniquely named temporary path
 * in the same directory, `chmod`s it 0600 (Node creates sockets 0755 under the
 * umask; the 0700 directory is the real barrier), and `rename`s it over the real
 * path. rename(2) is atomic, so the path is never briefly absent, and the NEWEST
 * listener always holds it: a stale predecessor stays bound to an inode nothing
 * can reach. A fixed temp name would let an old listener's close unlink it.
 *
 * Every owner unlinks on close only if the path's inode is still its own. libuv
 * unlinks the name it BOUND (the temp name, already renamed away), never the
 * final path, so this explicit unlink is the only thing that removes the socket
 * file. Check-then-unlink has a tiny residual window, which is accepted.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
import {
  CALLBACK_DEADLINE_MS,
  CALLBACK_MAX_CONNECTIONS,
  createCallbackFrameDecoder,
  encodeCallbackFrame,
  errorReply,
  type CallbackReply,
} from '@shared/callback/protocol';
import { FrameError } from '@shared/wire/frame';

export interface CallbackListenerOptions {
  /** Final socket path. Its directory must already exist and be verified. */
  socketPath: string;
  /** Answers the one decoded request of a connection. A throw becomes `internal`. */
  handle: (request: unknown) => CallbackReply;
  /** Concurrent connections served; further ones are dropped. Default 32. */
  maxConnections?: number;
  /** Absolute per-connection deadline, from accept. Default 5 s. */
  readDeadlineMs?: number;
  /** A server-level error after bind (for example a failed accept). */
  onError?: (error: Error) => void;
}

export class CallbackListener {
  private readonly sockets = new Set<Socket>();
  private closing: Promise<void> | null = null;

  private constructor(
    private readonly server: Server,
    readonly socketPath: string,
    private readonly identity: { dev: bigint; ino: bigint },
    private readonly handle: CallbackListenerOptions['handle'],
    private readonly readDeadlineMs: number,
  ) {}

  /** Bind, chmod 0600 and rename into place. Rejects (leaving nothing behind) on any failure. */
  static async start(opts: CallbackListenerOptions): Promise<CallbackListener> {
    const tempPath = join(
      dirname(opts.socketPath),
      `${basename(opts.socketPath, '.sock')}.${randomBytes(3).toString('hex')}.tmp`,
    );
    const server = createServer();
    server.maxConnections = opts.maxConnections ?? CALLBACK_MAX_CONNECTIONS;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(tempPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    let listener: CallbackListener;
    try {
      chmodSync(tempPath, 0o600);
      const st = lstatSync(tempPath, { bigint: true });
      if (!st.isSocket()) throw new Error(`${tempPath} is not a socket`);
      renameSync(tempPath, opts.socketPath);
      listener = new CallbackListener(
        server,
        opts.socketPath,
        { dev: st.dev, ino: st.ino },
        opts.handle,
        opts.readDeadlineMs ?? CALLBACK_DEADLINE_MS,
      );
    } catch (err) {
      server.close(); // libuv unlinks the temp name it bound
      throw err;
    }
    server.on('error', (err) => opts.onError?.(err));
    server.on('connection', (socket) => listener.onConnection(socket));
    return listener;
  }

  /** Connections currently open (test and diagnostics seam). */
  get connectionCount(): number {
    return this.sockets.size;
  }

  /**
   * Unlink the socket if it is still ours, stop accepting, and drop open
   * connections. The unlink comes first and is synchronous, so the path is gone
   * the moment `close()` is called even when the process exits (the app does not
   * await its teardown at quit) before the rest completes.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.unlinkIfOurs();
      for (const socket of this.sockets) socket.destroy();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    })();
    return this.closing;
  }

  private unlinkIfOurs(): void {
    try {
      const st = lstatSync(this.socketPath, { bigint: true });
      if (st.isSocket() && st.dev === this.identity.dev && st.ino === this.identity.ino) {
        unlinkSync(this.socketPath);
      }
    } catch {
      // Already gone, or replaced by a newer owner: nothing of ours to remove.
    }
  }

  /**
   * One request per connection: decode the first complete frame, answer it, and
   * close. An absolute deadline from accept bounds a silent or slowloris peer
   * (and a peer that never closes after its reply).
   */
  private onConnection(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = createCallbackFrameDecoder();
    let answered = false;
    const answer = (reply: CallbackReply, destroyAfter = false): void => {
      if (answered) return;
      answered = true;
      let frame: Uint8Array;
      try {
        frame = encodeCallbackFrame(reply);
      } catch {
        // A reply over the frame cap must not become an uncaught exception in main.
        frame = encodeCallbackFrame(errorReply(0, 'internal', 'internal error'));
      }
      socket.end(frame, destroyAfter ? () => socket.destroy() : undefined);
    };
    const deadline = setTimeout(() => {
      if (answered) socket.destroy();
      else answer(errorReply(0, 'timeout', 'request not received in time'), true);
    }, this.readDeadlineMs);
    deadline.unref();
    socket.on('close', () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    socket.on('end', () => {
      // The peer finished without a complete request (a truncated frame): nobody to answer.
      if (!answered) {
        answered = true;
        socket.destroy();
      }
    });
    socket.on('data', (chunk) => {
      if (answered) return; // anything after the one request is ignored
      let requests: unknown[];
      try {
        requests = decoder.push(chunk);
      } catch (err) {
        answer(errorReply(0, 'bad-request', err instanceof FrameError ? err.message : 'bad frame'));
        return;
      }
      if (requests.length === 0) return;
      let reply: CallbackReply;
      try {
        reply = this.handle(requests[0]);
      } catch {
        reply = errorReply(0, 'internal', 'internal error');
      }
      answer(reply);
    });
  }
}
