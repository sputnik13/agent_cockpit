/**
 * Single source of truth for IPC channel names and request/response types,
 * shared by main, preload, and renderer.
 *
 * Provider reads are addressable by `projectId` (default = active project), so
 * any live session's data can be loaded regardless of which project is focused.
 * Terminal/control-mode IPC stay active-only. Watch is not renderer-driven:
 * main owns one watch per live session over its lifecycle (SessionManager) and
 * pushes terminal/watch/status events tagged with the originating projectId.
 */
import type {
  ConnectionSpec,
  ConnectionStatus,
  DirEntry,
  FileReadOptions,
  FileReadResult,
  ProjectKind,
  ResolvedPath,
  StatResult,
  TerminalExitInfo,
  TerminalOpenOptions,
  WatchEvent,
} from '@shared/providers/types';
import type { AppSettings } from '@shared/settings';
import type { TmuxWireNotification } from '@shared/tmux';

export const Channels = {
  appPing: 'app:ping',

  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsRemove: 'projects:remove',
  projectsUpdate: 'projects:update',
  projectsOpenDialog: 'projects:open-dialog',
  projectsActivate: 'projects:activate',
  projectsGetActive: 'projects:get-active',
  projectsReorder: 'projects:reorder',
  projectsSetRunCommand: 'projects:set-run-command',
  /** Disconnect a remote project's provider but keep it selected (state=disconnected). */
  projectsDisconnect: 'projects:disconnect',
  /** Evict cached provider and reconnect from scratch (re-provisions helper). */
  projectsReconnect: 'projects:reconnect',

  providerListWorktrees: 'provider:list-worktrees',
  providerGetChangeset: 'provider:get-changeset',
  providerGetFileDiff: 'provider:get-file-diff',
  providerReadFile: 'provider:read-file',
  providerStat: 'provider:stat',
  providerListDir: 'provider:list-dir',
  providerResolvePath: 'provider:resolve-path',
  providerDetectBeads: 'provider:detect-beads',
  providerGetTaskGraph: 'provider:get-task-graph',
  providerGetTask: 'provider:get-task',
  providerBeadsClose: 'provider:beads-close',
  providerBeadsReopen: 'provider:beads-reopen',
  providerBeadsComment: 'provider:beads-comment',
  providerBeadsCreate: 'provider:beads-create',
  providerBeadsListComments: 'provider:beads-list-comments',
  /** Snapshot of every live session's current connection status (for renderer
   *  reload hydration; main's ConnectionMachine stays the single source). */
  providerGetStatuses: 'provider:get-statuses',
  /** Resolve the branch-point (merge-base between HEAD and parent branch) for a
   *  worktree; null when no parent can be resolved (orphan, unrelated histories). */
  providerResolveBranchPoint: 'provider:resolve-branch-point',

  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalClose: 'terminal:close',
  terminalList: 'terminal:list',

  // tmux control-mode (-CC) subsystem (additive; not yet the active terminal path)
  tmuxControlOpen: 'tmuxControl:open',
  tmuxControlClose: 'tmuxControl:close',
  tmuxControlCommand: 'tmuxControl:command',
  tmuxControlInput: 'tmuxControl:input',
  tmuxControlResize: 'tmuxControl:resize',
  tmuxControlCapturePane: 'tmuxControl:capture-pane',

  notesCreate: 'notes:create',
  notesUpdate: 'notes:update',
  notesDelete: 'notes:delete',
  notesList: 'notes:list',
  notesExport: 'notes:export',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsFonts: 'settings:fonts',

  sessionsList: 'sessions:list',
  sessionsKill: 'sessions:kill',
  sessionsKillDetached: 'sessions:kill-detached',

  // diagnostics log channels
  logsGet: 'logs:get',
  evtLog: 'evt:log',
  windowOpenDiagnostics: 'window:open-diagnostics',

  // push events (main -> renderer)
  evtSettingsChanged: 'evt:settings-changed',
  evtTerminalData: 'evt:terminal-data',
  evtTerminalExit: 'evt:terminal-exit',
  evtTmux: 'evt:tmux',
  evtWatch: 'evt:watch',
  evtStatus: 'evt:status',
  evtProjectsChanged: 'evt:projects-changed',
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

// ---- Domain types ----------------------------------------------------------

export interface ProjectInfo {
  id: string;
  label: string;
  kind: ProjectKind;
  connection: ConnectionSpec;
  createdAt: string;
  lastActiveAt: string | null;
  /** Command executed by the Run panel; null when none is configured. */
  runCommand: string | null;
}

export interface WorktreeRecord {
  path: string;
  branch: string | null;
  head: string;
  locked: boolean;
  prunable: boolean;
  detached: boolean;
}

/**
 * Resolved branch-point for the working tree: the parent branch reference and
 * the merge-base SHA between HEAD and that parent. `parentKind` indicates
 * whether the parent was the configured upstream (@{upstream}) or the repo
 * default branch (origin/HEAD → main/master).
 * Returned by `resolveBranchPoint`; null when no parent can be resolved
 * (orphan branch, unrelated histories, or no upstream and no default branch).
 */
export interface BranchPoint {
  /** The branch/ref used as the parent (e.g. "origin/main"). */
  parentRef: string;
  /** How the parent was resolved. */
  parentKind: 'upstream' | 'default';
  /** The merge-base commit SHA between HEAD and parentRef. */
  mergeBase: string;
}

export type FileChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'ignored'
  | 'conflicted';

export interface FileChange {
  status: FileChangeStatus;
  oldPath: string | null;
  newPath: string;
  isBinary: boolean;
  isGenerated: boolean;
  sizeBytes: number | null;
  staged: boolean;
}

export interface Changeset {
  worktree: string;
  baseline: string;
  baselineKind: 'HEAD' | 'ref' | 'commit';
  files: FileChange[];
  generatedAt: string;
}

export interface BeadsIssue {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: number;
  issueType: string;
  labels: string[];
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BeadsDep {
  from: string;
  to: string;
  type: string;
}

export interface BeadsTaskGraph {
  source: { kind: 'sqlite' | 'jsonl'; path: string };
  schemaCompatible: boolean;
  issues: BeadsIssue[];
  deps: BeadsDep[];
}

/** A comment on an issue, as returned by `br comments list --json`. */
export interface BeadsComment {
  id: number;
  issueId: string;
  author: string;
  text: string;
  createdAt: string;
}

/** Fields for `br create` (title required; the issue becomes a child of
 *  `parent` when set). */
export interface BeadsCreateInput {
  title: string;
  parent?: string;
  priority?: number;
  description?: string;
}

export type ReviewTargetKind = 'project' | 'worktree' | 'file' | 'hunk' | 'block' | 'bead';

export interface NoteRecord {
  id: number;
  projectId: string;
  targetKind: ReviewTargetKind;
  targetId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TmuxSessionInfo {
  name: string;
  windows: number;
  attached: boolean;
  createdAt: string;
  /** Command to attach manually from any terminal. */
  attachCommand: string;
}

// ---- Event payloads --------------------------------------------------------

export interface TerminalDataEvent {
  projectId: string;
  terminalId: string;
  data: string;
}
export interface TerminalExitEvent {
  projectId: string;
  terminalId: string;
  info: TerminalExitInfo;
}
export interface WatchPushEvent {
  projectId: string;
  event: WatchEvent;
}
/** One typed tmux control-mode notification, tagged with its project. */
export interface TmuxEvent {
  projectId: string;
  notification: TmuxWireNotification;
}
/** Result of a reply-correlated tmux control command. */
export interface TmuxCommandReply {
  num: number;
  error: boolean;
  lines: string[];
}
export interface StatusEvent {
  projectId: string;
  status: ConnectionStatus;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  context?: string;
  message: string;
}

// ---- IPC contract ----------------------------------------------------------

export interface IpcContract {
  [Channels.appPing]: { request: void; response: { ok: true; at: string } };

  [Channels.projectsList]: { request: void; response: { projects: ProjectInfo[] } };
  [Channels.projectsAdd]: {
    request: { label: string; connection: ConnectionSpec };
    response: { project: ProjectInfo };
  };
  [Channels.projectsRemove]: { request: { id: string }; response: { ok: true } };
  [Channels.projectsUpdate]: {
    request: { id: string; patch: { label?: string; connection?: ConnectionSpec } };
    response: { project: ProjectInfo };
  };
  [Channels.projectsOpenDialog]: { request: void; response: { path: string | null } };
  [Channels.projectsActivate]: { request: { id: string }; response: { ok: true } };
  [Channels.projectsGetActive]: { request: void; response: { id: string | null } };
  [Channels.projectsReorder]: { request: { ids: string[] }; response: { ok: true } };
  [Channels.projectsSetRunCommand]: {
    request: { id: string; command: string | null };
    response: { ok: true };
  };
  [Channels.projectsDisconnect]: { request: { id: string }; response: { ok: true } };
  [Channels.projectsReconnect]: { request: { id: string }; response: { ok: true } };

  [Channels.providerListWorktrees]: {
    request: { projectId?: string } | void;
    response: { worktrees: WorktreeRecord[] };
  };
  [Channels.providerGetChangeset]: {
    request: { worktreePath: string; baseline?: string; projectId?: string };
    response: { changeset: Changeset };
  };
  [Channels.providerGetFileDiff]: {
    request: { worktreePath: string; filePath: string; baseline?: string; projectId?: string };
    response: { patch: string };
  };
  [Channels.providerReadFile]: {
    request: { path: string; opts?: FileReadOptions; projectId?: string };
    response: { file: FileReadResult };
  };
  [Channels.providerStat]: { request: { path: string; projectId?: string }; response: { stat: StatResult } };
  [Channels.providerListDir]: {
    request: { dirPath: string; projectId?: string };
    response: { entries: DirEntry[] };
  };
  [Channels.providerResolvePath]: {
    request: { input: string; base?: string; projectId?: string };
    response: { resolved: ResolvedPath };
  };
  [Channels.providerDetectBeads]: { request: { projectId?: string } | void; response: { hasBeads: boolean } };
  [Channels.providerGetTaskGraph]: { request: { projectId?: string } | void; response: { graph: BeadsTaskGraph } };
  [Channels.providerGetTask]: {
    request: { issueId: string; projectId?: string };
    response: { issue: BeadsIssue | null };
  };
  [Channels.providerBeadsClose]: {
    request: { issueId: string; reason?: string; projectId?: string };
    response: { ok: true };
  };
  [Channels.providerBeadsReopen]: {
    request: { issueId: string; projectId?: string };
    response: { ok: true };
  };
  [Channels.providerBeadsComment]: {
    request: { issueId: string; message: string; projectId?: string };
    response: { ok: true };
  };
  [Channels.providerBeadsCreate]: {
    request: { input: BeadsCreateInput; projectId?: string };
    response: { issueId: string | null };
  };
  [Channels.providerBeadsListComments]: {
    request: { issueId: string; projectId?: string };
    response: { comments: BeadsComment[] };
  };
  [Channels.providerGetStatuses]: {
    request: void;
    response: { statuses: Record<string, ConnectionStatus> };
  };
  [Channels.providerResolveBranchPoint]: {
    request: { worktreePath: string; projectId?: string };
    response: { branchPoint: BranchPoint | null };
  };

  [Channels.terminalOpen]: { request: { opts: TerminalOpenOptions }; response: { terminalId: string } };
  [Channels.terminalWrite]: { request: { terminalId: string; data: string }; response: { ok: true } };
  [Channels.terminalResize]: {
    request: { terminalId: string; cols: number; rows: number };
    response: { ok: true };
  };
  [Channels.terminalClose]: {
    request: { terminalId: string; kill?: boolean };
    response: { ok: true };
  };
  [Channels.terminalList]: { request: void; response: { keys: string[] } };

  // tmux control-mode (-CC): additive channels for the active project's control session.
  [Channels.tmuxControlOpen]: {
    request: { cols?: number; rows?: number };
    response: { sessionName: string };
  };
  [Channels.tmuxControlClose]: { request: { kill?: boolean }; response: { ok: true } };
  [Channels.tmuxControlCommand]: { request: { args: string }; response: { reply: TmuxCommandReply } };
  [Channels.tmuxControlInput]: {
    request: { paneId: string; hex: string };
    response: { ok: true };
  };
  [Channels.tmuxControlResize]: { request: { cols: number; rows: number }; response: { ok: true } };
  [Channels.tmuxControlCapturePane]: {
    request: { paneId: string; startLine?: number };
    response: { lines: string[] };
  };
  [Channels.evtTmux]: { request: void; response: TmuxEvent };

  [Channels.evtTerminalData]: { request: void; response: TerminalDataEvent };
  [Channels.evtTerminalExit]: { request: void; response: TerminalExitEvent };
  [Channels.evtWatch]: { request: void; response: WatchPushEvent };
  [Channels.evtStatus]: { request: void; response: StatusEvent };
  [Channels.evtProjectsChanged]: { request: void; response: { at: string } };

  [Channels.notesCreate]: {
    request: { projectId: string; targetKind: ReviewTargetKind; targetId: string; body: string };
    response: { note: NoteRecord };
  };
  [Channels.notesUpdate]: { request: { id: number; body: string }; response: { note: NoteRecord | null } };
  [Channels.notesDelete]: { request: { id: number }; response: { ok: true } };
  [Channels.notesList]: {
    request: { projectId: string; targetKind?: ReviewTargetKind; targetId?: string };
    response: { notes: NoteRecord[] };
  };
  [Channels.notesExport]: { request: { projectId: string }; response: { markdown: string } };

  [Channels.settingsGet]: { request: void; response: { settings: AppSettings } };
  [Channels.settingsSet]: { request: { patch: Partial<AppSettings> }; response: { settings: AppSettings } };
  [Channels.settingsFonts]: { request: void; response: { fonts: string[] } };

  [Channels.sessionsList]: { request: void; response: { sessions: TmuxSessionInfo[] } };
  [Channels.sessionsKill]: { request: { name: string }; response: { ok: true } };
  [Channels.sessionsKillDetached]: { request: void; response: { killed: string[] } };
  [Channels.evtSettingsChanged]: { request: void; response: AppSettings };

  [Channels.logsGet]: { request: void; response: { entries: LogEntry[] } };
  [Channels.evtLog]: { request: void; response: LogEntry };
  [Channels.windowOpenDiagnostics]: { request: void; response: { ok: true } };
}

export type Request<C extends ChannelName> = IpcContract[C]['request'];
export type Response<C extends ChannelName> = IpcContract[C]['response'];
