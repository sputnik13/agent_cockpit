import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConnectionMachine, ConnectionMachine } from './connectionMachine';
import type { ConnectionStatus } from './types';

function collect(machine: ConnectionMachine): ConnectionStatus[] {
  const events: ConnectionStatus[] = [];
  machine.subscribe((s) => events.push({ ...s }));
  return events;
}

describe('ConnectionMachine — legal transitions', () => {
  it('disconnected -> connecting', () => {
    const m = createConnectionMachine('p1');
    const events = collect(m);
    m.toConnecting();
    expect(m.current().state).toBe('connecting');
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('connecting');
  });

  it('connecting -> connected', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    const events = collect(m);
    m.toConnected();
    expect(m.current().state).toBe('connected');
    expect(events[0]!.state).toBe('connected');
  });

  it('connecting -> failed', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toFailed('ssh timeout');
    expect(m.current().state).toBe('failed');
    expect(m.current().detail).toBe('ssh timeout');
  });

  it('connected -> disconnected', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toConnected();
    m.toDisconnected();
    expect(m.current().state).toBe('disconnected');
  });

  it('connected -> reconnecting', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toConnected();
    m.toReconnecting();
    expect(m.current().state).toBe('reconnecting');
  });

  it('reconnecting -> connected', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toConnected();
    m.toReconnecting();
    m.toConnected();
    expect(m.current().state).toBe('connected');
  });

  it('reconnecting -> failed', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toConnected();
    m.toReconnecting();
    m.toFailed('reattach gave up');
    expect(m.current().state).toBe('failed');
  });

  it('failed -> connecting (user retry)', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toFailed();
    m.toConnecting();
    expect(m.current().state).toBe('connecting');
  });
});

describe('ConnectionMachine — illegal transitions are no-ops', () => {
  const illegalPairs: [string, () => void][] = [
    ['disconnected -> connected', () => {
      const m = createConnectionMachine('p1');
      m.toConnected();
      expect(m.current().state).toBe('disconnected');
    }],
    ['disconnected -> reconnecting', () => {
      const m = createConnectionMachine('p1');
      m.toReconnecting();
      expect(m.current().state).toBe('disconnected');
    }],
    ['disconnected -> failed', () => {
      const m = createConnectionMachine('p1');
      m.toFailed();
      expect(m.current().state).toBe('disconnected');
    }],
    ['connected -> connecting', () => {
      const m = createConnectionMachine('p1');
      m.toConnecting();
      m.toConnected();
      m.toConnecting();
      expect(m.current().state).toBe('connected');
    }],
    ['failed -> connected', () => {
      const m = createConnectionMachine('p1');
      m.toConnecting();
      m.toFailed();
      m.toConnected();
      expect(m.current().state).toBe('failed');
    }],
    ['failed -> disconnected', () => {
      const m = createConnectionMachine('p1');
      m.toConnecting();
      m.toFailed();
      m.toDisconnected();
      expect(m.current().state).toBe('failed');
    }],
    ['reconnecting -> disconnected', () => {
      const m = createConnectionMachine('p1');
      m.toConnecting();
      m.toConnected();
      m.toReconnecting();
      m.toDisconnected();
      expect(m.current().state).toBe('reconnecting');
    }],
  ];

  for (const [label, fn] of illegalPairs) {
    it(label, fn);
  }

  it('no event emitted for illegal transitions', () => {
    const m = createConnectionMachine('p1');
    const events = collect(m);
    m.toConnected(); // illegal
    m.toFailed(); // illegal
    expect(events).toHaveLength(0);
  });
});

describe('ConnectionMachine — coalescing', () => {
  it('toConnecting while already connecting: no-op (coalesces)', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    const events = collect(m);
    m.toConnecting(); // second request — should coalesce
    expect(events).toHaveLength(0); // no duplicate event
    expect(m.current().state).toBe('connecting');
  });

  it('toReconnecting while already reconnecting: no-op (coalesces)', () => {
    const m = createConnectionMachine('p1');
    m.toConnecting();
    m.toConnected();
    m.toReconnecting();
    const events = collect(m);
    m.toReconnecting();
    expect(events).toHaveLength(0);
    expect(m.current().state).toBe('reconnecting');
  });

  it('coalesce() returns same promise for concurrent callers', async () => {
    const m = createConnectionMachine('p1');
    let calls = 0;
    const fn = (): Promise<void> => new Promise<void>((resolve) => { calls += 1; setTimeout(resolve, 10); });
    const p1 = m.coalesce(fn);
    const p2 = m.coalesce(fn);
    expect(p1).toBe(p2); // same in-flight promise
    await p1;
    expect(calls).toBe(1); // fn only called once
  });

  it('coalesce() allows a new call after the first resolves', async () => {
    const m = createConnectionMachine('p1');
    let calls = 0;
    const fn = (): Promise<void> => new Promise<void>((resolve) => { calls += 1; resolve(); });
    await m.coalesce(fn);
    await m.coalesce(fn);
    expect(calls).toBe(2);
  });
});

describe('ConnectionMachine — subscribe fires on every accepted transition', () => {
  it('emits the full sequence: disconnected->connecting->connected', () => {
    const m = createConnectionMachine('p1');
    const states: string[] = [];
    m.subscribe((s) => states.push(s.state));
    m.toConnecting();
    m.toConnected();
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('emits reconnecting as an intermediate state', () => {
    const m = createConnectionMachine('p1');
    const states: string[] = [];
    m.subscribe((s) => states.push(s.state));
    m.toConnecting();
    m.toConnected();
    m.toReconnecting();
    m.toConnected();
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  it('carries detail on transitions that provide one', () => {
    const m = createConnectionMachine('p1');
    const events: ConnectionStatus[] = [];
    m.subscribe((s) => events.push(s));
    m.toConnecting('uploading helper');
    expect(events[0]!.detail).toBe('uploading helper');
  });

  it('unsubscribe removes handler', () => {
    const m = createConnectionMachine('p1');
    const handler = vi.fn();
    const off = m.subscribe(handler);
    off();
    m.toConnecting();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('ConnectionMachine — LocalProvider short-circuit', () => {
  it('shortCircuitConnected() hard-sets connected and emits', () => {
    const m = createConnectionMachine('p1');
    const events = collect(m);
    m.shortCircuitConnected();
    expect(m.current().state).toBe('connected');
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toBe('connected');
  });

  it('shortCircuitConnected() bypasses guard (no from->to check)', () => {
    // Can be called from any state (local is always connected).
    const m = createConnectionMachine('p1');
    m.toConnecting(); // advance to connecting first
    m.shortCircuitConnected();
    expect(m.current().state).toBe('connected');
  });
});

describe('ConnectionMachine — current()', () => {
  it('starts disconnected by default', () => {
    const m = createConnectionMachine('p1');
    expect(m.current().state).toBe('disconnected');
    expect(m.current().detail).toBeUndefined();
    expect(m.current().since).toBeTruthy();
  });

  it('accepts an initial state for testing', () => {
    const m = new ConnectionMachine('p1', 'connected');
    expect(m.current().state).toBe('connected');
  });
});

describe('ConnectionMachine — isInFlight()', () => {
  it('false when no coalesce is active', () => {
    const m = createConnectionMachine('p1');
    expect(m.isInFlight()).toBe(false);
  });

  it('true while a coalesce promise is pending', () => {
    const m = createConnectionMachine('p1');
    let resolve!: () => void;
    void m.coalesce(() => new Promise<void>((r) => { resolve = r; }));
    expect(m.isInFlight()).toBe(true);
    resolve();
  });

  it('false after a coalesce promise settles', async () => {
    const m = createConnectionMachine('p1');
    await m.coalesce(() => Promise.resolve());
    expect(m.isInFlight()).toBe(false);
  });
});

describe('ConnectionMachine — multiple subscribers', () => {
  it('all subscribers receive each accepted transition', () => {
    const m = createConnectionMachine('p1');
    const a: string[] = [];
    const b: string[] = [];
    m.subscribe((s) => a.push(s.state));
    m.subscribe((s) => b.push(s.state));
    m.toConnecting();
    m.toConnected();
    expect(a).toEqual(['connecting', 'connected']);
    expect(b).toEqual(['connecting', 'connected']);
  });

  it('removing one subscriber does not affect others', () => {
    const m = createConnectionMachine('p1');
    const a: string[] = [];
    const b: string[] = [];
    const offA = m.subscribe((s) => a.push(s.state));
    m.subscribe((s) => b.push(s.state));
    offA();
    m.toConnecting();
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

describe('ConnectionMachine — logging (smoke)', () => {
  it('does not throw on any transition sequence', () => {
    const m = createConnectionMachine('smoke');
    expect(() => {
      m.toConnecting();
      m.toConnected();
      m.toReconnecting();
      m.toConnected();
      m.toDisconnected();
      m.toConnecting();
      m.toFailed('err');
      m.toConnecting();
      m.toConnected();
    }).not.toThrow();
  });
});

// Suppress logger.warn in tests (expected for illegal-transition smoke).
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
