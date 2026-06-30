/**
 * In-memory WorkspaceProvider for tests (renderer/panel tests and the provider
 * contract-conformance suite). Backed by injectable canned data; the terminal
 * echoes input, and watch subscriptions can be driven via `emitWatch`.
 */
import type {
  BeadsComment,
  BeadsIssue,
  BeadsTaskGraph,
  BranchPoint,
  Changeset,
  WorktreeRecord,
} from '../ipc/channels';
import type {
  ConnectionStatus,
  DiffBundle,
  FileReadOptions,
  FileReadResult,
  ProjectKind,
  StatResult,
  TerminalDataHandler,
  TerminalExitHandler,
  TerminalHandle,
  TerminalOpenOptions,
  WatchHandler,
  WatchSubscription,
  WorkspaceProvider,
} from './types';

export interface FakeProviderData {
  worktrees?: WorktreeRecord[];
  changeset?: Changeset;
  fileDiffs?: Record<string, string>;
  files?: Record<string, FileReadResult>;
  dirs?: Record<string, import('./types').DirEntry[]>;
  taskGraph?: BeadsTaskGraph;
  issues?: Record<string, BeadsIssue>;
  hasBeads?: boolean;
  branchPoint?: BranchPoint | null;
}

const EMPTY_GRAPH: BeadsTaskGraph = {
  source: { kind: 'sqlite', path: '' },
  schemaCompatible: true,
  issues: [],
  deps: [],
};

let counter = 0;

export class FakeProvider implements WorkspaceProvider {
  readonly kind: ProjectKind;
  readonly projectId: string;

  private statusValue: ConnectionStatus = { state: 'disconnected', since: new Date(0).toISOString() };
  private statusHandlers = new Set<(s: ConnectionStatus) => void>();
  private terminalData = new Map<string, Set<TerminalDataHandler>>();
  private terminalExit = new Map<string, Set<TerminalExitHandler>>();
  private watchers = new Map<string, WatchHandler>();
  /** When set, the next connect() rejects with this error (test seam for the
   *  failed-connect path). Cleared after it fires so a retry can succeed. */
  failNextConnect: Error | null = null;
  /** Count of connect() attempts, for asserting retry behavior in tests. */
  connectAttempts = 0;

  constructor(
    projectId: string,
    kind: ProjectKind = 'local',
    private data: FakeProviderData = {},
  ) {
    this.projectId = projectId;
    this.kind = kind;
  }

  // Lifecycle
  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.failNextConnect) {
      const err = this.failNextConnect;
      this.failNextConnect = null;
      throw err;
    }
    this.setStatus({ state: 'connected', since: new Date().toISOString() });
  }
  async disconnect(): Promise<void> {
    this.setStatus({ state: 'disconnected', since: new Date().toISOString() });
  }
  status(): ConnectionStatus {
    return this.statusValue;
  }
  onStatusChange(handler: (s: ConnectionStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }
  private setStatus(s: ConnectionStatus): void {
    this.statusValue = s;
    for (const h of this.statusHandlers) h(s);
  }

  // Terminal (echoes writes back as data)
  async openTerminal(opts: TerminalOpenOptions): Promise<TerminalHandle> {
    const id = opts.key ?? `fake-term-${++counter}`;
    if (!this.terminalData.has(id)) this.terminalData.set(id, new Set());
    if (!this.terminalExit.has(id)) this.terminalExit.set(id, new Set());
    return { id };
  }
  async listTerminals(): Promise<string[]> {
    return [...this.terminalData.keys()];
  }
  async writeTerminal(id: string, data: string): Promise<void> {
    for (const h of this.terminalData.get(id) ?? []) h(data);
  }
  async resizeTerminal(): Promise<void> {}
  onTerminalData(id: string, handler: TerminalDataHandler): () => void {
    const set = this.terminalData.get(id) ?? new Set();
    set.add(handler);
    this.terminalData.set(id, set);
    return () => set.delete(handler);
  }
  onTerminalExit(id: string, handler: TerminalExitHandler): () => void {
    const set = this.terminalExit.get(id) ?? new Set();
    set.add(handler);
    this.terminalExit.set(id, set);
    return () => set.delete(handler);
  }
  async closeTerminal(id: string, _opts?: { kill?: boolean }): Promise<void> {
    for (const h of this.terminalExit.get(id) ?? []) h({ code: 0, signal: null });
    this.terminalData.delete(id);
    this.terminalExit.delete(id);
  }

  // Git
  async listWorktrees(): Promise<WorktreeRecord[]> {
    return this.data.worktrees ?? [];
  }
  async getChangeset(worktreePath: string, baseline = 'HEAD'): Promise<Changeset> {
    return (
      this.data.changeset ?? {
        worktree: worktreePath,
        baseline,
        baselineKind: 'HEAD',
        files: [],
        generatedAt: new Date().toISOString(),
      }
    );
  }
  async getFileDiff(_worktreePath: string, filePath: string): Promise<string> {
    return this.data.fileDiffs?.[filePath] ?? '';
  }
  async getDiffBundle(_worktreePath: string, filePath: string, baseline?: string): Promise<DiffBundle> {
    const patch = this.data.fileDiffs?.[filePath] ?? '';
    const file = this.data.files?.[filePath];
    const newContent = file && !file.truncated && !file.isBinary ? file.content : null;
    return { patch, newContent, oldContent: baseline ? newContent : null };
  }
  async resolveBranchPoint(_worktreePath: string): Promise<BranchPoint | null> {
    return this.data.branchPoint ?? null;
  }

  // Filesystem
  async readFile(path: string, _opts?: FileReadOptions): Promise<FileReadResult> {
    return (
      this.data.files?.[path] ?? { content: null, truncated: false, isBinary: false, sizeBytes: 0 }
    );
  }
  async stat(path: string): Promise<StatResult> {
    const f = this.data.files?.[path];
    return f
      ? { exists: true, size: f.sizeBytes, isDir: false, mtime: new Date().toISOString() }
      : { exists: false, size: 0, isDir: false, mtime: null };
  }
  async listDir(dirPath: string): Promise<import('./types').DirEntry[]> {
    return this.data.dirs?.[dirPath] ?? [];
  }
  async resolvePath(input: string): Promise<import('./types').ResolvedPath> {
    const f = this.data.files?.[input];
    return {
      exists: f != null,
      isDir: false,
      insideProject: true,
      relPath: f != null ? input : null,
      absPath: input,
    };
  }

  // Beads
  async detectBeads(): Promise<boolean> {
    return this.data.hasBeads ?? false;
  }
  async getTaskGraph(): Promise<BeadsTaskGraph> {
    return this.data.taskGraph ?? EMPTY_GRAPH;
  }
  async getTask(issueId: string): Promise<BeadsIssue | null> {
    return this.data.issues?.[issueId] ?? null;
  }

  // Beads (write) — no-op stubs for interface compliance.
  async beadsClose(): Promise<void> {}
  async beadsReopen(): Promise<void> {}
  async beadsComment(): Promise<void> {}
  async beadsCreate(): Promise<string | null> {
    return null;
  }
  async beadsListComments(): Promise<BeadsComment[]> {
    return [];
  }

  // Watch
  async subscribeWatch(_globs: string[], handler: WatchHandler): Promise<WatchSubscription> {
    const token = `fake-watch-${++counter}`;
    this.watchers.set(token, handler);
    return {
      token,
      unsubscribe: async () => {
        this.watchers.delete(token);
      },
    };
  }

  /** Test helper: drive a watch event to all (or one) active subscription. */
  emitWatch(paths: string[], token?: string): void {
    const at = new Date().toISOString();
    for (const [t, h] of this.watchers) {
      if (token && t !== token) continue;
      h({ token: t, paths, at });
    }
  }
}
