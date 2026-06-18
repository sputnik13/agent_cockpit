import type {
  BeadsComment,
  BeadsCreateInput,
  BeadsIssue,
  BeadsTaskGraph,
  BranchPoint,
  Changeset,
  LogEntry,
  NoteRecord,
  ProjectInfo,
  ReviewTargetKind,
  StatusEvent,
  TmuxCommandReply,
  TmuxEvent,
  TmuxSessionInfo,
  TerminalDataEvent,
  TerminalExitEvent,
  WatchPushEvent,
  WorktreeRecord,
} from './channels';
import type {
  ConnectionSpec,
  ConnectionStatus,
  DirEntry,
  FileReadOptions,
  FileReadResult,
  ResolvedPath,
  ResolvePathOptions,
  StatResult,
  TerminalOpenOptions,
} from '@shared/providers/types';
import type { AppSettings } from '@shared/settings';

/**
 * `window.api` — the narrow preload bridge. Provider/terminal/watch calls
 * target the active project (SessionManager); switching is `projects.activate`.
 * Event subscriptions return an unsubscribe function.
 */
export interface RendererApi {
  ping(): Promise<{ ok: true; at: string }>;

  projects: {
    list(): Promise<ProjectInfo[]>;
    add(input: { label: string; connection: ConnectionSpec }): Promise<ProjectInfo>;
    remove(id: string): Promise<void>;
    /** Update a project's label and/or connection spec (kind immutable). */
    update(id: string, patch: { label?: string; connection?: ConnectionSpec }): Promise<ProjectInfo>;
    openDialog(): Promise<string | null>;
    activate(id: string): Promise<void>;
    getActive(): Promise<string | null>;
    /** Persist a new left-to-right project order (full ordered id list). */
    reorder(ids: string[]): Promise<void>;
    /** Set (or clear, with null) the project's Run-panel command. */
    setRunCommand(id: string, command: string | null): Promise<void>;
    /** Disconnect a remote project's provider, keeping it selected (state=disconnected). */
    disconnect(id: string): Promise<void>;
    /** Evict cached provider and reconnect from scratch (re-provisions helper). */
    reconnect(id: string): Promise<void>;
  };

  /**
   * Provider reads. Each read optionally accepts a trailing `projectId` to
   * address a specific live session; omitting it targets the active project
   * (legacy behavior). panelDataSync passes an explicit id so any connected
   * project's slice stays current regardless of which project is focused.
   */
  provider: {
    listWorktrees(projectId?: string): Promise<WorktreeRecord[]>;
    getChangeset(worktreePath: string, baseline?: string, projectId?: string): Promise<Changeset>;
    getFileDiff(worktreePath: string, filePath: string, baseline?: string, projectId?: string): Promise<string>;
    readFile(path: string, opts?: FileReadOptions, projectId?: string): Promise<FileReadResult>;
    stat(path: string, projectId?: string): Promise<StatResult>;
    listDir(dirPath: string, projectId?: string): Promise<DirEntry[]>;
    /** Resolve + validate + classify a link target (inside/outside project). */
    resolvePath(input: string, opts?: ResolvePathOptions, projectId?: string): Promise<ResolvedPath>;
    detectBeads(projectId?: string): Promise<boolean>;
    getTaskGraph(projectId?: string): Promise<BeadsTaskGraph>;
    getTask(issueId: string, projectId?: string): Promise<BeadsIssue | null>;
    // Beads writes (via the provider's `br` CLI seam). Reject (with br's message)
    // on failure; the store surfaces it inline.
    beadsClose(issueId: string, reason?: string, projectId?: string): Promise<void>;
    beadsReopen(issueId: string, projectId?: string): Promise<void>;
    beadsComment(issueId: string, message: string, projectId?: string): Promise<void>;
    beadsCreate(input: BeadsCreateInput, projectId?: string): Promise<string | null>;
    beadsListComments(issueId: string, projectId?: string): Promise<BeadsComment[]>;
    /** Snapshot of every live session's current connection status, keyed by
     *  projectId. Used to hydrate the session store on renderer (re)load. */
    getStatuses(): Promise<Record<string, ConnectionStatus>>;
    /**
     * Resolve the branch-point baseline for a worktree. Returns the parent
     * branch reference and merge-base SHA, or null when no parent can be
     * resolved (orphan branch, unrelated histories, no upstream + no default).
     */
    resolveBranchPoint(worktreePath: string, projectId?: string): Promise<BranchPoint | null>;
  };

  terminal: {
    open(opts: TerminalOpenOptions): Promise<string>;
    write(terminalId: string, data: string): Promise<void>;
    resize(terminalId: string, cols: number, rows: number): Promise<void>;
    close(terminalId: string, kill?: boolean): Promise<void>;
    list(): Promise<string[]>;
  };

  /**
   * tmux control-mode (`-CC`) for the active project. ADDITIVE: this drives a
   * single per-project control session and is not yet the active terminal path.
   * `command` issues a tmux command and resolves with the correlated reply;
   * `input` sends pane keystrokes as space-separated hex pairs.
   */
  tmuxControl: {
    open(opts?: { cols?: number; rows?: number }): Promise<string>;
    close(kill?: boolean): Promise<void>;
    command(args: string): Promise<TmuxCommandReply>;
    input(paneId: string, hex: string): Promise<void>;
    resize(cols: number, rows: number): Promise<void>;
    capturePane(paneId: string, startLine?: number): Promise<string[]>;
  };

  notes: {
    create(input: {
      projectId: string;
      targetKind: ReviewTargetKind;
      targetId: string;
      body: string;
      line?: number | null;
      anchorText?: string | null;
    }): Promise<NoteRecord>;
    update(id: number, body: string): Promise<NoteRecord | null>;
    remove(id: number): Promise<void>;
    list(projectId: string, filter?: { targetKind?: ReviewTargetKind; targetId?: string }): Promise<NoteRecord[]>;
    exportMarkdown(projectId: string): Promise<string>;
  };

  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    listFonts(): Promise<string[]>;
  };

  sessions: {
    list(): Promise<TmuxSessionInfo[]>;
    kill(name: string): Promise<void>;
    killDetached(): Promise<string[]>;
  };

  logs: {
    get(): Promise<LogEntry[]>;
  };

  openDiagnostics(): Promise<void>;

  events: {
    onSettingsChanged(handler: (s: AppSettings) => void): () => void;
    onTerminalData(handler: (e: TerminalDataEvent) => void): () => void;
    onTerminalExit(handler: (e: TerminalExitEvent) => void): () => void;
    onTmux(handler: (e: TmuxEvent) => void): () => void;
    onWatch(handler: (e: WatchPushEvent) => void): () => void;
    onStatus(handler: (e: StatusEvent) => void): () => void;
    onProjectsChanged(handler: (e: { at: string }) => void): () => void;
    onLog(handler: (e: LogEntry) => void): () => void;
  };
}
