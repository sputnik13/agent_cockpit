import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../config', () => ({
  loadSettings: () => ({
    terminalBackend: 'cockpit-mux',
    muxPersistScrollback: true,
    deterministicSessionNames: false,
  }),
}));

import { loadMuxArtifactManifest, selectMuxArtifact, verifyMuxArtifact } from '../muxArtifacts';
import { LocalProvider } from './index';
import { localMuxSocketPath, LocalMuxLauncher, stopLocalMuxOwners } from './mux';
import { MuxClient } from '../remote/muxClient';

const roots: string[] = [];
const paneProcessGroups = new Map<number, Map<number, string>>();
let previousMuxEphemeral: string | undefined;
function socketOwnerPID(socketPath: string): number | undefined {
  if (!existsSync(socketPath)) return undefined;
  try {
    const output = execFileSync('lsof', ['-t', socketPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Number(output.split(/\s+/)[0]);
  } catch {
    return undefined;
  }
}
function recordPaneProcessGroups(daemonPid: number): void {
	const entries = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8' });
	const processes = entries.split('\n').flatMap((line) => {
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
		return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4], command: match[5] }] : [];
	});
	const groups = new Set(processes.filter((entry) => entry.ppid === daemonPid).map((entry) => entry.pgid));
	for (const groupId of groups) {
		if (groupId <= 0) continue;
		const members = new Map<number, string>();
		for (const entry of processes) {
			if (entry.pgid === groupId) members.set(entry.pid, `${entry.started}\n${entry.command}`);
		}
		paneProcessGroups.set(groupId, members);
	}
}
async function eventually(
  assertion: () => void | Promise<void>,
  timeoutMs = 12_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('timed out waiting for mux recovery');
}
beforeEach(() => {
  previousMuxEphemeral = process.env['COCKPIT_MUX_EPHEMERAL'];
  process.env['COCKPIT_MUX_EPHEMERAL'] = '1';
});
afterEach(async () => {
  await stopLocalMuxOwners();
  // The crash-recovery test deliberately SIGKILLs its daemon. Reap the exact
  // PTY groups observed as its children before the OS reparents shell helpers.
	for (const [groupId, members] of paneProcessGroups) {
		const processes = execFileSync('ps', ['-axo', 'pid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8' })
			.split('\n')
			.flatMap((line) => {
				const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
				return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), state: match[3], started: match[4], command: match[5] }] : [];
			});
		const matching = processes.filter((entry) =>
			entry.pgid === groupId && !entry.state.startsWith('Z') &&
			members.get(entry.pid) === `${entry.started}\n${entry.command}`,
		);
		const leader = matching.find((entry) => entry.pid === groupId);
		try {
			if (leader) process.kill(-groupId, 'SIGKILL');
			else for (const entry of matching) process.kill(entry.pid, 'SIGKILL');
		} catch {
			// Exact identities avoid signaling an unrelated process after PGID reuse.
		}
	}
	paneProcessGroups.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (previousMuxEphemeral === undefined) delete process.env['COCKPIT_MUX_EPHEMERAL'];
  else process.env['COCKPIT_MUX_EPHEMERAL'] = previousMuxEphemeral;
});

describe('mux artifact manifest', () => {
  it('uses the newest manifest instead of an unmanifested higher-version filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-local-artifacts-'));
    roots.push(root);
    await writeFile(
      join(root, 'manifest-0.1.9.json'),
      JSON.stringify({
        version: '0.1.9',
        binaries: [
          {
            os: 'darwin',
            arch: 'arm64',
            filename: 'cockpit-mux-0.1.9-darwin-arm64',
            sha256: 'a'.repeat(64),
          },
        ],
      }),
    );
    await writeFile(join(root, 'cockpit-mux-0.1.10-darwin-arm64'), 'unreleased');

    const binary = selectMuxArtifact(await loadMuxArtifactManifest(root), 'darwin', 'arm64');
    expect(binary?.filename).toBe('cockpit-mux-0.1.9-darwin-arm64');
  });

  it('rejects an artifact whose bytes do not match its manifest checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-local-artifacts-'));
    roots.push(root);
    const artifact = join(root, 'cockpit-mux-0.1.9-darwin-arm64');
    await writeFile(artifact, 'corrupted');

    await expect(
      verifyMuxArtifact(artifact, createHash('sha256').update('expected').digest('hex')),
    ).rejects.toThrow(/checksum mismatch/i);
  });
});

describe('LocalMuxLauncher socket liveness', () => {
  it('preserves powerline, private-use, and emoji bytes through the live mux terminal path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-raw-bytes-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    const home = join(root, 'mux');
    process.env['COCKPIT_MUX_HOME'] = home;
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    const provider = new LocalProvider('raw-byte-project', root);
    const received: Uint8Array[] = [];
    const expected = Buffer.from('mux-glyph: ─  🧪');
    try {
      const terminal = await provider.openTerminal({ cols: 80, rows: 24, key: 'raw-byte-glyphs' });
      provider.onTerminalData(terminal.id, (data) => received.push(Buffer.from(data)));
      await provider.writeTerminal(terminal.id, "printf 'mux-glyph: ─  🧪\\n'\n");
      await eventually(() => {
        const all = Buffer.concat(received);
        if (!all.includes(expected)) throw new Error('glyph bytes not observed');
      });
      const socketPath = localMuxSocketPath(home);
      expect(execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' }).trim()).not.toBe('');
    } finally {
      await provider.disconnect();
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
    }
  }, 15_000);

  it('opens concurrent renderer terminals without leaving either provider open pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-concurrent-open-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    const home = join(root, 'mux');
    process.env['COCKPIT_MUX_HOME'] = home;
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    const provider = new LocalProvider('concurrent-open-project', root);
    try {
      const opening = Promise.all(
        ['t1', 't2'].map((key) =>
          provider.openTerminal({ cols: 80, rows: 24, key, hydrateScrollback: true }),
        ),
      );
      // The renderer polls topology while its WTerm instances are registering.
      // Exercise that real IPC shape instead of only two clean open calls.
      const polling = Promise.all(
        Array.from({ length: 20 }, async () => {
          await provider.listMuxTopology();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }),
      );
      const [terminals] = await Promise.all([opening, polling]);
      expect(terminals.map((terminal) => terminal.id).sort()).toEqual(['t1', 't2']);
      await eventually(async () => {
        const topology = await provider.listMuxTopology();
        expect(
          topology.sessions.flatMap((session) => session.windows).flatMap((window) => window.panes),
        ).toHaveLength(2);
      });
      const socketPath = localMuxSocketPath(home);
      expect(execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' }).trim()).not.toBe('');
    } finally {
      await provider.disconnect();
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
    }
  }, 15_000);

  it('surfaces a real daemon crash as reconnecting, restores connected, and reattaches the terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-provider-crash-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    const home = join(root, 'mux');
    process.env['COCKPIT_MUX_HOME'] = home;
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    const provider = new LocalProvider('crash-project', root);
    const states: string[] = [];
    const output: string[] = [];
    const exits: Array<{ code: number | null; signal: string | null }> = [];
    const unsubscribe = provider.onStatusChange((status) => states.push(status.state));
    try {
      const terminal = await provider.openTerminal({ cols: 80, rows: 24, key: 'crash-recovery' });
      provider.onTerminalData(terminal.id, (data) =>
        output.push(data instanceof Uint8Array ? new TextDecoder().decode(data) : data),
      );
      provider.onTerminalExit(terminal.id, (exit) => exits.push(exit));
      const socketPath = localMuxSocketPath(home);
      const [firstPID] = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(firstPID).toBeGreaterThan(0);
      recordPaneProcessGroups(firstPID!);
      output.splice(0);
      process.kill(firstPID!, 'SIGKILL');
      await eventually(() => expect(states).toContain('reconnecting'));
      await eventually(() => expect(provider.status().state).toBe('connected'));
      await eventually(() => expect(exits).toContainEqual({ code: null, signal: 'daemon-crash' }));
      expect(output.join('')).toContain('recovered from a daemon crash');
      await eventually(async () => {
        const sessions = await provider.listMuxSessions();
        expect(sessions).toContainEqual(
          expect.objectContaining({ key: terminal.id, exited: true }),
        );
      });
      const [replacementPID] = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(replacementPID).toBeGreaterThan(0);
      expect(replacementPID).not.toBe(firstPID);
    } finally {
      unsubscribe();
      await provider.disconnect();
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
    }
  }, 15_000);

  it('replaces a SIGKILLed real mux daemon and serves protocol requests again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-crash-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    process.env['COCKPIT_MUX_HOME'] = join(root, 'mux');
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    try {
      const launcher = new LocalMuxLauncher();
      const socketPath = localMuxSocketPath(process.env['COCKPIT_MUX_HOME']);
      const first = await launcher.launch();
      first.stdin.destroy();
      const [firstPID] = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(firstPID).toBeGreaterThan(0);
      process.kill(firstPID!, 'SIGKILL');

      const replacement = await launcher.launch();
      const client = new MuxClient(replacement);
      client.open();
      await expect(client.request('session.list', {})).resolves.toBeDefined();
      client.close();
      const [replacementPID] = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(replacementPID).toBeGreaterThan(0);
      expect(replacementPID).not.toBe(firstPID);
    } finally {
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
    }
  });

  it('keeps the production daemon alive when Electron releases ephemeral owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-production-lifetime-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const previousEphemeral = process.env['COCKPIT_MUX_EPHEMERAL'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    process.env['COCKPIT_MUX_HOME'] = join(root, 'mux');
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    delete process.env['COCKPIT_MUX_EPHEMERAL'];
    const socketPath = localMuxSocketPath(process.env['COCKPIT_MUX_HOME']);
    let daemonPID: number | undefined;
    try {
      const launcher = new LocalMuxLauncher();
      const connection = await launcher.launch();
      connection.stdin.destroy();
      daemonPID = socketOwnerPID(socketPath);
      expect(daemonPID).toBeGreaterThan(0);

      await stopLocalMuxOwners();
      const [remainingPID] = execFileSync('lsof', ['-t', socketPath], { encoding: 'utf8' })
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(remainingPID).toBe(daemonPID);

      const clientConnection = await launcher.launch();
      const client = new MuxClient(clientConnection);
      client.open();
      await expect(client.request('session.list', {})).resolves.toBeDefined();
      client.close();
    } finally {
      // This daemon is intentionally unowned by Electron. Resolve teardown by
      // its unique socket, even if the assertion failed before initial PID
      // discovery, and wait for confirmed socket-owner exit before removing its
      // private home in afterEach.
      const currentOwner = socketOwnerPID(socketPath);
      if (currentOwner && (daemonPID === undefined || currentOwner === daemonPID)) {
        try {
          process.kill(currentOwner, 'SIGTERM');
        } catch {
          // The daemon may have exited after the assertion failed.
        }
        try {
          await eventually(() => expect(socketOwnerPID(socketPath)).toBeUndefined(), 3_000);
        } catch {
          if (socketOwnerPID(socketPath) === currentOwner) {
            try {
              process.kill(currentOwner, 'SIGKILL');
            } catch {
              // A failed readiness assertion may already have exited it.
            }
          }
          await eventually(() => expect(socketOwnerPID(socketPath)).toBeUndefined(), 3_000);
        }
      }
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
      if (previousEphemeral === undefined) delete process.env['COCKPIT_MUX_EPHEMERAL'];
      else process.env['COCKPIT_MUX_EPHEMERAL'] = previousEphemeral;
    }
  });

  it('stops an explicitly ephemeral daemon when its owner pipe is released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-ephemeral-lifetime-'));
    roots.push(root);
    const previousHome = process.env['COCKPIT_MUX_HOME'];
    const previousBinary = process.env['COCKPIT_MUX_BIN'];
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(await loadMuxArtifactManifest(dist), 'darwin', 'arm64');
    if (!artifact) throw new Error(`missing local mux artifact in ${dist}`);
    process.env['COCKPIT_MUX_HOME'] = join(root, 'mux');
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    process.env['COCKPIT_MUX_EPHEMERAL'] = '1';
    const socketPath = localMuxSocketPath(process.env['COCKPIT_MUX_HOME']);
    try {
      const connection = await new LocalMuxLauncher().launch();
      connection.stdin.destroy();
      expect(socketOwnerPID(socketPath)).toBeGreaterThan(0);

      await stopLocalMuxOwners();
      await eventually(() => expect(socketOwnerPID(socketPath)).toBeUndefined());
    } finally {
      const owner = socketOwnerPID(socketPath);
      if (owner) {
        try {
          process.kill(owner, 'SIGTERM');
        } catch {
          // The owner lease may already have stopped it.
        }
        try {
          await eventually(() => expect(socketOwnerPID(socketPath)).toBeUndefined(), 3_000);
        } catch {
          const stillOwner = socketOwnerPID(socketPath);
          if (stillOwner === owner) process.kill(stillOwner, 'SIGKILL');
          await eventually(() => expect(socketOwnerPID(socketPath)).toBeUndefined(), 3_000);
        }
      }
      if (previousHome === undefined) delete process.env['COCKPIT_MUX_HOME'];
      else process.env['COCKPIT_MUX_HOME'] = previousHome;
      if (previousBinary === undefined) delete process.env['COCKPIT_MUX_BIN'];
      else process.env['COCKPIT_MUX_BIN'] = previousBinary;
    }
  });

  it('uses a stable short per-user socket path for an overlong mux home', () => {
    const home = join('/private/var/folders', 'long-home-'.repeat(16));
    const path = localMuxSocketPath(home);

    expect(path).toMatch(/^\/tmp\/acm-\d+\/[a-f0-9]{24}\.sock$/);
    expect(path).toBe(localMuxSocketPath(home));
    expect(path).not.toBe(localMuxSocketPath(`${home}-other`));
  });

  it('recognizes a live Unix socket before treating its path as stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-live-socket-'));
    roots.push(root);
    const socketPath = join(root, 'mux.sock');
    const server = createServer();
    const listening = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') resolve(false);
        else reject(error);
      });
      server.listen(socketPath, () => {
        server.removeAllListeners('error');
        resolve(true);
      });
    });
    // This agent sandbox forbids Unix-socket bind; normal local and CI runs
    // execute the assertion below. The launcher itself is separately exercised
    // against a real daemon outside that sandbox.
    if (!listening) return;
    try {
      const launcher = new LocalMuxLauncher() as unknown as {
        acceptsConnections(socketPath: string): Promise<boolean>;
      };
      await expect(launcher.acceptsConnections(socketPath)).resolves.toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
