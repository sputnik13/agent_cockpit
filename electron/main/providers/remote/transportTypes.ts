/**
 * RemoteTransport — the mechanism-agnostic boundary between the RemoteProvider
 * (and its helper launcher, terminal manager, and control-mode path) and the
 * wire that reaches the remote host.
 *
 * The provider depends ONLY on this interface, never on `ssh2` types or a raw
 * client. `Ssh2Transport` is the default implementation; a future native-`ssh`
 * transport plugs in behind `createRemoteTransport()` without touching any
 * consumer (see docs/proposals — remote-transport-abstraction).
 *
 * RAW-BYTE INVARIANT (CLAUDE.md): every channel that carries terminal/RPC data
 * delivers the wire bytes **undecoded**. `PtyChannel.onData` and
 * `DuplexChannel.stdout` emit raw `Buffer`/`Uint8Array`; no layer here UTF-8
 * decodes the control/RPC stream. A `Buffer` is a `Uint8Array`, so ssh2 buffers
 * pass straight through.
 */
import type { Readable, Writable } from 'node:stream';
import type { ConnectionState, RemoteConnectionSpec, StatResult } from '../types';

/**
 * Phase of the transport lifecycle at which a failure occurred. `RemoteProvider`
 * reads `phase` structurally to surface context, so these values are part of the
 * interface contract (not an ssh2-private detail). `'hostkey'` covers known_hosts
 * verification failures.
 */
export type RemoteTransportErrorPhase =
  | 'auth'
  | 'connect'
  | 'timeout'
  | 'identity'
  | 'hostkey'
  | 'unexpected';

/**
 * Typed, inspectable transport error carrying the host and the failure phase so
 * callers can surface context without re-parsing opaque transport messages.
 * Secrets and full key paths are never embedded.
 */
export class RemoteTransportError extends Error {
  readonly host: string;
  readonly phase: RemoteTransportErrorPhase;
  override readonly cause?: unknown;

  constructor(message: string, host: string, phase: RemoteTransportErrorPhase, cause?: unknown) {
    super(message);
    this.name = 'RemoteTransportError';
    this.host = host;
    this.phase = phase;
    this.cause = cause;
  }
}

/**
 * Host-key verification policy passed through `connect`. Part of the interface
 * contract (not ssh2-private) so an alternate transport can satisfy the same
 * policy later.
 */
export interface HostKeyPolicy {
  /** Override the known_hosts path (defaults to ~/.ssh/known_hosts). */
  knownHostsPath?: string;
  /**
   * Trust-on-first-use: accept (and, conceptually, would record) a host whose
   * key is not yet present in known_hosts. A *mismatch* against an existing
   * entry is always rejected regardless of this flag. Defaults to `true`
   * (preserves the prior connect-anywhere behavior for unknown hosts while still
   * closing the silent-accept gap for known hosts whose key changed).
   */
  tofu?: boolean;
}

export interface RemoteConnectOptions {
  /** Override the handshake ready timeout (ms). Useful for tests against dead hosts. */
  readyTimeoutMs?: number;
  /** Host-key verification policy (known_hosts path + TOFU). */
  hostKeyPolicy?: HostKeyPolicy;
}

/**
 * Long-lived stdio duplex channel — the RPC transport. `stdin`/`stdout` match the
 * `RpcStream` shape (`{ stdin, stdout }`) so `rpcClient.ts` consumes it untouched:
 * `stdout` emits Node `'data'` (raw `Buffer`), `'end'`, and `'error'` (the RPC
 * decoder's `failAll` depends on `end`/`error`). `stderr` carries the remote
 * command's stderr as raw bytes; the helper launcher drains it and surfaces it to
 * the app so remote errors/panics are not silently dropped (an unread stderr
 * stream can also apply backpressure to the remote process).
 */
export interface DuplexChannel {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

/**
 * A PTY channel (control-mode + interactive terminals). `onData` delivers raw
 * bytes (CLAUDE.md raw-byte invariant). `close()` is CHANNEL-level (not a
 * connection teardown). `resize` is required (terminals call it on every
 * resize); control-mode pushes size over `write` instead and may never call it.
 */
export interface PtyChannel {
  write(data: string | Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  /** Resize the remote PTY. Maps to ssh2 `setWindow(rows, cols, 0, 0)`. */
  resize(cols: number, rows: number): void;
}

/** Result of a one-shot command. `code` is `null` on signal death. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface ExecOptions {
  /** Force-close the channel and resolve after this many ms (e.g. version probe). */
  timeoutMs?: number;
}

export interface OpenPtyOptions {
  cols: number;
  rows: number;
}

export interface OpenShellOptions {
  cols: number;
  rows: number;
  /** Terminal type; defaults to `'xterm-256color'`. */
  term?: string;
}

/**
 * The mechanism-agnostic remote transport. Implemented by `Ssh2Transport`
 * (default). Consumers (`RemoteProvider`, helper launcher, terminal manager,
 * control-mode path) depend only on this surface.
 */
export interface RemoteTransport {
  /** Establish + authenticate. Rejects with `RemoteTransportError` on failure. */
  connect(spec: RemoteConnectionSpec, opts?: RemoteConnectOptions): Promise<void>;
  /** Tear down. Idempotent. */
  disconnect(): Promise<void>;
  /** Current transport state. */
  state(): ConnectionState;
  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(cb: (state: ConnectionState) => void): () => void;

  /**
   * Run a one-shot command, collecting stdout/stderr separately. Never rejects
   * on a non-zero exit (`code` is returned for the caller to decide); rejects
   * with `RemoteTransportError` when not connected.
   */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /** Open a long-lived stdio duplex (raw bytes) — the helper RPC transport. */
  execStream(command: string): Promise<DuplexChannel>;

  /** Open an exec-with-PTY channel (raw bytes) — control-mode. */
  openPty(command: string, opts: OpenPtyOptions): Promise<PtyChannel>;

  /** Open a login/interactive shell channel (raw bytes) — terminals. */
  openShell(opts: OpenShellOptions): Promise<PtyChannel>;

  /**
   * Provision files within a SINGLE underlying session (matching today's
   * open-once / end-in-finally). `mkdirp` is tolerant single-level (not `-p`);
   * `exists` never rejects; `uploadExecutable` is put-then-chmod (mode
   * best-effort).
   */
  beginProvision(): Promise<ProvisionSession>;

  /**
   * Stat a remote path over SFTP (the Download capability's byte-source
   * primitive). Missing path resolves `{ exists: false, size: 0, isDir: false,
   * mtime: null }` — it does NOT reject on absence. Rejects with
   * `RemoteTransportError` when not connected or the SFTP channel cannot be
   * opened, matching `beginProvision`'s error mapping.
   */
  stat(remotePath: string): Promise<StatResult>;

  /**
   * Open a byte-exact read stream over SFTP. `start`/`end` are INCLUSIVE byte
   * offsets (`fs.createReadStream` semantics).
   *
   * RANGE CAPABILITY — NON-GOAL: `start`/`end` are deliberately included now
   * for a FUTURE, separately proposed capability (viewing a large remote media
   * file in-app via range-based streaming/seek); retrofitting range support
   * onto this primitive later would be more disruptive than shaping it
   * correctly now, and ssh2's `sftp.createReadStream` supports `{start,end}`
   * natively so it costs nothing today. The Download capability (this issue)
   * NEVER passes a range — it always reads the whole file — and NOTHING else
   * in this repository may pass one or build a range consumer (no streaming
   * UI, no media player, no HTTP range proxy, no renderer-facing range API).
   *
   * Stream errors propagate on the returned Readable's `'error'` event (never
   * swallowed). Rejects with `RemoteTransportError` when not connected or the
   * SFTP channel cannot be opened.
   */
  createReadStream(remotePath: string, opts?: { start?: number; end?: number }): Promise<Readable>;
}

/**
 * A scoped file-provisioning session (one SFTP session for the whole
 * mkdirp+exists+upload sequence). `end()` releases it.
 */
export interface ProvisionSession {
  /** Resolve `true` iff the remote path exists. Never rejects. */
  exists(path: string): Promise<boolean>;
  /** Tolerant single-level mkdir (success if the dir already exists). */
  mkdirp(dir: string): Promise<void>;
  /** Upload a local file then best-effort chmod it to `mode`. */
  uploadExecutable(localPath: string, remotePath: string, mode: number): Promise<void>;
  /** Release the session. Idempotent. */
  end(): void;
}
