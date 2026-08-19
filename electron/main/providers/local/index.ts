/**
 * LocalProvider — WorkspaceProvider backed by direct local filesystem/git/beads
 * access and (later) a node-pty terminal and chokidar watch.
 *
 * This module implements the read surface (br h7a.2.2). The terminal methods
 * are implemented by the PTY host task (br h7a.3.1) and watch by the chokidar
 * task (br h7a.2.3); until then they throw a clear NotImplemented error.
 */
import { join, isAbsolute } from 'node:path';
import type {
  BeadsComment,
  BeadsCreateInput,
  BeadsIssue,
  BeadsTaskGraph,
  Changeset,
  WorktreeRecord,
} from '@shared/ipc/channels';
import { beadsArgs, parseComments, parseCreatedId, runBr } from '../../beads/runner';
import type {
  DiffBundle,
  DirEntry,
  ConnectionStatus,
  FileBytesOptions,
  FileBytesResult,
  FileReadOptions,
  FileReadResult,
  ProjectKind,
  ResolvedPath,
  ResolvePathOptions,
  StatResult,
  TerminalDataHandler,
  TerminalExitHandler,
  TerminalHandle,
  TerminalOpenOptions,
  WatchHandler,
  WatchSubscription,
  WorkspaceProvider,
} from '../types';
import {
  localChangeset,
  localDetectBeads,
  localFileDiff,
  localGetTask,
  localListDir,
  localListWorktrees,
  localReadFile,
  localResolvePath,
  localStat,
  localTaskGraph,
} from './reads';
import { localReadFileBytes } from './readFileBytes';
import { localExportFile } from './export';
import { LocalWatchManager } from './watch';
import { LocalTerminalManager } from './terminal';
import { sessionNameToken } from '../sessionKey';
import { loadSettings } from '../../config';
import { createConnectionMachine, type ConnectionMachine } from '../connectionMachine';
import { resolveBranchPoint as gitResolveBranchPoint } from '../../git/branchPoint';
import type { BranchPoint } from '@shared/ipc/channels';

export class LocalProvider implements WorkspaceProvider {
  readonly kind: ProjectKind = 'local';
  readonly projectId: string;
  private readonly rootPath: string;
  // Local access has no real transport: a local project is always considered
  // connected once the provider is instantiated. The machine short-circuits to
  // connected immediately so disconnect/reconnect intents from the UI are
  // guarded no-ops (illegal transitions are rejected by the machine).
  private readonly machine: ConnectionMachine;
  private readonly watch: LocalWatchManager;
  private readonly terminals: LocalTerminalManager;

  constructor(projectId: string, rootPath: string) {
    this.projectId = projectId;
    this.rootPath = rootPath;
    this.machine = createConnectionMachine(projectId, 'connected');
    this.watch = new LocalWatchManager(rootPath);
    const token = sessionNameToken(loadSettings().deterministicSessionNames, projectId, rootPath);
    this.terminals = new LocalTerminalManager(rootPath, token);
  }

  private resolve(path: string): string {
    return isAbsolute(path) ? path : join(this.rootPath, path);
  }

  // Lifecycle — local access has no transport; always connected.
  async connect(): Promise<void> {
    // Local is always connected; machine was initialized to 'connected'.
    // Re-emit via shortCircuit so any late subscriber gets the current status.
    this.machine.shortCircuitConnected();
  }
  async disconnect(): Promise<void> {
    this.terminals.closeAll();
    await this.watch.closeAll();
    // Local disconnect/reconnect intents are no-ops at the machine level
    // (connected->disconnected is a legal transition but local should not flow
    // remote transitions). We honor the teardown for resource cleanup but do
    // not change the connection status: the machine's guard will reject any
    // illegal follow-on transition anyway.
  }
  status(): ConnectionStatus {
    return this.machine.current();
  }
  onStatusChange(handler: (s: ConnectionStatus) => void): () => void {
    return this.machine.subscribe(handler);
  }

  // Git (read-only)
  listWorktrees(): Promise<WorktreeRecord[]> {
    return localListWorktrees(this.rootPath);
  }
  getChangeset(worktreePath: string, baseline?: string): Promise<Changeset> {
    return localChangeset(worktreePath || this.rootPath, baseline);
  }
  getFileDiff(worktreePath: string, filePath: string, baseline?: string): Promise<string> {
    return localFileDiff(worktreePath || this.rootPath, filePath, baseline);
  }
  async getDiffBundle(worktreePath: string, filePath: string, baseline?: string): Promise<DiffBundle> {
    // Local reads are free, so just compose the existing primitives behind the
    // shared one-call contract (the bundle exists to save round trips on remote).
    const cwd = worktreePath || this.rootPath;
    const [patch, newR, oldR] = await Promise.all([
      localFileDiff(cwd, filePath, baseline),
      // Read both sides from the worktree (not the fixed project root) so a linked
      // worktree's content is highlighted — matching remote, which already reads
      // the new side from the worktree.
      localReadFile(this.rootPath, filePath, { worktreePath: cwd }),
      // No explicit baseline means "compare against HEAD" (the default diff
      // target), not "there is no old side" — read at the literal 'HEAD' ref so
      // the default view resolves old content the same way an explicit
      // baseline would. A genuinely new file still resolves to null: getFile's
      // ref branch catches a failed `git cat-file` (path absent at that ref)
      // and returns content: null, so "no history at this ref" and "no
      // baseline supplied" stay correctly distinct.
      localReadFile(this.rootPath, filePath, { ref: baseline || 'HEAD', worktreePath: cwd }),
    ]);
    const usable = (r: FileReadResult | null): string | null =>
      r && !r.truncated && !r.isBinary ? r.content : null;
    return { patch, newContent: usable(newR), oldContent: usable(oldR) };
  }
  resolveBranchPoint(worktreePath: string): Promise<BranchPoint | null> {
    return gitResolveBranchPoint(worktreePath || this.rootPath);
  }

  // Filesystem (read-only)
  readFile(path: string, opts?: FileReadOptions): Promise<FileReadResult> {
    return localReadFile(this.rootPath, path, opts);
  }
  async stat(path: string): Promise<StatResult> {
    return localStat(this.resolve(path));
  }
  async listDir(dirPath: string, worktreePath?: string): Promise<DirEntry[]> {
    return localListDir(this.rootPath, dirPath, worktreePath);
  }
  async resolvePath(input: string, opts?: ResolvePathOptions): Promise<ResolvedPath> {
    return localResolvePath(this.rootPath, input, opts);
  }
  async readFileBytes(path: string, opts?: FileBytesOptions): Promise<FileBytesResult> {
    return localReadFileBytes(this.rootPath, path, opts);
  }

  // Filesystem (bounded export — the one write, OUT of the repo only)
  async exportFile(path: string, destAbsPath: string, opts?: { worktreePath?: string }): Promise<void> {
    return localExportFile(this.rootPath, path, destAbsPath, opts);
  }

  // Beads (read-only)
  async detectBeads(): Promise<boolean> {
    return localDetectBeads(this.rootPath);
  }
  async getTaskGraph(): Promise<BeadsTaskGraph> {
    return localTaskGraph(this.rootPath);
  }
  async getTask(issueId: string): Promise<BeadsIssue | null> {
    return localGetTask(this.rootPath, issueId);
  }

  // Beads (write — via the `br` CLI in the project root; argv only, no shell).
  async beadsClose(issueId: string, reason?: string): Promise<void> {
    runBr(this.rootPath, beadsArgs.close(issueId, reason));
  }
  async beadsReopen(issueId: string): Promise<void> {
    runBr(this.rootPath, beadsArgs.reopen(issueId));
  }
  async beadsComment(issueId: string, message: string): Promise<void> {
    runBr(this.rootPath, beadsArgs.comment(issueId, message));
  }
  async beadsCreate(input: BeadsCreateInput): Promise<string | null> {
    return parseCreatedId(runBr(this.rootPath, beadsArgs.create(input)));
  }
  async beadsListComments(issueId: string): Promise<BeadsComment[]> {
    return parseComments(runBr(this.rootPath, beadsArgs.listComments(issueId)));
  }

  // Terminal (node-pty)
  async openTerminal(opts: TerminalOpenOptions): Promise<TerminalHandle> {
    return this.terminals.open(opts);
  }
  async writeTerminal(id: string, data: string): Promise<void> {
    this.terminals.write(id, data);
  }
  async resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
    this.terminals.resize(id, cols, rows);
  }
  onTerminalData(id: string, handler: TerminalDataHandler): () => void {
    return this.terminals.onData(id, handler);
  }
  onTerminalExit(id: string, handler: TerminalExitHandler): () => void {
    return this.terminals.onExit(id, handler);
  }
  async closeTerminal(id: string, opts?: { kill?: boolean }): Promise<void> {
    this.terminals.close(id, opts);
  }
  async listTerminals(): Promise<string[]> {
    return this.terminals.listSessions();
  }

  // Watch (chokidar, debounced)
  async subscribeWatch(globs: string[], handler: WatchHandler): Promise<WatchSubscription> {
    return this.watch.subscribe(globs, handler);
  }
  async subscribeWorktreeWatch(worktreePath: string, handler: WatchHandler): Promise<WatchSubscription> {
    return this.watch.subscribeWorktree(worktreePath, handler);
  }
}
