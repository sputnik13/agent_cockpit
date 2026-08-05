import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Captures every handler `agentCockpit.events.onWatch` is given, mirroring
 *  the real preload bridge's `on()` shape (subscribe returns an unsubscribe
 *  that removes the same handler). `emit` drives a synthetic raw event
 *  through every currently-registered handler, exactly like the real IPC
 *  push would. */
const handlers: Array<(e: unknown) => void> = [];
const mockOnWatch = vi.fn((h: (e: unknown) => void) => {
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
});

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: {
    events: { onWatch: (h: (e: unknown) => void) => mockOnWatch(h) },
  },
}));

import { subscribeWatch, type HubWatchEvent } from './hub';

function emit(raw: {
  projectId?: string;
  worktreePath?: string;
  event?: { paths?: string[]; at?: string };
}): void {
  for (const h of [...handlers]) h(raw);
}

beforeEach(() => {
  handlers.length = 0;
  mockOnWatch.mockClear();
});

describe('watch hub (src/renderer/watch/hub.ts)', () => {
  it('attaches the provider listener on the first subscriber and detaches it after the last unsubscribe', () => {
    const onEvent = vi.fn();
    const off = subscribeWatch({ interest: ['working-tree'], onEvent });
    expect(mockOnWatch).toHaveBeenCalledTimes(1);

    off();
    // A raw event emitted after the last unsubscribe must reach no handler
    // (the hub detached its own provider subscription).
    emit({ projectId: 'p1', event: { paths: ['a.ts'], at: 't' } });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('a second concurrent subscriber does not attach a second provider listener', () => {
    const off1 = subscribeWatch({ interest: ['working-tree'], onEvent: vi.fn() });
    const off2 = subscribeWatch({ interest: ['beads'], onEvent: vi.fn() });
    expect(mockOnWatch).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });

  it('routes an event only to subscribers whose interest intersects its classified categories', () => {
    const workingTree = vi.fn();
    const beads = vi.fn();
    const off1 = subscribeWatch({ interest: ['working-tree'], onEvent: workingTree });
    const off2 = subscribeWatch({ interest: ['beads'], onEvent: beads });

    emit({ projectId: 'p1', event: { paths: ['.beads/beads.db'], at: 't' } });

    expect(beads).toHaveBeenCalledTimes(1);
    expect(workingTree).not.toHaveBeenCalled();
    off1();
    off2();
  });

  describe('worktreePath passthrough (local_repo_explorer-g1je)', () => {
    it('a TAGGED raw event (the active-external-worktree watch shape) carries worktreePath through to HubWatchEvent unchanged', () => {
      const onEvent = vi.fn();
      const off = subscribeWatch({ interest: ['working-tree'], onEvent });

      emit({ projectId: 'p1', worktreePath: '/sibling-wt', event: { paths: ['data.json'], at: 't' } });

      expect(onEvent).toHaveBeenCalledTimes(1);
      const received = onEvent.mock.calls[0]![0] as HubWatchEvent;
      expect(received.projectId).toBe('p1');
      expect(received.worktreePath).toBe('/sibling-wt');
      expect(received.paths).toEqual(['data.json']);
      expect(received.categories).toEqual(['working-tree']);
      off();
    });

    it('an UNTAGGED raw event (the primary root-rooted watch shape) leaves HubWatchEvent.worktreePath undefined', () => {
      const onEvent = vi.fn();
      const off = subscribeWatch({ interest: ['working-tree'], onEvent });

      emit({ projectId: 'p1', event: { paths: ['data.json'], at: 't' } });

      expect(onEvent).toHaveBeenCalledTimes(1);
      const received = onEvent.mock.calls[0]![0] as HubWatchEvent;
      expect(received.worktreePath).toBeUndefined();
      off();
    });

    it('classification is unaffected by the tag — a tagged working-tree-shaped path still routes only to working-tree interest', () => {
      const workingTree = vi.fn();
      const beads = vi.fn();
      const off1 = subscribeWatch({ interest: ['working-tree'], onEvent: workingTree });
      const off2 = subscribeWatch({ interest: ['beads'], onEvent: beads });

      emit({ projectId: 'p1', worktreePath: '/sibling-wt', event: { paths: ['data.json'], at: 't' } });

      expect(workingTree).toHaveBeenCalledTimes(1);
      expect(beads).not.toHaveBeenCalled();
      off1();
      off2();
    });
  });
});
