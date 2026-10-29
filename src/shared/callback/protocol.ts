/**
 * Terminal callback socket protocol (terminal -> app): the versioned
 * request/reply envelope, its limits, and the pure validation every listener
 * shares. Main's `CallbackBroker` consumes it today; the remote helper and the
 * `cockpit` CLI mirror it in Go (the JSON fixtures under `./fixtures` pin the
 * cases both sides must agree on).
 *
 * Framing is the shared length-prefixed JSON codec (`../wire/frame`) bound to
 * the 64 KiB callback cap. One request per connection.
 *
 * Identity is not a secret: a request names no project (the project is the one
 * that owns the socket it arrived on) and `pane` is attribution metadata only.
 *
 * Governing doc: docs/design/terminal-callback-socket.md ("Envelope, wire and limits").
 */
import { FrameDecoder, encodeFrame } from '../wire/frame';

export const CALLBACK_PROTOCOL_VERSION = 1;

/** Largest frame body, either direction. */
export const CALLBACK_MAX_FRAME_BYTES = 64 * 1024;
/** The listener's read deadline, and the CLI's overall deadline. */
export const CALLBACK_DEADLINE_MS = 5_000;
/** Concurrent connections main's listener serves; further connections are dropped. */
export const CALLBACK_MAX_CONNECTIONS = 32;
/** Default per-project burst limit. */
export const CALLBACK_RATE_LIMIT_PER_SECOND = 10;
/** Longest accepted `path` / `canonicalPath` (PATH_MAX on Linux). */
export const CALLBACK_MAX_PATH_BYTES = 4096;

const MAX_OP_CHARS = 32;
const MAX_PANE_ID_CHARS = 128;

/** Variables the app owns in a pane's environment (see docs/design/terminal-callback-socket.md, "Environment injection"). */
export const CALLBACK_ENV_PREFIX = 'COCKPIT_CALLBACK_';
export const CALLBACK_CLI_ENV = 'COCKPIT_CLI';
export const CALLBACK_MUX_KEY_ENV = 'COCKPIT_CALLBACK_MUX_KEY';

/** The default-deny operation allowlist. Anything else is `unsupported-op`. */
export const CALLBACK_OPS = ['open'] as const;
export type CallbackOp = (typeof CALLBACK_OPS)[number];

export function isCallbackOp(op: string): op is CallbackOp {
  return (CALLBACK_OPS as readonly string[]).includes(op);
}

export const CALLBACK_ERROR_CODES = [
  'unsupported-op',
  'bad-request',
  'rate-limited',
  'timeout',
  'not-connected',
  'internal',
] as const;
export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

/** Which terminal a request came from. Attribution metadata: main cannot verify it. */
export interface CallbackPane {
  kind: 'tmux' | 'mux';
  id: string;
}

export interface OpenArgs {
  /** Absolute logical path, as the user named it (lexically cleaned by the CLI). */
  path: string;
  /** Absolute canonical form (symlink-resolved parent + base name); omitted when
   *  the CLI could not compute it. */
  canonicalPath?: string;
}

export interface OpenResult {
  status: 'dispatched';
}

/** The request a client sends (what the `cockpit` CLI builds). */
export interface CallbackRequest {
  v: typeof CALLBACK_PROTOCOL_VERSION;
  id: number;
  op: string;
  pane?: CallbackPane;
  args: unknown;
}

export interface CallbackOkReply<T = unknown> {
  id: number;
  ok: true;
  result: T;
}

export interface CallbackErrorReply {
  id: number;
  ok: false;
  error: { code: CallbackErrorCode; message: string };
}

export type CallbackReply<T = unknown> = CallbackOkReply<T> | CallbackErrorReply;

/**
 * The content selection an `open` produces: the subset of the renderer's
 * `ContentSelection` a plain file open uses. It deliberately has no `baseline`
 * field: a plain file open must never force a git-ref read (an untracked file
 * would then render "not found").
 */
export interface CallbackOpenSelection {
  /** Relative to `worktreePath` (or the project root when that is ''); the
   *  absolute logical path for 'external-file'. */
  path: string;
  /** Canonical worktree root, or '' (project root / external). */
  worktreePath: string;
  kind: 'file' | 'external-file';
}

export function okReply<T>(id: number, result: T): CallbackOkReply<T> {
  return { id, ok: true, result };
}

export function errorReply(
  id: number,
  code: CallbackErrorCode,
  message: string,
): CallbackErrorReply {
  return { id, ok: false, error: { code, message } };
}

export function encodeCallbackFrame(message: CallbackRequest | CallbackReply): Uint8Array {
  return encodeFrame(message, CALLBACK_MAX_FRAME_BYTES);
}

export function createCallbackFrameDecoder(): FrameDecoder {
  return new FrameDecoder(CALLBACK_MAX_FRAME_BYTES);
}

// ---- Envelope validation ----------------------------------------------------

const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isPaneId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PANE_ID_CHARS &&
    !CONTROL_CHARS.test(value)
  );
}

function parsePane(raw: unknown): CallbackPane | null {
  if (!isRecord(raw)) return null;
  const { kind, id } = raw;
  if ((kind !== 'tmux' && kind !== 'mux') || !isPaneId(id)) return null;
  return { kind, id };
}

export type EnvelopeResult =
  | { ok: true; id: number; op: string; pane?: CallbackPane; args: unknown }
  | { ok: false; id: number; message: string };

/**
 * Validate the envelope's shape (not the operation's arguments). A failure
 * carries the request's own `id` when it has a valid one, else 0 (a valid id is
 * always >= 1), so the reply can still be correlated.
 *
 * Unknown top-level fields are ignored. In particular nothing in a request can
 * name a project: the receiving socket decides that.
 */
export function parseCallbackEnvelope(raw: unknown): EnvelopeResult {
  if (!isRecord(raw)) return { ok: false, id: 0, message: 'request must be a JSON object' };
  const id =
    Number.isSafeInteger(raw['id']) && (raw['id'] as number) >= 1 ? (raw['id'] as number) : 0;
  if (raw['v'] !== CALLBACK_PROTOCOL_VERSION) {
    return {
      ok: false,
      id,
      message: `unsupported protocol version (expected v=${CALLBACK_PROTOCOL_VERSION})`,
    };
  }
  if (id === 0) return { ok: false, id, message: 'id must be a positive integer' };
  const op = raw['op'];
  if (typeof op !== 'string' || op.length === 0 || op.length > MAX_OP_CHARS) {
    return { ok: false, id, message: 'op must be a non-empty string' };
  }
  const paneRaw = raw['pane'];
  if (paneRaw === undefined || paneRaw === null) return { ok: true, id, op, args: raw['args'] };
  const pane = parsePane(paneRaw);
  if (!pane) return { ok: false, id, message: 'pane must be {kind: "tmux" | "mux", id: string}' };
  return { ok: true, id, op, pane, args: raw['args'] };
}

function parseAbsolutePath(
  value: unknown,
  field: string,
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, message: `${field} must be a non-empty string` };
  }
  if (!value.startsWith('/')) return { ok: false, message: `${field} must be an absolute path` };
  if (value.includes('\0')) return { ok: false, message: `${field} must not contain NUL` };
  if (textEncoder.encode(value).length > CALLBACK_MAX_PATH_BYTES) {
    return { ok: false, message: `${field} is longer than ${CALLBACK_MAX_PATH_BYTES} bytes` };
  }
  return { ok: true, path: value };
}

/** Validate `open`'s arguments: an absolute `path`, and an optional absolute `canonicalPath`. */
export function parseOpenArgs(
  raw: unknown,
): { ok: true; args: OpenArgs } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: 'args must be an object' };
  const path = parseAbsolutePath(raw['path'], 'path');
  if (!path.ok) return path;
  const canonicalRaw = raw['canonicalPath'];
  if (canonicalRaw === undefined || canonicalRaw === null)
    return { ok: true, args: { path: path.path } };
  const canonical = parseAbsolutePath(canonicalRaw, 'canonicalPath');
  if (!canonical.ok) return canonical;
  return { ok: true, args: { path: path.path, canonicalPath: canonical.path } };
}

// ---- Identity & injectable values -------------------------------------------

/**
 * The pane identity a client reads from its own environment (the reference the
 * Go CLI mirrors): the app-chosen mux key WINS when present, because an app
 * launched from a tmux pane makes its mux daemon inherit a stale `TMUX_PANE`;
 * otherwise tmux's `TMUX_PANE`; otherwise none (a missing `pane` is accepted).
 */
export function paneFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CallbackPane | undefined {
  const muxKey = env[CALLBACK_MUX_KEY_ENV];
  if (isPaneId(muxKey)) return { kind: 'mux', id: muxKey };
  const tmuxPane = env['TMUX_PANE'];
  if (isPaneId(tmuxPane)) return { kind: 'tmux', id: tmuxPane };
  return undefined;
}

/**
 * Whether `value` may be injected into a terminal environment. Values are never
 * restricted by charset (spaces and shell metacharacters are legal; they travel
 * as argv or quoted tmux arguments), only rejected when they contain NUL or a
 * line break, which cannot survive an environment block or a tmux command line.
 */
export function isInjectableEnvValue(value: string): boolean {
  return !/[\0\r\n]/.test(value);
}
