/**
 * The LOCAL `cockpit` CLI link: `<userData>/callback/bin/cockpit`, the path every
 * local terminal receives as `COCKPIT_CLI` (see localEnvironment.ts).
 *
 * The CLI is a multi-call mode of the remote helper's Go binary: invoked under the
 * program name `cockpit` it dispatches to the CLI instead of serving RPC. The same
 * Go source is already built for the host platform and shipped in app resources
 * (`remote-helper/dist/helper-<version>-<os>-<arch>`, listed by `manifest.json`;
 * electron-builder's `extraResources` carries the whole directory, and the macOS
 * signer signs the darwin binary like the mux binaries). So no new artifact is
 * built: the link points at the host's entry of that manifest, and a dev run
 * resolves the same files from the built `remote-helper/dist`.
 *
 * The link lives under `<userData>/callback/bin/`, created 0700 and verified like
 * the socket directory. It is replaced atomically (a temp link renamed over the
 * old one), so a pane that is running the CLI never finds it missing, and
 * refreshing it is idempotent. Creating it is best-effort by design: a failure
 * must never fail startup or a session, it is logged once, and the injected
 * `COCKPIT_CLI` simply dangles (a pane gets "No such file or directory", which
 * names the missing file).
 *
 * Side effects, accepted and documented: the link is ONE path per user data
 * directory, so it follows whichever app instance last ran this function, and its
 * target lives inside that instance's files.
 *
 *  - Linux AppImage. The app's resources are a per-run mount
 *    (`/tmp/.mount_<random>/resources/...`) that disappears when the app exits, so
 *    between runs the link dangles and a pane that outlived the app gets "No such
 *    file or directory" from `$COCKPIT_CLI`. That is the honest answer (nothing is
 *    running to answer a request); the next start re-links it to its own mount.
 *    A macOS app has a stable resources path; moving or updating it re-points the
 *    link on the next start.
 *  - Development checkouts and worktrees. A dev run links to the built
 *    `remote-helper/dist` of the checkout being run, and every dev run shares one
 *    user data directory (the historical development profile). Running a second
 *    checkout (or worktree), or one after another, re-points the one link at the
 *    newest start; deleting a checkout, or `build.sh` rebuilding its `dist`
 *    (`rm -rf dist`), leaves the link dangling until the next start. Terminals
 *    started in between receive the same `COCKPIT_CLI` path either way, and the
 *    envelope's `v` field covers protocol skew between a CLI from one build and a
 *    listener from another.
 *  - The link is refreshed only when a local listener binds (a session starting),
 *    never in the background: a `dist` replaced mid-run is picked up by the next
 *    bind, not before.
 */
import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../logger';
import { localCliPath } from './localEnvironment';
import { CallbackPathError, prepareSocketDir } from './socketPath';

const LOG_CONTEXT = 'callback';

/** Map Node's platform/arch to the helper manifest's tokens (see helper.ts). */
export function manifestPlatform(
  platform: NodeJS.Platform,
  arch: string,
): { os: string; arch: string } | null {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const machine = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'amd64' : null;
  return os && machine ? { os, arch: machine } : null;
}

export interface LocalCliLinkOptions {
  userDataDir: string;
  /** The directory holding the helper binaries and `manifest.json`. */
  distDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Owning user; defaults to the current uid. */
  uid?: number;
}

export type LocalCliLinkResult =
  | { ok: true; link: string; target: string; changed: boolean }
  | { ok: false; reason: LocalCliLinkFailure; detail: string };

export type LocalCliLinkFailure =
  | 'unsupported-platform'
  | 'no-manifest'
  | 'no-binary'
  | 'unsafe-dir'
  | 'link-failed';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface ManifestBinary {
  os?: unknown;
  arch?: unknown;
  filename?: unknown;
}

/** The host's helper binary from `<distDir>/manifest.json`, as an absolute path. */
function hostBinary(
  distDir: string,
  host: { os: string; arch: string },
): { ok: true; path: string } | { ok: false; reason: 'no-manifest' | 'no-binary'; detail: string } {
  const manifestPath = join(distDir, 'manifest.json');
  let manifest: { binaries?: ManifestBinary[] };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { binaries?: ManifestBinary[] };
  } catch (err) {
    return { ok: false, reason: 'no-manifest', detail: `${manifestPath}: ${describe(err)}` };
  }
  const entry = (manifest.binaries ?? []).find((b) => b.os === host.os && b.arch === host.arch);
  if (!entry || typeof entry.filename !== 'string' || entry.filename.length === 0) {
    return {
      ok: false,
      reason: 'no-binary',
      detail: `${manifestPath} lists no ${host.os}-${host.arch} build`,
    };
  }
  const path = join(distDir, entry.filename);
  try {
    if (!lstatSync(path).isFile()) throw new Error('not a regular file');
  } catch (err) {
    return { ok: false, reason: 'no-binary', detail: `${path}: ${describe(err)}` };
  }
  return { ok: true, path };
}

/**
 * Make `<userData>/callback/bin/cockpit` a symlink to the host's helper binary.
 * Idempotent: an already-correct link is left untouched (`changed: false`).
 */
export function ensureLocalCliLink(options: LocalCliLinkOptions): LocalCliLinkResult {
  const host = manifestPlatform(options.platform ?? process.platform, options.arch ?? process.arch);
  if (!host) {
    return {
      ok: false,
      reason: 'unsupported-platform',
      detail: `${options.platform ?? process.platform}/${options.arch ?? process.arch}`,
    };
  }
  const binary = hostBinary(options.distDir, host);
  if (!binary.ok) return binary;

  const link = localCliPath(options.userDataDir);
  const binDir = dirname(link);
  try {
    prepareSocketDir(dirname(binDir), options.uid);
    prepareSocketDir(binDir, options.uid);
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof CallbackPathError && err.code === 'unsafe-dir'
          ? 'unsafe-dir'
          : 'link-failed',
      detail: describe(err),
    };
  }

  try {
    if (readlinkSync(link) === binary.path) {
      return { ok: true, link, target: binary.path, changed: false };
    }
  } catch {
    /* absent, or not a symlink: (re)create it below */
  }
  const temp = `${link}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    symlinkSync(binary.path, temp);
    renameSync(temp, link);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      /* nothing was created */
    }
    return { ok: false, reason: 'link-failed', detail: `${link}: ${describe(err)}` };
  }
  return { ok: true, link, target: binary.path, changed: true };
}

/**
 * A best-effort, idempotent "make sure the CLI link exists" for the app to call at
 * each local listener start. It never throws, logs a creation or refresh once, and
 * logs a failure once per distinct reason, so repeated session starts do not spam.
 */
export function createLocalCliLinker(
  resolve: () => Pick<LocalCliLinkOptions, 'userDataDir' | 'distDir'>,
): () => void {
  const reported = new Set<string>();
  return () => {
    let result: LocalCliLinkResult;
    try {
      result = ensureLocalCliLink(resolve());
    } catch (err) {
      result = { ok: false, reason: 'link-failed', detail: describe(err) };
    }
    if (result.ok) {
      if (result.changed) {
        logger.info(
          `callback CLI linked link=${JSON.stringify(result.link)} target=${JSON.stringify(result.target)}`,
          LOG_CONTEXT,
        );
      }
      return;
    }
    const key = `${result.reason}:${result.detail}`;
    if (reported.has(key)) return;
    reported.add(key);
    logger.warn(
      `callback CLI unavailable reason=${result.reason} detail=${JSON.stringify(result.detail)}; ` +
        'COCKPIT_CLI will not resolve in local terminals',
      LOG_CONTEXT,
    );
  };
}
