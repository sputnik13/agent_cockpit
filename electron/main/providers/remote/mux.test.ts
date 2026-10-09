import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decode, encode } from '@msgpack/msgpack';
import { RemoteMuxLauncher } from './mux';
import type { ProvisionSession, RemoteTransport } from './transportTypes';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifactDir(
  filename = 'cockpit-mux-0.1.0-linux-amd64',
  sourceHash?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cockpit-mux-artifacts-'));
  roots.push(root);
  const artifact = 'mux binary';
  await writeFile(join(root, filename), artifact);
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      ...(sourceHash ? { sourceHash } : {}),
      binaries: [{ os: 'linux', arch: 'amd64', filename, sha256: sha256(artifact) }],
    }),
  );
  return root;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function transport(session: ProvisionSession) {
  const channel = {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  };
  return {
    exec: vi.fn(async (command: string) =>
      command === 'uname -sm'
        ? { stdout: 'Linux x86_64\n', stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 0 },
    ),
    beginProvision: vi.fn(async () => session),
    execStream: vi.fn(async () => channel),
    channel,
  };
}

function replyToMethod(
  channel: ReturnType<typeof transport>['channel'],
  method: string,
  reply: { data?: unknown; error?: string } = {},
): void {
  let buffered = Buffer.alloc(0);
  channel.stdin.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4) {
      const size = buffered.readUInt32BE(0);
      if (buffered.byteLength < size + 4) return;
      const frame = decode(buffered.subarray(4, size + 4)) as { id?: number; method?: string };
      buffered = buffered.subarray(size + 4);
      if (frame.method !== method || frame.id == null) continue;
      const response = encode(
        reply.error ? { id: frame.id, error: reply.error } : { id: frame.id, data: encode(reply.data ?? {}) },
      );
      const output = Buffer.alloc(4 + response.byteLength);
      output.writeUInt32BE(response.byteLength, 0);
      Buffer.from(response).copy(output, 4);
      channel.stdout.write(output);
    }
  });
}

function replyToUpgrade(channel: ReturnType<typeof transport>['channel'], accepted: boolean): void {
  replyToMethod(
    channel,
    'mux.upgrade',
    accepted ? {} : { error: 'incompatible mux handoff engine' },
  );
}

describe('RemoteMuxLauncher', () => {
  it('prefers the newest additive versioned manifest over the legacy manifest', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    const artifacts = await artifactDir();
    const newer = 'cockpit-mux-0.1.1-linux-amd64';
    await writeFile(join(artifacts, newer), 'new mux binary');
    await writeFile(
      join(artifacts, 'manifest-0.1.1.json'),
      JSON.stringify({
        version: '0.1.1',
        sourceHash: 'new-hash',
        binaries: [
          { os: 'linux', arch: 'amd64', filename: newer, sha256: sha256('new mux binary') },
        ],
      }),
    );

    const result = await new RemoteMuxLauncher(
      fake as unknown as RemoteTransport,
      artifacts,
    ).launch();

    expect(result.remotePath).toBe('./.agent-cockpit/cockpit-mux-0.1.1-linux-amd64');
    expect(session.uploadExecutable).toHaveBeenCalledWith(
      join(artifacts, newer),
      result.remotePath,
      0o755,
    );
  });

  it('provisions the matching binary and launches a raw attach bridge', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    const artifacts = await artifactDir();

    const result = await new RemoteMuxLauncher(
      fake as unknown as RemoteTransport,
      artifacts,
    ).launch("/tmp/mux socket's");

    expect(result.remotePath).toBe('./.agent-cockpit/cockpit-mux-0.1.0-linux-amd64');
    expect(session.mkdirp).toHaveBeenCalledWith('./.agent-cockpit');
    expect(session.uploadExecutable).toHaveBeenCalledWith(
      join(artifacts, 'cockpit-mux-0.1.0-linux-amd64'),
      './.agent-cockpit/cockpit-mux-0.1.0-linux-amd64',
      0o755,
    );
    expect(session.end).toHaveBeenCalledOnce();
    expect(fake.exec).toHaveBeenCalledWith(
      expect.stringContaining(
        'ln -s "$HOME/.agent-cockpit/cockpit-mux-0.1.0-linux-amd64" "$HOME/.agent-cockpit/cockpit-mux"',
      ),
      { timeoutMs: 2_000 },
    );
    expect(fake.exec).toHaveBeenCalledWith(
      expect.stringContaining('if test -L "$HOME/.agent-cockpit/cockpit-mux"; then exit 0; fi'),
      { timeoutMs: 2_000 },
    );
    expect(fake.exec).toHaveBeenCalledWith(
      expect.stringContaining('nohup "$HOME/.agent-cockpit/cockpit-mux-0.1.0-linux-amd64"'),
      { timeoutMs: 2_000 },
    );
    expect(fake.execStream).toHaveBeenCalledWith(
      "exec \"$HOME/.agent-cockpit/cockpit-mux-0.1.0-linux-amd64\" bridge --socket '/tmp/mux socket'\\''s'",
    );
    expect(result.channel).toBe(fake.channel);
  });

  it('rejects a manifest filename that could escape the remote mux directory', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    const artifacts = await artifactDir('../cockpit-mux-0.1.0-linux-amd64');

    await expect(
      new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch('/tmp/mux.sock'),
    ).rejects.toThrow(/invalid mux artifact filename/i);
    expect(fake.beginProvision).not.toHaveBeenCalled();
  });

  it('rejects a locally corrupted artifact before opening an SFTP provisioning session', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    const artifacts = await artifactDir();
    await writeFile(join(artifacts, 'cockpit-mux-0.1.0-linux-amd64'), 'corrupted binary');

    await expect(
      new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch('/tmp/mux.sock'),
    ).rejects.toThrow(/checksum mismatch/i);
    expect(fake.beginProvision).not.toHaveBeenCalled();
  });

  it('does not open a raw bridge when the remote daemon fails to become ready', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    fake.exec.mockImplementation(async (command: string) =>
      command === 'uname -sm'
        ? { stdout: 'Linux x86_64\n', stderr: '', code: 0 }
        : command.includes('for attempt')
          ? { stdout: '', stderr: 'socket did not appear', code: 1 }
          : { stdout: '', stderr: '', code: 0 },
    );
    const artifacts = await artifactDir();

    await expect(
      new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch('/tmp/mux.sock'),
    ).rejects.toThrow(/did not become ready/i);
    expect(fake.execStream).not.toHaveBeenCalled();
  });

  it('atomically replaces a stale remote binary when the manifest has a source hash', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => true),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    fake.exec.mockImplementation(async (command: string) => {
      if (command === 'uname -sm') return { stdout: 'Linux x86_64\n', stderr: '', code: 0 };
      if (command.endsWith(' version')) return { stdout: 'old-hash\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const artifacts = await artifactDir('cockpit-mux-0.1.0-linux-amd64', 'new-hash');

    await new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch(
      '/tmp/mux.sock',
    );

    expect(session.uploadExecutable).not.toHaveBeenCalled();
    expect(session.replaceExecutable).toHaveBeenCalledWith(
      join(artifacts, 'cockpit-mux-0.1.0-linux-amd64'),
      './.agent-cockpit/cockpit-mux-0.1.0-linux-amd64',
      0o755,
    );
  });

  it('performs a verified live handoff when a live daemon records a different source hash', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    let upgraded = false;
    replyToUpgrade(fake.channel, true);
    fake.channel.stdin.on('data', (chunk: Buffer) => {
      if (Buffer.from(chunk).includes(Buffer.from('mux.upgrade'))) upgraded = true;
    });
    fake.exec.mockImplementation(async (command: string) => {
      if (command === 'uname -sm') return { stdout: 'Linux x86_64\n', stderr: '', code: 0 };
      if (command.includes('daemon-source-hash'))
        return { stdout: '', stderr: '', code: upgraded ? 0 : 42 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const artifacts = await artifactDir('cockpit-mux-0.1.0-linux-amd64', 'new-hash');

    await new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch();

    expect(upgraded).toBe(true);
    expect(fake.execStream).toHaveBeenCalledWith(
      'exec "$HOME/.agent-cockpit/cockpit-mux-0.1.0-linux-amd64" --home "$HOME/.agent-cockpit/mux" bridge',
    );
  });

  it('restarts an idle stale daemon instead of attempting an impossible live handoff', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    const shutdown = transport(session).channel;
    const bridge = transport(session).channel;
    let idleStopped = false;
    replyToMethod(fake.channel, 'mux.upgrade', { error: 'mux handoff requires at least one live pane' });
    replyToMethod(shutdown, 'mux.shutdown');
    shutdown.stdin.on('data', (chunk: Buffer) => {
      if (Buffer.from(chunk).includes(Buffer.from('mux.shutdown'))) idleStopped = true;
    });
    fake.execStream
      .mockResolvedValueOnce(fake.channel)
      .mockResolvedValueOnce(shutdown)
      .mockResolvedValueOnce(bridge);
    fake.exec.mockImplementation(async (command: string) => {
      if (command === 'uname -sm') return { stdout: 'Linux x86_64\n', stderr: '', code: 0 };
      if (command.includes('daemon-source-hash'))
        return { stdout: '', stderr: '', code: idleStopped ? 0 : 42 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const artifacts = await artifactDir('cockpit-mux-0.1.0-linux-amd64', 'new-hash');

    await new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch();

    expect(idleStopped).toBe(true);
    expect(fake.exec).toHaveBeenCalledWith(
      expect.stringContaining('if test ! -S "$HOME/.agent-cockpit/mux/mux.sock"; then exit 0; fi'),
      { timeoutMs: 2_000 },
    );
  });

  it('surfaces an upgrade failure when live handoff is rejected', async () => {
    const session: ProvisionSession = {
      exists: vi.fn(async () => false),
      mkdirp: vi.fn(async () => {}),
      uploadExecutable: vi.fn(async () => {}),
      replaceExecutable: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const fake = transport(session);
    replyToUpgrade(fake.channel, false);
    fake.exec.mockImplementation(async (command: string) => {
      if (command === 'uname -sm') return { stdout: 'Linux x86_64\n', stderr: '', code: 0 };
      if (command.includes('daemon-source-hash')) return { stdout: '', stderr: '', code: 42 };
      return { stdout: '', stderr: '', code: 0 };
    });
    const artifacts = await artifactDir('cockpit-mux-0.1.0-linux-amd64', 'new-hash');

    await expect(
      new RemoteMuxLauncher(fake as unknown as RemoteTransport, artifacts).launch(),
    ).rejects.toMatchObject({ phase: 'upgrade' });
  });
});
