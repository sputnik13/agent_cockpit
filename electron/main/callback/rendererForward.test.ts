import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallbackOpenPushEvent, WorktreeRecord } from '@shared/ipc/channels';
import { logger } from '../logger';
import { CallbackBroker, type CallbackOpenEvent } from './broker';
import { forwardCallbackOpens } from './rendererForward';

const worktree = (path: string): WorktreeRecord => ({
  path,
  branch: 'main',
  head: 'abc',
  locked: false,
  prunable: false,
  detached: false,
});

/** The smallest broker stand-in: lets a test emit exactly the event it wants. */
function fakeBroker(): {
  broker: Pick<CallbackBroker, 'onOpen'>;
  emit: (event: unknown) => void;
  listeners: () => number;
} {
  const listeners = new Set<(event: CallbackOpenEvent) => void>();
  return {
    broker: {
      onOpen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit: (event) => listeners.forEach((l) => l(event as CallbackOpenEvent)),
    listeners: () => listeners.size,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('forwardCallbackOpens (evt:callback-open, main leg)', () => {
  it('pushes {projectId, selection} for a classified open', () => {
    const { broker, emit } = fakeBroker();
    const deliver = vi.fn(() => true);
    forwardCallbackOpens(broker, deliver);
    emit({
      projectId: 'p1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo' },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({
      projectId: 'p1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo' },
    });
  });

  it('passes an external-file selection through unchanged', () => {
    const { broker, emit } = fakeBroker();
    const deliver = vi.fn(() => true);
    forwardCallbackOpens(broker, deliver);
    emit({
      projectId: 'p1',
      selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
    });
    expect(deliver).toHaveBeenCalledWith({
      projectId: 'p1',
      selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
    });
  });

  it('copies the selection field by field: pane attribution and a stray baseline never cross', () => {
    const { broker, emit } = fakeBroker();
    const payloads: CallbackOpenPushEvent[] = [];
    forwardCallbackOpens(broker, (payload) => {
      payloads.push(payload);
      return true;
    });
    emit({
      projectId: 'p1',
      pane: { kind: 'tmux', id: '%3' },
      selection: {
        kind: 'file',
        path: 'a.md',
        worktreePath: '/repo',
        baseline: 'HEAD',
        oldPath: 'b.md',
      },
    });
    expect(payloads).toHaveLength(1);
    expect(Object.keys(payloads[0]!).sort()).toEqual(['projectId', 'selection']);
    expect(Object.keys(payloads[0]!.selection).sort()).toEqual(['kind', 'path', 'worktreePath']);
    expect(payloads[0]!.selection).not.toHaveProperty('baseline');
  });

  it('logs a drop instead of staying silent when no live window can receive the push', () => {
    const { broker, emit } = fakeBroker();
    const warn = vi.spyOn(logger, 'warn');
    forwardCallbackOpens(broker, () => false);
    emit({ projectId: 'p1', selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo' } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /callback open dropped project=p1 .*no main window/,
    );
  });

  it('does not log when the push was delivered', () => {
    const { broker, emit } = fakeBroker();
    const warn = vi.spyOn(logger, 'warn');
    forwardCallbackOpens(broker, () => true);
    emit({ projectId: 'p1', selection: { kind: 'file', path: 'a', worktreePath: '' } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the unsubscribe: nothing is pushed after it is called', () => {
    const { broker, emit, listeners } = fakeBroker();
    const deliver = vi.fn(() => true);
    const off = forwardCallbackOpens(broker, deliver);
    expect(listeners()).toBe(1);
    off();
    expect(listeners()).toBe(0);
    emit({ projectId: 'p1', selection: { kind: 'file', path: 'a', worktreePath: '' } });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('forwardCallbackOpens with the real CallbackBroker', () => {
  function realBroker(): CallbackBroker {
    const roots: Record<string, string> = { a: '/repo-a', b: '/repo-b' };
    const providers = new Map(
      Object.entries(roots).map(([id, root]) => [
        id,
        { kind: 'local' as const, listWorktrees: vi.fn(async () => [worktree(root)]) },
      ]),
    );
    return new CallbackBroker({
      statusOf: () => ({ state: 'connected', since: '' }),
      providerOf: (id) => providers.get(id),
      projectRootOf: (id) => roots[id] ?? null,
      userDataDir: () => '/nonexistent',
      realpath: async (p) => p,
    });
  }

  const openOn = (broker: CallbackBroker, projectId: string, path: string): void => {
    broker.handle(projectId, {
      v: 1,
      id: 1,
      op: 'open',
      args: { path, canonicalPath: path },
    });
  };

  it('tags each push with the project that owns the socket the request arrived on, never ambient', async () => {
    const broker = realBroker();
    const payloads: CallbackOpenPushEvent[] = [];
    forwardCallbackOpens(broker, (payload) => {
      payloads.push(payload);
      return true;
    });
    openOn(broker, 'b', '/repo-b/notes/x.md');
    openOn(broker, 'a', '/repo-a/src/y.ts');
    await vi.waitFor(() => expect(payloads).toHaveLength(2));
    const byProject = Object.fromEntries(payloads.map((p) => [p.projectId, p.selection]));
    expect(byProject).toEqual({
      b: { kind: 'file', path: 'notes/x.md', worktreePath: '/repo-b' },
      a: { kind: 'file', path: 'src/y.ts', worktreePath: '/repo-a' },
    });
  });

  it('pushes an outside-the-project path as an external file with its logical path', async () => {
    const broker = realBroker();
    const payloads: CallbackOpenPushEvent[] = [];
    forwardCallbackOpens(broker, (payload) => {
      payloads.push(payload);
      return true;
    });
    openOn(broker, 'a', '/etc/hosts');
    await vi.waitFor(() => expect(payloads).toHaveLength(1));
    expect(payloads[0]).toEqual({
      projectId: 'a',
      selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
    });
  });

  it('pushes nothing for a request the broker rejects', async () => {
    const broker = realBroker();
    const deliver = vi.fn(() => true);
    forwardCallbackOpens(broker, deliver);
    broker.handle('a', { v: 1, id: 2, op: 'open', args: { path: 'relative/path.md' } });
    broker.handle('a', { v: 1, id: 3, op: 'review', args: { path: '/repo-a/a.md' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliver).not.toHaveBeenCalled();
  });
});
