/**
 * RemoteProvider — WorkspaceProvider backed by an SSH connection to a remote
 * host. Connection lifecycle (br h7a.7.1) delegates to `SshTransport`; the
 * read surface (git/fs/beads + watch, br h7a.7.3) is served by the Go remote
 * helper over a length-prefixed JSON RPC stream (`HelperRpcClient`), which is
 * provisioned and launched by `RemoteHelperLauncher` (br h7a.7.2); the terminal
 * (br h7a.7.4) is a persistent tmux session over an ssh2 PTY shell channel
 * (`RemoteTerminalManager`).
 *
 * Mirrors LocalProvider's structure: status emitter and read methods adapting
 * transport-specific results into the shared WorkspaceProvider contract.
 */
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type {
  BeadsComment,
  BeadsCreateInput,
  BeadsDep,
  BeadsIssue,
  BeadsTaskGraph,
  Changeset,
  FileChange,
  FileChangeStatus,
  WorktreeRecord,
} from '@shared/ipc/channels';
import type {
  ConnectionStatus,
  DirEntry,
  FileReadOptions,
  FileReadResult,
  ProjectKind,
  RemoteConnectionSpec,
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
import { createRemoteTransport } from './transportFactory';
import type { RemoteTransport } from './transportTypes';
import { RemoteHelperLauncher, type LaunchedHelper } from './helper';
import type { GitStatusEntry, HelperRpcClient } from './rpcClient';
import { beadsArgs, beadsErrorMessage, parseComments, parseCreatedId } from '../../beads/runner';
import { RemoteTerminalManager } from './tmux';
import { RemoteTmuxControlManager, type ControlChannel } from './tmuxControl';
import { createEnvLauncher, DEV_ENV_SCOPE_UNIT, type EnvLauncher } from './envLauncher';
import { loadSettings } from '../../config';
import { logger } from '../../logger';
import { createConnectionMachine, type ConnectionMachine } from '../connectionMachine';
import { createWatchIngest } from '../../watch/ingest';
import { deriveWatchSpec } from '@shared/watch/policy';
import { TERMINAL_SCROLLBACK } from '@shared/tmux';


/**
 * Map a git porcelain/name-status code to a FileChangeStatus. Codes come from
 * the helper's `gitStatus` (porcelain v1 two-letter codes for the working tree
 * and `--name-status` letters for a baseline diff).
 */
export function mapGitStatus(code: string): FileChangeStatus {
  const c = code.trim();
  if (c === '??') return 'untracked';
  if (c === '!!') return 'ignored';
  if (c.includes('U') || c === 'AA' || c === 'DD') return 'conflicted';
  const letter = c[0] ?? '';
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    case 'M':
    default:
      return 'modified';
  }
}

/** Assemble a Changeset from helper gitStatus entries with v1-shape defaults. */
export function assembleChangeset(
  worktree: string,
  baseline: string,
  entries: GitStatusEntry[],
): Changeset {
  const files: FileChange[] = entries.map((e) => ({
    status: mapGitStatus(e.status),
    oldPath: null,
    newPath: e.path,
    isBinary: false,
    isGenerated: false,
    sizeBytes: null,
    staged: false,
  }));
  return {
    worktree,
    baseline,
    baselineKind: 'HEAD',
    files,
    generatedAt: new Date().toISOString(),
  };
}

/** Parse a remote `.beads/issues.jsonl` body into a BeadsTaskGraph. */
function parseBeadsJsonl(path: string, text: string): BeadsTaskGraph {
  const issues: BeadsIssue[] = [];
  const deps: BeadsDep[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed['status'] === 'tombstone') continue;
    issues.push({
      id: String(parsed['id']),
      title: String(parsed['title'] ?? ''),
      body: String(parsed['description'] ?? ''),
      status: String(parsed['status'] ?? 'open'),
      priority: Number(parsed['priority'] ?? 2),
      issueType: String(parsed['issue_type'] ?? 'task'),
      labels: Array.isArray(parsed['labels']) ? (parsed['labels'] as string[]) : [],
      externalRef: (parsed['external_ref'] as string | undefined) ?? null,
      createdAt: String(parsed['created_at'] ?? ''),
      updatedAt: String(parsed['updated_at'] ?? ''),
    });
    if (Array.isArray(parsed['dependencies'])) {
      for (const d of parsed['dependencies'] as Array<{
        issue_id: string;
        depends_on_id: string;
        type: string;
      }>) {
        deps.push({ from: d.issue_id, to: d.depends_on_id, type: d.type });
      }
    }
  }
  return { source: { kind: 'jsonl', path }, schemaCompatible: true, issues, deps };
}

/** tmux session names cannot contain '.' or ':'. */
const sanitize = (s: string): string => s.replace(/[.:\s]/g, '-');

/** The dedicated control-mode session name for a project (mirrors local naming). */
export function controlSessionName(projectId: string): string {
  return `agent-cockpit-${sanitize(projectId)}`;
}

/** Shared tmux socket for control-mode sessions (same as local). */
const CONTROL_SOCKET = 'agent-cockpit';

/** Shell-quote a value for a remote command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Strip a `file://` URI to its POSIX path; pass anything else through. */
function stripRemoteFileUri(input: string): string {
  if (!/^file:\/\//i.test(input)) return input;
  try {
    return decodeURIComponent(new URL(input).pathname);
  } catch {
    return input;
  }
}

export class RemoteProvider implements WorkspaceProvider {
  readonly kind: ProjectKind = 'remote';
  readonly projectId: string;
  private readonly spec: RemoteConnectionSpec;
  private readonly transport: RemoteTransport;
  private readonly terminals: RemoteTerminalManager;
  private readonly machine: ConnectionMachine;
  private helper: LaunchedHelper | null = null;
  private controlMgr: RemoteTmuxControlManager | null = null;
  /** Dev-environment launcher (resolved at connect from the global devEnv
   *  setting); ensure() applies the systemd-scope memory cap, wrapExec wraps the
   *  control opener (identity for the shipped modes). */
  private envLauncher: EnvLauncher | null = null;

  constructor(projectId: string, spec: RemoteConnectionSpec) {
    this.projectId = projectId;
    this.spec = spec;
    this.machine = createConnectionMachine(projectId);
    this.transport = createRemoteTransport();
    this.terminals = new RemoteTerminalManager(this.transport, projectId);
    // Keep provider status in sync with transport state transitions.
    // The transport emits raw ConnectionState values; the machine validates and
    // guards transitions so illegal transport events are silently ignored.
    this.transport.onStateChange((state) => {
      switch (state) {
        case 'connecting':
          this.machine.toConnecting();
          break;
        case 'connected':
          // FR6: socket-up does NOT mean "connected". `connected` must imply the
          // helper RPC is ready, so a read issued the instant the renderer sees
          // `connected` cannot hit a not-yet-launched helper. We hold at
          // `connecting` here and fire toConnected() only after launch() resolves
          // in connect() below. (No-op if the machine already left connecting.)
          this.machine.toConnecting();
          break;
        case 'disconnected':
          this.machine.toDisconnected();
          break;
        case 'reconnecting':
          this.machine.toReconnecting();
          break;
        case 'failed':
          this.machine.toFailed();
          break;
      }
    });
  }

  /**
   * The per-project remote tmux control-mode manager. Created lazily on first
   * access so it can be used even before the SSH transport is connected.
   * The opener is evaluated at open-time, ensuring the transport is live.
   */
  tmuxControl(): RemoteTmuxControlManager {
    if (!this.controlMgr) {
      const sessionName = controlSessionName(this.projectId);
      const cwd = this.spec.remotePath;
      const transport = this.transport;
      const opener = async (): Promise<ControlChannel> => {
        // byobu-safe channel: exec (non-login, no profile.d), explicit PTY,
        // BYOBU_DISABLE=1 belt-and-suspenders. The dedicated cockpit session
        // is created/attached via `new-session -A -s <name>`.
        //
        // Set the GLOBAL history-limit on the socket BEFORE the `-CC
        // new-session`: `new-session -A` creates the initial pane during session
        // creation and `set-option` does NOT resize existing panes, so the option
        // must precede pane creation for the auto-created pane (and later panes)
        // to inherit it.
        //
        // CRITICAL: `set -g` requires a RUNNING server — it does NOT start one.
        // On a fresh host it fails with "error connecting to <socket> (No such
        // file or directory)" and, because these two tmux invocations are chained
        // with `&&` in ONE remote shell command, the failure short-circuits so the
        // `-CC new-session` never runs (the remote control-mode connect bug). So
        // `start-server` first (same invocation via `\;` — the remote shell turns
        // `\;` into a literal `;` arg, tmux's command separator) creates the empty
        // server `set -g` can target. `set -g exit-empty off` then keeps that
        // sessionless server ALIVE so the `history-limit` survives to the
        // `&&`-chained `-CC new-session`, whose pane is created afterwards and so
        // inherits it (without it, the empty server exits between the two
        // invocations and the first cold-start pane falls back to tmux's default
        // scrollback). The `-CC` step creates-or-attaches in control mode. See FR3.
        const baseCmd = [
          `BYOBU_DISABLE=1 tmux -L ${CONTROL_SOCKET} start-server \\; set -g exit-empty off \\; set -g history-limit ${TERMINAL_SCROLLBACK}`,
          '&&',
          'BYOBU_DISABLE=1',
          'tmux',
          '-L',
          CONTROL_SOCKET,
          '-CC',
          'new-session',
          '-A',
          '-s',
          shellQuote(sessionName),
          '-c',
          shellQuote(cwd),
        ].join(' ');
        // The dev-env launcher (systemd-scope cap is applied to the shared server
        // by ensure() in connect(); wrapExec is identity for the shipped modes,
        // so the opener is byte-for-byte unchanged). The reserved devcontainer
        // mode would inject its exec wrapper here.
        const cmd = this.envLauncher?.wrapExec(baseCmd) ?? baseCmd;
        const channel = await transport.openPty(cmd, { cols: 220, rows: 50 });
        // Wrap the transport PtyChannel into a ControlChannel.
        // The transport delivers raw bytes (Uint8Array) with no encoding,
        // preserving the CLAUDE.md raw-byte invariant. The manager's ingest()
        // feeds the parser as Uint8Array (Buffer is a Uint8Array subclass), so
        // we hand each chunk through as a Buffer view without copying or decoding.
        const ctrl: ControlChannel = {
          write: (data: string) => channel.write(data),
          onData: (handler: (chunk: Buffer) => void) => {
            channel.onData((chunk) => handler(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
          },
          onClose: (handler: () => void) => {
            channel.onClose(handler);
          },
          close: () => channel.close(),
        };
        return ctrl;
      };
      this.controlMgr = new RemoteTmuxControlManager(opener);
    }
    return this.controlMgr;
  }

  /** The control-mode session name for use in IPC responses. */
  tmuxControlSessionName(): string {
    return controlSessionName(this.projectId);
  }

  /**
   * Kill the dedicated control-mode tmux session on the host (ends all its
   * panes). Mirrors {@link RemoteTerminalManager.close}'s kill path: a one-shot
   * `kill-session` over a non-pty exec channel on the same `agent-cockpit`
   * socket. Best-effort — failures (already gone, transport down) are swallowed.
   */
  async killControlSession(): Promise<void> {
    const cmd = `tmux -L ${CONTROL_SOCKET} kill-session -t ${shellQuote(controlSessionName(this.projectId))}`;
    // Best-effort: a one-shot exec on the control socket. `exec` rejects when not
    // connected and is lenient on non-zero exit; swallow both (already gone /
    // transport down) as before.
    await this.transport.exec(cmd).catch(() => undefined);
  }

  // Lifecycle — delegated to the SSH transport, then helper provisioning.
  async connect(): Promise<void> {
    const ctx = 'remote-connect';
    logger.info(`SSH connect start: ${this.spec.user}@${this.spec.host}:${this.spec.port}`, ctx);
    try {
      await this.transport.connect(this.spec);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase = (err as { phase?: string }).phase ?? 'connect';
      logger.error(`SSH connect failed at phase=${phase}: ${msg}`, ctx);
      // The transport already triggered machine.toFailed() via onStateChange;
      // update the detail on the failure so the renderer shows the error.
      this.machine.toFailed(phase !== 'connect' ? `[${phase}] ${msg}` : msg);
      throw err;
    }
    logger.info(`SSH connect ok: ${this.spec.user}@${this.spec.host}`, ctx);

    logger.info('Helper provision start', ctx);
    const launcher = new RemoteHelperLauncher(this.transport);
    try {
      this.helper = await launcher.launch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const phase = (err as { phase?: string }).phase ?? 'launch';
      logger.error(`Helper provision failed at phase=${phase}: ${msg}`, ctx);
      // Re-emit failed with the helper-launch detail so the renderer shows it.
      this.machine.toFailed(`[${phase}] ${msg}`);
      throw err;
    }
    logger.info(`Helper provision ok (version=${this.helper.version})`, ctx);

    // Dev-environment cap: resolve the launcher from the global devEnv setting
    // and ensure() the (per-host) capped tmux server exists before the control
    // session is opened. systemd-scope self-degrades to uncapped tmux with a
    // surfaced WARN when the host can't support the scope; it never blocks
    // connecting. The bare server-start command (no shell env prefix; systemd-run
    // execs it directly) mirrors the opener's first chained command.
    const devEnv = loadSettings().devEnv;
    const serverStartCmd =
      `tmux -L ${CONTROL_SOCKET} start-server \\; set -g exit-empty off \\; set -g history-limit ${TERMINAL_SCROLLBACK}`;
    this.envLauncher = createEnvLauncher(devEnv, {
      transport: this.transport,
      scopeUnit: DEV_ENV_SCOPE_UNIT,
      hostLabel: `${this.spec.user}@${this.spec.host}`,
      serverStartCmd,
    });
    try {
      await this.envLauncher.ensure();
    } catch (err) {
      // Shipped modes never throw from ensure() (systemd self-degrades). A throw
      // here is the reserved devcontainer / unexpected mode: log and run uncapped
      // rather than blocking the connection.
      logger.warn(`dev-env ensure failed, running uncapped: ${String(err)}`, 'dev-env');
      this.envLauncher = null;
    }

    // FR6: now that the helper RPC is proven, transition to `connected`. The
    // transport's socket-up event only moved us to `connecting`, so this is the
    // single edge that surfaces `connected` to the renderer — guaranteeing a
    // read fired on `connected` finds a live helper.
    this.machine.toConnected();
  }

  async disconnect(): Promise<void> {
    const ctx = 'remote-disconnect';
    logger.info(`SSH disconnect start: ${this.spec.user}@${this.spec.host}`, ctx);
    this.terminals.closeAll();
    this.controlMgr?.close();
    this.controlMgr = null;
    this.helper?.channel.close();
    this.helper = null;
    await this.transport.disconnect();
    // The transport.disconnect() triggers machine.toDisconnected() via
    // onStateChange. Emit an explicit transition here in case the machine is in
    // a state that transport does not transition (e.g. failed). This is
    // idempotent: if already disconnected the machine guard no-ops.
    this.machine.toDisconnected();
    logger.info(`SSH disconnect ok: ${this.spec.user}@${this.spec.host}`, ctx);
  }

  status(): ConnectionStatus {
    return this.machine.current();
  }

  onStatusChange(handler: (s: ConnectionStatus) => void): () => void {
    return this.machine.subscribe(handler);
  }

  /** The live helper RPC client; throws if the provider is not connected. */
  private rpc(): HelperRpcClient {
    if (!this.helper) {
      throw new Error('RemoteProvider: not connected (helper RPC unavailable)');
    }
    return this.helper.client;
  }

  /** Resolve a path against the remote repository root (POSIX semantics). */
  private resolve(path: string): string {
    return posix.isAbsolute(path) ? path : posix.join(this.spec.remotePath, path);
  }

  // Git (read-only) — helper RPC reads (br h7a.7.3).
  async listWorktrees(): Promise<WorktreeRecord[]> {
    const entries = await this.rpc().listWorktrees(this.spec.remotePath);
    return entries.map((e) => {
      const detached = e.branch === '' || e.branch === '(detached)';
      return {
        path: e.path,
        branch: detached ? null : e.branch,
        head: e.head,
        locked: false,
        prunable: false,
        detached,
      };
    });
  }
  async getChangeset(worktreePath: string, baseline?: string): Promise<Changeset> {
    const cwd = worktreePath || this.spec.remotePath;
    const entries = await this.rpc().gitStatus(cwd, baseline);
    return assembleChangeset(cwd, baseline ?? 'HEAD', entries);
  }
  async getFileDiff(worktreePath: string, filePath: string, baseline?: string): Promise<string> {
    const cwd = worktreePath || this.spec.remotePath;
    const res = await this.rpc().gitDiff(cwd, filePath, baseline);
    return res.patch;
  }

  // Filesystem (read-only) — helper RPC reads (br h7a.7.3).
  async readFile(path: string, _opts?: FileReadOptions): Promise<FileReadResult> {
    const res = await this.rpc().readFile(this.resolve(path));
    return {
      content: res.content,
      truncated: res.truncated,
      isBinary: false,
      sizeBytes: Buffer.byteLength(res.content, 'utf8'),
    };
  }
  async stat(path: string): Promise<StatResult> {
    const res = await this.rpc().stat(this.resolve(path));
    return {
      exists: res.exists,
      size: res.size,
      isDir: res.isDir,
      mtime: res.exists ? res.mtime : null,
    };
  }
  async listDir(dirPath: string): Promise<DirEntry[]> {
    // Resolve the dir path against the project root (POSIX semantics).
    const absDir = this.resolve(dirPath);
    const entries = await this.rpc().listDir(absDir, this.spec.remotePath);
    return entries.map((e) => ({
      name: e.name,
      path: e.path,
      isDir: e.isDir,
    }));
  }
  async resolvePath(input: string, opts?: ResolvePathOptions): Promise<ResolvedPath> {
    const raw = stripRemoteFileUri(input.trim());
    const root = this.spec.remotePath;
    const baseDir = opts?.base
      ? posix.isAbsolute(opts.base)
        ? opts.base
        : posix.join(root, opts.base)
      : root;
    const absPath = posix.isAbsolute(raw) ? posix.normalize(raw) : posix.join(baseDir, raw);
    const st = await this.rpc().stat(absPath);
    const rel = posix.relative(root, absPath);
    const insideProject = rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
    const relPath = insideProject ? (rel === '' ? '.' : rel) : null;
    return { exists: st.exists, isDir: st.isDir, insideProject, relPath, absPath };
  }

  // Beads (read-only) — helper RPC reads (br h7a.7.3).
  // We read .beads/issues.jsonl over readFile and parse it client-side rather
  // than shelling out to `br`: it avoids depending on `br` being installed on
  // the remote host and on the exact `br ... --json` output shape.
  async detectBeads(): Promise<boolean> {
    const res = await this.rpc().stat(this.resolve('.beads'));
    return res.exists && res.isDir;
  }
  async getTaskGraph(): Promise<BeadsTaskGraph> {
    const remotePath = this.resolve('.beads/issues.jsonl');
    const exists = await this.rpc().stat(remotePath);
    if (!exists.exists) {
      return { source: { kind: 'jsonl', path: '' }, schemaCompatible: false, issues: [], deps: [] };
    }
    const file = await this.rpc().readFile(remotePath);
    return parseBeadsJsonl(remotePath, file.content);
  }
  async getTask(issueId: string): Promise<BeadsIssue | null> {
    const graph = await this.getTaskGraph();
    return graph.issues.find((i) => i.id === issueId) ?? null;
  }

  // Beads (write) — run `br` on the remote host via the helper exec RPC. Same
  // argv builders as the local provider, so both transports issue identical,
  // injection-safe commands. The helper returns {stdout, exitCode}; a non-zero
  // exit becomes a thrown error carrying br's message.
  private async runBeads(args: string[]): Promise<string> {
    const res = await this.rpc().beadsExec(this.spec.remotePath, [...args, '--json']);
    if (res.exitCode !== 0) {
      throw new Error(
        beadsErrorMessage(res.stdout, null) ?? `br ${args.join(' ')} exited ${String(res.exitCode)}`,
      );
    }
    return res.stdout;
  }
  async beadsClose(issueId: string, reason?: string): Promise<void> {
    await this.runBeads(beadsArgs.close(issueId, reason));
  }
  async beadsReopen(issueId: string): Promise<void> {
    await this.runBeads(beadsArgs.reopen(issueId));
  }
  async beadsComment(issueId: string, message: string): Promise<void> {
    await this.runBeads(beadsArgs.comment(issueId, message));
  }
  async beadsCreate(input: BeadsCreateInput): Promise<string | null> {
    return parseCreatedId(await this.runBeads(beadsArgs.create(input)));
  }
  async beadsListComments(issueId: string): Promise<BeadsComment[]> {
    return parseComments(await this.runBeads(beadsArgs.listComments(issueId)));
  }

  // Terminal — persistent tmux session over an ssh2 PTY shell (br h7a.7.4).
  async openTerminal(opts: TerminalOpenOptions): Promise<TerminalHandle> {
    const cwd = opts.cwd ?? this.spec.remotePath;
    return this.terminals.open({ ...opts, cwd });
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

  // Watch — helper watch.subscribe push events (br h7a.7.3). The helper applies
  // the shared watch policy (deriveWatchSpec) and pushes raw signal paths; we
  // feed them through the same ingest pipeline as the local provider so both
  // transports emit identical canonical events.
  async subscribeWatch(_globs: string[], handler: WatchHandler): Promise<WatchSubscription> {
    const rpc = this.rpc();
    const token = randomUUID();
    const ingest = createWatchIngest((canonical) => {
      handler({ token, paths: canonical.paths.map((p) => p.rel), at: canonical.at });
    });
    await rpc.watchSubscribe(this.spec.remotePath, token, deriveWatchSpec(), (data) => {
      ingest.feed(data.paths);
    });
    return {
      token,
      unsubscribe: async () => {
        ingest.dispose();
        await rpc.watchUnsubscribe(token);
      },
    };
  }
}
