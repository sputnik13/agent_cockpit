import { contextBridge, ipcRenderer } from 'electron';
import { Channels } from '@shared/ipc/channels';
import type { RendererApi } from '@shared/ipc/api';
import type { FileBytesResult } from '@shared/providers/types';

const invoke = <T>(channel: string, payload?: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, payload) as Promise<T>;

function on<T>(channel: string, handler: (e: T) => void): () => void {
  const listener = (_e: unknown, payload: unknown) => handler(payload as T);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: RendererApi = {
  ping: () => invoke(Channels.appPing),

  projects: {
    list: () => invoke<{ projects: never }>(Channels.projectsList).then((r) => r.projects),
    add: (input) => invoke<{ project: never }>(Channels.projectsAdd, input).then((r) => r.project),
    remove: (id) => invoke<{ ok: true }>(Channels.projectsRemove, { id }).then(() => undefined),
    update: (id, patch) =>
      invoke<{ project: never }>(Channels.projectsUpdate, { id, patch }).then((r) => r.project),
    openDialog: () => invoke<{ path: string | null }>(Channels.projectsOpenDialog).then((r) => r.path),
    activate: (id) => invoke<{ ok: true }>(Channels.projectsActivate, { id }).then(() => undefined),
    getActive: () => invoke<{ id: string | null }>(Channels.projectsGetActive).then((r) => r.id),
    reorder: (ids) => invoke<{ ok: true }>(Channels.projectsReorder, { ids }).then(() => undefined),
    setRunCommand: (id, command) =>
      invoke<{ ok: true }>(Channels.projectsSetRunCommand, { id, command }).then(() => undefined),
    disconnect: (id) =>
      invoke<{ ok: true }>(Channels.projectsDisconnect, { id }).then(() => undefined),
    reconnect: (id) =>
      invoke<{ ok: true }>(Channels.projectsReconnect, { id }).then(() => undefined),
  },

  provider: {
    listWorktrees: (projectId) =>
      invoke<{ worktrees: never }>(Channels.providerListWorktrees, { projectId }).then((r) => r.worktrees),
    getChangeset: (worktreePath, baseline, projectId) =>
      invoke<{ changeset: never }>(Channels.providerGetChangeset, { worktreePath, baseline, projectId }).then(
        (r) => r.changeset,
      ),
    getFileDiff: (worktreePath, filePath, baseline, projectId) =>
      invoke<{ patch: string }>(Channels.providerGetFileDiff, { worktreePath, filePath, baseline, projectId }).then(
        (r) => r.patch,
      ),
    getDiffBundle: (worktreePath, filePath, baseline, projectId) =>
      invoke<{ bundle: never }>(Channels.providerGetDiffBundle, {
        worktreePath,
        filePath,
        baseline,
        projectId,
      }).then((r) => r.bundle),
    readFile: (path, opts, projectId) =>
      invoke<{ file: never }>(Channels.providerReadFile, { path, opts, projectId }).then((r) => r.file),
    readFileBytes: (path, opts, projectId) =>
      invoke<{ bytes: FileBytesResult }>(Channels.providerReadFileBytes, { path, opts, projectId }).then(
        (r) => r.bytes,
      ),
    stat: (path, projectId) =>
      invoke<{ stat: never }>(Channels.providerStat, { path, projectId }).then((r) => r.stat),
    listDir: (dirPath, worktreePath, projectId) =>
      invoke<{ entries: never }>(Channels.providerListDir, { dirPath, worktreePath, projectId }).then(
        (r) => r.entries,
      ),
    resolvePath: (input, opts, projectId) =>
      invoke<{ resolved: never }>(Channels.providerResolvePath, {
        input,
        base: opts?.base,
        projectId,
      }).then((r) => r.resolved),
    detectBeads: (projectId) =>
      invoke<{ hasBeads: boolean }>(Channels.providerDetectBeads, { projectId }).then((r) => r.hasBeads),
    getTaskGraph: (projectId) =>
      invoke<{ graph: never }>(Channels.providerGetTaskGraph, { projectId }).then((r) => r.graph),
    getTask: (issueId, projectId) =>
      invoke<{ issue: never }>(Channels.providerGetTask, { issueId, projectId }).then((r) => r.issue),
    beadsClose: (issueId, reason, projectId) =>
      invoke<{ ok: true }>(Channels.providerBeadsClose, { issueId, reason, projectId }).then(() => undefined),
    beadsReopen: (issueId, projectId) =>
      invoke<{ ok: true }>(Channels.providerBeadsReopen, { issueId, projectId }).then(() => undefined),
    beadsComment: (issueId, message, projectId) =>
      invoke<{ ok: true }>(Channels.providerBeadsComment, { issueId, message, projectId }).then(() => undefined),
    beadsCreate: (input, projectId) =>
      invoke<{ issueId: string | null }>(Channels.providerBeadsCreate, { input, projectId }).then(
        (r) => r.issueId,
      ),
    beadsListComments: (issueId, projectId) =>
      invoke<{ comments: never }>(Channels.providerBeadsListComments, { issueId, projectId }).then(
        (r) => r.comments,
      ),
    getStatuses: () =>
      invoke<{ statuses: never }>(Channels.providerGetStatuses).then((r) => r.statuses),
    resolveBranchPoint: (worktreePath, projectId) =>
      invoke<{ branchPoint: never }>(Channels.providerResolveBranchPoint, {
        worktreePath,
        projectId,
      }).then((r) => r.branchPoint),
  },

  files: {
    saveAs: (path, opts) =>
      invoke<{ savedPath: string | null }>(Channels.filesSaveAs, { path, ...opts }).then(
        (r) => r.savedPath,
      ),
  },

  watch: {
    setActiveWorktree: (projectId, worktreePath) =>
      invoke<{ ok: true }>(Channels.watchSetActiveWorktree, { projectId, worktreePath }).then(
        () => undefined,
      ),
  },

  terminal: {
    open: (opts) => invoke<{ terminalId: string }>(Channels.terminalOpen, { opts }).then((r) => r.terminalId),
    write: (terminalId, data) =>
      invoke<{ ok: true }>(Channels.terminalWrite, { terminalId, data }).then(() => undefined),
    resize: (terminalId, cols, rows) =>
      invoke<{ ok: true }>(Channels.terminalResize, { terminalId, cols, rows }).then(() => undefined),
    close: (terminalId, kill) =>
      invoke<{ ok: true }>(Channels.terminalClose, { terminalId, kill }).then(() => undefined),
    list: () => invoke<{ keys: string[] }>(Channels.terminalList).then((r) => r.keys),
  },

  tmuxControl: {
    open: (opts) =>
      invoke<{ sessionName: string }>(Channels.tmuxControlOpen, opts ?? {}).then((r) => r.sessionName),
    close: (kill) => invoke<{ ok: true }>(Channels.tmuxControlClose, { kill }).then(() => undefined),
    command: (args) =>
      invoke<{ reply: never }>(Channels.tmuxControlCommand, { args }).then((r) => r.reply),
    input: (paneId, hex) =>
      invoke<{ ok: true }>(Channels.tmuxControlInput, { paneId, hex }).then(() => undefined),
    resize: (cols, rows) =>
      invoke<{ ok: true }>(Channels.tmuxControlResize, { cols, rows }).then(() => undefined),
    capturePane: (paneId, startLine) =>
      invoke<{ lines: string[] }>(Channels.tmuxControlCapturePane, { paneId, startLine }).then(
        (r) => r.lines,
      ),
  },

  notes: {
    create: (input) => invoke<{ note: never }>(Channels.notesCreate, input).then((r) => r.note),
    update: (id, body) => invoke<{ note: never }>(Channels.notesUpdate, { id, body }).then((r) => r.note),
    remove: (id) => invoke<{ ok: true }>(Channels.notesDelete, { id }).then(() => undefined),
    list: (projectId, filter) =>
      invoke<{ notes: never }>(Channels.notesList, { projectId, ...filter }).then((r) => r.notes),
    exportMarkdown: (projectId) =>
      invoke<{ markdown: string }>(Channels.notesExport, { projectId }).then((r) => r.markdown),
  },

  settings: {
    get: () => invoke<{ settings: never }>(Channels.settingsGet).then((r) => r.settings),
    set: (patch) => invoke<{ settings: never }>(Channels.settingsSet, { patch }).then((r) => r.settings),
    listFonts: () => invoke<{ fonts: string[] }>(Channels.settingsFonts).then((r) => r.fonts),
  },

  sessions: {
    list: () => invoke<{ sessions: never }>(Channels.sessionsList).then((r) => r.sessions),
    kill: (name) => invoke<{ ok: true }>(Channels.sessionsKill, { name }).then(() => undefined),
    killDetached: () => invoke<{ killed: string[] }>(Channels.sessionsKillDetached).then((r) => r.killed),
  },

  logs: {
    get: () => invoke<{ entries: never }>(Channels.logsGet).then((r) => r.entries),
  },

  openDiagnostics: () => invoke<{ ok: true }>(Channels.windowOpenDiagnostics).then(() => undefined),

  events: {
    onSettingsChanged: (h) => on(Channels.evtSettingsChanged, h),
    onTerminalData: (h) => on(Channels.evtTerminalData, h),
    onTerminalExit: (h) => on(Channels.evtTerminalExit, h),
    onTmux: (h) => on(Channels.evtTmux, h),
    onWatch: (h) => on(Channels.evtWatch, h),
    onStatus: (h) => on(Channels.evtStatus, h),
    onProjectsChanged: (h) => on(Channels.evtProjectsChanged, h),
    onLog: (h) => on(Channels.evtLog, h),
  },
};

contextBridge.exposeInMainWorld('api', api);
