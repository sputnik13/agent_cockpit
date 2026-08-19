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
import { tmuxSocket } from '../../instanceConfig';
import type {
  BeadsComment,
  BeadsCreateInput,
  BeadsDep,
  BeadsIssue,
  BeadsTaskGraph,
  BranchPoint,
  Changeset,
  FileChange,
  FileChangeStatus,
  WorktreeRecord,
} from '@shared/ipc/channels';
import type {
  ConnectionStatus,
  DirEntry,
  DiffBundle,
  FileBytesOptions,
  FileBytesResult,
  FileBytesUnavailableReason,
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
import { writeStreamToDest } from '../exportWrite';
import { FILE_BYTES_CAP } from '@shared/providers/fileBytesCap';
import { RemoteHelperLauncher, type LaunchedHelper } from './helper';
import type {
  GitDiffBundleResult,
  GitStatusEntry,
  HelperRpcClient,
  ReadFileBytesResult,
  ReadFileResult,
} from './rpcClient';
import { beadsArgs, beadsErrorMessage, parseComments, parseCreatedId } from '../../beads/runner';
import { RemoteTerminalManager } from './tmux';
import { RemoteTmuxControlManager, type ControlChannel } from './tmuxControl';
import { createEnvLauncher, DEV_ENV_SCOPE_UNIT, type EnvLauncher } from './envLauncher';
import { sessionNameToken } from '../sessionKey';
import { loadSettings } from '../../config';
import { logger } from '../../logger';
import { createConnectionMachine, type ConnectionMachine } from '../connectionMachine';
import { createWatchIngest } from '../../watch/ingest';
import { deriveWatchSpec } from '@shared/watch/policy';
import { TERMINAL_COLORTERM, tmuxServerOptionShell } from '@shared/tmux';


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

// Read cap for a remote .beads/issues.jsonl fetch (see getTaskGraph). Well
// under the helper's maxReadFileCapBytes (12 MiB) ceiling, generous relative
// to the helper's 2 MiB default text-read cap.
const GRAPH_READ_MAX_BYTES = 10 << 20; // 10 MiB

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

/** Turn a `readFile` RPC result for `.beads/issues.jsonl` into a task graph.
 *  Never silently parses a truncated read as an empty-but-valid graph
 *  (`parseBeadsJsonl('')` → `{issues:[],deps:[]}`) — that would render as an
 *  ordinary "no tasks" empty state with no indication anything is wrong.
 *  Throwing here surfaces through `beadsStore.load()`'s catch as an explicit
 *  "Failed to load workgraph" error instead (local_repo_explorer video_manager
 *  diagnosis: a JSONL over GRAPH_READ_MAX_BYTES was silently read as empty). */
export function toTaskGraph(path: string, file: ReadFileResult): BeadsTaskGraph {
  if (file.truncated) {
    throw new Error(
      `.beads/issues.jsonl is too large to read (over ${String(GRAPH_READ_MAX_BYTES / (1 << 20))} MiB); ` +
        'the workgraph cannot be loaded until it is pruned (e.g. tombstone compaction via br).',
    );
  }
  return parseBeadsJsonl(path, file.content);
}

/** tmux session names cannot contain '.' or ':'. */
const sanitize = (s: string): string => s.replace(/[.:\s]/g, '-');

/** The dedicated control-mode session name for a project (mirrors local naming). */
export function controlSessionName(projectId: string): string {
  return `agent-cockpit-${sanitize(projectId)}`;
}

/** Shared tmux socket for control-mode sessions (same as local). */
const CONTROL_SOCKET = tmuxSocket();

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

/**
 * The remote byte source for the bounded binary-preview read primitive
 * (`WorkspaceProvider.readFileBytes`) — the WORKING-TREE (non-`ref`) branch
 * only. Exported (alongside `mapGitStatus`/`assembleChangeset` above) so it is
 * directly unit-testable against a fake transport — `RemoteProvider` has no
 * transport-injection seam (it always builds its transport via
 * `createRemoteTransport()`), so this is the only way to exercise the SFTP
 * byte-read path without a live SSH host.
 *
 * Deliberately goes over `RemoteTransport` SFTP (`stat` + `createReadStream`),
 * NEVER the helper RPC's `readFile` (text-only, hard-capped at 2 MiB) — see
 * the `WorkspaceProvider.readFileBytes` doc comment for the full rationale.
 * Stats first and refuses (metadata only) when missing/dir/over-cap, exactly
 * like `localReadFileBytes`; never passes a `{start,end}` range.
 *
 * A `ref`-bearing call NEVER reaches this function — SFTP is filesystem-only
 * and cannot serve a git-object read; `RemoteProvider.readFileBytes` routes
 * that case through the helper's dedicated `readFileBytes` RPC instead (see
 * `toFileBytesResult` below, local_repo_explorer-bn8a).
 *
 * NOTE: a successful read opens TWO SFTP sessions (stat ends its own channel;
 * then `createReadStream` opens and releases a second on `'close'`/`'error'`)
 * — this is expected and correct (matches `RemoteTransport`'s per-operation
 * channel lifecycle), not a bug to dedupe.
 */
export async function readFileBytesOverTransport(
  transport: Pick<RemoteTransport, 'stat' | 'createReadStream'>,
  absPath: string,
): Promise<FileBytesResult> {
  const st = await transport.stat(absPath);
  if (!st.exists) return { bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' };
  if (st.isDir) return { bytesBase64: null, sizeBytes: st.size, exists: true, reason: 'is-dir' };
  if (st.size > FILE_BYTES_CAP) {
    return { bytesBase64: null, sizeBytes: st.size, exists: true, reason: 'too-large' };
  }
  // No opts — no range, ever (see the readFileBytes doc comment's NON-GOAL note).
  const stream = await transport.createReadStream(absPath);
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    // A stream read error MUST reject, never resolve with silent empty bytes.
    stream.on('error', reject);
  });
  return { bytesBase64: buf.toString('base64'), sizeBytes: st.size, exists: true, reason: null };
}

/**
 * Adapt a helper `readFileBytes` RPC response (the git-`ref` branch of the
 * binary-preview read primitive — local_repo_explorer-bn8a) into the
 * `FileBytesResult` contract. Exported (alongside `toFileReadResult`/
 * `readFileBytesOverTransport` above) for the same reason: `RemoteProvider`
 * has no transport-injection seam, so this pure adapter is the only way to
 * exercise the ref-read response shape without a live SSH host + a helper
 * build new enough to serve this RPC.
 *
 * `reason` is validated against the known set (plus the RPC's own `''` =
 * "bytes present" sentinel) rather than cast blindly, so a malformed/future
 * wire value degrades to `'missing'` (refuse) instead of silently passing an
 * unrecognized reason through. `bytesBase64`/`sizeBytes` are read defensively
 * (not trusted at their static type), matching `toFileReadResult`'s existing
 * degrade-gracefully precedent for a response from a build that predates a
 * field.
 */
export function toFileBytesResult(res: ReadFileBytesResult): FileBytesResult {
  const sizeBytes = typeof res.sizeBytes === 'number' ? res.sizeBytes : 0;
  if (res.reason === '') {
    return {
      bytesBase64: typeof res.bytesBase64 === 'string' ? res.bytesBase64 : '',
      sizeBytes,
      exists: true,
      reason: null,
    };
  }
  const reason: FileBytesUnavailableReason = res.reason === 'too-large' ? 'too-large' : 'missing';
  return { bytesBase64: null, sizeBytes, exists: res.exists === true, reason };
}

/**
 * Adapt a helper `readFile` RPC response into the `FileReadResult` contract,
 * mirroring `LocalProvider`'s null-content-when-binary rule (electron/main/
 * git/files.ts's `getFile`: `content: isBin ? null : buf.toString('utf8')`).
 * Exported (alongside `readFileBytesOverTransport` above) so this
 * one-line-looking but load-bearing transformation is directly unit-testable
 * — `RemoteProvider` has no transport-injection seam, so this is the only way
 * to exercise it without a live SSH host + built helper binary (br r3s6).
 *
 * Without the null, every consumer (RawFile.tsx, HtmlPreview.tsx) branches on
 * `content !== null` BEFORE ever consulting `isBinary` — a non-null (if
 * U+FFFD-mangled, since Go's encoding/json substitutes invalid UTF-8 rather
 * than failing) string always won the text branch and `isBinary` was never
 * consulted.
 *
 * `content` is ALSO nulled when `truncated === true` (local_repo_explorer-
 * ftbq — a separate, genuinely load-bearing fix from the `isBinary` one
 * above, found while wiring the `maxBytes` read-cap override): the Go helper
 * now refuses (never truncates) a file over its effective cap — see
 * remote-helper/commands.go's `handleReadFile` — but `content` is still a
 * plain, always-present `string` field on the wire (`""` when refused, never
 * absent), so without this OR clause a refused-but-non-null `content` would
 * win the same `content !== null` branch every consumer checks first, and a
 * refuse (empty content, `truncated: true`) would misrender as a genuinely
 * empty FILE rather than the "too large to preview inline" placeholder. This
 * mirrors local's `getFile` exactly, whose working-tree branch already
 * returns `content: null` together with `truncated: true` — refuse-never-
 * truncate, never a partial/truncated string silently served as complete.
 *
 * `sizeBytes` comes from the helper's own stat/blob-length, never derived
 * from `content` — computing it via `Buffer.byteLength` over a possibly
 * U+FFFD-mangled string would inflate the reported size for binary content
 * (every invalid byte becomes a 3-byte replacement char).
 *
 * Both `isBinary` and `sizeBytes` are read defensively (not trusted at their
 * static type) so a stale helper build that predates one or both fields
 * degrades to "not binary" / a content-derived size instead of `undefined`
 * reaching the renderer — matches this repo's existing additive/optional-
 * field degradation pattern (e.g. `worktreePath`).
 */
export function toFileReadResult(res: ReadFileResult): FileReadResult {
  const isBinary = res.isBinary === true;
  const truncated = res.truncated === true;
  const sizeBytes =
    typeof res.sizeBytes === 'number'
      ? res.sizeBytes
      : Buffer.byteLength(res.content ?? '', 'utf8');
  return {
    content: isBinary || truncated ? null : res.content,
    truncated,
    isBinary,
    sizeBytes,
  };
}

/** Map the helper's getDiffBundle RPC result into the shared DiffBundle shape.
 *  Old-side content is gated on the helper's own `oldReadable`/`oldTruncated`
 *  flags alone — the same gate already applied to `newContent` — never
 *  re-gated on whether the caller supplied an explicit `baseline`. The helper
 *  is the sole authority on whether it found old content at the requested
 *  ref; double-gating here on `baseline` would incorrectly null out old
 *  content the helper actually read back. */
export function toDiffBundle(res: GitDiffBundleResult): DiffBundle {
  return {
    patch: res.patch,
    newContent: res.newReadable && !res.newTruncated ? res.newContent : null,
    oldContent: res.oldReadable && !res.oldTruncated ? res.oldContent : null,
  };
}

export class RemoteProvider implements WorkspaceProvider {
  readonly kind: ProjectKind = 'remote';
  readonly projectId: string;
  private readonly spec: RemoteConnectionSpec;
  private readonly transport: RemoteTransport;
  private readonly terminals: RemoteTerminalManager;
  private readonly machine: ConnectionMachine;
  /** Token embedded in this project's tmux session names — the project id
   *  (default) or a sha of the remote repo path when deterministic session
   *  names are enabled. Resolved once at construction so two clients opening the
   *  same remote repo (deterministic mode) share the session. */
  private readonly nameToken: string;
  private helper: LaunchedHelper | null = null;
  private controlMgr: RemoteTmuxControlManager | null = null;
  /** Dev-environment launcher (resolved at connect from the global devEnv
   *  setting); ensure() applies the systemd-scope memory cap, wrapExec wraps the
   *  control opener (identity for the shipped modes). */
  private envLauncher: EnvLauncher | null = null;

  constructor(projectId: string, spec: RemoteConnectionSpec) {
    this.projectId = projectId;
    this.spec = spec;
    this.nameToken = sessionNameToken(
      loadSettings().deterministicSessionNames,
      projectId,
      spec.remotePath,
    );
    this.machine = createConnectionMachine(projectId);
    this.transport = createRemoteTransport();
    this.terminals = new RemoteTerminalManager(this.transport, this.nameToken);
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
      const sessionName = controlSessionName(this.nameToken);
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
          `COLORTERM=${TERMINAL_COLORTERM} BYOBU_DISABLE=1 tmux -L ${CONTROL_SOCKET} start-server \\; ${tmuxServerOptionShell()}`,
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
      // Surface the control-channel reattach cycle in the connection status. The
      // `-CC` channel reconnects independently of the SSH transport, so without
      // this the machine would stay `connected` through a silent flap. This is
      // observability only — the renderer re-init is driven by the `attached`
      // epoch, not by these transitions. Machine guards make illegal transitions
      // (e.g. a hook firing outside the connected/reconnecting window) safe no-ops.
      this.controlMgr.onReconnecting = () => this.machine.toReconnecting();
      this.controlMgr.onReattached = () => this.machine.toConnected();
      this.controlMgr.onReattachExhausted = () => this.machine.toFailed('tmux control channel lost');
    }
    return this.controlMgr;
  }

  /** The control-mode session name for use in IPC responses. */
  tmuxControlSessionName(): string {
    return controlSessionName(this.nameToken);
  }

  /**
   * Kill the dedicated control-mode tmux session on the host (ends all its
   * panes). Mirrors {@link RemoteTerminalManager.close}'s kill path: a one-shot
   * `kill-session` over a non-pty exec channel on the same `agent-cockpit`
   * socket. Best-effort — failures (already gone, transport down) are swallowed.
   */
  async killControlSession(): Promise<void> {
    const cmd = `tmux -L ${CONTROL_SOCKET} kill-session -t ${shellQuote(controlSessionName(this.nameToken))}`;
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
      // A synchronous connect throw (e.g. an unparseable identity key) is wrapped
      // with a generic message; append the underlying cause so the failure is
      // diagnosable from the log alone.
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg =
        cause instanceof Error ? cause.message : cause != null ? String(cause) : '';
      logger.error(
        `SSH connect failed at phase=${phase}: ${msg}${causeMsg ? ` (cause: ${causeMsg})` : ''}`,
        ctx,
      );
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
      `tmux -L ${CONTROL_SOCKET} start-server \\; ${tmuxServerOptionShell()}`;
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
    return this.resolveIn(this.spec.remotePath, path);
  }

  /** Resolve `path` against `base` (POSIX). An absolute path is returned as-is;
   *  a relative path is joined onto `base`. Callers pass `worktreePath ||
   *  remotePath` as the base to make a read worktree-aware. */
  private resolveIn(base: string, path: string): string {
    return posix.isAbsolute(path) ? path : posix.join(base, path);
  }

  /** Path relative to the remote repository root — the pathspec form `git show
   *  <ref>:<path>` expects. Selection paths are usually already repo-relative;
   *  an absolute path is made relative to the repo root. */
  private repoRelative(path: string): string {
    return posix.isAbsolute(path) ? posix.relative(this.spec.remotePath, path) : path;
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
  async getDiffBundle(worktreePath: string, filePath: string, baseline?: string): Promise<DiffBundle> {
    // One round trip: patch + both sides' content. The helper reads the new side
    // from the working tree and the old side via `git show <baseline>:<path>`
    // (repo-relative). Unreadable/truncated sides come back as null so the
    // renderer falls back to plain text for that side. `baseline` is forwarded
    // exactly as given (including undefined) — this method must not widen it to
    // a literal 'HEAD' here, because the helper's `getDiffBundle` RPC reuses the
    // same param to build the `git diff` args for `patch`, and substituting
    // 'HEAD' would change patch semantics whenever the index has staged changes
    // (out of scope; patch generation already matches git's own default). See
    // toDiffBundle's doc comment for the old-content mapping fix on this side;
    // handleGetDiffBundle (remote-helper/commands.go) completes the other half
    // server-side — it now defaults its old-side READ (not the patch-args
    // above) to HEAD when Baseline is empty, so default-target old-content
    // parity with LocalProvider is complete end to end.
    const cwd = worktreePath || this.spec.remotePath;
    const res = await this.rpc().getDiffBundle(cwd, this.repoRelative(filePath), baseline);
    return toDiffBundle(res);
  }
  async resolveBranchPoint(worktreePath: string): Promise<BranchPoint | null> {
    const cwd = worktreePath || this.spec.remotePath;
    const res = await this.rpc().gitBranchPoint(cwd);
    // The Go handler returns an empty parentRef as the null sentinel.
    if (!res.parentRef) return null;
    return { parentRef: res.parentRef, parentKind: res.parentKind, mergeBase: res.mergeBase };
  }

  // Filesystem (read-only) — helper RPC reads (br h7a.7.3).
  async readFile(path: string, opts?: FileReadOptions): Promise<FileReadResult> {
    // Resolve against the worktree root when supplied; empty/absent = project
    // root. Additive/optional — no worktree behaves exactly as before.
    const base = opts?.worktreePath || this.spec.remotePath;
    // Honor opts.ref: read the file AT the git ref (diff old side / raw at
    // baseline) via the helper's `git show <ref>:<repo-relative-path>` run in the
    // worktree (`cwd = base`). Without a ref, read the working-tree file resolved
    // against the worktree base, forwarding worktreePath so the helper honors it.
    const res = opts?.ref
      ? await this.rpc().readFile(this.repoRelative(path), {
          ref: opts.ref,
          cwd: base,
          maxBytes: opts?.maxBytes,
        })
      : await this.rpc().readFile(this.resolveIn(base, path), {
          worktreePath: opts?.worktreePath,
          maxBytes: opts?.maxBytes,
        });
    return toFileReadResult(res);
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
  async listDir(dirPath: string, worktreePath?: string): Promise<DirEntry[]> {
    // Resolve the dir path against the worktree root when supplied; empty/absent
    // = project root (POSIX semantics). Root is the same base so the returned
    // entry paths stay base-relative (clean 'src/a.ts', not '../wt/src/a.ts').
    const base = worktreePath || this.spec.remotePath;
    const absDir = this.resolveIn(base, dirPath);
    const entries = await this.rpc().listDir(absDir, base, worktreePath);
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
  // Bounded binary-preview read. Working-tree (no `ref`): over SFTP, never
  // the helper RPC (see readFileBytesOverTransport's doc comment and the
  // WorkspaceProvider one). `ref` set (local_repo_explorer-bn8a): SFTP is
  // filesystem-only and cannot serve a git-object read, so this routes
  // through the helper's dedicated readFileBytes RPC instead — repoRelative()
  // gives `git show` the repo-relative POSIX pathspec it expects, mirroring
  // readFile's own ref branch below.
  async readFileBytes(path: string, opts?: FileBytesOptions): Promise<FileBytesResult> {
    const base = opts?.worktreePath || this.spec.remotePath;
    if (opts?.ref) {
      const res = await this.rpc().readFileBytes(this.repoRelative(path), opts.ref, base);
      return toFileBytesResult(res);
    }
    return readFileBytesOverTransport(this.transport, this.resolveIn(base, path));
  }

  // Filesystem (bounded export — the one write, OUT of the repo only). Goes
  // over the SFTP-backed RemoteTransport primitive, NOT the helper RPC's
  // text-only, 2 MiB-capped readFile — this is the whole point of the SFTP
  // design (see the issue's Contract). Always the whole file; never a range.
  async exportFile(path: string, destAbsPath: string, opts?: { worktreePath?: string }): Promise<void> {
    const base = opts?.worktreePath || this.spec.remotePath;
    const source = await this.transport.createReadStream(this.resolveIn(base, path));
    await writeStreamToDest(source, destAbsPath);
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
    // Override the helper's default 2 MiB text-read cap: issues.jsonl is
    // full task history (including tombstones), not a preview, and routinely
    // outgrows 2 MiB on active projects. GRAPH_READ_MAX_BYTES sits well under
    // the helper's own 12 MiB frame-size ceiling (maxReadFileCapBytes), which
    // clamps a caller-requested override rather than honoring it verbatim.
    const file = await this.rpc().readFile(remotePath, { maxBytes: GRAPH_READ_MAX_BYTES });
    return toTaskGraph(remotePath, file);
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
  /**
   * Shared implementation for both `subscribeWatch` (rooted at the project's
   * `remotePath`) and `subscribeWorktreeWatch` (rooted at an arbitrary
   * worktree path) — the Go helper's `watch.subscribe` RPC already supports
   * multiple concurrent subscriptions, each with its own `Cwd` and `token`
   * (see `remote-helper/watch.go`'s `watchSubscribeParams`), so a second,
   * independently-rooted subscription needs no helper changes at all.
   */
  private async subscribeAt(cwd: string, handler: WatchHandler): Promise<WatchSubscription> {
    const rpc = this.rpc();
    const token = randomUUID();
    const ingest = createWatchIngest((canonical) => {
      handler({ token, paths: canonical.paths.map((p) => p.rel), at: canonical.at });
    });
    await rpc.watchSubscribe(cwd, token, deriveWatchSpec(), (data) => {
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

  async subscribeWatch(_globs: string[], handler: WatchHandler): Promise<WatchSubscription> {
    return this.subscribeAt(this.spec.remotePath, handler);
  }

  /**
   * See `WorkspaceProvider.subscribeWorktreeWatch`'s doc comment for the
   * working-tree-only contract. The helper applies the SAME derived
   * `WatchSpec` regardless of root — there is no `.git`/`.beads` special-
   * casing to add or omit on the Go side. The "no signal events for a
   * worktree checkout" property falls out naturally rather than needing one:
   * `watch.go`'s `shouldEmit` only classifies a path as a git-state/beads
   * signal when it matches an EXACT signal path/prefix (`.git/HEAD`,
   * `.git/refs`, `.beads/beads.db`, …), and a linked worktree's own `.git`
   * is a plain pointer FILE (not a directory), so those nested paths never
   * exist under a worktree root at all — there is nothing for
   * `matchesSignal` to ever match.
   */
  async subscribeWorktreeWatch(worktreePath: string, handler: WatchHandler): Promise<WatchSubscription> {
    return this.subscribeAt(worktreePath, handler);
  }
}
