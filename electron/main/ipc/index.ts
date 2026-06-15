/**
 * Provider IPC bridge. Registers typed handlers that route renderer calls to
 * the active project's WorkspaceProvider (via SessionManager) and the SQLite
 * project store, and forwards provider push events (terminal/watch/status) to
 * the renderer. Inputs are validated at this boundary; errors surface as
 * rejected invocations.
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { Channels } from '@shared/ipc/channels';
import type { BeadsCreateInput, ProjectInfo } from '@shared/ipc/channels';
import type { ConnectionStatus, WorkspaceProvider } from '../providers/types';
import { sessionManager } from '../providers';
import {
  addProject,
  getProject,
  listProjects,
  removeProject,
  reorderProjects,
  setActiveProjectId,
  setProjectRunCommand,
  getActiveProjectId,
  touchProject,
  relabelRemoteProjects,
  updateProject,
} from '../store/projects';
import type { ReviewTargetKind } from '@shared/ipc/channels';
import { createNote, deleteNote, exportNotesMarkdown, listNotes, updateNote } from '../store/notes';
import type { AppSettings } from '@shared/settings';
import { loadSettings, saveSettings } from '../config';
import { listSystemFonts } from '../fonts';
import { killCockpitSession, killDetachedCockpitSessions, listCockpitSessions } from '../sessions';
import { LocalTmuxControlManager } from '../providers/local/tmuxControl';
import { RemoteProvider } from '../providers/remote';
import { toWireNotification } from '@shared/tmux';
import { logger, getBuffer, subscribe } from '../logger';

type WinGetter = () => BrowserWindow | null;
type OpenDiagnostics = () => void;

function activeProvider(): WorkspaceProvider {
  const p = sessionManager.getActive();
  if (!p) throw new Error('no active project');
  return p;
}

/**
 * Structured "the addressed session no longer exists" error. Thrown by
 * providerFor() when an explicit projectId has no live session (e.g. it
 * disconnected/was removed between the renderer issuing a read and main
 * handling it). Carries a `kind` discriminant that survives the IPC boundary
 * (electron serializes own-enumerable props), so panelDataSync can treat it as
 * a transient clear-to-disconnected rather than a hard panel error.
 */
export class SessionGoneError extends Error {
  readonly kind = 'session-gone' as const;
  readonly projectId: string;
  constructor(projectId: string) {
    super(`session gone: ${projectId}`);
    this.name = 'SessionGoneError';
    this.projectId = projectId;
  }
}

/**
 * Resolve the provider for a read. An explicit projectId targets that session
 * (throwing SessionGoneError if it is gone); omitting it preserves the legacy
 * "active project" behavior for callers that do not address a specific project.
 */
function providerFor(projectId?: string): WorkspaceProvider {
  if (projectId === undefined) return activeProvider();
  const p = sessionManager.get(projectId);
  if (!p) throw new SessionGoneError(projectId);
  return p;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`invalid ${name}`);
  return v;
}

export function registerIpc(getWindow: WinGetter, openDiagnostics: OpenDiagnostics): void {
  // One-time idempotent relabel: fix remote project labels persisted before the
  // name-first fix (e15eaa0). Runs at IPC registration (once per app launch)
  // so the renderer always sees name-first labels from the first projectsList.
  relabelRemoteProjects();

  // Broadcast to ALL open BrowserWindows so the diagnostics pop-out receives
  // push events (evtLog, etc.) alongside the main window.
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  };

  // send() is kept for channels that should only go to the main window (status,
  // terminal data, watch, etc.). Log events use broadcast().
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };
  // Keyed by (projectId, terminalId): the renderer terminal id (`t1`/`run`) is
  // not unique across projects, so keying by id alone let a second project's
  // open overwrite and leak the first project's data/exit disposers.
  const termDisposers = new Map<string, Array<() => void>>();
  const termKey = (projectId: string, terminalId: string): string => `${projectId} ${terminalId}`;

  const notifyProjects = (): void => send(Channels.evtProjectsChanged, { at: new Date().toISOString() });

  // Forward provider status changes to the renderer. Wired into the
  // SessionManager so subscription happens at provider creation, BEFORE
  // connect() — the previous wire-after-connect ordering dropped the first
  // 'connected' transition into the void, leaving the UI stuck on the
  // 'disconnected' fallback. The manager owns subscription lifecycle (replace
  // on reconnect, dispose on close/failed connect) so there are no leaks.
  sessionManager.setStatusListener((projectId, status) =>
    send(Channels.evtStatus, { projectId, status }),
  );

  // Forward each live session's watch events to the renderer, tagged with the
  // originating projectId. Main owns one watch per live session over its
  // lifecycle (started on connect, stopped on disconnect/close); the renderer no
  // longer drives watch.subscribe — the watchSubscribe/Unsubscribe IPC channels
  // were removed. The renderer hub routes these by (projectId, category).
  sessionManager.setWatchListener((projectId, event) =>
    send(Channels.evtWatch, { projectId, event }),
  );

  // IPC cache cleanup on provider eviction (D2/FR5).
  // When a provider is evicted (disconnect/reconnect/close/failed-connect), the
  // stale tmuxControl, tmuxDisposers, and termDisposers entries for that project
  // are disposed and removed. This ensures a reconnected provider always wires
  // fresh notification subscriptions in activeControl() — the old has(pid) guard
  // was the root cause of D2: after reconnect the stale disposer prevented the
  // new manager from ever being wired to the renderer.
  sessionManager.onEviction((projectId) => {
    // Dispose and remove the tmux notification forwarder for this project.
    const offTmux = tmuxDisposers.get(projectId);
    if (offTmux) {
      offTmux();
      tmuxDisposers.delete(projectId);
    }
    // Drop the control manager reference (local or remote).
    if (tmuxControl.has(projectId)) {
      tmuxControl.get(projectId)!.close();
      tmuxControl.delete(projectId);
    }
    // Dispose and remove all terminal data/exit subscriptions for this project.
    for (const [key, disposers] of [...termDisposers.entries()]) {
      if (key.startsWith(`${projectId} `)) {
        disposers.forEach((d) => d());
        termDisposers.delete(key);
      }
    }
    logger.info(`IPC cache evicted for project ${projectId}`, 'ipc-eviction');
  });

  // ---- Diagnostics logs ----
  ipcMain.handle(Channels.logsGet, () => ({ entries: getBuffer() }));
  // Broadcast new log entries to ALL BrowserWindows so both the main window
  // and the diagnostics pop-out receive live entries.
  subscribe((entry) => broadcast(Channels.evtLog, entry));

  // ---- Diagnostics window ----
  ipcMain.handle(Channels.windowOpenDiagnostics, () => {
    openDiagnostics();
    return { ok: true as const };
  });

  ipcMain.handle(Channels.appPing, () => ({ ok: true as const, at: new Date().toISOString() }));

  // ---- Projects ----
  ipcMain.handle(Channels.projectsList, () => ({ projects: listProjects() as ProjectInfo[] }));
  ipcMain.handle(Channels.projectsAdd, (_e, req: { label: string; connection: never }) => {
    const project = addProject({ label: requireString(req?.label, 'label'), connection: req.connection });
    notifyProjects();
    return { project: project as ProjectInfo };
  });
  ipcMain.handle(Channels.projectsRemove, async (_e, req: { id: string }) => {
    const id = requireString(req?.id, 'id');
    if (sessionManager.get(id)) await sessionManager.close(id);
    removeProject(id);
    notifyProjects();
    return { ok: true as const };
  });
  ipcMain.handle(
    Channels.projectsUpdate,
    async (_e, req: { id: string; patch: { label?: string; connection?: never } }) => {
      const id = requireString(req?.id, 'id');
      // Drop the cached provider so reactivation creates a fresh one with the
      // new connection spec — do not silently reconnect to a changed host.
      if (sessionManager.get(id)) await sessionManager.close(id);
      const project = updateProject(id, req?.patch ?? {});
      notifyProjects();
      return { project: project as ProjectInfo };
    },
  );
  ipcMain.handle(Channels.projectsOpenDialog, async () => {
    const win = getWindow();
    const res = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return { path: res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]! };
  });
  ipcMain.handle(Channels.projectsActivate, async (_e, req: { id: string }) => {
    const id = requireString(req?.id, 'id');
    try {
      await sessionManager.activate(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Provide phase context for typed remote connect errors.
      const phase = (err as { phase?: string }).phase;
      logger.error(
        phase
          ? `projectsActivate: connect failed at phase=${phase}: ${msg}`
          : `projectsActivate: connect failed: ${msg}`,
        'ipc',
      );
      throw err;
    }
    // Status forwarding is wired in SessionManager.setStatusListener.
    touchProject(id);
    // Refresh the runtime idle clock so focusing a session resets aging-out.
    sessionManager.touch(id);
    notifyProjects();
    return { ok: true as const };
  });
  ipcMain.handle(Channels.projectsReorder, (_e, req: { ids: string[] }) => {
    const ids = Array.isArray(req?.ids) ? req.ids.map((id) => requireString(id, 'id')) : [];
    reorderProjects(ids);
    notifyProjects();
    return { ok: true as const };
  });
  ipcMain.handle(Channels.projectsDisconnect, async (_e, req: { id: string }) => {
    const id = requireString(req?.id, 'id');
    await sessionManager.disconnect(id);
    return { ok: true as const };
  });
  ipcMain.handle(Channels.projectsReconnect, async (_e, req: { id: string }) => {
    const id = requireString(req?.id, 'id');
    try {
      await sessionManager.reconnect(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase = (err as { phase?: string }).phase;
      logger.error(
        phase
          ? `projectsReconnect: connect failed at phase=${phase}: ${msg}`
          : `projectsReconnect: connect failed: ${msg}`,
        'ipc',
      );
      throw err;
    }
    // Status forwarding is wired in SessionManager.setStatusListener.
    return { ok: true as const };
  });
  ipcMain.handle(Channels.projectsSetRunCommand, (_e, req: { id: string; command: string | null }) => {
    const command = typeof req?.command === 'string' && req.command.length > 0 ? req.command : null;
    setProjectRunCommand(requireString(req?.id, 'id'), command);
    notifyProjects();
    return { ok: true as const };
  });
  // Returns the *live* active session id. On cold boot, lazily restore the
  // persisted active project's session so the renderer never sees an active id
  // without a backing session (which would make every provider call fail).
  ipcMain.handle(Channels.projectsGetActive, async () => {
    let id = sessionManager.activeProjectId();
    if (!id) {
      const persisted = getActiveProjectId();
      if (persisted && getProject(persisted)) {
        try {
          await sessionManager.activate(persisted);
          // Status forwarding is wired in SessionManager.setStatusListener.
          // Seed the idle clock on cold-boot restore (mirrors projectsActivate).
          sessionManager.touch(persisted);
          id = persisted;
        } catch {
          // Restore failed (e.g. remote unreachable); leave inactive so the UI
          // shows a disconnected/no-active state rather than blocking boot.
          id = null;
        }
      }
    }
    return { id };
  });

  // ---- Provider reads (active project by default; addressable by projectId) ----
  // Omitting projectId preserves the legacy active-project behavior; an explicit
  // id targets that live session (panelDataSync uses this to keep every live
  // session's slice current regardless of which project is focused).
  ipcMain.handle(Channels.providerListWorktrees, async (_e, req?: { projectId?: string }) => ({
    worktrees: await providerFor(req?.projectId).listWorktrees(),
  }));
  ipcMain.handle(
    Channels.providerGetChangeset,
    async (_e, req: { worktreePath: string; baseline?: string; projectId?: string }) => ({
      changeset: await providerFor(req?.projectId).getChangeset(req.worktreePath, req.baseline),
    }),
  );
  ipcMain.handle(
    Channels.providerGetFileDiff,
    async (_e, req: { worktreePath: string; filePath: string; baseline?: string; projectId?: string }) => ({
      patch: await providerFor(req?.projectId).getFileDiff(req.worktreePath, req.filePath, req.baseline),
    }),
  );
  ipcMain.handle(Channels.providerReadFile, async (_e, req: { path: string; opts?: never; projectId?: string }) => ({
    file: await providerFor(req?.projectId).readFile(requireString(req?.path, 'path'), req.opts),
  }));
  ipcMain.handle(Channels.providerStat, async (_e, req: { path: string; projectId?: string }) => ({
    stat: await providerFor(req?.projectId).stat(requireString(req?.path, 'path')),
  }));
  ipcMain.handle(Channels.providerListDir, async (_e, req: { dirPath: string; projectId?: string }) => ({
    entries: await providerFor(req?.projectId).listDir(req?.dirPath ?? ''),
  }));
  ipcMain.handle(
    Channels.providerResolvePath,
    async (_e, req: { input: string; base?: string; projectId?: string }) => ({
      resolved: await providerFor(req?.projectId).resolvePath(requireString(req?.input, 'input'), {
        base: req?.base,
      }),
    }),
  );
  ipcMain.handle(Channels.providerDetectBeads, async (_e, req?: { projectId?: string }) => ({
    hasBeads: await providerFor(req?.projectId).detectBeads(),
  }));
  ipcMain.handle(Channels.providerGetTaskGraph, async (_e, req?: { projectId?: string }) => ({
    graph: await providerFor(req?.projectId).getTaskGraph(),
  }));
  ipcMain.handle(Channels.providerGetTask, async (_e, req: { issueId: string; projectId?: string }) => ({
    issue: await providerFor(req?.projectId).getTask(requireString(req?.issueId, 'issueId')),
  }));
  // Beads writes — all route through the provider's `br` CLI seam (local
  // spawnSync / remote helper exec). A br failure rejects; the renderer store
  // surfaces the message inline.
  ipcMain.handle(
    Channels.providerBeadsClose,
    async (_e, req: { issueId: string; reason?: string; projectId?: string }) => {
      await providerFor(req?.projectId).beadsClose(requireString(req?.issueId, 'issueId'), req?.reason);
      return { ok: true as const };
    },
  );
  ipcMain.handle(
    Channels.providerBeadsReopen,
    async (_e, req: { issueId: string; projectId?: string }) => {
      await providerFor(req?.projectId).beadsReopen(requireString(req?.issueId, 'issueId'));
      return { ok: true as const };
    },
  );
  ipcMain.handle(
    Channels.providerBeadsComment,
    async (_e, req: { issueId: string; message: string; projectId?: string }) => {
      await providerFor(req?.projectId).beadsComment(
        requireString(req?.issueId, 'issueId'),
        requireString(req?.message, 'message'),
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle(
    Channels.providerBeadsCreate,
    async (_e, req: { input: BeadsCreateInput; projectId?: string }) => {
      const input = req?.input;
      if (!input || typeof input.title !== 'string' || input.title.trim() === '') {
        throw new Error('beadsCreate: title is required');
      }
      const issueId = await providerFor(req?.projectId).beadsCreate(input);
      return { issueId };
    },
  );
  ipcMain.handle(
    Channels.providerBeadsListComments,
    async (_e, req: { issueId: string; projectId?: string }) => ({
      comments: await providerFor(req?.projectId).beadsListComments(requireString(req?.issueId, 'issueId')),
    }),
  );
  // Snapshot of every live session's current connection status. The renderer
  // pulls this on (re)load to hydrate the session store — a reload resets the
  // renderer store to empty and main only PUSHES evt:status on transitions, so
  // without this a still-connected session would render as 'disconnected' until
  // the next transition. Main's ConnectionMachine remains the single source.
  ipcMain.handle(Channels.providerGetStatuses, () => {
    const statuses: Record<string, ConnectionStatus> = {};
    for (const projectId of sessionManager.listOpen()) {
      const status = sessionManager.statusOf(projectId);
      if (status) statuses[projectId] = status;
    }
    return { statuses };
  });
  ipcMain.handle(
    Channels.providerResolveBranchPoint,
    async (_e, req: { worktreePath: string; projectId?: string }) => ({
      branchPoint: await providerFor(req?.projectId).resolveBranchPoint(
        requireString(req?.worktreePath, 'worktreePath'),
      ),
    }),
  );

  // ---- Terminal (active project) ----
  ipcMain.handle(Channels.terminalOpen, async (_e, req: { opts: never }) => {
    const provider = activeProvider();
    const { id } = await provider.openTerminal(req.opts);
    const pid = provider.projectId;
    const offData = provider.onTerminalData(id, (data) =>
      send(Channels.evtTerminalData, { projectId: pid, terminalId: id, data }),
    );
    const offExit = provider.onTerminalExit(id, (info) =>
      send(Channels.evtTerminalExit, { projectId: pid, terminalId: id, info }),
    );
    const dkey = termKey(pid, id);
    // Re-open of the same (project, id) replaces its subscriptions cleanly.
    termDisposers.get(dkey)?.forEach((off) => off());
    termDisposers.set(dkey, [offData, offExit]);
    return { terminalId: id };
  });
  ipcMain.handle(Channels.terminalWrite, async (_e, req: { terminalId: string; data: string }) => {
    await activeProvider().writeTerminal(requireString(req?.terminalId, 'terminalId'), req.data ?? '');
    return { ok: true as const };
  });
  ipcMain.handle(Channels.terminalResize, async (_e, req: { terminalId: string; cols: number; rows: number }) => {
    await activeProvider().resizeTerminal(requireString(req?.terminalId, 'terminalId'), req.cols, req.rows);
    return { ok: true as const };
  });
  ipcMain.handle(Channels.terminalClose, async (_e, req: { terminalId: string; kill?: boolean }) => {
    const id = requireString(req?.terminalId, 'terminalId');
    const provider = activeProvider();
    const dkey = termKey(provider.projectId, id);
    await provider.closeTerminal(id, { kill: req?.kill ?? false });
    termDisposers.get(dkey)?.forEach((off) => off());
    termDisposers.delete(dkey);
    return { ok: true as const };
  });
  ipcMain.handle(Channels.terminalList, async () => ({ keys: await activeProvider().listTerminals() }));

  // ---- tmux control-mode (-CC) — local and remote projects ----
  // Per-project control-session managers, kept alongside (not replacing) the
  // existing terminal path. Local projects use LocalTmuxControlManager; remote
  // projects use RemoteTmuxControlManager (via RemoteProvider.tmuxControl()).
  const tmuxControl = new Map<string, LocalTmuxControlManager>();
  const tmuxDisposers = new Map<string, () => void>();

  /** Unified control-mode accessor. Returns a manager that exposes at least
   *  command/input/capturePane/resizeClient/close methods plus onNotification. */
  interface AnyControlManager {
    command(args: string): Promise<{ num: number; error: boolean; lines: string[] }>;
    input(paneId: string, data: string | Uint8Array): Promise<unknown>;
    capturePane(paneId: string, opts?: { startLine?: number }): Promise<string[]>;
    resizeClient(cols: number, rows: number): Promise<unknown>;
    onNotification(handler: (n: import('@shared/tmux').TmuxNotification) => void): () => void;
    close(): void;
    sessionName?(): string;
    tmuxControlSessionName?(): string;
  }

  function activeControl(): { mgr: AnyControlManager; sessionName: string; projectId: string } {
    const provider = activeProvider();
    const pid = provider.projectId;

    if (provider.kind === 'local') {
      let mgr = tmuxControl.get(pid);
      if (!mgr) {
        const project = getProject(pid);
        const rootPath =
          project && project.connection.kind === 'local' ? project.connection.rootPath : process.cwd();
        mgr = new LocalTmuxControlManager(pid, rootPath);
        // Background %output counts as session activity (idle aging-out).
        mgr.onOutputActivity = () => sessionManager.touch(pid);
        tmuxControl.set(pid, mgr);
        const off = mgr.onNotification((notification) =>
          send(Channels.evtTmux, { projectId: pid, notification: toWireNotification(notification) }),
        );
        tmuxDisposers.set(pid, off);
      }
      return { mgr, sessionName: mgr.sessionName(), projectId: pid };
    }

    if (provider instanceof RemoteProvider) {
      const remoteCtrl = provider.tmuxControl();
      // Always unwire-old then wire-new for remote: the prior has(pid) guard
      // was the root cause of D2. After reconnect, a new RemoteTmuxControlManager
      // instance is built inside the new provider; if the stale disposer from the
      // evicted provider were still present, onEviction will have cleared it, but
      // we unconditionally rewire here for safety (idempotent: dispose nothing if
      // no prior entry, then set the fresh one).
      const priorOff = tmuxDisposers.get(pid);
      if (priorOff) priorOff();
      // Background %output counts as session activity (idle aging-out).
      remoteCtrl.onOutputActivity = () => sessionManager.touch(pid);
      const off = remoteCtrl.onNotification((notification) =>
        send(Channels.evtTmux, { projectId: pid, notification: toWireNotification(notification) }),
      );
      tmuxDisposers.set(pid, off);
      return { mgr: remoteCtrl, sessionName: provider.tmuxControlSessionName(), projectId: pid };
    }

    throw new Error('tmux control-mode is not available for this provider kind');
  }

  ipcMain.handle(Channels.tmuxControlOpen, async (_e, req: { cols?: number; rows?: number }) => {
    const { mgr, sessionName, projectId: pid } = activeControl();
    const provider = activeProvider();
    if (provider.kind === 'local') {
      // LocalTmuxControlManager.open() is synchronous; cast for unified call.
      (mgr as LocalTmuxControlManager).open({ cols: req?.cols, rows: req?.rows });
    } else {
      // RemoteTmuxControlManager.open() is async.
      await (mgr as import('../providers/remote/tmuxControl').RemoteTmuxControlManager).open();
    }
    void pid; // acknowledge pid used indirectly via activeControl
    return { sessionName };
  });
  ipcMain.handle(Channels.tmuxControlClose, async (_e, req: { kill?: boolean }) => {
    const { mgr, projectId } = activeControl();
    const provider = activeProvider();
    if (req?.kill && provider.kind === 'local') {
      // Local: killSession() detaches and kills the tmux session in one call.
      (mgr as LocalTmuxControlManager).killSession();
    } else if (req?.kill && provider instanceof RemoteProvider) {
      // Remote: detach the control channel, then kill the host session (a
      // one-shot kill-session over the SSH transport). Mirrors local's kill so
      // remote honors `kill` exactly like local.
      mgr.close();
      await provider.killControlSession();
    } else {
      mgr.close();
    }
    tmuxDisposers.get(projectId)?.();
    tmuxDisposers.delete(projectId);
    tmuxControl.delete(projectId);
    return { ok: true as const };
  });
  ipcMain.handle(Channels.tmuxControlCommand, async (_e, req: { args: string }) => {
    const { mgr } = activeControl();
    const reply = await mgr.command(requireString(req?.args, 'args'));
    return { reply };
  });
  ipcMain.handle(Channels.tmuxControlInput, async (_e, req: { paneId: string; hex: string }) => {
    const { mgr } = activeControl();
    await mgr.input(requireString(req?.paneId, 'paneId'), req?.hex ?? '');
    return { ok: true as const };
  });
  ipcMain.handle(Channels.tmuxControlResize, async (_e, req: { cols: number; rows: number }) => {
    const { mgr } = activeControl();
    await mgr.resizeClient(req.cols, req.rows);
    return { ok: true as const };
  });
  ipcMain.handle(
    Channels.tmuxControlCapturePane,
    async (_e, req: { paneId: string; startLine?: number }) => {
      const { mgr } = activeControl();
      const opts = req?.startLine != null ? { startLine: req.startLine } : undefined;
      const lines = await mgr.capturePane(requireString(req?.paneId, 'paneId'), opts);
      return { lines };
    },
  );

  // ---- Watch ----
  // No renderer-facing watch IPC: main owns one watch per live session over its
  // lifecycle (SessionManager) and forwards events via setWatchListener above.
  // The watchSubscribe/watchUnsubscribe channels were removed.

  // ---- Notes (app-local, by project) ----
  ipcMain.handle(
    Channels.notesCreate,
    (_e, req: { projectId: string; targetKind: ReviewTargetKind; targetId: string; body: string }) => ({
      note: createNote({
        projectId: requireString(req?.projectId, 'projectId'),
        targetKind: req.targetKind,
        targetId: req.targetId,
        body: req.body ?? '',
      }),
    }),
  );
  ipcMain.handle(Channels.notesUpdate, (_e, req: { id: number; body: string }) => ({
    note: updateNote(req.id, req.body ?? ''),
  }));
  ipcMain.handle(Channels.notesDelete, (_e, req: { id: number }) => {
    deleteNote(req.id);
    return { ok: true as const };
  });
  ipcMain.handle(
    Channels.notesList,
    (_e, req: { projectId: string; targetKind?: ReviewTargetKind; targetId?: string }) => {
      const filter: { targetKind?: ReviewTargetKind; targetId?: string } = {};
      if (req.targetKind) filter.targetKind = req.targetKind;
      if (req.targetId) filter.targetId = req.targetId;
      return { notes: listNotes(requireString(req?.projectId, 'projectId'), filter) };
    },
  );
  ipcMain.handle(Channels.notesExport, (_e, req: { projectId: string }) => ({
    markdown: exportNotesMarkdown(listNotes(requireString(req?.projectId, 'projectId'))),
  }));

  // ---- Settings (persisted config file) ----
  ipcMain.handle(Channels.settingsGet, () => ({ settings: loadSettings() }));
  ipcMain.handle(Channels.settingsSet, (_e, req: { patch: Partial<AppSettings> }) => {
    const settings = saveSettings(req?.patch ?? {});
    // evtSettingsChanged carries the bare AppSettings (matching the api.ts
    // handler type). Wrapping it in `{ settings }` made the renderer write the
    // wrapper into the store and every Select.value read undefined for one
    // render — triggering Radix's "controlled to uncontrolled" warning.
    send(Channels.evtSettingsChanged, settings);
    return { settings };
  });
  ipcMain.handle(Channels.settingsFonts, async () => ({ fonts: await listSystemFonts() }));

  // ---- Terminal sessions (cockpit tmux socket) ----
  ipcMain.handle(Channels.sessionsList, () => ({ sessions: listCockpitSessions() }));
  ipcMain.handle(Channels.sessionsKill, (_e, req: { name: string }) => {
    killCockpitSession(requireString(req?.name, 'name'));
    return { ok: true as const };
  });
  ipcMain.handle(Channels.sessionsKillDetached, () => ({ killed: killDetachedCockpitSessions() }));

  void setActiveProjectId; // reserved for future explicit active persistence paths
}
