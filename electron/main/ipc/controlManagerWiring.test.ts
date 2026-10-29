/**
 * Behavior of the IPC handlers around callback injection, driven through the
 * real `registerIpc` with its collaborators replaced by recorders:
 *
 *  - A local session reports `connected` BEFORE its callback socket is bound, and
 *    the renderer's terminal and control-mode IPC addresses the provider directly
 *    (not through `SessionManager.open()`). Every local creation/attach handler
 *    must therefore wait for `sessionManager.callbackReady()` BEFORE it builds or
 *    opens anything, or an attach could carry no socket and the server-wide
 *    `update-environment` entries would strip the values the session already held.
 *    A remote session has nothing to wait for.
 *  - The lazily created control-mode manager takes its `deterministicSessionNames`
 *    gate from ONE settings read at creation, and is discarded and rebuilt (with a
 *    NEW read) on `tmuxControl.close` and on eviction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '@shared/ipc/channels';

interface FakeManager {
  opens: unknown[];
  closes: number;
  open(opts: unknown): void;
  close(): void;
  killSession(): void;
  sessionName(): string;
  onNotification(): () => void;
  command(): Promise<{ num: number; error: boolean; lines: string[] }>;
}

const h = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (e: unknown, req?: unknown) => Promise<unknown>>(),
    evictionListeners: [] as Array<(projectId: string) => void>,
    // `deterministicSessionNames` is read through a counting getter (see `setting`).
    settings: { deterministicSessionNames: false, tmuxPauseMode: false },
    gateReads: 0,
    sessions: new Map<string, unknown>(),
    active: null as string | null,
    readiness: new Map<string, Promise<void>>(),
    readyCalls: [] as string[],
    created: [] as Array<{
      input: {
        projectId: string;
        rootPath: string;
        deterministicSessionNames: boolean;
        callbackEnvironment: { projectId?: string };
      };
      mgr: unknown;
    }>,
  };
  class RemoteProvider {
    readonly kind = 'remote' as const;
    readonly manager = {
      opens: 0,
      open: async (): Promise<void> => {
        this.manager.opens += 1;
      },
      close: (): void => undefined,
      onNotification: (): (() => void) => () => undefined,
      command: async () => ({ num: 0, error: false, lines: [] as string[] }),
      onOutputActivity: undefined as undefined | (() => void),
      onUnresponsive: undefined as undefined | (() => void),
    };
    readonly openTerminal = vi.fn(async (opts: { key?: string }) => ({ id: opts.key ?? 't' }));
    constructor(readonly projectId: string) {}
    tmuxControl() {
      return this.manager;
    }
    tmuxControlSessionName(): string {
      return `agent-cockpit-${this.projectId}`;
    }
    onTerminalData = (): (() => void) => () => undefined;
    onTerminalExit = (): (() => void) => () => undefined;
  }
  return { ...state, RemoteProvider };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, req?: unknown) => Promise<unknown>) => {
      h.handlers.set(channel, fn);
    },
  },
}));
vi.mock('../providers', () => ({
  sessionManager: {
    setStatusListener: () => undefined,
    setWatchListener: () => undefined,
    onEviction: (fn: (projectId: string) => void) => {
      h.evictionListeners.push(fn);
      return () => undefined;
    },
    get: (id: string) => h.sessions.get(id),
    getActive: () => (h.active ? h.sessions.get(h.active) : undefined),
    callbackReady: (id: string) => {
      h.readyCalls.push(id);
      return h.readiness.get(id) ?? Promise.resolve();
    },
    touch: () => undefined,
  },
  // registerIpc forwards the broker's classified opens to the renderer; this suite
  // never emits one.
  callbackBroker: { onOpen: () => () => undefined },
  // A distinct source per call, tagged with the project it was built for.
  localCallbackEnvironment: (projectId: string) => Object.assign(() => undefined, { projectId }),
}));
vi.mock('../providers/local/controlManager', () => ({
  createLocalControlManager: (input: (typeof h.created)[number]['input']) => {
    const mgr: FakeManager = {
      opens: [],
      closes: 0,
      open(opts) {
        this.opens.push(opts);
      },
      close() {
        this.closes += 1;
      },
      killSession() {
        this.closes += 1;
      },
      sessionName: () => `agent-cockpit-${input.projectId}`,
      onNotification: () => () => undefined,
      command: async () => ({ num: 0, error: false, lines: [] }),
    };
    h.created.push({ input, mgr });
    return mgr;
  },
}));
vi.mock('../providers/remote', () => ({ RemoteProvider: h.RemoteProvider }));
vi.mock('../store/projects', () => ({
  addProject: () => undefined,
  getProject: (id: string) => ({ id, connection: { kind: 'local', rootPath: `/repo/${id}` } }),
  listProjects: () => [],
  removeProject: () => undefined,
  reorderProjects: () => undefined,
  setActiveProjectId: () => undefined,
  setProjectRunCommand: () => undefined,
  getActiveProjectId: () => null,
  touchProject: () => undefined,
  relabelRemoteProjects: () => undefined,
  updateProject: () => undefined,
}));
vi.mock('../store/notes', () => ({
  createNote: () => undefined,
  deleteNote: () => undefined,
  exportNotesMarkdown: () => '',
  listNotes: () => [],
  updateNote: () => undefined,
}));
vi.mock('../config', () => ({
  loadSettings: () => h.settings,
  saveSettings: () => h.settings,
}));
vi.mock('../fonts', () => ({ listSystemFonts: async () => [] }));
vi.mock('../sessions', () => ({
  killCockpitSession: () => undefined,
  killDetachedCockpitSessions: () => undefined,
  listCockpitSessions: () => [],
}));

import { registerIpc } from './index';

function localProvider(projectId: string) {
  return {
    kind: 'local' as const,
    projectId,
    openTerminal: vi.fn(async (opts: { key?: string }) => ({ id: opts.key ?? 't' })),
    splitMuxTerminal: vi.fn(async (_source: string, id: string) => ({ id })),
    newMuxWindow: vi.fn(async (_source: string, id: string) => ({ id })),
    onTerminalData: () => () => undefined,
    onTerminalExit: () => () => undefined,
  };
}

const call = (channel: string, req?: unknown): Promise<unknown> => {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  return handler({}, req);
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

let locals: Record<string, ReturnType<typeof localProvider>>;

beforeEach(() => {
  h.handlers.clear();
  h.evictionListeners.length = 0;
  h.sessions.clear();
  h.readiness.clear();
  h.readyCalls.length = 0;
  h.created.length = 0;
  h.active = null;
  h.gateReads = 0;
  let gate = false;
  Object.defineProperty(h.settings, 'deterministicSessionNames', {
    configurable: true,
    enumerable: true,
    get: () => {
      h.gateReads += 1;
      return gate;
    },
    set: (value: boolean) => {
      gate = value;
    },
  });
  locals = { p1: localProvider('p1'), p2: localProvider('p2') };
  for (const [id, provider] of Object.entries(locals)) h.sessions.set(id, provider);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  registerIpc(
    () => null,
    () => undefined,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('control-mode open waits for the local callback socket', () => {
  it('builds and opens nothing until the pending bind has settled', async () => {
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const opened = call(Channels.tmuxControlOpen, { cols: 100, rows: 30, projectId: 'p1' });
    await flush();
    expect(h.readyCalls).toEqual(['p1']);
    expect(h.created).toHaveLength(0); // not even the manager exists yet
    gate.resolve();
    await expect(opened).resolves.toEqual({ sessionName: 'agent-cockpit-p1' });
    expect(h.created).toHaveLength(1);
    expect((h.created[0]!.mgr as FakeManager).opens).toEqual([{ cols: 100, rows: 30 }]);
  });

  it('waits only on the ADDRESSED project, not on another one that is still binding', async () => {
    const slow = deferred();
    h.readiness.set('p2', slow.promise); // p2 is still binding
    await expect(call(Channels.tmuxControlOpen, { projectId: 'p1' })).resolves.toBeDefined();
    expect(h.readyCalls).toEqual(['p1']);
    expect(h.created.map((c) => c.input.projectId)).toEqual(['p1']);
    slow.resolve();
  });

  it('pins an ambient request to the project that was active when it arrived, across the wait', async () => {
    h.active = 'p1';
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const opened = call(Channels.tmuxControlOpen, {}); // no projectId: ambient
    await flush();
    h.active = 'p2'; // the active project changes while the bind is pending
    gate.resolve();
    await opened;
    expect(h.readyCalls).toEqual(['p1']);
    expect(h.created.map((c) => c.input.projectId)).toEqual(['p1']);
    expect((h.created[0]!.mgr as FakeManager).opens).toHaveLength(1);
  });

  it('does not open a session that was evicted while it waited', async () => {
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const opened = call(Channels.tmuxControlOpen, { projectId: 'p1' });
    await flush();
    h.sessions.delete('p1'); // the session ended during the wait
    gate.resolve();
    await expect(opened).rejects.toMatchObject({ kind: 'session-gone', projectId: 'p1' });
    expect(h.created).toHaveLength(0);
  });

  it("never waits for, or delays, a remote session's attach", async () => {
    const remote = new h.RemoteProvider('r1');
    h.sessions.set('r1', remote);
    h.readiness.set('r1', new Promise<void>(() => undefined)); // would hang if consulted
    await expect(call(Channels.tmuxControlOpen, { projectId: 'r1' })).resolves.toEqual({
      sessionName: 'agent-cockpit-r1',
    });
    expect(h.readyCalls).toEqual([]);
    expect(remote.manager.opens).toBe(1);
  });
});

describe('terminal creation waits for the local callback socket', () => {
  it('terminal open: provider.openTerminal runs only after the bind settled', async () => {
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const opened = call(Channels.terminalOpen, { projectId: 'p1', opts: { key: 't1' } });
    await flush();
    expect(h.readyCalls).toEqual(['p1']);
    expect(locals['p1']!.openTerminal).not.toHaveBeenCalled();
    gate.resolve();
    await expect(opened).resolves.toEqual({ terminalId: 't1' });
    expect(locals['p1']!.openTerminal).toHaveBeenCalledTimes(1);
  });

  it('mux split: runs only after the bind settled', async () => {
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const split = call(Channels.terminalSplit, {
      projectId: 'p1',
      sourceId: 't1',
      terminalId: 't2',
      direction: 'vertical',
    });
    await flush();
    expect(locals['p1']!.splitMuxTerminal).not.toHaveBeenCalled();
    gate.resolve();
    await expect(split).resolves.toEqual({ terminalId: 't2' });
    expect(locals['p1']!.splitMuxTerminal).toHaveBeenCalledTimes(1);
  });

  it('mux new window: runs only after the bind settled', async () => {
    const gate = deferred();
    h.readiness.set('p1', gate.promise);
    const created = call(Channels.terminalNewWindow, {
      projectId: 'p1',
      sourceId: 't1',
      terminalId: 't3',
    });
    await flush();
    expect(locals['p1']!.newMuxWindow).not.toHaveBeenCalled();
    gate.resolve();
    await expect(created).resolves.toEqual({ terminalId: 't3' });
    expect(locals['p1']!.newMuxWindow).toHaveBeenCalledTimes(1);
  });

  it('a remote session is never held back', async () => {
    const remote = new h.RemoteProvider('r1');
    h.sessions.set('r1', remote);
    h.readiness.set('r1', new Promise<void>(() => undefined)); // would hang if consulted
    await expect(
      call(Channels.terminalOpen, { projectId: 'r1', opts: { key: 'rt' } }),
    ).resolves.toEqual({ terminalId: 'rt' });
    expect(h.readyCalls).toEqual([]);
  });
});

describe('the control-mode manager and its shared-session gate', () => {
  it("is built for the addressed project with that project's own callback source", async () => {
    await call(Channels.tmuxControlOpen, { projectId: 'p2' });
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.input).toMatchObject({ projectId: 'p2', rootPath: '/repo/p2' });
    expect(h.created[0]!.input.callbackEnvironment.projectId).toBe('p2');
  });

  it('takes the gate from ONE settings read at creation, and keeps it while the manager lives', async () => {
    h.settings.deterministicSessionNames = true;
    h.gateReads = 0;
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    expect(h.created[0]!.input.deterministicSessionNames).toBe(true);
    expect(h.gateReads).toBe(1); // the one read that names the session and decides the gate

    h.settings.deterministicSessionNames = false; // toggled while the manager is cached
    h.gateReads = 0;
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    expect(h.created).toHaveLength(1); // no rebuild...
    expect(h.gateReads).toBe(0); // ...and no new read
  });

  it('rebuilds with a NEW settings read after tmuxControl.close', async () => {
    h.settings.deterministicSessionNames = true;
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    h.settings.deterministicSessionNames = false;
    await call(Channels.tmuxControlClose, { projectId: 'p1' });
    expect((h.created[0]!.mgr as FakeManager).closes).toBe(1);

    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.input.deterministicSessionNames).toBe(false);
    expect(h.created[1]!.mgr).not.toBe(h.created[0]!.mgr);
  });

  it('rebuilds with a NEW settings read after the session is evicted', async () => {
    h.settings.deterministicSessionNames = true;
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    for (const listener of h.evictionListeners) listener('p1');
    expect((h.created[0]!.mgr as FakeManager).closes).toBe(1);

    h.settings.deterministicSessionNames = false;
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    expect(h.created).toHaveLength(2);
    expect(h.created[1]!.input.deterministicSessionNames).toBe(false);
  });

  it('keeps one manager per project', async () => {
    await call(Channels.tmuxControlOpen, { projectId: 'p1' });
    await call(Channels.tmuxControlOpen, { projectId: 'p2' });
    expect(h.created.map((c) => c.input.projectId)).toEqual(['p1', 'p2']);
    expect(h.created[0]!.mgr).not.toBe(h.created[1]!.mgr);
  });
});
