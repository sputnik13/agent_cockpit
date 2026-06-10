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
  DirEntry,
  ConnectionStatus,
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
import { LocalWatchManager } from './watch';
import { LocalTerminalManager } from './terminal';
import { createConnectionMachine, type ConnectionMachine } from '../connectionMachine';

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
    this.terminals = new LocalTerminalManager(rootPath, projectId);
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

  // Filesystem (read-only)
  readFile(path: string, opts?: FileReadOptions): Promise<FileReadResult> {
    return localReadFile(this.rootPath, path, opts);
  }
  async stat(path: string): Promise<StatResult> {
    return localStat(this.resolve(path));
  }
  async listDir(dirPath: string): Promise<DirEntry[]> {
    return localListDir(this.rootPath, dirPath);
  }
  async resolvePath(input: string, opts?: ResolvePathOptions): Promise<ResolvedPath> {
    return localResolvePath(this.rootPath, input, opts);
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
}
