import { PassThrough } from 'node:stream';
import { encode } from '@msgpack/msgpack';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteMuxConnectionManager } from './muxConnection';
import type { DuplexChannel } from './transportTypes';

function channel(): DuplexChannel {
  return { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
}

function frame(value: unknown): Buffer {
  const payload = encode(value);
  const result = Buffer.alloc(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(result, 4);
  return result;
}

afterEach(() => vi.useRealTimers());

describe('RemoteMuxConnectionManager', () => {
  it('increments epoch only after a fresh remote raw channel attaches', async () => {
    vi.useFakeTimers();
    const first = channel();
    const second = channel();
    const opener = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new RemoteMuxConnectionManager(opener);
    const epochs: number[] = [];
    manager.onAttached.add((epoch) => epochs.push(epoch));

    await manager.open();
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(500);

    expect(opener).toHaveBeenCalledTimes(2);
    expect(epochs).toEqual([1, 2]);
    manager.close();
  });

  it('reconnects only the project whose mux channel flapped', async () => {
    vi.useFakeTimers();
    const projectAFirst = channel();
    const projectASecond = channel();
    const projectBFirst = channel();
    const openA = vi.fn().mockResolvedValueOnce(projectAFirst).mockResolvedValueOnce(projectASecond);
    const openB = vi.fn().mockResolvedValueOnce(projectBFirst);
    const projectA = new RemoteMuxConnectionManager(openA, 'project-a');
    const projectB = new RemoteMuxConnectionManager(openB, 'project-b');
    const epochsA: number[] = [];
    const epochsB: number[] = [];
    projectA.onAttached.add((epoch) => epochsA.push(epoch));
    projectB.onAttached.add((epoch) => epochsB.push(epoch));

    await Promise.all([projectA.open(), projectB.open()]);
    projectAFirst.stdout.end();
    await vi.advanceTimersByTimeAsync(500);

    expect(openA).toHaveBeenCalledTimes(2);
    expect(epochsA).toEqual([1, 2]);
    expect(openB).toHaveBeenCalledOnce();
    expect(epochsB).toEqual([1]);
    projectA.close();
    projectB.close();
  });

  it('restores the full reconnect budget after a successful reattachment', async () => {
    vi.useFakeTimers();
    const first = channel();
    const second = channel();
    const third = channel();
    const opener = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const manager = new RemoteMuxConnectionManager(opener);

    await manager.open();
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(opener).toHaveBeenCalledTimes(2);

    second.stdout.end();
    await vi.advanceTimersByTimeAsync(500);
    expect(opener).toHaveBeenCalledTimes(3);
    manager.close();
  });

  it('reports reconnecting and reattached around a channel-only flap while epochs drive reseeding', async () => {
    vi.useFakeTimers();
    const first = channel();
    const second = channel();
    const opener = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = new RemoteMuxConnectionManager(opener);
    const epochs: number[] = [];
    const reconnecting = vi.fn();
    const reattached = vi.fn();
    manager.onAttached.add((epoch) => epochs.push(epoch));
    manager.onReconnecting = reconnecting;
    manager.onReattached = reattached;

    await manager.open();
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(500);

    expect(reconnecting).toHaveBeenCalledOnce();
    expect(reattached).toHaveBeenCalledOnce();
    expect(epochs).toEqual([1, 2]);
    manager.close();
  });

  it('reports exhaustion after every bounded reconnect attempt fails', async () => {
    vi.useFakeTimers();
    const first = channel();
    const opener = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValue(new Error('remote channel unavailable'));
    const manager = new RemoteMuxConnectionManager(opener);
    const exhausted = vi.fn();
    manager.onReattachExhausted = exhausted;

    await manager.open();
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(opener).toHaveBeenCalledTimes(5);
    expect(exhausted).toHaveBeenCalledOnce();
    manager.close();
  });

  it('does not schedule a reconnect after explicit close', async () => {
    vi.useFakeTimers();
    const first = channel();
    const opener = vi.fn().mockResolvedValue(first);
    const manager = new RemoteMuxConnectionManager(opener);

    await manager.open();
    manager.close();
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(opener).toHaveBeenCalledOnce();
  });

  it('opens a fresh channel after close while an earlier opener is still pending', async () => {
    let releaseFirst!: (value: DuplexChannel) => void;
    const first = new Promise<DuplexChannel>((resolve) => {
      releaseFirst = resolve;
    });
    const second = channel();
    const opener = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(second);
    const manager = new RemoteMuxConnectionManager(opener);
    const epochs: number[] = [];
    manager.onAttached.add((epoch) => epochs.push(epoch));

    const stale = manager.open();
    manager.close();
    const fresh = manager.open();
    releaseFirst(channel());
    await Promise.all([stale, fresh]);

    expect(opener).toHaveBeenCalledTimes(2);
    expect(epochs).toEqual([1]);
    manager.close();
  });

  it('does not reconnect after a stolen-session event', async () => {
    vi.useFakeTimers();
    const first = channel();
    const opener = vi.fn().mockResolvedValue(first);
    const manager = new RemoteMuxConnectionManager(opener);
    const stolen: string[] = [];
    manager.onStolen.add((sessionId) => stolen.push(sessionId));

    await manager.open();
    first.stdout.write(frame({ event: 'session.stolen', session_id: 'session-1', by_kind: 'tty' }));
    first.stdout.end();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stolen).toEqual(['session-1']);
    expect(opener).toHaveBeenCalledOnce();
  });
});
