/**
 * RemoteHelperLauncher — provisions and launches the Go remote helper on the
 * SSH host so the RemoteProvider can serve read-only repository data over the
 * length-prefixed JSON RPC protocol.
 *
 * Flow (br h7a.7.2):
 *   1. Detect the remote os/arch via `uname -sm` over an ssh exec channel.
 *   2. Pick the matching prebuilt binary from remote-helper/dist (selected by
 *      the local manifest.json) and SFTP-upload it to
 *      ~/.agent-cockpit/helper-<version>-<os>-<arch>, chmod +x. Re-upload is
 *      skipped when a binary of the same name already exists remotely.
 *   3. Launch it via an ssh exec channel whose stdio is the RPC transport and
 *      perform the `handshake`. On a protocol-version mismatch we re-provision
 *      and relaunch exactly once.
 *
 * The dist directory (remote-helper/dist) is produced by the helper's build.
 * If it is absent in this environment, provisioning fails with a clear typed
 * error; integration upload/launch is exercised in the integration phase.
 */
import { readFile, access } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { app } from 'electron';
import { HelperRpcClient, PROTOCOL_VERSION, type RpcStream } from './rpcClient';
import type { ProvisionSession, RemoteTransport } from './transportTypes';
import { logger } from '../../logger';

/** Typed error for helper provisioning/launch failures. */
export class HelperLaunchError extends Error {
  readonly phase: 'manifest' | 'detect' | 'select' | 'upload' | 'launch' | 'handshake';
  override readonly cause?: unknown;
  constructor(
    message: string,
    phase: HelperLaunchError['phase'],
    cause?: unknown,
  ) {
    super(message);
    this.name = 'HelperLaunchError';
    this.phase = phase;
    this.cause = cause;
  }
}

interface ManifestBinary {
  os: string;
  arch: string;
  filename: string;
  sha256: string;
}

interface HelperManifest {
  version: string;
  protocolVersion: number;
  /** Build-time content hash of the Go source (embedded via ldflags). Present
   *  in manifests produced by build.sh; absent in older builds. When absent,
   *  provisioning falls back to the existing filename-existence check. */
  sourceHash?: string;
  binaries: ManifestBinary[];
}

/**
 * Resolve the local remote-helper/dist directory.
 *
 * Dev (not packaged): __dirname is out/main at runtime (electron-vite bundles
 * to out/main/index.js). Two levels up from out/main reaches the repo root,
 * so the dist lives at <repo>/remote-helper/dist.
 *   out/main -> out -> <repo root> -> remote-helper/dist  (2x "..")
 * Confirmed by the preload precedent: window.ts does join(__dirname, '../preload/index.js')
 * i.e. one ".." from out/main reaches out/.
 *
 * Packaged (app.isPackaged): __dirname is inside app.asar/out/main. The
 * remote-helper/dist directory is NOT inside the asar; it ships via
 * extraResources and lands at <app>/Contents/Resources/remote-helper/dist
 * (macOS) or resources/remote-helper/dist (Linux). process.resourcesPath
 * points to that Resources directory on all platforms.
 */
function distDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'remote-helper', 'dist');
  }
  return pathResolve(__dirname, '..', '..', 'remote-helper', 'dist');
}

/** A launched helper: the live RPC client plus its underlying channel handle. */
export interface LaunchedHelper {
  client: HelperRpcClient;
  /** Channel-level close handle for the launched helper's exec stream. */
  channel: { close(): void };
  /** The remote path the helper was launched from. */
  remotePath: string;
  /** Helper release version reported by the manifest. */
  version: string;
}

const REMOTE_DIR = '.agent-cockpit';

/** Map `uname -s` output to the manifest os token. */
function normalizeOs(unameS: string): string {
  const s = unameS.trim().toLowerCase();
  if (s === 'darwin') return 'darwin';
  if (s === 'linux') return 'linux';
  return s;
}

/** Map `uname -m` output to the manifest arch token. */
function normalizeArch(unameM: string): string {
  const m = unameM.trim().toLowerCase();
  if (m === 'x86_64' || m === 'amd64') return 'amd64';
  if (m === 'aarch64' || m === 'arm64') return 'arm64';
  return m;
}

export class RemoteHelperLauncher {
  constructor(private readonly transport: RemoteTransport) {}

  /** Read and parse the local dist manifest. */
  private async loadManifest(): Promise<HelperManifest> {
    const manifestPath = join(distDir(), 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch (err) {
      throw new HelperLaunchError(
        `remote-helper dist manifest not found at ${manifestPath} (helper not built in this environment)`,
        'manifest',
        err,
      );
    }
    try {
      return JSON.parse(raw) as HelperManifest;
    } catch (err) {
      throw new HelperLaunchError('failed to parse remote-helper manifest.json', 'manifest', err);
    }
  }

  /**
   * Run `uname -sm` and return [os, arch] tokens. The transport's `exec` is
   * lenient (never rejects on a non-zero exit), so the non-zero check lives here
   * in the caller.
   */
  private async detectPlatform(): Promise<{ os: string; arch: string }> {
    let res;
    try {
      res = await this.transport.exec('uname -sm');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HelperLaunchError(`failed to run uname: ${msg}`, 'detect', err);
    }
    if (res.code !== 0 && res.code !== null) {
      throw new HelperLaunchError(`uname exited ${res.code}: ${res.stderr.trim()}`, 'detect');
    }
    const parts = res.stdout.trim().split(/\s+/);
    if (parts.length < 2) {
      throw new HelperLaunchError(`unexpected uname output: ${res.stdout.trim()}`, 'detect');
    }
    return { os: normalizeOs(parts[0]!), arch: normalizeArch(parts[1]!) };
  }

  /**
   * Run `helper version` over a non-login exec channel and return the printed
   * source hash (trimmed). Returns null on any error (missing, crash, timeout,
   * no output) so the caller can treat the remote as stale and re-upload.
   */
  private async queryRemoteVersion(remotePath: string): Promise<string | null> {
    // Resolve the home-relative path (same as launchExec): "./.agent-cockpit/…"
    // -> "$HOME/.agent-cockpit/…"
    const rel = remotePath.replace(/^\.\//, '');
    const cmd = `"$HOME/${rel}" version`;
    try {
      // Non-pty exec: we only want clean stdout (the source hash line). A 5s
      // timeout force-closes a hung probe and resolves with what was collected.
      const res = await this.transport.exec(cmd, { timeoutMs: 5_000 });
      const hash = res.stdout.trim();
      return hash.length > 0 ? hash : null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure the matching helper binary is present and up-to-date at its remote
   * path. Version-aware flow (requires a manifest with `sourceHash`):
   *
   *   - Absent  → upload + chmod, log "uploading (absent)"
   *   - Present, hash matches local → skip, log "up-to-date"
   *   - Present, hash differs / version cmd fails → re-upload, log "replacing (stale)"
   *
   * Falls back to the legacy existence-only check when the manifest has no
   * `sourceHash` (older builds without the hash field).
   *
   * Returns the remote path and manifest version.
   */
  private async provision(): Promise<{ remotePath: string; version: string }> {
    const manifest = await this.loadManifest();
    const { os, arch } = await this.detectPlatform();
    const binary = manifest.binaries.find((b) => b.os === os && b.arch === arch);
    if (!binary) {
      const have = manifest.binaries.map((b) => `${b.os}-${b.arch}`).join(', ');
      throw new HelperLaunchError(
        `no prebuilt helper for ${os}-${arch} (manifest has: ${have})`,
        'select',
      );
    }

    const localPath = join(distDir(), binary.filename);
    try {
      await access(localPath);
    } catch (err) {
      throw new HelperLaunchError(
        `helper binary missing locally at ${localPath}`,
        'upload',
        err,
      );
    }

    const remoteDir = `./${REMOTE_DIR}`;
    const remotePath = `${remoteDir}/${binary.filename}`;
    const ctx = 'remote-helper';

    const session: ProvisionSession = await this.beginProvision();
    try {
      const exists = await session.exists(remotePath);

      if (!exists) {
        // Binary is absent: upload fresh.
        logger.info(`helper: uploading (absent at ${remotePath})`, ctx);
        await session.mkdirp(remoteDir);
        await session.uploadExecutable(localPath, remotePath, 0o755);
      } else if (manifest.sourceHash) {
        // Binary is present and the manifest carries a source hash: check
        // whether the remote is running the same build.
        const remoteHash = await this.queryRemoteVersion(remotePath);
        if (remoteHash === manifest.sourceHash) {
          logger.info(`helper: up-to-date (hash=${manifest.sourceHash.slice(0, 12)}…)`, ctx);
        } else {
          logger.info(
            `helper: replacing (remote=${remoteHash ?? 'error'} local=${manifest.sourceHash.slice(0, 12)}…)`,
            ctx,
          );
          await session.uploadExecutable(localPath, remotePath, 0o755);
        }
      } else {
        // Legacy: no sourceHash in manifest — existence-only check (no re-upload).
        logger.info(`helper: present (no sourceHash in manifest, skipping version check)`, ctx);
      }
    } finally {
      session.end();
    }

    return { remotePath, version: manifest.version };
  }

  /**
   * Open the provisioning session, mapping a transport-level failure into the
   * helper's typed `upload`-phase error.
   */
  private async beginProvision(): Promise<ProvisionSession> {
    try {
      return await this.transport.beginProvision();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HelperLaunchError(`failed to open provisioning session: ${msg}`, 'upload', err);
    }
  }

  /** Launch the helper at remotePath and return its live RPC duplex stream. */
  private async launchExec(remotePath: string): Promise<RpcStream> {
    // remotePath is "./.agent-cockpit/<file>", relative to the SSH session's
    // home directory; resolve against $HOME so it does not need to be on PATH.
    const rel = remotePath.replace(/^\.\//, '');
    const cmd = `exec "$HOME/${rel}"`;
    try {
      const stream = await this.transport.execStream(cmd);
      // Drain + surface the helper's stderr so remote errors/panics reach the
      // app's diagnostics instead of being silently dropped (an unread stderr
      // stream can also back-pressure the remote process).
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trimEnd();
        if (text) logger.warn(`remote helper stderr: ${text}`, 'remote-helper');
      });
      return stream;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HelperLaunchError(`failed to launch helper: ${msg}`, 'launch', err);
    }
  }

  /**
   * Provision (if needed), launch, and handshake. On a protocol-version
   * mismatch the helper is re-provisioned and relaunched once before giving up.
   */
  async launch(): Promise<LaunchedHelper> {
    const provisioned = await this.provision();
    const attempt = async (remotePath: string, version: string): Promise<LaunchedHelper> => {
      const stream = await this.launchExec(remotePath);
      // Channel-level close handle: end the duplex's writable half (the RPC
      // decoder's failAll fires on the readable's end/error).
      const channel = { close: () => stream.stdin.end() };
      const client = new HelperRpcClient(stream);
      let result;
      try {
        result = await client.handshake();
      } catch (err) {
        channel.close();
        throw new HelperLaunchError(
          `handshake failed: ${err instanceof Error ? err.message : String(err)}`,
          'handshake',
          err,
        );
      }
      if (result.protocolVersion !== PROTOCOL_VERSION) {
        channel.close();
        throw new HelperLaunchError(
          `protocol version mismatch: helper ${result.protocolVersion}, client ${PROTOCOL_VERSION}`,
          'handshake',
        );
      }
      return { client, channel, remotePath, version };
    };

    try {
      return await attempt(provisioned.remotePath, provisioned.version);
    } catch (err) {
      if (err instanceof HelperLaunchError && err.phase === 'handshake') {
        // Re-provision and relaunch once on a version mismatch / bad handshake.
        const fresh = await this.provision();
        return attempt(fresh.remotePath, fresh.version);
      }
      throw err;
    }
  }
}
