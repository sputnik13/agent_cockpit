import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join, resolve as pathResolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { app } from 'electron';
import {
  isMuxArtifactFilename,
  loadMuxArtifactManifest,
  selectMuxArtifact,
  verifyMuxArtifact,
} from '../muxArtifacts';
import type { DuplexChannel } from '../remote/transportTypes';
import { MuxClient } from '../remote/muxClient';

const execFile = promisify(execFileCallback);
const UPGRADE_TIMEOUT_MS = 12_000;
const MAX_HOME_SOCKET_PATH = 90;
const ownerLeases = new Map<string, { child: ChildProcess; release: () => void }>();
const ownerStarts = new Map<string, Promise<void>>();

/** Release explicitly ephemeral mux daemons started by this Electron process. */
export async function stopLocalMuxOwners(): Promise<void> {
  await Promise.allSettled([...ownerStarts.values()]);
  const leases = [...ownerLeases.values()];
  ownerLeases.clear();
  for (const lease of leases) lease.release();
  await Promise.all(
    leases.map(
      (lease) =>
        new Promise<void>((resolve) => {
          if (lease.child.exitCode !== null || lease.child.signalCode !== null) {
            resolve();
            return;
          }
          const done = (): void => {
            clearTimeout(timeout);
            lease.child.removeListener('exit', done);
            resolve();
          };
          const timeout = setTimeout(() => {
            lease.child.kill('SIGTERM');
            setTimeout(() => lease.child.kill('SIGKILL'), 1_500).unref();
          }, 2_000);
          lease.child.once('exit', done);
        }),
    ),
  );
}

/** Keep this byte-for-byte compatible with daemon.SocketPath. */
export function localMuxSocketPath(home: string): string {
  const resolvedHome = pathResolve(home);
  const ordinary = join(resolvedHome, 'mux.sock');
  if (ordinary.length <= MAX_HOME_SOCKET_PATH) return ordinary;
  const uid = process.getuid?.() ?? 0;
  const hash = createHash('sha256').update(resolvedHome).digest('hex').slice(0, 24);
  return join('/tmp', `acm-${uid}`, `${hash}.sock`);
}

function distDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'cockpit-mux', 'dist')
    : pathResolve(__dirname, '..', '..', 'cockpit-mux', 'dist');
}

async function localBinary(): Promise<string> {
  const dir = distDir();
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const binary = selectMuxArtifact(await loadMuxArtifactManifest(dir), os, arch);
  if (!binary || !isMuxArtifactFilename(binary.filename)) {
    throw new Error(`no valid local cockpit-mux artifact for ${os}-${arch}`);
  }
  const path = join(dir, binary.filename);
  await verifyMuxArtifact(path, binary.sha256);
  return path;
}

/** Starts the local daemon only when needed and returns its raw Unix-socket bridge. */
export class LocalMuxLauncher {
  async launch(): Promise<DuplexChannel> {
    const home = pathResolve(
      process.env['COCKPIT_MUX_HOME'] ?? join(app.getPath('userData'), 'mux'),
    );
    const socketPath = localMuxSocketPath(home);
    const binary = process.env['COCKPIT_MUX_BIN'] ?? (await localBinary());
    await access(binary);
    const sourceHash = await muxSourceHash(binary);
    let starting = ownerStarts.get(home);
    if (!starting) {
      starting = this.ensureDaemon(home, socketPath, binary, sourceHash);
      ownerStarts.set(home, starting);
      const clearStarting = (): void => {
        if (ownerStarts.get(home) === starting) ownerStarts.delete(home);
      };
      void starting.then(clearStarting, clearStarting);
    }
    await starting;
    const socket = await connectSocket(socketPath);
    const stderr = new PassThrough();
    stderr.end();
    return { stdin: socket, stdout: socket, stderr };
  }

  private async ensureDaemon(
    home: string,
    socketPath: string,
    binary: string,
    sourceHash: string,
  ): Promise<void> {
    let socketExists = await this.isSocket(socketPath);
    if (socketExists && !(await this.acceptsConnections(socketPath))) {
      // A daemon killed without its shutdown path leaves the private endpoint
      // behind. It has already been verified as a socket for this mux home, so
      // removing that stale endpoint is safe; spawn below restores service.
      await unlink(socketPath);
      socketExists = false;
    }
    if (!socketExists) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      const logPath = join(home, 'mux.log');
      const logFile = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
      const ephemeral = process.env['COCKPIT_MUX_EPHEMERAL'] === '1';
      let spawnError: Error | null = null;
      let child: ChildProcess | undefined;
      try {
        child = spawn(binary, ['--home', home, ...(ephemeral ? ['--owner-fd=3'] : [])], {
          detached: true,
          stdio: ephemeral ? ['ignore', logFile, logFile, 'pipe'] : ['ignore', logFile, logFile],
        });
        child.once('error', (error) => {
          spawnError = error;
        });
        if (ephemeral) {
          const owner = child.stdio[3];
          if (!owner || !('end' in owner)) {
            child.kill('SIGTERM');
            throw new Error('local cockpit-mux owner pipe was not created');
          }
          ownerLeases.set(home, {
            child,
            release: () => {
              owner.end();
            },
          });
        } else {
          // Production sessions belong to the mux home, not the Electron
          // process lifetime. The daemon must survive app quit/relaunch.
          child.unref();
        }
      } finally {
        closeSync(logFile);
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (await this.isSocket(socketPath)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await this.isSocket(socketPath))) {
        ownerLeases.get(home)?.release();
        ownerLeases.delete(home);
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
              child?.kill('SIGKILL');
              resolve();
            }, 1_500);
            child?.once('exit', () => {
              clearTimeout(timeout);
              resolve();
            });
          });
        }
        const startupFailure = (): Error | null => spawnError;
        if (startupFailure())
          throw new Error(`failed to start local cockpit-mux daemon: ${startupFailure()?.message}`);
        throw new Error(`local cockpit-mux daemon did not become ready; inspect ${logPath}`);
      }
    } else if ((await recordedMuxHash(home)) !== sourceHash) {
      await this.upgrade(socketPath, binary, sourceHash);
    }
  }

  private async upgrade(socketPath: string, binaryPath: string, sourceHash: string): Promise<void> {
    const socket = await connectSocket(socketPath);
    const stderr = new PassThrough();
    stderr.end();
    const client = new MuxClient({ stdin: socket, stdout: socket, stderr });
    client.open();
    try {
      await requestWithin(
        client.request('mux.upgrade', { binary_path: binaryPath, source_hash: sourceHash }),
        UPGRADE_TIMEOUT_MS,
        'live handoff',
      );
    } finally {
      client.close();
    }
  }

  private async isSocket(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isSocket();
    } catch {
      return false;
    }
  }

  private async acceptsConnections(socketPath: string): Promise<boolean> {
    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
      return true;
    } catch {
      return false;
    }
  }
}

async function muxSourceHash(binary: string): Promise<string> {
  const { stdout } = await execFile(binary, ['version'], { timeout: 5_000 });
  const sourceHash = stdout.trim();
  if (!sourceHash) throw new Error(`local cockpit-mux did not report a source hash: ${binary}`);
  return sourceHash;
}

async function recordedMuxHash(home: string): Promise<string | null> {
  try {
    return (await readFile(join(home, 'daemon-source-hash'), 'utf8')).trim() || null;
  } catch {
    return null;
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

async function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const connection = new Socket();
    connection.once('error', reject);
    connection.connect(socketPath, () => {
      connection.removeListener('error', reject);
      resolve(connection);
    });
  });
}
