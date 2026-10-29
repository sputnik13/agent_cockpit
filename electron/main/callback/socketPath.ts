/**
 * Where a LOCAL project's callback socket lives, and the directory checks that
 * make that location the access-control boundary (requirements 2 and 4 of
 * docs/requirements/terminal-callback-socket.md).
 *
 * Primary: `<userData>/callback/<h>.sock`, `<h>` = first 12 hex of
 * SHA-256(projectId). The default macOS profile path contains spaces, which a
 * unix socket and argv handle. A unix socket path is limited to 104 bytes on
 * macOS (108 on Linux) and the takeover temp name needs a few more, so a path
 * over the 90-byte guard (the same guard the mux socket uses) falls back to the
 * literal `/tmp/ac-cb-<uid>/<h>.sock`. So does a path that could not be injected
 * into a terminal environment (a NUL or line break in the userData path), since
 * the fallback never contains such characters. The fallback's `<h>` hashes the resolved
 * userData path TOGETHER with the projectId: isolated runs (userData under
 * `tmpdir()`) and long usernames always land on the fallback, and two profiles
 * sharing a projectId (a copied `store.db`) must never share a socket under
 * newest-wins takeover.
 *
 * The directory is created 0700 and verified with `lstat` (a directory, not a
 * symlink, owned by the current user, no group/other access) or the project's
 * callback fails closed. The 0600 socket mode is applied by the listener.
 */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isInjectableEnvValue } from '@shared/callback/protocol';

/** Longest socket path (bytes) the app binds: the documented guard, below the OS limit. */
export const SOCKET_PATH_GUARD_BYTES = 90;

export type CallbackPathErrorCode = 'invalid-value' | 'too-long' | 'unsafe-dir' | 'dir-error';

export class CallbackPathError extends Error {
  readonly code: CallbackPathErrorCode;
  constructor(code: CallbackPathErrorCode, message: string) {
    super(message);
    this.name = 'CallbackPathError';
    this.code = code;
  }
}

export interface SocketLocation {
  socketPath: string;
  /** The directory holding the socket (and nothing else of ours). */
  dir: string;
  /** True when the userData path was too long and the /tmp fallback was chosen. */
  fallback: boolean;
}

export interface SocketLocationOptions {
  userDataDir: string;
  projectId: string;
  /** Owning user; defaults to the current uid. */
  uid?: number;
  /** Parent of the fallback directory; defaults to the literal `/tmp`. Tests
   *  inject a private directory so they never touch the shared one. */
  tmpRoot?: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** First 12 hex characters of SHA-256(projectId): the stable per-project socket name. */
export function projectHash(projectId: string): string {
  return sha256Hex(projectId).slice(0, 12);
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

/**
 * Pure path derivation (no I/O). Falls back to /tmp when the primary path is too
 * long or not injectable; throws `invalid-value` / `too-long` when no usable path
 * exists even then.
 */
export function deriveSocketLocation(opts: SocketLocationOptions): SocketLocation {
  const userData = resolve(opts.userDataDir);
  const primaryDir = join(userData, 'callback');
  const primary = join(primaryDir, `${projectHash(opts.projectId)}.sock`);
  let location: SocketLocation = { socketPath: primary, dir: primaryDir, fallback: false };
  if (Buffer.byteLength(primary) > SOCKET_PATH_GUARD_BYTES || !isInjectableEnvValue(primary)) {
    const dir = join(opts.tmpRoot ?? '/tmp', `ac-cb-${opts.uid ?? currentUid()}`);
    const h = sha256Hex(`${userData}\0${opts.projectId}`).slice(0, 12);
    location = { socketPath: join(dir, `${h}.sock`), dir, fallback: true };
  }
  if (!isInjectableEnvValue(location.socketPath)) {
    throw new CallbackPathError('invalid-value', 'socket path contains NUL or a line break');
  }
  const bytes = Buffer.byteLength(location.socketPath);
  if (bytes > SOCKET_PATH_GUARD_BYTES) {
    throw new CallbackPathError(
      'too-long',
      `socket path is ${bytes} bytes even after the /tmp fallback (limit ${SOCKET_PATH_GUARD_BYTES})`,
    );
  }
  return location;
}

/** Create `dir` 0700 if absent, then verify it by `lstat`; fail closed on anything unexpected. */
export function prepareSocketDir(dir: string, uid: number = currentUid()): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new CallbackPathError('dir-error', `cannot create ${dir}: ${errorMessage(err)}`);
  }
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    throw new CallbackPathError('dir-error', `cannot stat ${dir}: ${errorMessage(err)}`);
  }
  if (st.isSymbolicLink()) throw new CallbackPathError('unsafe-dir', `${dir} is a symlink`);
  if (!st.isDirectory()) throw new CallbackPathError('unsafe-dir', `${dir} is not a directory`);
  if (st.uid !== uid) {
    throw new CallbackPathError('unsafe-dir', `${dir} is owned by uid ${st.uid}, not ${uid}`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new CallbackPathError(
      'unsafe-dir',
      `${dir} grants group/other access (mode ${(st.mode & 0o777).toString(8)}); it must be 700`,
    );
  }
}

/** Derive the location and make its directory safe to bind in. */
export function resolveSocketLocation(opts: SocketLocationOptions): SocketLocation {
  const location = deriveSocketLocation(opts);
  prepareSocketDir(location.dir, opts.uid ?? currentUid());
  return location;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
