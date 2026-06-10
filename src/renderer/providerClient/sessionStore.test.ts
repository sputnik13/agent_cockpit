// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { ConnectionStatus } from '@shared/providers/types';
import { useSessionStore, isConnected, isDisconnected, selectStatus, initSessionSync } from './sessionStore';

beforeEach(() => {
  // Reset the store between tests.
  useSessionStore.setState({ statuses: {} });
});

describe('sessionStore selectors', () => {
  it('isConnected: true when state is connected', () => {
    useSessionStore.getState().setStatus('a', { state: 'connected', since: '2024-01-01' });
    expect(isConnected('a')(useSessionStore.getState())).toBe(true);
  });

  it('isConnected: false when state is disconnected', () => {
    useSessionStore.getState().setStatus('a', { state: 'disconnected', since: '2024-01-01' });
    expect(isConnected('a')(useSessionStore.getState())).toBe(false);
  });

  it('isConnected: false for connecting (in-flight)', () => {
    useSessionStore.getState().setStatus('a', { state: 'connecting', since: '2024-01-01' });
    expect(isConnected('a')(useSessionStore.getState())).toBe(false);
  });

  it('isConnected: false for null projectId', () => {
    expect(isConnected(null)(useSessionStore.getState())).toBe(false);
  });

  it('isConnected: false for unknown project (no status)', () => {
    expect(isConnected('unknown')(useSessionStore.getState())).toBe(false);
  });

  it('isDisconnected: true for disconnected', () => {
    useSessionStore.getState().setStatus('a', { state: 'disconnected', since: '2024-01-01' });
    expect(isDisconnected('a')(useSessionStore.getState())).toBe(true);
  });

  it('isDisconnected: true for failed (failed counts as disconnected for UI purposes)', () => {
    useSessionStore.getState().setStatus('a', { state: 'failed', since: '2024-01-01' });
    expect(isDisconnected('a')(useSessionStore.getState())).toBe(true);
  });

  it('isDisconnected: false for connected', () => {
    useSessionStore.getState().setStatus('a', { state: 'connected', since: '2024-01-01' });
    expect(isDisconnected('a')(useSessionStore.getState())).toBe(false);
  });

  it('isDisconnected: false for connecting', () => {
    useSessionStore.getState().setStatus('a', { state: 'connecting', since: '2024-01-01' });
    expect(isDisconnected('a')(useSessionStore.getState())).toBe(false);
  });

  it('isDisconnected: false for null projectId', () => {
    expect(isDisconnected(null)(useSessionStore.getState())).toBe(false);
  });

  it('selectStatus: returns the status for a known project', () => {
    const s = { state: 'connected' as const, since: '2024-01-01' };
    useSessionStore.getState().setStatus('a', s);
    expect(selectStatus('a')(useSessionStore.getState())).toEqual(s);
  });

  it('selectStatus: returns null for unknown project', () => {
    expect(selectStatus('unknown')(useSessionStore.getState())).toBeNull();
  });

  it('selectStatus: returns null for null projectId', () => {
    expect(selectStatus(null)(useSessionStore.getState())).toBeNull();
  });

  it('clear() removes the status for a project', () => {
    useSessionStore.getState().setStatus('a', { state: 'connected', since: '2024-01-01' });
    useSessionStore.getState().clear('a');
    expect(selectStatus('a')(useSessionStore.getState())).toBeNull();
  });
});

describe('initSessionSync hydration (renderer reload)', () => {
  type StatusHandler = (e: { projectId: string; status: ConnectionStatus }) => void;

  function stubApi(opts: {
    getStatuses: () => Promise<Record<string, ConnectionStatus>>;
    onStatus?: (h: StatusHandler) => () => void;
  }): void {
    const api = {
      events: { onStatus: opts.onStatus ?? (() => () => undefined) },
      provider: { getStatuses: opts.getStatuses },
    };
    (window as unknown as { api: typeof api }).api = api;
  }

  it('hydrates the store from the main snapshot on init', async () => {
    const snapshot: Record<string, ConnectionStatus> = {
      a: { state: 'connected', since: '2024-01-01' },
      b: { state: 'connecting', since: '2024-01-02' },
    };
    stubApi({ getStatuses: () => Promise.resolve(snapshot) });
    const off = initSessionSync();
    await Promise.resolve();
    await Promise.resolve();
    expect(selectStatus('a')(useSessionStore.getState())?.state).toBe('connected');
    expect(selectStatus('b')(useSessionStore.getState())?.state).toBe('connecting');
    off();
  });

  it('does not clobber a status set by a push that raced in during hydration', async () => {
    let captured: StatusHandler | undefined;
    let resolveSnapshot!: (s: Record<string, ConnectionStatus>) => void;
    const pending = new Promise<Record<string, ConnectionStatus>>((res) => {
      resolveSnapshot = res;
    });
    stubApi({
      getStatuses: () => pending,
      onStatus: (h) => {
        captured = h;
        return () => undefined;
      },
    });
    const off = initSessionSync();
    // A transition arrives BEFORE the snapshot resolves: 'a' is now disconnected.
    captured!({ projectId: 'a', status: { state: 'disconnected', since: '2024-01-03' } });
    // The (older) snapshot still reports 'a' as connected.
    resolveSnapshot({ a: { state: 'connected', since: '2024-01-01' } });
    await pending;
    await Promise.resolve();
    // The pushed (newer) status wins; the snapshot must not overwrite it.
    expect(selectStatus('a')(useSessionStore.getState())?.state).toBe('disconnected');
    off();
  });
});
