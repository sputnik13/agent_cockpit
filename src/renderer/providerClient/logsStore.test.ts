// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@shared/ipc/channels';

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: 'info',
    message: 'test message',
    ...over,
  };
}

// Install a mock window.api before importing the store (the store reads
// window.api at call time, not import time, so any pre-import stub works).
function installApi(opts: {
  entries?: LogEntry[];
  onLog?: (handler: (e: LogEntry) => void) => () => void;
} = {}) {
  const onLogMock = opts.onLog ?? vi.fn().mockReturnValue(vi.fn());
  const getMock = vi.fn().mockResolvedValue(opts.entries ?? []);
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true });
  (globalThis as unknown as Record<string, unknown>)['api'] = {
    logs: { get: getMock },
    events: { onLog: onLogMock },
  };
  return { getMock, onLogMock };
}

describe('logsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('addEntry adds to entries', async () => {
    installApi();
    const { useLogsStore } = await import('./logsStore');
    const { addEntry, clearEntries } = useLogsStore.getState();
    clearEntries();
    const e = makeEntry({ message: 'hello' });
    addEntry(e);
    expect(useLogsStore.getState().entries).toHaveLength(1);
    expect(useLogsStore.getState().entries[0]!.message).toBe('hello');
  });

  it('clearEntries resets to empty', async () => {
    installApi();
    const { useLogsStore } = await import('./logsStore');
    const { addEntry, clearEntries } = useLogsStore.getState();
    addEntry(makeEntry());
    addEntry(makeEntry());
    clearEntries();
    expect(useLogsStore.getState().entries).toHaveLength(0);
  });

  it('caps at 1000 entries, dropping oldest', async () => {
    installApi();
    const { useLogsStore } = await import('./logsStore');
    const { clearEntries, addEntry } = useLogsStore.getState();
    clearEntries();
    for (let i = 0; i < 1005; i++) {
      addEntry(makeEntry({ message: `msg-${i}` }));
    }
    const entries = useLogsStore.getState().entries;
    expect(entries).toHaveLength(1000);
    // msg-0 through msg-4 should have been evicted.
    expect(entries[0]!.message).toBe('msg-5');
    expect(entries[999]!.message).toBe('msg-1004');
  });

  it('initLogsSync seeds from get() and subscribes to onLog', async () => {
    const seed = [makeEntry({ message: 'seed-1' }), makeEntry({ message: 'seed-2' })];
    let capturedHandler: ((e: LogEntry) => void) | null = null;
    const offMock = vi.fn();
    const { getMock } = installApi({
      entries: seed,
      onLog: (h) => {
        capturedHandler = h;
        return offMock;
      },
    });

    const { useLogsStore, initLogsSync } = await import('./logsStore');
    useLogsStore.getState().clearEntries();

    const off = initLogsSync();

    // Wait for the async get() to resolve.
    await vi.runAllTimersAsync();

    expect(getMock).toHaveBeenCalledOnce();
    const entries = useLogsStore.getState().entries;
    expect(entries.some((e) => e.message === 'seed-1')).toBe(true);
    expect(entries.some((e) => e.message === 'seed-2')).toBe(true);

    // Live push via the onLog subscription.
    expect(capturedHandler).not.toBeNull();
    capturedHandler!(makeEntry({ message: 'live-push' }));
    expect(useLogsStore.getState().entries.some((e) => e.message === 'live-push')).toBe(true);

    off();
    expect(offMock).toHaveBeenCalledOnce();
  });
});
