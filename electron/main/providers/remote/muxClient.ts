import { decode, encode } from '@msgpack/msgpack';
import type { DuplexChannel } from './transportTypes';

const MAX_FRAME_BYTES = 16 << 20;

type Response = { id: number; data?: Uint8Array; error?: string };
export type MuxEvent = { event: 'session.stolen'; session_id: string; by_kind?: 'cockpit' | 'tty' };

export class MuxClientError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MuxClientError';
  }
}

/**
 * The MessagePack request client shared by a local socket adapter and the remote
 * `cockpit-mux attach` exec bridge. It deliberately has no SSH knowledge: both
 * transports supply the same length-prefixed byte stream.
 */
export class MuxClient {
  private buffered = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly closeHandlers = new Set<(error: Error) => void>();
  private readonly eventHandlers = new Set<(event: MuxEvent) => void>();

  constructor(
    private readonly channel: DuplexChannel,
    private readonly projectId = '',
  ) {
    channel.stdout.on('data', (chunk: Uint8Array) => this.ingest(Buffer.from(chunk)));
    channel.stdout.once('end', () => this.fail(new MuxClientError('mux channel ended')));
    channel.stdout.once('error', (cause) =>
      this.fail(new MuxClientError('mux channel failed', cause)),
    );
  }

  /** Send the negotiated protocol version before issuing any request. */
  open(): void {
    this.writeFrame({ protocol: 1 });
  }

  request<T>(method: string, data: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new MuxClientError('mux channel is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      try {
        this.writeFrame({
          id,
          method,
          ...(this.projectId ? { project_id: this.projectId } : {}),
          data: encode(data),
        });
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new MuxClientError('write mux request', cause));
      }
    });
  }

  onClose(handler: (error: Error) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onEvent(handler: (event: MuxEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  close(): void {
    this.fail(new MuxClientError('mux client closed'));
    this.channel.stdin.end();
  }

  private writeFrame(value: unknown): void {
    const payload = encode(value);
    if (payload.byteLength > MAX_FRAME_BYTES) throw new MuxClientError('mux frame exceeds 16 MiB');
    const frame = Buffer.allocUnsafe(4 + payload.byteLength);
    frame.writeUInt32BE(payload.byteLength, 0);
    Buffer.from(payload).copy(frame, 4);
    this.channel.stdin.write(frame);
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.byteLength >= 4) {
      const size = this.buffered.readUInt32BE(0);
      if (size > MAX_FRAME_BYTES) {
        this.fail(new MuxClientError('mux frame exceeds 16 MiB'));
        return;
      }
      if (this.buffered.byteLength < 4 + size) return;
      const payload = this.buffered.subarray(4, 4 + size);
      this.buffered = this.buffered.subarray(4 + size);
      let frame: Response | MuxEvent;
      try {
        frame = decode(payload) as Response | MuxEvent;
      } catch (cause) {
        this.fail(new MuxClientError('decode mux response', cause));
        return;
      }
      if ('event' in frame) {
        for (const handler of this.eventHandlers) handler(frame);
        continue;
      }
      const response = frame;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(new MuxClientError(response.error));
      } else {
        try {
          pending.resolve(response.data == null ? undefined : decode(response.data));
        } catch (cause) {
          pending.reject(new MuxClientError('decode mux response payload', cause));
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const handler of this.closeHandlers) handler(error);
  }
}
