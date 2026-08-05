/**
 * HelperRpcClient — the Electron-main client half of the length-prefixed JSON
 * RPC protocol served by the Go remote helper (see remote-helper/protocol.go).
 *
 * Wire framing: each message is a 4-byte big-endian uint32 length header
 * followed by that many bytes of a JSON payload. Three payload shapes exist:
 *   - request  `{ id, method, params }`
 *   - response `{ id, result, error }`
 *   - event    `{ event, data }` (server push, no id)
 *
 * This client encodes requests with incrementing ids, correlates responses by
 * id through a pending-promise map, and dispatches server-push `watch` events
 * to registered handlers. The transport is any duplex byte stream — in
 * production the helper's ssh exec channel (stdin = writable, stdout =
 * readable); in tests an in-memory PassThrough pair.
 *
 * The codec is intentionally decoupled from ssh2 so it can be unit-tested with
 * no live SSH server or built helper binary.
 */
import type { Readable, Writable } from 'node:stream';
import type { WatchSpec } from '@shared/watch/types';

/** Protocol version this client speaks; must match the helper's. */
export const PROTOCOL_VERSION = 1;

// ---- Wire message shapes ---------------------------------------------------

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface RpcResponse {
  id: number;
  result: unknown;
  error: string | null;
}

interface RpcEvent {
  event: string;
  data: Record<string, unknown>;
}

// ---- Method result shapes (mirror the Go helper) ---------------------------

export interface HandshakeResult {
  protocolVersion: number;
  pid: number;
}

export interface ReadFileResult {
  content: string;
  truncated: boolean;
  /** Real binary sniff from the helper (mirrors electron/main/git/files.ts's
   *  looksBinary: a NUL byte within the content's first 8000 bytes), computed
   *  from the same bytes already read for `content` — no second RPC. */
  isBinary: boolean;
  /** True byte size from the helper (fs stat for a working-tree read, full
   *  `git show` blob length for a ref read) — independent of any cap/
   *  truncation applied to `content`, and NOT derived from `content` (which,
   *  once JSON round-tripped, substitutes invalid UTF-8 with U+FFFD and would
   *  inflate a binary file's apparent size). See remote-helper/commands.go's
   *  `readFileResult.SizeBytes`. */
  sizeBytes: number;
}

/**
 * Result of the `readFileBytes` RPC (local_repo_explorer-bn8a) — the
 * git-ref branch of the binary-preview read primitive
 * (`WorkspaceProvider.readFileBytes`). NEVER used for a working-tree read
 * (that stays on SFTP via `readFileBytesOverTransport`); this method exists
 * solely to serve a `ref`-bearing call.
 */
export interface ReadFileBytesResult {
  /** Base64-encoded blob bytes. Go's encoding/json marshals a []byte struct
   *  field as base64 automatically — byte-faithful, unlike readFile's
   *  `content` (a `string` field, which corrupts invalid UTF-8 to U+FFFD at
   *  the JSON boundary — see remote-helper/commands.go's handleReadFileBytes
   *  doc comment and local_repo_explorer-r3s6). Absent (undefined) whenever
   *  `reason` is non-empty (bytes refused/absent); present — possibly `''`
   *  for a genuinely empty blob — when `reason` is `''`. */
  bytesBase64?: string;
  sizeBytes: number;
  exists: boolean;
  /** `''` means bytes are present (the TS adapter maps that to
   *  `FileBytesResult.reason: null`); else mirrors
   *  `FileBytesUnavailableReason` (`'missing' | 'too-large'`). */
  reason: string;
}

export interface StatResult {
  exists: boolean;
  size: number;
  isDir: boolean;
  mtime: string;
}

export interface GitStatusEntry {
  path: string;
  status: string;
}

export interface GitDiffResult {
  patch: string;
}

export interface GitDiffBundleResult {
  patch: string;
  newContent: string;
  newReadable: boolean;
  newTruncated: boolean;
  oldContent: string;
  oldReadable: boolean;
  oldTruncated: boolean;
}

/** Result of the gitBranchPoint RPC call. Null-sentinel is indicated by an
 *  empty parentRef (the Go handler returns {} for null). */
export interface GitBranchPointResult {
  parentRef: string;
  parentKind: 'upstream' | 'default';
  mergeBase: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
}

/** One entry from the helper's listDir result (mirrors DirEntry shape). */
export interface ListDirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface BeadsExecResult {
  stdout: string;
  exitCode: number;
}

/** Payload of a server-push `watch` event. */
export interface WatchEventData {
  token: string;
  paths: string[];
}

export type WatchEventHandler = (data: WatchEventData) => void;

/** Typed error raised by RPC failures (helper-reported errors or transport). */
export class HelperRpcError extends Error {
  readonly method: string | undefined;
  constructor(message: string, method?: string) {
    super(message);
    this.name = 'HelperRpcError';
    this.method = method;
  }
}

const HEADER_BYTES = 4;
/** Match the helper's 16 MiB cap so a corrupt header can't allocate forever. */
const MAX_MESSAGE_BYTES = 16 << 20;

/** Encode a JSON-serializable payload as a length-prefixed frame. */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_MESSAGE_BYTES) {
    throw new HelperRpcError(`frame too large: ${body.length} bytes`);
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame decoder. Feed it arbitrary chunks; it yields complete
 * payloads as they become available, buffering partial frames across chunks.
 */
export class FrameDecoder {
  // Pending chunks held WITHOUT concatenation, plus their running byte total.
  // Concatenating the whole accumulated buffer on every chunk (the old approach)
  // is O(n^2) in chunk count for a large payload that arrives as many small SSH
  // packets; here we concat exactly once per complete frame instead.
  private chunks: Buffer[] = [];
  private buffered = 0;

  /** Append a chunk and return any complete payloads decoded from the buffer. */
  push(chunk: Buffer): unknown[] {
    if (chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const out: unknown[] = [];
    for (;;) {
      if (this.buffered < HEADER_BYTES) break;
      // Coalesce only when we have at least a header to read; one concat yields a
      // contiguous view for both the length read and the body slice below.
      const buf = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered);
      this.chunks = [buf];
      const length = buf.readUInt32BE(0);
      if (length > MAX_MESSAGE_BYTES) {
        throw new HelperRpcError(`frame too large: ${length} bytes`);
      }
      if (buf.length < HEADER_BYTES + length) break;
      const body = buf.subarray(HEADER_BYTES, HEADER_BYTES + length);
      out.push(JSON.parse(body.toString('utf8')));
      const rest = buf.subarray(HEADER_BYTES + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.buffered = rest.length;
    }
    return out;
  }
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/**
 * Duplex byte transport for the RPC client: a writable sink for outbound
 * frames and a readable source for inbound bytes. Satisfied by an ssh2 exec
 * channel (which is both) or a PassThrough pair in tests.
 */
export interface RpcStream {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

export class HelperRpcClient {
  private readonly stdin: Writable;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, PendingCall>();
  private readonly watchHandlers = new Map<string, WatchEventHandler>();
  private nextId = 1;
  private closed = false;

  constructor(stream: RpcStream) {
    this.stdin = stream.stdin;
    stream.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    stream.stdout.on('close', () => this.failAll('helper stream closed'));
    stream.stdout.on('end', () => this.failAll('helper stream ended'));
    stream.stdout.on('error', (err: Error) =>
      this.failAll(`helper stream error: ${err.message}`),
    );
  }

  private onData(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      this.failAll(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const msg of messages) this.dispatch(msg);
  }

  private dispatch(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return;
    const record = msg as Record<string, unknown>;
    // Server-push event (no id, has an `event` field).
    if (typeof record['event'] === 'string') {
      const ev = msg as RpcEvent;
      if (ev.event === 'watch') {
        const data = ev.data as unknown as WatchEventData;
        const handler = this.watchHandlers.get(data.token);
        if (handler) handler(data);
      }
      return;
    }
    // Otherwise a response correlated by id.
    if (typeof record['id'] === 'number') {
      const res = msg as RpcResponse;
      const call = this.pending.get(res.id);
      if (!call) return;
      this.pending.delete(res.id);
      if (res.error != null) {
        call.reject(new HelperRpcError(res.error, call.method));
      } else {
        call.resolve(res.result);
      }
    }
  }

  private failAll(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, call] of this.pending) {
      call.reject(new HelperRpcError(reason, call.method));
    }
    this.pending.clear();
  }

  /** Send one request and resolve with its typed result. */
  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new HelperRpcError('helper stream is closed', method));
    }
    const id = this.nextId++;
    const req: RpcRequest = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
      });
      try {
        this.stdin.write(encodeFrame(req));
      } catch (err) {
        this.pending.delete(id);
        reject(new HelperRpcError(err instanceof Error ? err.message : String(err), method));
      }
    });
  }

  // ---- Typed method wrappers ----------------------------------------------

  handshake(): Promise<HandshakeResult> {
    return this.call<HandshakeResult>('handshake', { protocolVersion: PROTOCOL_VERSION });
  }

  readFile(
    path: string,
    opts?: { ref?: string; cwd?: string; worktreePath?: string; maxBytes?: number },
  ): Promise<ReadFileResult> {
    // ref/cwd/worktreePath/maxBytes are omitted from the JSON when undefined,
    // so the helper sees empty/zero fields and reads the working tree at the
    // project root under its own default cap (unchanged behavior). When set,
    // `ref` reads at a git ref via `git show` (run in `cwd`), `worktreePath`
    // resolves a working-tree read against that worktree root instead of the
    // project root, and `maxBytes` (local_repo_explorer-ftbq) raises the
    // helper's read cap for this call — the helper clamps it to its own
    // frame-size-bounded ceiling (remote-helper/commands.go's
    // maxReadFileCapBytes) rather than trusting it verbatim.
    return this.call<ReadFileResult>('readFile', {
      path,
      ref: opts?.ref,
      cwd: opts?.cwd,
      worktreePath: opts?.worktreePath,
      maxBytes: opts?.maxBytes,
    });
  }

  /**
   * The git-ref branch of the binary-preview read primitive
   * (`WorkspaceProvider.readFileBytes`) — the byte-safe counterpart to
   * `readFile`'s ref branch above (local_repo_explorer-bn8a). `path` must
   * already be repo-relative (POSIX) — callers pass it through
   * `RemoteProvider`'s `repoRelative()`, mirroring `readFile`'s own
   * ref-branch requirement. NEVER used for a working-tree (non-ref) read —
   * that stays on SFTP via `readFileBytesOverTransport`.
   */
  readFileBytes(path: string, ref: string, cwd: string): Promise<ReadFileBytesResult> {
    return this.call<ReadFileBytesResult>('readFileBytes', { path, ref, cwd });
  }

  stat(path: string): Promise<StatResult> {
    return this.call<StatResult>('stat', { path });
  }

  gitStatus(cwd: string, baseline?: string): Promise<GitStatusEntry[]> {
    const params: Record<string, unknown> = { cwd };
    if (baseline !== undefined) params['baseline'] = baseline;
    return this.call<GitStatusEntry[]>('gitStatus', params);
  }

  gitDiff(cwd: string, path: string, baseline?: string): Promise<GitDiffResult> {
    const params: Record<string, unknown> = { cwd, path };
    if (baseline !== undefined) params['baseline'] = baseline;
    return this.call<GitDiffResult>('gitDiff', params);
  }

  /** One round trip: unified patch + both sides' content for highlighting. */
  getDiffBundle(cwd: string, path: string, baseline?: string): Promise<GitDiffBundleResult> {
    const params: Record<string, unknown> = { cwd, path };
    if (baseline !== undefined) params['baseline'] = baseline;
    return this.call<GitDiffBundleResult>('getDiffBundle', params);
  }

  /** Resolve the branch-point (parent ref + merge-base SHA) for a worktree.
   *  Returns null-sentinel (parentRef === '') when no parent can be resolved. */
  gitBranchPoint(cwd: string): Promise<GitBranchPointResult> {
    return this.call<GitBranchPointResult>('gitBranchPoint', { cwd });
  }

  listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
    return this.call<WorktreeEntry[]>('listWorktrees', { cwd });
  }

  /** Run `br <args>` in `cwd` on the remote host (read OR write — no longer
   *  query-only). Returns the raw stdout + exit code; the caller interprets
   *  failures. argv only — the helper execs `br` with no shell. */
  beadsExec(cwd: string, args: string[]): Promise<BeadsExecResult> {
    return this.call<BeadsExecResult>('beadsExec', { cwd, args });
  }

  listDir(dir: string, root: string, worktreePath?: string): Promise<ListDirEntry[]> {
    // worktreePath is omitted from the JSON when undefined; when set, the helper
    // resolves a relative `dir` against that worktree root instead of the
    // project root (working-tree read parity with readFile).
    return this.call<ListDirEntry[]>('listDir', { dir, root, worktreePath });
  }

  /**
   * Subscribe to filesystem-change events for cwd, keyed by token. `spec` is the
   * shared watch policy (derived from src/shared/watch/policy.ts) the helper
   * applies — the single source of "what to watch", so the helper never defines
   * its own exclusion/signal set.
   */
  watchSubscribe(
    cwd: string,
    token: string,
    spec: WatchSpec,
    handler: WatchEventHandler,
  ): Promise<void> {
    this.watchHandlers.set(token, handler);
    return this.call<unknown>('watch.subscribe', { cwd, token, spec }).then(() => undefined);
  }

  /** Stop the watch keyed by token and detach its handler. */
  watchUnsubscribe(token: string): Promise<void> {
    this.watchHandlers.delete(token);
    return this.call<unknown>('watch.unsubscribe', { token }).then(() => undefined);
  }
}
