import { describe, it, expect, vi } from 'vitest';
import type { AppSettings } from '@shared/settings';
import { DEFAULT_SETTINGS } from '@shared/settings';
import type { ConnectionStatus } from './types';
import {
  AGED_OUT_DETAIL,
  sweepIdleSessions,
  startSessionReaper,
  type ReaperSessionManager,
} from './sessionReaper';

interface FakeSession {
  kind: 'local' | 'remote';
  state: ConnectionStatus['state'];
  activity: number;
}

/**
 * A fake SessionManager exposing exactly the surface the reaper reads, plus a
 * recording `close`. The clock is injected separately so threshold math is
 * deterministic.
 */
function fakeManager(sessions: Record<string, FakeSession>, active: string | null = null) {
  const closed: Array<{ id: string; detail?: string }> = [];
  const sm: ReaperSessionManager = {
    listOpen: () => Object.keys(sessions),
    activeProjectId: () => active,
    get: (id) => (sessions[id] ? { kind: sessions[id]!.kind } : undefined),
    statusOf: (id) =>
      sessions[id] ? { state: sessions[id]!.state, since: '2026-01-01T00:00:00Z' } : undefined,
    activityOf: (id) => sessions[id]?.activity,
    close: vi.fn(async (id: string, detail?: string) => {
      closed.push({ id, detail });
      delete sessions[id];
    }),
  };
  return { sm, closed, setActive: (id: string | null) => (active = id) };
}

function settings(idleMin: number): () => AppSettings {
  return () => ({ ...DEFAULT_SETTINGS, sessionIdleTimeoutMin: idleMin });
}

const NOW = 1_000_000_000_000;
const THRESHOLD_MS = 20 * 60_000;

describe('sweepIdleSessions candidate selection', () => {
  it('reaps a stale, non-active, connected REMOTE session with the aged-out cue', async () => {
    const { sm, closed } = fakeManager({
      r: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS - 1 },
    });
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
    expect(closed).toEqual([{ id: 'r', detail: AGED_OUT_DETAIL }]);
  });

  it('never reaps the active session even past the threshold (FR2)', async () => {
    const { sm, closed } = fakeManager(
      { r: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS * 10 } },
      'r',
    );
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
    expect(closed).toEqual([]);
  });

  it('never reaps a LOCAL session (remote-only v1)', async () => {
    const { sm, closed } = fakeManager({
      l: { kind: 'local', state: 'connected', activity: NOW - THRESHOLD_MS * 10 },
    });
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
    expect(closed).toEqual([]);
  });

  it.each(['connecting', 'reconnecting', 'failed', 'disconnected'] as const)(
    'skips a %s (non-connected) session (FR3)',
    async (state) => {
      const { sm, closed } = fakeManager({
        r: { kind: 'remote', state, activity: NOW - THRESHOLD_MS * 10 },
      });
      await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
      expect(closed).toEqual([]);
    },
  );

  it('does NOT reap a session that is idle but within the threshold', async () => {
    const { sm, closed } = fakeManager({
      r: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS + 1 },
    });
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
    expect(closed).toEqual([]);
  });

  it('treats a session with no recorded activity (undefined) as idle since 0 (reapable)', async () => {
    const m = fakeManager({ r: { kind: 'remote', state: 'connected', activity: 0 } });
    m.sm.activityOf = () => undefined; // never touched
    await sweepIdleSessions({ sessionManager: m.sm, loadSettings: settings(20), now: () => NOW });
    expect(m.closed).toEqual([{ id: 'r', detail: AGED_OUT_DETAIL }]);
  });
});

describe('sweepIdleSessions off switch (FR5)', () => {
  it('reaps nothing when sessionIdleTimeoutMin is 0', async () => {
    const { sm, closed } = fakeManager({
      r: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS * 100 },
    });
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(0), now: () => NOW });
    expect(closed).toEqual([]);
  });
});

describe('sweepIdleSessions focus race (re-check before close)', () => {
  it('skips a session that becomes active between the scan and the close', async () => {
    const sessions: Record<string, FakeSession> = {
      r: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS - 1 },
    };
    let active: string | null = null;
    const closed: string[] = [];
    const sm: ReaperSessionManager = {
      listOpen: () => Object.keys(sessions),
      // activeProjectId is read twice: once in the candidate scan, once right
      // before close(). Flip it to 'r' on the second read to model the race.
      activeProjectId: vi
        .fn<[], string | null>()
        .mockImplementationOnce(() => active)
        .mockImplementationOnce(() => 'r'),
      get: (id) => (sessions[id] ? { kind: sessions[id]!.kind } : undefined),
      statusOf: (id) => (sessions[id] ? { state: 'connected', since: '' } : undefined),
      activityOf: (id) => sessions[id]?.activity,
      close: vi.fn(async (id: string) => {
        closed.push(id);
      }),
    };
    void active;
    await sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
    expect(closed).toEqual([]); // re-check caught the focus race
  });
});

describe('sweepIdleSessions error isolation (FR7)', () => {
  it('continues to other sessions when one close() throws', async () => {
    const sessions: Record<string, FakeSession> = {
      bad: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS - 1 },
      good: { kind: 'remote', state: 'connected', activity: NOW - THRESHOLD_MS - 1 },
    };
    const closedOk: string[] = [];
    const sm: ReaperSessionManager = {
      listOpen: () => Object.keys(sessions),
      activeProjectId: () => null,
      get: (id) => (sessions[id] ? { kind: sessions[id]!.kind } : undefined),
      statusOf: () => ({ state: 'connected', since: '' }),
      activityOf: (id) => sessions[id]?.activity,
      close: vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('boom');
        closedOk.push(id);
      }),
    };
    await expect(
      sweepIdleSessions({ sessionManager: sm, loadSettings: settings(20), now: () => NOW }),
    ).resolves.toBeUndefined();
    expect(closedOk).toEqual(['good']); // the failing close did not stop the loop
  });
});

describe('startSessionReaper lifecycle (FR7)', () => {
  it('runs no sweep after stop() and leaks no interval', async () => {
    vi.useFakeTimers();
    try {
      const { sm } = fakeManager({
        r: { kind: 'remote', state: 'connected', activity: 0 },
      });
      const handle = startSessionReaper({ sessionManager: sm, loadSettings: settings(20), now: () => NOW });
      handle.stop();
      vi.advanceTimersByTime(60_000 * 5);
      expect(sm.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
