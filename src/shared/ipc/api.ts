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
  DiffBundle,
  DirEntry,
  FileBytesOptions,
  FileBytesResult,
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
    getDiffBundle(
      worktreePath: string,
      filePath: string,
      baseline?: string,
      projectId?: string,
    ): Promise<DiffBundle>;
    readFile(path: string, opts?: FileReadOptions, projectId?: string): Promise<FileReadResult>;
    /** Bounded binary-preview read (base64 bytes, size-capped, no range, no
     *  `ref`) — see WorkspaceProvider.readFileBytes for the full contract. */
    readFileBytes(path: string, opts?: FileBytesOptions, projectId?: string): Promise<FileBytesResult>;
    stat(path: string, projectId?: string): Promise<StatResult>;
    listDir(dirPath: string, worktreePath?: string, projectId?: string): Promise<DirEntry[]>;
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

  /**
   * Bounded export (Download capability): opens a native Save-as dialog in
   * main and streams `path`'s bytes to the chosen destination — no file bytes
   * cross IPC. Resolves the saved absolute path, or `null` if the user
   * canceled (nothing is written in that case). `path` resolves against
   * `opts.worktreePath || project root`, matching every other provider read.
   */
  files: {
    saveAs(
      path: string,
      opts?: { worktreePath?: string; projectId?: string; suggestedName?: string },
    ): Promise<string | null>;
  };

  /**
   * The one renderer -> main watch channel (watch is otherwise not
   * renderer-driven — see channels.ts's module doc comment). `worktreeStore`
   * is the sole owner of the active-worktree selection; this projects that
   * selection to main so it can (de)establish the lazy, at-most-one-per-
   * project active-external-worktree watch (`SessionManager.setActiveWorktree`,
   * local_repo_explorer-g1je). The renderer owns no watch-subscription state
   * of its own — it only forwards the selection on every transition,
   * including to `null` (no worktree selected / project switch).
   */
  watch: {
    setActiveWorktree(projectId: string, worktreePath: string | null): Promise<void>;
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
    /** `projectId`, when given, EXPLICITLY addresses this open at that
     *  specific project's control session — see `command`'s doc comment
     *  (local_repo_explorer-0255). Called on every `acquireControlSession`
     *  (every project switch, not just first-visit), so it needs the same
     *  explicit addressing: without it, a switch racing main's own active-
     *  project update can open/attach the WRONG project's control manager. */
    open(opts?: { cols?: number; rows?: number }, projectId?: string): Promise<string>;
    /** `projectId`, when given, EXPLICITLY addresses this close at that
     *  specific project's control session (local_repo_explorer-0255). */
    close(kill?: boolean, projectId?: string): Promise<void>;
    /** `projectId`, when given, EXPLICITLY addresses this command at that
     *  live session instead of implicitly targeting whichever project main
     *  currently considers active — see TmuxCommandReply's doc comment
     *  (local_repo_explorer-0255). Required for any multi-step sequence tied
     *  to a specific project; omit only when "whatever's active right now" is
     *  the genuinely intended target (e.g. a direct user keystroke/click). */
    command(args: string, projectId?: string): Promise<TmuxCommandReply>;
    /** `projectId`, when given, EXPLICITLY addresses these keystrokes at that
     *  specific pane's own project — without it, this can send input into the
     *  wrong project's real pane across different tmux servers, since pane
     *  ids are only unique per-server (local_repo_explorer-0255). */
    input(paneId: string, hex: string, projectId?: string): Promise<void>;
    /** `projectId`, when given, EXPLICITLY addresses this client-size push at
     *  that specific project's control client (local_repo_explorer-0255). */
    resize(cols: number, rows: number, projectId?: string): Promise<void>;
    /** `projectId`, when given, EXPLICITLY addresses this capture at that
     *  specific pane's own project. This is the channel that seeds/re-seeds a
     *  pane's VISIBLE CONTENT from `capture-pane` — omitting it let another
     *  project's real terminal content get painted into this project's pane
     *  across different tmux servers, since pane ids are only unique
     *  per-server (local_repo_explorer-0255). */
    capturePane(paneId: string, startLine?: number, projectId?: string): Promise<string[]>;
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
