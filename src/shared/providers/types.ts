/**
 * WorkspaceProvider — the transport-agnostic seam between renderer panels and a
 * project's data/terminal, regardless of whether the project is local or
 * accessed over SSH. `LocalProvider` and `RemoteProvider` implement this; the
 * renderer consumes it through a provider-client proxy. Panels never know which
 * transport backs the active provider.
 *
 * Repository access is read-only — the embedded terminal is the only write
 * path INTO a project. One deliberate, bounded exception: `exportFile` copies
 * a file OUT of the repository to a user-chosen destination on the app host
 * (the Download capability), at explicit user request. It never writes into
 * the repository, local or remote, and it is not license to reopen the
 * read-only model. Methods are async because the renderer always reaches a
 * provider over IPC (and, for remote, over SSH).
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
  /** Resolve the path against this worktree root instead of the project root;
   *  empty/absent = project root. */
  worktreePath?: string;
}

/** One-round-trip diff bundle (see WorkspaceProvider.getDiffBundle). `newContent`
 *  / `oldContent` are null when that side should not be highlighted (absent,
 *  binary, too large, or unreadable). */
export interface DiffBundle {
  patch: string;
  newContent: string | null;
  oldContent: string | null;
}

export interface FileReadResult {
  content: string | null;
  truncated: boolean;
  isBinary: boolean;
  sizeBytes: number;
}

/** Why `readFileBytes` returned no bytes for an existing path (or `missing`
 *  when the path itself does not exist). */
export type FileBytesUnavailableReason = 'missing' | 'too-large' | 'is-dir';

/** Options for `readFileBytes`. `ref`, added by local_repo_explorer-bn8a, is
 *  the byte-safe counterpart to `FileReadOptions.ref` — see the method's doc
 *  comment for the full byte-source/routing rationale. */
export interface FileBytesOptions {
  /** Resolve the path against this worktree root instead of the project root;
   *  empty/absent = project root. Also selects the git context (cwd) a `ref`
   *  read resolves against, so a linked worktree on another branch reads that
   *  branch's ref — mirrors every other worktree-aware provider read. */
  worktreePath?: string;
  /** Read the file's bytes AT this git ref instead of the working tree —
   *  serves the image-diff baseline preview (ImageCompare's "before" pane).
   *  Local: `simpleGit.binaryCatFile`, the same plumbing `getFile`'s text-
   *  preview ref branch already uses (electron/main/git/files.ts). Remote:
   *  the helper's dedicated `readFileBytes` RPC (`git show ref:path`,
   *  base64-encoded via a Go `[]byte` field — byte-faithful, unlike the
   *  text-only `readFile` RPC's `string` field, which corrupts invalid UTF-8
   *  to U+FFFD at the JSON boundary); NEVER SFTP (SFTP is filesystem-only —
   *  it cannot serve a git-object read). A path absent at `ref` (e.g. an
   *  added file, which has no baseline version) resolves
   *  `{ exists: false, reason: 'missing' }`, exactly like a missing
   *  working-tree path, rather than rejecting. */
  ref?: string;
}

/**
 * Result of `readFileBytes`. `bytesBase64` is the file's WHOLE bytes,
 * base64-encoded; `null` when bytes are refused/absent (see `reason`).
 * NOTE: an existing 0-byte file yields `''` (empty string) — falsy but valid.
 * Consumers MUST branch on `reason === null` to detect "bytes are present",
 * never on the truthiness of `bytesBase64`.
 */
export interface FileBytesResult {
  bytesBase64: string | null;
  sizeBytes: number;
  exists: boolean;
  reason: FileBytesUnavailableReason | null;
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
   * One-round-trip diff bundle for the Content view: the unified patch plus the
   * file content needed to syntax-highlight both sides (working tree = new,
   * `baseline` ref = old). Collapses what was getFileDiff + 2× readFile into a
   * single provider call (one RPC on remote). `newContent`/`oldContent` are null
   * when that side is absent (added/deleted file), binary, too large, or
   * unreadable — the caller then renders that side as plain text.
   */
  getDiffBundle(worktreePath: string, filePath: string, baseline?: string): Promise<DiffBundle>;
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
  /** List a directory (path relative to the base root; '' = root). `worktreePath`
   *  resolves the base against that worktree instead of the project root;
   *  empty/absent = project root. */
  listDir(dirPath: string, worktreePath?: string): Promise<DirEntry[]>;
  /** Resolve a link target (absolute, `file://`, or relative) to its canonical
   *  path, existence, and project membership. */
  resolvePath(input: string, opts?: ResolvePathOptions): Promise<ResolvedPath>;

  /**
   * Bounded, general-purpose binary-preview read: returns `path`'s bytes
   * (base64-encoded) to the renderer over IPC, gated by a prior size check.
   * This is the byte source every content-type preview needs (images now,
   * other binary types later) — `readFile` is text-only (assumes UTF-8 and
   * flags/truncates binary) and `exportFile` writes to the app HOST, not the
   * renderer, so neither can serve a renderer-side binary preview.
   *
   * Name/shape: `readFileBytes` parallels `readFile`/`stat`/`exportFile` —
   * "file bytes" describes the READ, not a content class, so a second
   * content type (audio, PDF, ...) can adopt this with no signature change.
   * `FileBytesResult.reason` is a closed, machine-readable enum rather than a
   * message string, so callers branch without parsing text.
   *
   * Size gate (refuse, never truncate): the resolved path is STATTED FIRST
   * (local `fs.stat`, remote `RemoteTransport.stat`); `size > FILE_BYTES_CAP`
   * (10 MiB — see `src/shared/providers/fileBytesCap.ts`, the one authoring
   * site, for the full justification and contrast with the smaller local
   * 256 KiB / remote-helper 2 MiB text-read caps) resolves METADATA ONLY
   * (`sizeBytes` + `reason: 'too-large'`, no bytes) — never a truncated
   * prefix. A prefix is useless to every decode-dependent consumer anyway (a
   * half-read PNG does not render), so "refuse with size" is both the
   * correct product behavior and the boundary-preserving one. A missing path
   * resolves `{ exists: false, reason: 'missing' }` rather than rejecting.
   *
   * No range, ever: this is a WHOLE-FILE read. `RemoteTransport.createReadStream`
   * accepts an optional `{start,end}` reserved for a distinct, not-yet-built
   * future streaming/seek capability (see that method's doc comment and
   * docs/ARCHITECTURE.md "Future streaming (deferred; the range capability)");
   * this primitive never passes one and no caller may add one — that would
   * silently widen a documented repo-wide non-goal.
   *
   * `ref` (reading content at a git ref instead of the working tree) IS
   * supported (added by local_repo_explorer-bn8a) — see
   * `FileBytesOptions.ref`'s doc comment for the byte-source/routing detail
   * (local: git plumbing via simpleGit; remote: a dedicated helper RPC,
   * NEVER SFTP — SFTP is filesystem-only and cannot serve a git-object read;
   * and never the text-only `readFile` RPC either, whose `string` field
   * corrupts invalid UTF-8 at the JSON boundary). A `ref` read applies the
   * SAME size gate and refuse-never-truncate contract as the working-tree
   * path above (still `FILE_BYTES_CAP`, still no partial bytes) — this is an
   * ADDITION to the v1 contract, not a rework of it. Consequence for
   * consumers: the image-diff "before (baseline)" pane (ImageCompare) now has
   * a real byte source for every add/modify/delete/rename status — a path
   * absent at `ref` (an added file, which has no baseline version) resolves
   * `{ exists: false, reason: 'missing' }` exactly like a missing
   * working-tree path, which callers fold into the same "absent" rendering
   * rather than a separate case.
   *
   * `opts.worktreePath` behaves exactly like every other provider read: base
   * = `worktreePath || project root`; an already-absolute `path` passes
   * through unchanged.
   */
  readFileBytes(path: string, opts?: FileBytesOptions): Promise<FileBytesResult>;

  // Filesystem (bounded export — the one write, OUT of the repo only)
  /**
   * Copy `path`'s bytes (resolved against `opts.worktreePath || project root`,
   * exactly like `readFile`/`stat`) to `destAbsPath` on the app host — the
   * Download capability. Always the whole file; never binary-sniffed or
   * size-capped (that is `readFile`'s preview concern, not this one). Rejects
   * on a missing/unreadable source, a disconnected transport, an unwritable
   * destination, or a mid-transfer failure; on any failure `destAbsPath` is
   * left with no partial/truncated content.
   */
  exportFile(path: string, destAbsPath: string, opts?: { worktreePath?: string }): Promise<void>;

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
  /**
   * Subscribe to filesystem changes rooted at a SPECIFIC worktree path,
   * independent of the project's primary `subscribeWatch` subscription
   * (which stays rootPath/remotePath-scoped and structurally cannot observe
   * a worktree outside its own subtree). Establishes a lazy, per-project,
   * at-most-one extra watch for the ACTIVE external worktree
   * (`SessionManager.setActiveWorktree`, local_repo_explorer-g1je) — never
   * an eager fanout across every known worktree.
   *
   * Working-tree-only semantics: unlike `subscribeWatch`, this does NOT emit
   * `.git`/`.beads` git-state/beads signal events for the worktree checkout.
   * A linked worktree's own `.git` is a plain FILE (a `gitdir:` pointer into
   * the primary worktree's `.git/worktrees/<name>`, not a real `.git`
   * directory), so those signals are meaningless there — the project's
   * PRIMARY `subscribeWatch` subscription already covers git/beads state,
   * which is shared repo-wide across every worktree.
   *
   * Paths delivered by the returned subscription's `WatchEvent.paths` are
   * relative to `worktreePath`, NOT the project root — callers must not
   * conflate them with `subscribeWatch`'s root-relative paths. Consumers
   * that fan these events out further (e.g. the `evt:watch` IPC payload) are
   * expected to tag them with `worktreePath` so downstream matching (diff
   * cache, FoldingView's read cache) can tell a worktree-relative batch
   * apart from a root-relative one.
   */
  subscribeWorktreeWatch(worktreePath: string, handler: WatchHandler): Promise<WatchSubscription>;
}
