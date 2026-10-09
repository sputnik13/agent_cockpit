import type { DuplexChannel } from './transportTypes';
import { MuxClient } from './muxClient';

const REATTACH_BACKOFF_MS = [500, 1_000, 2_000, 5_000];

export type MuxChannelOpener = () => Promise<DuplexChannel>;

/**
 * Owns one remote raw mux channel. A fresh channel always creates a fresh
 * MuxClient and increments the epoch, which lets a renderer re-seed from mux
 * state without treating a channel flap as a separate provider connection.
 */
export class RemoteMuxConnectionManager {
  private client: MuxClient | null = null;
  private opening: Promise<void> | null = null;
  /** Invalidates an opener that resolves after an explicit close/reopen. */
  private generation = 0;
  private closed = false;
  private epoch = 0;
  private reattachAttempt = 0;
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  private stolen = false;
  readonly onAttached = new Set<(epoch: number) => void>();
  readonly onStolen = new Set<(sessionId: string, byKind?: 'cockpit' | 'tty') => void>();
  onReconnecting?: () => void;
  onReattached?: () => void;
  onReattachExhausted?: () => void;

  constructor(
    private readonly openChannel: MuxChannelOpener,
    private readonly projectId = '',
  ) {}

  async open(): Promise<void> {
    if (this.client || this.opening) return this.opening ?? Promise.resolve();
    this.closed = false;
    this.stolen = false;
    return this.ensureOpen();
  }

  current(): MuxClient {
    if (!this.client) throw new Error('mux channel is not open');
    return this.client;
  }

  close(): void {
    this.generation += 1;
    this.closed = true;
    if (this.reattachTimer) clearTimeout(this.reattachTimer);
    this.reattachTimer = null;
    this.client?.close();
    this.client = null;
    // A launch attempt can be waiting on a remote bridge while its caller
    // deliberately resets the channel for a lifecycle mutation. It must not
    // keep the next open() pinned to the old promise.
    this.opening = null;
  }

  private ensureOpen(): Promise<void> {
    if (this.opening) return this.opening;
    const opening = this.attach(this.generation);
    this.opening = opening;
    const clearOpening = (): void => {
      // A stale opener is allowed to finish, but never clears a newer open.
      if (this.opening === opening) this.opening = null;
    };
    // Observe both outcomes without manufacturing an unhandled rejection for
    // a reconnect that its scheduler intentionally retries.
    void opening.then(clearOpening, clearOpening);
    return opening;
  }

  private async attach(generation: number): Promise<void> {
    const channel = await this.openChannel();
    if (this.closed || generation !== this.generation) {
      channel.stdin.end();
      return;
    }
    const wasReattaching = this.reattachAttempt > 0;
    const client = new MuxClient(channel, this.projectId);
    this.client = client;
    client.onClose(() => {
      if (this.client === client) this.client = null;
      if (!this.closed && !this.stolen) this.scheduleReattach();
    });
    client.onEvent((event) => {
      if (event.event !== 'session.stolen') return;
      this.stolen = true;
      if (this.reattachTimer) clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
      for (const handler of this.onStolen) handler(event.session_id, event.by_kind);
    });
    client.open();
    this.epoch += 1;
    if (wasReattaching) {
      // Each successful channel is a new stable baseline. Retaining the
      // previous failure count would make independent future disconnects
      // consume an ever-smaller portion of the finite reconnect budget.
      this.reattachAttempt = 0;
      this.onReattached?.();
    }
    for (const handler of this.onAttached) handler(this.epoch);
  }

  private scheduleReattach(): void {
    if (this.reattachTimer) return;
    if (this.reattachAttempt >= REATTACH_BACKOFF_MS.length) {
      this.onReattachExhausted?.();
      return;
    }
    this.onReconnecting?.();
    const delay = REATTACH_BACKOFF_MS[this.reattachAttempt++]!;
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      this.ensureOpen().catch(() => this.scheduleReattach());
    }, delay);
    this.reattachTimer.unref?.();
  }
}
