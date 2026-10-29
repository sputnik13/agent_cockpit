/**
 * `evt:callback-open` through the real `registerIpc`: a classified open the
 * CallbackBroker emits reaches the MAIN window only, as `{projectId, selection}`
 * (scenario 16, main leg). The diagnostics window, which `broadcast()` would
 * reach, must never receive it: it has no Content panel to open a tab in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '@shared/ipc/channels';
import type { CallbackOpenEvent } from '../callback/broker';

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: { destroyed: boolean; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };
}

const h = vi.hoisted(() => {
  const fakeWindow = (): FakeWindow => {
    const win: FakeWindow = {
      destroyed: false,
      isDestroyed: () => win.destroyed,
      webContents: {
        destroyed: false,
        isDestroyed: () => win.webContents.destroyed,
        send: vi.fn(),
      },
    };
    return win;
  };
  return {
    fakeWindow,
    windows: [] as FakeWindow[],
    openListeners: new Set<(event: unknown) => void>(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => h.windows },
  dialog: {},
  ipcMain: { handle: () => undefined },
}));
vi.mock('../providers', () => ({
  sessionManager: {
    setStatusListener: () => undefined,
    setWatchListener: () => undefined,
    onEviction: () => () => undefined,
  },
  callbackBroker: {
    onOpen: (listener: (event: unknown) => void) => {
      h.openListeners.add(listener);
      return () => h.openListeners.delete(listener);
    },
  },
  localCallbackEnvironment: () => undefined,
}));
vi.mock('../store/projects', () => ({
  addProject: () => undefined,
  getProject: () => undefined,
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
  loadSettings: () => ({ deterministicSessionNames: false, tmuxPauseMode: false }),
  saveSettings: () => ({}),
}));
vi.mock('../fonts', () => ({ listSystemFonts: async () => [] }));
vi.mock('../sessions', () => ({
  killCockpitSession: () => undefined,
  killDetachedCockpitSessions: () => undefined,
  listCockpitSessions: () => [],
}));

import { logger } from '../logger';
import { registerIpc } from './index';

const emitOpen = (event: Partial<CallbackOpenEvent> & { projectId: string }): void => {
  for (const listener of h.openListeners) listener(event);
};

const callbackPushes = (win: FakeWindow): unknown[][] =>
  win.webContents.send.mock.calls.filter((call) => call[0] === Channels.evtCallbackOpen);

let main: FakeWindow;
let diagnostics: FakeWindow;

beforeEach(() => {
  h.openListeners.clear();
  main = h.fakeWindow();
  diagnostics = h.fakeWindow();
  h.windows.length = 0;
  h.windows.push(main, diagnostics);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('evt:callback-open wiring in registerIpc', () => {
  it('sends the classified open to the main window only, never to other windows', () => {
    registerIpc(
      () => main as never,
      () => undefined,
    );
    expect(h.openListeners.size).toBe(1);
    emitOpen({
      projectId: 'p2',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo-2' },
      pane: { kind: 'tmux', id: '%4' },
    });
    expect(callbackPushes(main)).toEqual([
      [
        Channels.evtCallbackOpen,
        { projectId: 'p2', selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo-2' } },
      ],
    ]);
    // Not a broadcast: the diagnostics window is among BrowserWindow.getAllWindows().
    expect(callbackPushes(diagnostics)).toEqual([]);
  });

  it('the channel name is the one the preload and the renderer subscribe to', () => {
    expect(Channels.evtCallbackOpen).toBe('evt:callback-open');
  });

  it('logs a drop and sends nothing when there is no main window', () => {
    const warn = vi.spyOn(logger, 'warn');
    registerIpc(
      () => null,
      () => undefined,
    );
    emitOpen({ projectId: 'p1', selection: { kind: 'file', path: 'a', worktreePath: '' } });
    expect(callbackPushes(main)).toEqual([]);
    expect(callbackPushes(diagnostics)).toEqual([]);
    expect(warn.mock.calls.some((c) => /callback open dropped project=p1/.test(String(c[0])))).toBe(
      true,
    );
  });

  it('sends nothing to a destroyed main window', () => {
    registerIpc(
      () => main as never,
      () => undefined,
    );
    main.destroyed = true;
    emitOpen({ projectId: 'p1', selection: { kind: 'file', path: 'a', worktreePath: '' } });
    expect(callbackPushes(main)).toEqual([]);
    main.destroyed = false;
    main.webContents.destroyed = true;
    emitOpen({ projectId: 'p1', selection: { kind: 'file', path: 'a', worktreePath: '' } });
    expect(callbackPushes(main)).toEqual([]);
  });
});
