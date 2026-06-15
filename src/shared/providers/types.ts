/**
 * WorkspaceProvider — the transport-agnostic seam between renderer panels and a
 * project's data/terminal, regardless of whether the project is local or
 * accessed over SSH. `LocalProvider` and `RemoteProvider` implement this; the
 * renderer consumes it through a provider-client proxy. Panels never know which
 * transport backs the active provider.
 *
 * All repository access is read-only — the embedded terminal is the only write
 * path. Methods are async because the renderer always reaches a provider over
 * IPC (and, for remote, over SSH).
 *
 * See docs/proposals/_active_agent-cockpit-local-remote.md (#workspaceprovider-interface-if-1).
 */
import type {
  BeadsComment,
  BeadsCreateInput,
  BeadsIssue,
  BeadsTaskGraph,
  BranchPoint,
  Changeset,
  WorktreeRecord,
} from '../ipc/channels';

export type ProjectKind = 'local' | 'remote';

export interface LocalConnectionSpec {
  kind: 'local';
  /** Absolute path to the repository root on this machine. */
  rootPath: string;
}

export interface RemoteConnectionSpec {
  kind: 'remote';
  host: string;
  user: string;
  port: number;
  /** Optional explicit identity file; otherwise the SSH agent/default keys. */
  identityPath?: string;
  /** Absolute path to the repository root on the remote host. */
  remotePath: string;
}

export type ConnectionSpec = LocalConnectionSpec | RemoteConnectionSpec;

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface ConnectionStatus {
  state: ConnectionState;
  /** Human-readable detail (e.g. "uploading helper", an error message). */
  detail?: string;
  /** ISO timestamp of the last state transition. */
  since: string;
}

// ---- Terminal --------------------------------------------------------------

/**
 * Terminal kind, which selects the tmux session namespace:
 * - `terminal` → `agent-cockpit-terminal-<projectId>-<key>` (many per project)
 * - `run` → `agent-cockpit-run-<projectId>` (one per project; the key is ignored
 *   for the session name)
 */
export type TerminalKind = 'terminal' | 'run';

export interface TerminalOpenOptions {
  /** Working directory; defaults to the project root. */
  cwd?: string;
  cols: number;
  rows: number;
  /**
   * Stable per-terminal key. For `terminal` kind it maps to a dedicated tmux
   * session (`agent-cockpit-terminal-<projectId>-<key>`) so the terminal
   * persists across restarts and multiple terminals can coexist per project.
   * Omitted = provider generates one.
   */
  key?: string;
  /** Session namespace. Defaults to `terminal`. See {@link TerminalKind}. */
  kind?: TerminalKind;
}

export interface TerminalHandle {
  /** The terminal key (also the tmux session suffix). */
  id: string;
}

export interface TerminalCloseOptions {
  /** End the underlying tmux session (kills the agent). Default: detach only. */
  kill?: boolean;
}

export interface TerminalExitInfo {
  code: number | null;
  signal: string | null;
}

export type TerminalDataHandler = (data: string) => void;
export type TerminalExitHandler = (info: TerminalExitInfo) => void;

// ---- Filesystem (read-only) ------------------------------------------------

export interface FileReadOptions {
  maxBytes?: number;
  /** Read the file content at a git ref instead of the working tree. */
  ref?: string;
}

export interface FileReadResult {
  content: string | null;
  truncated: boolean;
  isBinary: boolean;
  sizeBytes: number;
}

export interface StatResult {
  exists: boolean;
  size: number;
  isDir: boolean;
  mtime: string | null;
}

export interface DirEntry {
  /** Base name. */
  name: string;
  /** Path relative to the project root (for further listDir / readFile). */
  path: string;
  isDir: boolean;
}

/** Resolution + existence + project-membership of a clicked link target. The
 *  renderer never stats the filesystem itself; the provider resolves on the
 *  correct host (local vs remote). */
export interface ResolvedPath {
  exists: boolean;
  isDir: boolean;
  /** True when the resolved path is inside the project root. */
  insideProject: boolean;
  /** Path relative to the project root (POSIX separators) when inside; else null. */
  relPath: string | null;
  /** Canonical absolute path on the provider host. */
  absPath: string;
}

/** Options for resolvePath. `base` is the directory context a relative link is
 *  resolved against (absolute, or relative to the project root); omitted → root. */
export interface ResolvePathOptions {
  base?: string;
}

// ---- Watch -----------------------------------------------------------------

export interface WatchEvent {
  token: string;
  paths: string[];
  at: string;
}

export type WatchHandler = (event: WatchEvent) => void;

export interface WatchSubscription {
  token: string;
  unsubscribe(): Promise<void>;
}

// ---- The provider ----------------------------------------------------------

export interface WorkspaceProvider {
  readonly kind: ProjectKind;
  readonly projectId: string;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): ConnectionStatus;
  onStatusChange(handler: (status: ConnectionStatus) => void): () => void;

  // Terminal (the sole write path into the project). Each terminal is a
  // dedicated tmux session, so multiple coexist per project and persist across
  // restarts. `listTerminals` returns existing session keys for tab restore.
  openTerminal(opts: TerminalOpenOptions): Promise<TerminalHandle>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  onTerminalData(id: string, handler: TerminalDataHandler): () => void;
  onTerminalExit(id: string, handler: TerminalExitHandler): () => void;
  closeTerminal(id: string, opts?: TerminalCloseOptions): Promise<void>;
  listTerminals(): Promise<string[]>;

  // Git (read-only)
  listWorktrees(): Promise<WorktreeRecord[]>;
  getChangeset(worktreePath: string, baseline?: string): Promise<Changeset>;
  getFileDiff(worktreePath: string, filePath: string, baseline?: string): Promise<string>;
  /**
   * Resolve the branch-point baseline for a worktree. The parent is the
   * configured upstream (@{upstream}) if set, otherwise the repo default branch
   * (origin/HEAD → main → master). Returns null when no parent can be resolved
   * (orphan branch, unrelated histories, or no upstream and no default branch).
   */
  resolveBranchPoint(worktreePath: string): Promise<BranchPoint | null>;

  // Filesystem (read-only)
  readFile(path: string, opts?: FileReadOptions): Promise<FileReadResult>;
  stat(path: string): Promise<StatResult>;
  /** List a directory (path relative to project root; '' = root). */
  listDir(dirPath: string): Promise<DirEntry[]>;
  /** Resolve a link target (absolute, `file://`, or relative) to its canonical
   *  path, existence, and project membership. */
  resolvePath(input: string, opts?: ResolvePathOptions): Promise<ResolvedPath>;

  // Beads (read-only)
  detectBeads(): Promise<boolean>;
  getTaskGraph(): Promise<BeadsTaskGraph>;
  getTask(issueId: string): Promise<BeadsIssue | null>;

  // Beads (write — through the `br` CLI: audit trail, policy gates, WAL, JSONL
  // sync). Supported on local AND remote (remote runs `br` over the helper exec
  // RPC). `br` is always invoked with argv (no shell). Reads stay on SQLite/jsonl.
  beadsClose(issueId: string, reason?: string): Promise<void>;
  beadsReopen(issueId: string): Promise<void>;
  beadsComment(issueId: string, message: string): Promise<void>;
  /** Create a child issue; resolves to the new issue id when `br` reports it. */
  beadsCreate(input: BeadsCreateInput): Promise<string | null>;
  beadsListComments(issueId: string): Promise<BeadsComment[]>;

  // Watch
  subscribeWatch(globs: string[], handler: WatchHandler): Promise<WatchSubscription>;
}
