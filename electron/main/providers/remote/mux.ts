import { access } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { app } from 'electron';
import {
  isMuxArtifactFilename,
  loadMuxArtifactManifest,
  selectMuxArtifact,
  verifyMuxArtifact,
  type MuxArtifactManifest,
} from '../muxArtifacts';
import { MuxClient, MuxClientError } from './muxClient';
import type { DuplexChannel, ProvisionSession, RemoteTransport } from './transportTypes';

const REMOTE_HOME = '.agent-cockpit/mux';
const REMOTE_SOCKET = `${REMOTE_HOME}/mux.sock`;
const UPGRADE_TIMEOUT_MS = 12_000;
const IDLE_HANDOFF_ERROR = 'mux handoff requires at least one live pane';

export class MuxLaunchError extends Error {
  constructor(
    readonly phase: 'manifest' | 'detect' | 'select' | 'upload' | 'launch' | 'upgrade',
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'MuxLaunchError';
  }
}

function distDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'cockpit-mux', 'dist')
    : pathResolve(__dirname, '..', '..', 'cockpit-mux', 'dist');
}

function platformToken(value: string): string {
  const token = value.trim().toLowerCase();
  return token === 'darwin' ? 'darwin' : token === 'linux' ? 'linux' : token;
}

function archToken(value: string): string {
  const token = value.trim().toLowerCase();
  return token === 'x86_64' || token === 'amd64'
    ? 'amd64'
    : token === 'aarch64' || token === 'arm64'
      ? 'arm64'
      : token;
}

function remoteBinaryPath(filename: string): string {
  if (!isMuxArtifactFilename(filename)) {
    throw new MuxLaunchError('select', `invalid mux artifact filename: ${filename}`);
  }
  return `./.agent-cockpit/${filename}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class RemoteMuxLauncher {
  constructor(
    private readonly transport: RemoteTransport,
    private readonly artifacts?: string,
  ) {}

  async launch(socketPath?: string): Promise<{ channel: DuplexChannel; remotePath: string }> {
    const manifest = await this.manifest();
    const detected = await this.detect();
    const binary = selectMuxArtifact(manifest, detected.os, detected.arch);
    if (!binary)
      throw new MuxLaunchError('select', `no mux artifact for ${detected.os}-${detected.arch}`);
    const remotePath = remoteBinaryPath(binary.filename);
    const localPath = join(this.artifactDir(), binary.filename);
    try {
      await access(localPath);
    } catch (cause) {
      throw new MuxLaunchError('upload', `mux artifact missing: ${localPath}`, cause);
    }
    await this.verifyArtifact(localPath, binary.sha256);
    let session: ProvisionSession;
    try {
      session = await this.transport.beginProvision();
    } catch (cause) {
      throw new MuxLaunchError('upload', 'open mux provisioning session', cause);
    }
    try {
      const exists = await session.exists(remotePath);
      if (!exists) {
        await session.mkdirp('./.agent-cockpit');
        await session.uploadExecutable(localPath, remotePath, 0o755);
      } else if (
        manifest.sourceHash &&
        (await this.remoteHash(remotePath)) !== manifest.sourceHash
      ) {
        await session.replaceExecutable(localPath, remotePath, 0o755);
      }
    } finally {
      session.end();
    }
    await this.ensureStableCommandPath(remotePath);
    const daemonState = await this.ensureDaemon(remotePath, manifest.sourceHash);
    if (daemonState === 'upgrade-required') {
      const upgrade = await this.upgradeDaemon(remotePath, manifest.sourceHash);
      if (upgrade === 'idle-restart') await this.restartIdleDaemon(remotePath);
      if ((await this.ensureDaemon(remotePath, manifest.sourceHash)) !== 'ready') {
        throw new MuxLaunchError(
          'upgrade',
          'remote Cockpit mux still reports a different build after live handoff',
        );
      }
      await this.repointStableCommandPath(remotePath);
    }
    try {
      const attach = socketPath
        ? `bridge --socket ${shellQuote(socketPath)}`
        : `--home "$HOME/${REMOTE_HOME}" bridge`;
      return {
        channel: await this.transport.execStream(`exec "$HOME/${remotePath.slice(2)}" ${attach}`),
        remotePath,
      };
    } catch (cause) {
      throw new MuxLaunchError('launch', 'launch remote mux attach bridge', cause);
    }
  }

  private async repointStableCommandPath(remotePath: string): Promise<void> {
    const stable = '"$HOME/.agent-cockpit/cockpit-mux"';
    const temporary = '"$HOME/.agent-cockpit/cockpit-mux.next"';
    const target = `"$HOME/${remotePath.slice(2)}"`;
    const result = await this.transport.exec(
      [
        `if test ! -L ${stable}; then exit 43; fi`,
        `ln -s ${target} ${temporary}`,
        `mv -f ${temporary} ${stable}`,
      ].join('; '),
      { timeoutMs: 2_000 },
    );
    if (result.code !== 0)
      throw new MuxLaunchError(
        'upgrade',
        `repoint stable remote mux command after handoff: ${result.stderr.trim() || result.stdout.trim()}`,
      );
  }

  private async upgradeDaemon(
    remotePath: string,
    sourceHash?: string,
  ): Promise<'handoff' | 'idle-restart'> {
    if (!sourceHash) {
      throw new MuxLaunchError('upgrade', 'mux manifest is missing a source hash for live handoff');
    }
    const executable = `"$HOME/${remotePath.slice(2)}"`;
    const home = `"$HOME/${REMOTE_HOME}"`;
    let channel: DuplexChannel;
    try {
      channel = await this.transport.execStream(`exec ${executable} --home ${home} bridge`);
    } catch (cause) {
      throw new MuxLaunchError('upgrade', 'open remote mux live-upgrade bridge', cause);
    }
    const client = new MuxClient(channel);
    client.open();
    try {
      await requestWithin(
        client.request('mux.upgrade', {
          binary_path: `~/${remotePath.slice(2)}`,
          source_hash: sourceHash,
        }),
        UPGRADE_TIMEOUT_MS,
        'live handoff',
      );
      return 'handoff';
    } catch (cause) {
      // An idle daemon has no PTYs to transfer, so the daemon deliberately
      // rejects descriptor handoff. Its own shutdown guard proves there are no
      // live panes; restart it below instead of turning a harmless stale binary
      // into a remote connection failure. Every other upgrade rejection leaves
      // the old daemon serving and remains visible to the caller.
      if (cause instanceof MuxClientError && cause.message === IDLE_HANDOFF_ERROR) {
        return 'idle-restart';
      }
      throw new MuxLaunchError('upgrade', 'remote Cockpit mux rejected live handoff', cause);
    } finally {
      client.close();
    }
  }

  private async restartIdleDaemon(remotePath: string): Promise<void> {
    const executable = `"$HOME/${remotePath.slice(2)}"`;
    const home = `"$HOME/${REMOTE_HOME}"`;
    let channel: DuplexChannel;
    try {
      channel = await this.transport.execStream(`exec ${executable} --home ${home} bridge`);
    } catch (cause) {
      throw new MuxLaunchError('upgrade', 'open remote mux idle-restart bridge', cause);
    }
    const client = new MuxClient(channel);
    client.open();
    try {
      await requestWithin(client.request('mux.shutdown', {}), UPGRADE_TIMEOUT_MS, 'idle daemon shutdown');
    } catch (cause) {
      throw new MuxLaunchError('upgrade', 'remote Cockpit mux refused idle daemon restart', cause);
    } finally {
      client.close();
    }
    const socket = `"$HOME/${REMOTE_SOCKET}"`;
    let result;
    try {
      result = await this.transport.exec(
        [
          'for attempt in 1 2 3 4 5 6 7 8 9 10; do',
          `  if test ! -S ${socket}; then exit 0; fi`,
          '  sleep 0.1',
          'done',
          'exit 1',
        ].join('\n'),
        { timeoutMs: 2_000 },
      );
    } catch (cause) {
      throw new MuxLaunchError('upgrade', 'wait for idle remote mux shutdown', cause);
    }
    if (result.code !== 0) {
      throw new MuxLaunchError(
        'upgrade',
        `idle remote mux did not stop: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /**
   * The fallback contract uses a stable command name. It is intentionally
   * create-only: changing an existing link belongs to the verified handoff
   * transaction, not routine artifact provisioning.
   */
  private async ensureStableCommandPath(remotePath: string): Promise<void> {
    const stable = '"$HOME/.agent-cockpit/cockpit-mux"';
    const target = `"$HOME/${remotePath.slice(2)}"`;
    const command = [
      `if test -L ${stable}; then exit 0; fi; if test -e ${stable}; then exit 43; fi`,
      `ln -s ${target} ${stable}`,
    ].join('; ');
    let result;
    try {
      result = await this.transport.exec(command, { timeoutMs: 2_000 });
    } catch (cause) {
      throw new MuxLaunchError('launch', 'create stable remote mux command', cause);
    }
    if (result.code === 43) {
      throw new MuxLaunchError(
        'launch',
        'remote ~/.agent-cockpit/cockpit-mux exists and is not a symlink; refusing to replace it',
      );
    }
    if (result.code !== 0) {
      throw new MuxLaunchError(
        'launch',
        `create stable remote mux command: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  /**
   * Start the daemon only when its private socket is absent, then wait a bounded
   * interval for readiness. The daemon owns stale-socket cleanup on startup; a
   * healthy existing daemon is never replaced by this operation.
   */
  private async ensureDaemon(
    remotePath: string,
    sourceHash?: string,
  ): Promise<'ready' | 'upgrade-required'> {
    const executable = `"$HOME/${remotePath.slice(2)}"`;
    const home = `"$HOME/${REMOTE_HOME}"`;
    const parent = '"$HOME/.agent-cockpit"';
    const socket = `"$HOME/${REMOTE_SOCKET}"`;
    const recordedHash = `"$HOME/${REMOTE_HOME}/daemon-source-hash"`;
    const runningHashCheck = sourceHash
      ? `if test -r ${recordedHash} && test "$(cat ${recordedHash})" != ${shellQuote(sourceHash)}; then exit 42; fi;`
      : '';
    const command = [
      `if test -S ${socket}; then`,
      runningHashCheck,
      '  exit 0',
      'fi',
      `mkdir -p ${parent} ${home}`,
      `chmod 700 ${parent} ${home}`,
      `nohup ${executable} --home ${home} > ${home}/mux.log 2>&1 < /dev/null &`,
      'for attempt in 1 2 3 4 5 6 7 8 9 10; do',
      `  if test -S ${socket}; then exit 0; fi`,
      '  sleep 0.1',
      'done',
      'exit 1',
    ]
      .filter(Boolean)
      .join('\n');
    let result;
    try {
      result = await this.transport.exec(command, { timeoutMs: 2_000 });
    } catch (cause) {
      throw new MuxLaunchError('launch', 'start remote mux daemon', cause);
    }
    if (result.code === 42) {
      return 'upgrade-required';
    }
    if (result.code !== 0) {
      throw new MuxLaunchError(
        'launch',
        `remote mux daemon did not become ready: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return 'ready';
  }

  private async manifest(): Promise<MuxArtifactManifest> {
    try {
      return await loadMuxArtifactManifest(this.artifactDir());
    } catch (cause) {
      throw new MuxLaunchError('manifest', 'read mux artifact manifest', cause);
    }
  }

  private artifactDir(): string {
    return this.artifacts ?? distDir();
  }

  private async verifyArtifact(path: string, expectedSha256: string): Promise<void> {
    try {
      await verifyMuxArtifact(path, expectedSha256);
    } catch (cause) {
      if (cause instanceof MuxLaunchError) throw cause;
      const detail = cause instanceof Error ? `: ${cause.message}` : '';
      throw new MuxLaunchError('manifest', `verify mux artifact checksum: ${path}${detail}`, cause);
    }
  }

  private async remoteHash(remotePath: string): Promise<string | null> {
    try {
      const result = await this.transport.exec(`"$HOME/${remotePath.slice(2)}" version`, {
        timeoutMs: 5_000,
      });
      return result.code === 0 ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }
  private async detect(): Promise<{ os: string; arch: string }> {
    let result;
    try {
      result = await this.transport.exec('uname -sm');
    } catch (cause) {
      throw new MuxLaunchError('detect', 'detect remote mux platform', cause);
    }
    const [os, arch] = result.stdout.trim().split(/\s+/);
    if (!os || !arch || (result.code !== 0 && result.code !== null))
      throw new MuxLaunchError('detect', 'invalid uname result for mux');
    return { os: platformToken(os), arch: archToken(arch) };
  }
}

function requestWithin<T>(request: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mux ${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    request.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
