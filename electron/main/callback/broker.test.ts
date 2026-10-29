import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { Channels } from '@shared/ipc/channels';
import type { ConnectionState } from '@shared/providers/types';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { logger } from '../logger';
import { CallbackBroker, type CallbackBrokerDeps, type CallbackOpenEvent } from './broker';
import { CallbackListener } from './listener';
import { callbackRequest, openRequest } from './testClient';

const worktree = (path: string): WorktreeRecord => ({
  path,
  branch: 'main',
  head: 'abc',
  locked: false,
  prunable: false,
  detached: false,
});

interface Rig {
  broker: CallbackBroker;
  events: CallbackOpenEvent[];
  status: Map<string, ConnectionState>;
  listWorktrees: ReturnType<typeof vi.fn>;
  advance: (ms: number) => void;
  warn: ReturnType<typeof vi.spyOn>;
  /** Swap in a different provider object, as a reconnect does. */
  replaceProvider: () => void;
}

let userData: string;
let rigs: CallbackBroker[] = [];

beforeEach(() => {
  userData = mkdtempSync('/tmp/accb-b-');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await Promise.all(rigs.map((b) => b.stopAll()));
  rigs = [];
  rmSync(userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function rig(over: Partial<CallbackBrokerDeps> = {}): Rig {
  let now = 1_000_000;
  const status = new Map<string, ConnectionState>([['p', 'connected']]);
  const listWorktrees = vi.fn(async () => [worktree('/repo')]);
  // One stable provider object: the broker compares its identity across awaits.
  let provider = { kind: 'local' as const, listWorktrees };
  const broker = new CallbackBroker({
    statusOf: (id) => (status.has(id) ? { state: status.get(id)!, since: '' } : undefined),
    providerOf: () => provider,
    projectRootOf: () => '/repo',
    userDataDir: () => userData,
    realpath: async (p) => p,
    now: () => now,
    ...over,
  });
  rigs.push(broker);
  const events: CallbackOpenEvent[] = [];
  broker.onOpen((e) => events.push(e));
  return {
    broker,
    events,
    status,
    listWorktrees,
    advance: (ms) => {
      now += ms;
    },
    warn: vi.spyOn(logger, 'warn'),
    replaceProvider: () => {
      provider = { kind: 'local', listWorktrees };
    },
  };
}

const open = (path = '/repo/src/a.ts', id = 1): Record<string, unknown> =>
  openRequest(path, { id });
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('CallbackBroker decision (scenario 4)', () => {
  it('replies dispatched and emits the classified selection', async () => {
    const { broker, events } = rig();
    expect(broker.handle('p', open('/repo/src/a.ts', 7))).toEqual({
      id: 7,
      ok: true,
      result: { status: 'dispatched' },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      projectId: 'p',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo' },
    });
  });

  it('replies dispatched BEFORE classification, which may queue behind slow provider RPCs', async () => {
    let release: (w: WorktreeRecord[]) => void = () => undefined;
    const { broker, events, listWorktrees } = rig();
    listWorktrees.mockImplementation(
      () => new Promise<WorktreeRecord[]>((resolve) => (release = resolve)),
    );
    const reply = broker.handle('p', open());
    expect(reply).toMatchObject({ ok: true, result: { status: 'dispatched' } });
    await flush();
    expect(events).toEqual([]); // still classifying
    release([worktree('/repo')]);
    await vi.waitFor(() => expect(events).toHaveLength(1));
  });

  it('is default-deny: only open is allowlisted, anything else is unsupported-op', async () => {
    const { broker, events, listWorktrees } = rig();
    for (const op of ['review', 'focus', 'notify', 'Open', 'delete', '__proto__']) {
      expect(broker.handle('p', { v: 1, id: 3, op, args: { path: '/repo/a.md' } })).toEqual({
        id: 3,
        ok: false,
        error: { code: 'unsupported-op', message: 'unsupported operation' },
      });
    }
    await flush();
    expect(events).toEqual([]);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('rate-limits a project to a burst of 10 requests, refilling at 10 per second', () => {
    const { broker, advance } = rig();
    for (let i = 0; i < 10; i += 1)
      expect(broker.handle('p', open('/repo/a.md', i + 1))).toMatchObject({ ok: true });
    expect(broker.handle('p', open('/repo/a.md', 11))).toEqual({
      id: 11,
      ok: false,
      error: { code: 'rate-limited', message: 'too many requests' },
    });
    advance(50);
    expect(broker.handle('p', open())).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
    advance(50); // 100 ms in total = one token at 10 per second
    expect(broker.handle('p', open())).toMatchObject({ ok: true });
    expect(broker.handle('p', open())).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
    advance(5_000); // the bucket never holds more than the burst
    for (let i = 0; i < 10; i += 1) expect(broker.handle('p', open())).toMatchObject({ ok: true });
    expect(broker.handle('p', open())).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
  });

  it('keeps rate limits per project', () => {
    const { broker, status } = rig();
    status.set('q', 'connected');
    for (let i = 0; i < 10; i += 1) broker.handle('p', open());
    expect(broker.handle('p', open())).toMatchObject({
      ok: false,
      error: { code: 'rate-limited' },
    });
    expect(broker.handle('q', open())).toMatchObject({ ok: true });
  });

  it('refuses with not-connected unless the project status is connected', async () => {
    const { broker, events, status, listWorktrees } = rig();
    for (const state of ['disconnected', 'connecting', 'reconnecting', 'failed'] as const) {
      status.set('p', state);
      expect(broker.handle('p', open('/repo/a.md', 4))).toEqual({
        id: 4,
        ok: false,
        error: { code: 'not-connected', message: 'project is not connected' },
      });
    }
    // A project with no live session at all.
    expect(broker.handle('ghost', open())).toMatchObject({
      ok: false,
      error: { code: 'not-connected' },
    });
    await flush();
    expect(events).toEqual([]);
    expect(listWorktrees).not.toHaveBeenCalled();
    status.set('p', 'connected');
    expect(broker.handle('p', open())).toMatchObject({ ok: true });
  });

  it('answers bad-request for a relative, empty, missing, non-string or NUL-bearing path', async () => {
    const { broker, events, listWorktrees, advance } = rig();
    const bad: unknown[] = ['README.md', './README.md', '', null, 42, '/repo/a\0b'];
    for (const path of bad) {
      expect(broker.handle('p', { v: 1, id: 2, op: 'open', args: { path } })).toMatchObject({
        id: 2,
        ok: false,
        error: { code: 'bad-request' },
      });
    }
    advance(1_000); // rejected requests still spend rate-limit budget
    for (const args of [undefined, null, 'x', [], {}]) {
      expect(broker.handle('p', { v: 1, id: 2, op: 'open', args })).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      });
    }
    await flush();
    expect(events).toEqual([]);
    expect(listWorktrees).not.toHaveBeenCalled();
  });

  it('answers bad-request for a malformed envelope, echoing the id when it has one', () => {
    const { broker } = rig();
    expect(broker.handle('p', { v: 2, id: 9, op: 'open', args: { path: '/a' } })).toMatchObject({
      id: 9,
      ok: false,
      error: { code: 'bad-request' },
    });
    expect(broker.handle('p', 'nonsense')).toMatchObject({
      id: 0,
      ok: false,
      error: { code: 'bad-request' },
    });
    expect(broker.handle('p', null)).toMatchObject({
      id: 0,
      ok: false,
      error: { code: 'bad-request' },
    });
    expect(
      broker.handle('p', {
        v: 1,
        id: 5,
        op: 'open',
        pane: { kind: 'x', id: '1' },
        args: { path: '/a' },
      }),
    ).toMatchObject({
      id: 5,
      ok: false,
      error: { code: 'bad-request' },
    });
  });

  it('applies the cheap checks in order: envelope, allowlist, rate limit, status, bounds', () => {
    const { broker, status } = rig();
    status.set('p', 'disconnected');
    const badArgsOpen = { v: 1, id: 1, op: 'open', args: { path: 'relative' } };
    // status beats bounds
    expect(broker.handle('p', badArgsOpen)).toMatchObject({ error: { code: 'not-connected' } });
    status.set('p', 'connected');
    // bounds once connected
    expect(broker.handle('p', badArgsOpen)).toMatchObject({ error: { code: 'bad-request' } });
    // allowlist beats status
    status.set('p', 'disconnected');
    expect(broker.handle('p', { v: 1, id: 1, op: 'focus', args: {} })).toMatchObject({
      error: { code: 'unsupported-op' },
    });
    // rate limit beats status: exhaust the budget, then even a refused-by-status request is rate-limited
    for (let i = 0; i < 20; i += 1) broker.handle('p', open());
    expect(broker.handle('p', open())).toMatchObject({ error: { code: 'rate-limited' } });
  });

  it('delivers no event for any rejected request', async () => {
    const { broker, events, status } = rig();
    status.set('q', 'failed');
    broker.handle('p', { v: 9, id: 1, op: 'open', args: { path: '/repo/a.md' } });
    broker.handle('p', { v: 1, id: 1, op: 'nope', args: { path: '/repo/a.md' } });
    broker.handle('p', { v: 1, id: 1, op: 'open', args: { path: 'rel' } });
    broker.handle('q', open());
    await flush();
    expect(events).toEqual([]);
  });

  it('logs and opens nothing when classification fails after dispatched', async () => {
    const { broker, events, warn } = rig({ providerOf: () => undefined });
    expect(broker.handle('p', open('/repo/a.md'))).toMatchObject({
      ok: true,
      result: { status: 'dispatched' },
    });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /callback open dropped project=p path="\/repo\/a\.md" reason=/,
    );
    expect(warn.mock.calls[0]![1]).toBe('callback');
    expect(events).toEqual([]);
  });

  describe('an open whose session changes while its path is being classified', () => {
    /** Dispatch an open and hold its classification until `release` is called. */
    async function inFlight() {
      const r = rig();
      let release: (w: WorktreeRecord[]) => void = () => undefined;
      r.listWorktrees.mockImplementation(
        () => new Promise<WorktreeRecord[]>((resolve) => (release = resolve)),
      );
      expect(r.broker.handle('p', open('/repo/src/a.ts'))).toMatchObject({
        ok: true,
        result: { status: 'dispatched' },
      });
      await flush();
      return { ...r, release: () => release([worktree('/repo')]) };
    }

    it.each(['disconnected', 'failed', 'reconnecting', 'connecting'] as const)(
      'delivers nothing when the status becomes %s before delivery',
      async (state) => {
        const { events, status, warn, release } = await inFlight();
        status.set('p', state);
        release();
        await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
        expect(String(warn.mock.calls[0]![0])).toMatch(
          /^callback open dropped project=p path="\/repo\/src\/a\.ts" reason="the session ended while the path was being classified"$/,
        );
        expect(warn.mock.calls[0]![1]).toBe('callback');
        await flush();
        expect(events).toEqual([]);
      },
    );

    it('delivers nothing when the session is gone', async () => {
      const { events, status, warn, release } = await inFlight();
      status.delete('p');
      release();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(events).toEqual([]);
    });

    it('delivers nothing when a reconnect replaced the provider, even though the new one is connected', async () => {
      const { events, replaceProvider, warn, release } = await inFlight();
      replaceProvider(); // status still reads connected, but it is a different session
      release();
      await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
      expect(events).toEqual([]);
    });

    it('still delivers when the same session stays connected throughout', async () => {
      const { events, release, warn } = await inFlight();
      release();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('does not let a throwing listener break delivery to the others', async () => {
    const { broker, events } = rig();
    broker.onOpen(() => {
      throw new Error('subscriber bug');
    });
    const late: CallbackOpenEvent[] = [];
    broker.onOpen((e) => late.push(e));
    broker.handle('p', open());
    await vi.waitFor(() => expect(late).toHaveLength(1));
    expect(events).toHaveLength(1);
  });

  it('stops delivering to an unsubscribed listener', async () => {
    const { broker } = rig();
    const seen: CallbackOpenEvent[] = [];
    const off = broker.onOpen((e) => seen.push(e));
    broker.handle('p', open());
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    off();
    broker.handle('p', open());
    await flush();
    await flush();
    expect(seen).toHaveLength(1);
  });
});

describe('CallbackBroker identity (scenario 2)', () => {
  it('records the pane as attribution and accepts a request without one', async () => {
    const { broker, events } = rig();
    broker.handle('p', openRequest('/repo/a.md', { id: 1, pane: { kind: 'tmux', id: '%4' } }));
    broker.handle('p', openRequest('/repo/b.md', { id: 2, pane: { kind: 'mux', id: 'term-1' } }));
    broker.handle('p', openRequest('/repo/c.md', { id: 3 }));
    await vi.waitFor(() => expect(events).toHaveLength(3));
    const byPath = new Map(events.map((e) => [e.selection.path, e]));
    expect(byPath.get('a.md')!.pane).toEqual({ kind: 'tmux', id: '%4' });
    expect(byPath.get('b.md')!.pane).toEqual({ kind: 'mux', id: 'term-1' });
    expect(byPath.get('c.md')).not.toHaveProperty('pane');
  });

  it('derives the project from the receiving socket; a request cannot name another', async () => {
    const { broker, events, status } = rig();
    status.set('a', 'connected');
    status.set('b', 'connected');
    await Promise.all([broker.startLocalListener('a'), broker.startLocalListener('b')]);
    const sockA = broker.localSocketPath('a')!;
    const sockB = broker.localSocketPath('b')!;
    expect(sockA).not.toBe(sockB);

    // A request on A's socket that tries every way of naming project B.
    const sneaky = {
      ...openRequest('/repo/x.md', { id: 5 }),
      projectId: 'b',
      project: 'b',
      args: { path: '/repo/x.md', projectId: 'b', project: 'b' },
    };
    expect(await callbackRequest(sockA, sneaky)).toMatchObject({ id: 5, ok: true });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.projectId).toBe('a');

    expect(await callbackRequest(sockB, openRequest('/repo/y.md', { id: 6 }))).toMatchObject({
      ok: true,
    });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((e) => e.projectId)).toEqual(['a', 'b']);
    // Nothing was ever delivered for a project other than the one whose socket was used.
    expect(events.filter((e) => e.selection.path === 'x.md').map((e) => e.projectId)).toEqual([
      'a',
    ]);
  });

  it('introduces no secret material in settings, channels or logs', async () => {
    const lines: string[] = [];
    const off = vi.spyOn(logger, 'info').mockImplementation((m) => void lines.push(m));
    const warn = vi.spyOn(logger, 'warn').mockImplementation((m) => void lines.push(m));
    const { broker, events, status } = rig();
    status.set('p', 'connected');
    await broker.startLocalListener('p');
    await callbackRequest(
      broker.localSocketPath('p')!,
      openRequest('/repo/a.md', { pane: { kind: 'tmux', id: '%1' } }),
    );
    await vi.waitFor(() => expect(events).toHaveLength(1));
    await broker.stopListener('p');
    off.mockRestore();
    warn.mockRestore();

    const secretish = /secret|token|hmac|password|credential/i;
    expect(lines.length).toBeGreaterThan(0);
    // (the temp directory's random name is not part of what is being checked)
    for (const line of lines) expect(line.replace(/path=".*"/, '')).not.toMatch(secretish);
    expect(
      Object.keys(DEFAULT_SETTINGS).filter(
        (k) => /callback|cockpitcli/i.test(k) || secretish.test(k),
      ),
    ).toEqual([]);
    expect(
      [...Object.keys(Channels), ...Object.values(Channels)].filter(
        (c) => /callback/i.test(c) && secretish.test(c),
      ),
    ).toEqual([]);
    expect(Object.keys(events[0]!).sort()).toEqual(['pane', 'projectId', 'selection']);
  });
});

describe('CallbackBroker over its real local listener', () => {
  it('serves open end to end: dispatched reply, then the classified event', async () => {
    const { broker, events, status } = rig();
    status.set('p', 'connected');
    await broker.startLocalListener('p');
    const reply = await callbackRequest(
      broker.localSocketPath('p')!,
      openRequest('/repo/src/a.ts', { id: 12 }),
    );
    expect(reply).toEqual({ id: 12, ok: true, result: { status: 'dispatched' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]!.selection).toEqual({ kind: 'file', path: 'src/a.ts', worktreePath: '/repo' });
  });

  it('answers an unknown operation and a malformed frame through the socket', async () => {
    const { broker, status } = rig();
    status.set('p', 'connected');
    await broker.startLocalListener('p');
    const path = broker.localSocketPath('p')!;
    expect(await callbackRequest(path, { v: 1, id: 3, op: 'review', args: {} })).toMatchObject({
      id: 3,
      error: { code: 'unsupported-op' },
    });
    expect(
      await callbackRequest(path, { v: 9, id: 4, op: 'open', args: { path: '/a' } }),
    ).toMatchObject({
      id: 4,
      error: { code: 'bad-request' },
    });
  });

  it('refuses requests with not-connected while the machine is not connected, even with the listener up', async () => {
    const { broker, events, status } = rig();
    status.set('p', 'connected');
    await broker.startLocalListener('p');
    status.set('p', 'reconnecting');
    expect(
      await callbackRequest(broker.localSocketPath('p')!, openRequest('/repo/a.md')),
    ).toMatchObject({
      error: { code: 'not-connected' },
    });
    await flush();
    expect(events).toEqual([]);
  });

  it('forgets the rate-limit budget when the listener stops', async () => {
    const { broker, status } = rig();
    status.set('p', 'connected');
    for (let i = 0; i < 10; i += 1) broker.handle('p', open());
    expect(broker.handle('p', open())).toMatchObject({ error: { code: 'rate-limited' } });
    await broker.stopListener('p');
    expect(broker.handle('p', open())).toMatchObject({ ok: true });
  });
});

describe('CallbackBroker listener start/stop', () => {
  it('disables callback for the project with one structured log line when the bind fails, and never throws', async () => {
    // Neither the userData path nor the /tmp fallback root can be injected into an environment.
    const { broker, warn } = rig({
      userDataDir: () => '/tmp/accb-b-\n-bad',
      tmpRoot: '/tmp/accb-b-\n-tmp',
    });
    await expect(broker.startLocalListener('p')).resolves.toBeUndefined();
    expect(broker.localSocketPath('p')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^callback disabled project=p reason=invalid-value detail=".*"$/,
    );
    expect(warn.mock.calls[0]![1]).toBe('callback');
  });

  it('survives userDataDir() throwing (for example before the app is ready)', async () => {
    const { broker, warn } = rig({
      userDataDir: () => {
        throw new Error('app not ready');
      },
    });
    await expect(broker.startLocalListener('p')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('app not ready');
  });

  it('closes a listener that finished binding after a stop arrived (start/stop race)', async () => {
    const { broker } = rig();
    const starting = broker.startLocalListener('p');
    await broker.stopListener('p');
    await starting;
    expect(broker.localSocketPath('p')).toBeNull();
    expect(readdirSync(join(userData, 'callback'))).toEqual([]); // the late listener removed its own socket
  });

  it('runs overlapping starts for a project one after the other, in call order', async () => {
    const { broker } = rig();
    const realStart = CallbackListener.start.bind(CallbackListener);
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const start = vi.spyOn(CallbackListener, 'start').mockImplementationOnce(async (opts) => {
      await gate;
      return realStart(opts);
    });
    const first = broker.startLocalListener('p');
    const second = broker.startLocalListener('p');
    await flush();
    expect(start).toHaveBeenCalledTimes(1); // the newer start waits: its rename can never be overwritten by the older one's
    releaseFirst();
    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledTimes(2);
    expect(
      await callbackRequest(broker.localSocketPath('p')!, openRequest('/repo/a.md')),
    ).toMatchObject({ ok: true });
  });

  it('stopAll also undoes a start that is still binding', async () => {
    const { broker } = rig();
    const starting = broker.startLocalListener('p');
    await broker.stopAll();
    await starting;
    expect(broker.localSocketPath('p')).toBeNull();
    expect(readdirSync(join(userData, 'callback'))).toEqual([]);
  });

  it('stopAll is idempotent, safe with nothing running, and safe after listeners were already stopped', async () => {
    const { broker } = rig();
    await expect(broker.stopAll()).resolves.toBeUndefined(); // nothing ever started
    await broker.startLocalListener('p');
    await Promise.all([broker.stopAll(), broker.stopListener('p'), broker.stopAll()]);
    await expect(broker.stopAll()).resolves.toBeUndefined();
    expect(broker.localSocketPath('p')).toBeNull();
    expect(readdirSync(join(userData, 'callback'))).toEqual([]);
  });

  it('lets the newest of two overlapping starts win and retires the other', async () => {
    const { broker } = rig();
    await Promise.all([broker.startLocalListener('p'), broker.startLocalListener('p')]);
    const path = broker.localSocketPath('p')!;
    expect(await callbackRequest(path, openRequest('/repo/a.md'))).toMatchObject({ ok: true });
    await broker.stopListener('p');
    expect(broker.localSocketPath('p')).toBeNull();
  });
});
