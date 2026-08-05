import { describe, it, expect, vi } from 'vitest';
import { FakeProvider } from '@shared/providers/fakeProvider';
import type { ConnectionSpec, WatchSubscription } from './types';
import { ProviderRegistry } from './registry';
import { SessionManager } from './sessionManager';

function setupClock(now: () => number) {
  const registry = new ProviderRegistry();
  registry.register('local', ({ projectId }) => new FakeProvider(projectId, 'local'));
  const spec: ConnectionSpec = { kind: 'local', rootPath: '/repo' };
  const statusEvents: Array<{ projectId: string; status: { state: string; detail?: string } }> = [];
  const sm = new SessionManager(registry, {
    loadSpec: () => spec,
    persistActive: vi.fn(),
    onStatus: (projectId, status) => statusEvents.push({ projectId, status }),
    now,
  });
  return { sm, statusEvents };
}

function setup(onCreate?: (p: FakeProvider) => void) {
  const created = new Map<string, FakeProvider>();
  const createdAll: FakeProvider[] = [];
  const registry = new ProviderRegistry();
  registry.register('local', ({ projectId }) => {
    const p = new FakeProvider(projectId, 'local');
    created.set(projectId, p);
    createdAll.push(p);
    onCreate?.(p);
    return p;
  });
  const persistActive = vi.fn();
  const statusEvents: Array<{ projectId: string; state: string }> = [];
  const spec: ConnectionSpec = { kind: 'local', rootPath: '/repo' };
  const sm = new SessionManager(registry, {
    loadSpec: () => spec,
    persistActive,
    onStatus: (projectId, status) => statusEvents.push({ projectId, state: status.state }),
  });
  return { sm, created, createdAll, persistActive, statusEvents };
}

describe('SessionManager background-live lifecycle', () => {
  it('open() creates a connected session without activating it', async () => {
    const { sm } = setup();
    const p = await sm.open('a');
    expect(p.status().state).toBe('connected');
    expect(sm.activeProjectId()).toBeNull();
  });

  it('forwards a connected status event (subscribed BEFORE connect)', async () => {
    // Regression: status was wired AFTER connect, so the 'connected' transition
    // fired with no listener and the UI stuck on the 'disconnected' fallback.
    const { sm, statusEvents } = setup();
    await sm.activate('a');
    const states = statusEvents.filter((e) => e.projectId === 'a').map((e) => e.state);
    expect(states).toContain('connected');
  });

  it('emits disconnected then connected again across disconnect/reconnect', async () => {
    const { sm, statusEvents } = setup();
    await sm.activate('a');
    await sm.disconnect('a');
    await sm.reconnect('a');
    const states = statusEvents.filter((e) => e.projectId === 'a').map((e) => e.state);
    // connected (activate) -> disconnected (disconnect) -> connected (reconnect)
    expect(states).toContain('disconnected');
    expect(states.lastIndexOf('connected')).toBeGreaterThan(states.indexOf('disconnected'));
  });

  it('does not cache a provider whose connect() fails; a retry reconnects', async () => {
    // First-created provider fails its connect; later ones succeed. Mirrors a
    // remote SSH connect that fails (e.g. bad host) then succeeds after an edit.
    let first = true;
    const { sm, createdAll } = setup((p) => {
      if (first) {
        first = false;
        p.failNextConnect = new Error('boom: connect failed');
      }
    });

    await expect(sm.activate('a')).rejects.toThrow('boom');
    // The dead provider must NOT remain cached, or Reconnect returns it and
    // never retries (the "Reconnect button does nothing" bug).
    expect(sm.activeProjectId()).toBeNull();

    // Retry: open() must build a NEW provider and connect it.
    const p2 = await sm.activate('a');
    expect(p2.status().state).toBe('connected');
    expect(createdAll.length).toBe(2);
    expect(createdAll[0]!.connectAttempts).toBe(1); // failed once, evicted
    expect(createdAll[1]!.connectAttempts).toBe(1); // fresh provider connected
  });

  it('activate() records the active project and keeps backgrounded ones live', async () => {
    const { sm, persistActive } = setup();
    await sm.activate('a');
    expect(sm.activeProjectId()).toBe('a');
    expect(persistActive).toHaveBeenLastCalledWith('a');

    await sm.activate('b');
    // a stays fully live (still in the map, still connected) — no suspend.
    expect(sm.get('a')!.status().state).toBe('connected');
    expect(sm.getActive()).toBe(sm.get('b'));
    expect(persistActive).toHaveBeenLastCalledWith('b');
    expect(sm.listOpen().sort()).toEqual(['a', 'b']);
  });

  it('reuses an existing session instead of recreating', async () => {
    const { sm } = setup();
    const first = await sm.open('a');
    const second = await sm.activate('a');
    expect(second).toBe(first);
  });

  it('close() drops a session and clears active when it was active', async () => {
    const { sm, persistActive } = setup();
    await sm.activate('a');
    await sm.close('a');
    expect(sm.get('a')).toBeUndefined();
    expect(sm.activeProjectId()).toBeNull();
    expect(persistActive).toHaveBeenLastCalledWith(null);
  });

  it('throws when no spec resolves for a project', async () => {
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => new FakeProvider(projectId));
    const sm = new SessionManager(registry, { loadSpec: () => null, persistActive: vi.fn() });
    await expect(sm.open('x')).rejects.toThrow(/no project/i);
  });

  it('disconnect() sets state=disconnected but KEEPS the project selected (activeId unchanged)', async () => {
    const { sm, created, persistActive } = setup();
    await sm.activate('a');
    expect(sm.activeProjectId()).toBe('a');

    await sm.disconnect('a');

    // Provider disconnected
    expect(created.get('a')!.status().state).toBe('disconnected');
    // activeId is still 'a' (not cleared like close() does)
    expect(sm.activeProjectId()).toBe('a');
    // persistActive was NOT called again for null (only called on activate)
    const calls = persistActive.mock.calls;
    expect(calls[calls.length - 1]).toEqual(['a']);
    // Provider is still in the session map
    expect(sm.get('a')).toBeDefined();
  });

  it('disconnect() on a non-existent session is a no-op', async () => {
    const { sm } = setup();
    await expect(sm.disconnect('nonexistent')).resolves.toBeUndefined();
  });

  it('reconnect() evicts stale provider and builds a fresh connected one', async () => {
    const { sm, created, createdAll } = setup();
    await sm.activate('a');

    const originalProvider = created.get('a')!;
    expect(originalProvider.status().state).toBe('connected');

    await sm.reconnect('a');

    // A new provider was created (original was evicted + disconnected)
    expect(createdAll.length).toBe(2);
    const newProvider = createdAll[1]!;
    expect(newProvider.status().state).toBe('connected');
    expect(newProvider.connectAttempts).toBe(1);
    // The stale provider was disconnected
    expect(originalProvider.status().state).toBe('disconnected');
    // activeId is still 'a'
    expect(sm.activeProjectId()).toBe('a');
    // The session map now holds the new provider
    expect(sm.get('a')).toBe(newProvider);
  });

  it('reconnect() on a disconnected (no cached) session still connects fresh', async () => {
    const { sm, createdAll } = setup();
    // No prior activate — sessions map is empty
    await sm.reconnect('a');
    expect(createdAll.length).toBe(1);
    expect(createdAll[0]!.status().state).toBe('connected');
    expect(sm.activeProjectId()).toBe('a');
  });
});

describe('SessionManager session-owned watch lifecycle (FR7/NFR1)', () => {
  function setupWatch() {
    const created = new Map<string, FakeProvider>();
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => {
      const p = new FakeProvider(projectId, 'local');
      created.set(projectId, p);
      return p;
    });
    const watchEvents: Array<{ projectId: string; paths: string[] }> = [];
    const spec: ConnectionSpec = { kind: 'local', rootPath: '/repo' };
    const sm = new SessionManager(registry, {
      loadSpec: () => spec,
      persistActive: vi.fn(),
      onWatch: (projectId, event) => watchEvents.push({ projectId, paths: event.paths }),
    });
    return { sm, created, watchEvents };
  }

  it('starts one watch per live session on connect and forwards tagged events', async () => {
    const { sm, created, watchEvents } = setupWatch();
    await sm.open('a');
    await sm.open('b');
    // Two live sessions => exactly two watch subscriptions, no polling.
    expect(sm.watchSubCount()).toBe(2);

    created.get('b')!.emitWatch(['x.ts']);
    expect(watchEvents).toEqual([{ projectId: 'b', paths: ['x.ts'] }]);
  });

  it('stops the watch on a plain disconnect (status edge, no eviction)', async () => {
    const { sm } = setupWatch();
    await sm.activate('a');
    expect(sm.watchSubCount()).toBe(1);
    // disconnect() keeps the session in the map and does NOT fire onEviction;
    // the watch must still be torn down via the status->disconnected edge.
    await sm.disconnect('a');
    expect(sm.watchSubCount()).toBe(0);
  });

  it('stops the watch on close() (eviction path)', async () => {
    const { sm } = setupWatch();
    await sm.activate('a');
    expect(sm.watchSubCount()).toBe(1);
    await sm.close('a');
    expect(sm.watchSubCount()).toBe(0);
  });

  it('re-establishes a watch on reconnect (one sub, no clobber)', async () => {
    const { sm } = setupWatch();
    await sm.activate('a');
    await sm.reconnect('a');
    expect(sm.watchSubCount()).toBe(1);
  });
});

describe('SessionManager active-external-worktree watch lifecycle (local_repo_explorer-g1je)', () => {
  function setupWorktreeWatch(rootPath = '/repo', onCreate?: (p: FakeProvider) => void) {
    const created = new Map<string, FakeProvider>();
    const registry = new ProviderRegistry();
    registry.register('local', ({ projectId }) => {
      const p = new FakeProvider(projectId, 'local');
      created.set(projectId, p);
      onCreate?.(p);
      return p;
    });
    const watchEvents: Array<{ projectId: string; paths: string[]; worktreePath?: string }> = [];
    const spec: ConnectionSpec = { kind: 'local', rootPath };
    const sm = new SessionManager(registry, {
      loadSpec: () => spec,
      persistActive: vi.fn(),
      onWatch: (projectId, event, worktreePath) =>
        watchEvents.push({ projectId, paths: event.paths, worktreePath }),
    });
    return { sm, created, watchEvents };
  }

  describe('path classification (external vs nested-under-base vs equal-to-base)', () => {
    it('establishes an extra watch for a worktree EXTERNAL to the project root, alongside the primary watch, and forwards tagged events', async () => {
      const { sm, created, watchEvents } = setupWorktreeWatch();
      await sm.activate('a');
      expect(sm.worktreeWatchSubCount()).toBe(0);
      expect(sm.watchSubCount()).toBe(1); // primary watch already live

      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      expect(sm.watchSubCount()).toBe(1); // primary watch untouched

      // FakeProvider.emitWatch() with no token broadcasts to every active
      // subscription; the WORKTREE subscription's own closure tags its event
      // with worktreePath, the PRIMARY subscription's does not.
      created.get('a')!.emitWatch(['data.json']);
      expect(watchEvents).toContainEqual({
        projectId: 'a',
        paths: ['data.json'],
        worktreePath: '/sibling-wt',
      });
      expect(watchEvents).toContainEqual({ projectId: 'a', paths: ['data.json'], worktreePath: undefined });
    });

    it('does NOT establish an extra watch when the active worktree IS the project root', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/repo');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('does NOT establish an extra watch when the active worktree is NESTED under the project root', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/repo/.worktrees/feature');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('treats a trailing-slash root/worktree path as equal to its normalized form (no spurious extra watch)', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/repo/');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });
  });

  describe('establish / replace / no-op / teardown', () => {
    it('replaces the extra watch when the selection switches to a DIFFERENT external worktree (still exactly one)', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-1');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.setActiveWorktree('a', '/sibling-2');
      expect(sm.worktreeWatchSubCount()).toBe(1);
    });

    it('is a no-op when called again with the identical target (no churn)', async () => {
      const { sm, created } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      const provider = created.get('a')!;
      const subscribeSpy = vi.spyOn(provider, 'subscribeWorktreeWatch');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      expect(subscribeSpy).not.toHaveBeenCalled(); // no re-subscribe on a same-target call
    });

    it('tears down the extra watch when the selection moves back to the root/nested (external -> non-external)', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.setActiveWorktree('a', '/repo');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('tears down the extra watch when the selection clears to null', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.setActiveWorktree('a', null);
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('establishes nothing for a session that is not yet live (no cached provider)', async () => {
      const { sm } = setupWorktreeWatch();
      // No open()/activate() — 'a' has no session yet.
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('establishes nothing for an unknown project (no spec resolves)', async () => {
      const registry = new ProviderRegistry();
      registry.register('local', ({ projectId }) => new FakeProvider(projectId));
      const sm = new SessionManager(registry, { loadSpec: () => null, persistActive: vi.fn() });
      await expect(sm.setActiveWorktree('x', '/sibling-wt')).resolves.toBeUndefined();
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });
  });

  describe('symmetric teardown (disconnect / eviction / closeAll)', () => {
    it('stops the extra watch on a plain disconnect (status edge, no eviction) alongside the primary watch', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.disconnect('a');
      expect(sm.worktreeWatchSubCount()).toBe(0);
      expect(sm.watchSubCount()).toBe(0);
    });

    it('stops the extra watch on close() (eviction path)', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.close('a');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('stops the extra watch on reconnect() (eviction path) — a fresh provider starts with no worktree selection', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      await sm.reconnect('a');
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });

    it('closeAll() tears down every project\'s extra watch alongside every primary watch', async () => {
      const { sm } = setupWorktreeWatch();
      await sm.activate('a');
      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);
      expect(sm.watchSubCount()).toBe(1);
      await sm.closeAll();
      expect(sm.worktreeWatchSubCount()).toBe(0);
      expect(sm.watchSubCount()).toBe(0);
    });

    it("closeAll() tears down an extra watch even for a project whose PRIMARY watch never established (union-of-keys teardown)", async () => {
      // Forces the "primary watch absent, worktree watch present" shape a
      // union-of-watchSubs-keys-only closeAll would miss: subscribeWatch is
      // patched to fail BEFORE activate(), so startWatch's best-effort catch
      // (electron/main/providers/sessionManager.ts) leaves watchSubs empty
      // for this project, while setActiveWorktree's OWN subscribeWorktreeWatch
      // call still succeeds normally afterward.
      const { sm, created } = setupWorktreeWatch('/repo', (p) => {
        p.subscribeWatch = async () => {
          throw new Error('boom: primary watch unavailable');
        };
      });
      await sm.activate('a');
      expect(sm.watchSubCount()).toBe(0); // primary watch failed to establish
      expect(created.get('a')).toBeDefined();

      await sm.setActiveWorktree('a', '/sibling-wt');
      expect(sm.worktreeWatchSubCount()).toBe(1);

      await sm.closeAll();
      expect(sm.worktreeWatchSubCount()).toBe(0);
    });
  });

  describe('in-flight guard (mirrors startWatch\'s in-flight-eviction pattern)', () => {
    it('a NEWER setActiveWorktree call supersedes an older one still resolving (rapid worktree switching): only the newer target survives, the stale one unsubscribes itself', async () => {
      const { sm, created } = setupWorktreeWatch();
      await sm.activate('a');
      const provider = created.get('a')!;

      // Defer the FIRST subscribeWorktreeWatch call so a second, newer call
      // can be issued and complete before the first one resolves.
      let releaseFirst: (() => void) | null = null;
      let callCount = 0;
      const original = provider.subscribeWorktreeWatch.bind(provider);
      provider.subscribeWorktreeWatch = async (worktreePath, handler) => {
        callCount += 1;
        if (callCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return original(worktreePath, handler);
      };

      const firstCall = sm.setActiveWorktree('a', '/sibling-1'); // in flight, deferred
      await sm.setActiveWorktree('a', '/sibling-2'); // supersedes before the first resolves

      expect(sm.worktreeWatchSubCount()).toBe(1); // the NEWER target's sub only

      // Release the first call's deferred subscribe; its subscription must
      // be unsubscribed immediately as stale, not clobber the newer one.
      releaseFirst?.();
      await firstCall;

      expect(sm.worktreeWatchSubCount()).toBe(1); // still exactly one
    });

    it('a session evicted while subscribeWorktreeWatch is in flight does not leak the subscription', async () => {
      const { sm, created } = setupWorktreeWatch();
      await sm.activate('a');
      const provider = created.get('a')!;

      let subscribed: WatchSubscription | null = null;
      let releaseSubscribe: (() => void) | null = null;
      let signalEntered: (() => void) | null = null;
      // Resolves the INSTANT subscribeWorktreeWatch is entered (before ITS
      // OWN internal await) — awaiting this in the test (rather than a fixed
      // number of microtask ticks after issuing the call) is what guarantees
      // close() below only runs once setActiveWorktree has ALREADY read a
      // live provider and is genuinely suspended inside the subscribe call,
      // reproducing the real eviction-mid-subscribe race deterministically.
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const original = provider.subscribeWorktreeWatch.bind(provider);
      provider.subscribeWorktreeWatch = async (worktreePath, handler) => {
        signalEntered?.();
        await new Promise<void>((resolve) => {
          releaseSubscribe = resolve;
        });
        const sub = await original(worktreePath, handler);
        subscribed = sub;
        return sub;
      };

      const inFlight = sm.setActiveWorktree('a', '/sibling-wt');
      await entered;
      await sm.close('a'); // evicts the session while subscribeWorktreeWatch is still pending
      releaseSubscribe?.();
      await inFlight;

      expect(sm.worktreeWatchSubCount()).toBe(0);
      expect(subscribed).not.toBeNull();
    });
  });
});

describe('SessionManager activity tracker (idle aging-out)', () => {
  it('open() seeds the activity clock with the injected now()', async () => {
    let t = 1000;
    const { sm } = setupClock(() => t);
    await sm.open('a');
    expect(sm.activityOf('a')).toBe(1000);
  });

  it('touch() refreshes the activity clock to the current now()', async () => {
    let t = 1000;
    const { sm } = setupClock(() => t);
    await sm.open('a');
    t = 5000;
    sm.touch('a');
    expect(sm.activityOf('a')).toBe(5000);
  });

  it('activityOf() is undefined for an unknown session', () => {
    const { sm } = setupClock(() => 0);
    expect(sm.activityOf('nope')).toBeUndefined();
  });

  it('statusOf() returns the provider status, undefined when no session', async () => {
    const { sm } = setupClock(() => 0);
    expect(sm.statusOf('a')).toBeUndefined();
    await sm.open('a');
    expect(sm.statusOf('a')?.state).toBe('connected');
  });

  it('close() drops the activity entry', async () => {
    const { sm } = setupClock(() => 1000);
    await sm.activate('a');
    await sm.close('a');
    expect(sm.activityOf('a')).toBeUndefined();
  });

  it('close(detail) forwards a final disconnected status carrying the cue', async () => {
    const { sm, statusEvents } = setupClock(() => 1000);
    await sm.open('a');
    await sm.close('a', 'idle — aged out');
    const last = statusEvents.filter((e) => e.projectId === 'a').at(-1);
    expect(last?.status.state).toBe('disconnected');
    expect(last?.status.detail).toBe('idle — aged out');
  });
});

describe('SessionManager eviction lifecycle (D2 / FR5)', () => {
  it('onEviction fires before reconnect builds a new provider (D2 regression)', async () => {
    // The IPC layer subscribes to eviction to dispose stale tmuxDisposers/tmuxControl.
    // This test asserts that:
    //   1. The eviction listener fires with the correct projectId on reconnect.
    //   2. It fires BEFORE the new provider is created (so the IPC layer can
    //      dispose stale subscriptions before the new manager tries to wire).
    const { sm, createdAll } = setup();
    await sm.activate('a');

    const evictionEvents: string[] = [];
    const off = sm.onEviction((pid) => evictionEvents.push(pid));

    await sm.reconnect('a');

    expect(evictionEvents).toEqual(['a']);
    // A second provider was created after the eviction.
    expect(createdAll.length).toBe(2);
    off();
  });

  it('onEviction fires on close()', async () => {
    const { sm } = setup();
    await sm.activate('a');
    const evictions: string[] = [];
    const off = sm.onEviction((pid) => evictions.push(pid));
    await sm.close('a');
    expect(evictions).toEqual(['a']);
    off();
  });

  it('onEviction fires on failed-connect eviction', async () => {
    let first = true;
    const { sm } = setup((p) => {
      if (first) {
        first = false;
        p.failNextConnect = new Error('boom');
      }
    });
    const evictions: string[] = [];
    const off = sm.onEviction((pid) => evictions.push(pid));
    await expect(sm.activate('a')).rejects.toThrow('boom');
    expect(evictions).toEqual(['a']);
    off();
  });

  it('onEviction NOT fired on plain disconnect() (provider kept in map)', async () => {
    // disconnect() keeps the provider alive in the session map; no eviction.
    const { sm } = setup();
    await sm.activate('a');
    const evictions: string[] = [];
    const off = sm.onEviction((pid) => evictions.push(pid));
    await sm.disconnect('a');
    expect(evictions).toEqual([]); // no eviction on disconnect-in-place
    off();
  });

  it('onEviction unsubscribe stops future notifications', async () => {
    const { sm } = setup();
    await sm.activate('a');
    const evictions: string[] = [];
    const off = sm.onEviction((pid) => evictions.push(pid));
    off(); // unsubscribe before reconnect
    await sm.reconnect('a');
    expect(evictions).toHaveLength(0);
  });

  it('IPC cache disposal pattern: stale disposer replaced by new one after reconnect', async () => {
    // Simulates what the IPC layer does: subscribe to eviction to dispose the
    // stale tmux notification forwarder, and wire a new one on next activeControl.
    const { sm, createdAll } = setup();
    await sm.activate('a');

    // Simulate IPC layer's tmuxDisposers map.
    const fakeDisposers = new Map<string, () => void>();
    const disposeCalled: string[] = [];

    // Wire a fake "old" disposer as if activeControl() had wired it.
    fakeDisposers.set('a', () => disposeCalled.push('old-a'));

    // Subscribe to eviction — mirrors what registerIpc does.
    sm.onEviction((pid) => {
      const stale = fakeDisposers.get(pid);
      if (stale) {
        stale();
        fakeDisposers.delete(pid);
      }
    });

    await sm.reconnect('a');

    // The stale disposer was called on eviction.
    expect(disposeCalled).toContain('old-a');
    // The IPC entry was removed (the new provider can wire a fresh one).
    expect(fakeDisposers.has('a')).toBe(false);

    // New provider exists and is fresh.
    expect(createdAll.length).toBe(2);
  });
});
