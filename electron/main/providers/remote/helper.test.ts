/**
 * RemoteHelperLauncher (scenario 13, TS side): the handshake names the project so
 * the helper binds its callback socket, the launched helper keeps what the
 * handshake reported, the remote file is KEYED ON THE BUILD'S SOURCE HASH and is
 * only ever written by upload-beside-then-rename (a helper left running from that
 * path keeps its inode instead of failing the upload, and the final name never
 * holds a partial file), and the `onClient` hook sees the client before the
 * handshake. Fake transport and a fake helper process; no live SSH.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteHelperLauncher, remoteHelperFilename } from './helper';
import { FrameDecoder, encodeFrame } from './rpcClient';
import type { ProvisionSession, RemoteTransport } from './transportTypes';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

const SOURCE_HASH = 'a'.repeat(64);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The remote path a build with SOURCE_HASH is provisioned to. */
const KEYED_PATH = './.agent-cockpit/helper-0.1.0-aaaaaaaaaaaa-linux-amd64';
/** What the pre-hash naming (and a manifest without a hash) uses. */
const UNKEYED_PATH = './.agent-cockpit/helper-0.1.0-linux-amd64';

async function distDir(withSourceHash = true, sourceHash = SOURCE_HASH): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'helper-dist-'));
  roots.push(root);
  const filename = 'helper-0.1.0-linux-amd64';
  await writeFile(join(root, filename), 'helper binary');
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      protocolVersion: 2,
      ...(withSourceHash ? { sourceHash } : {}),
      binaries: [{ os: 'linux', arch: 'amd64', filename, sha256: 'x' }],
    }),
  );
  return root;
}

interface Harness {
  transport: RemoteTransport;
  session: {
    [K in keyof ProvisionSession]: ReturnType<typeof vi.fn>;
  };
  handshakes: Array<Record<string, unknown>>;
  launches: string[];
  /** The stdin of every helper process the launcher started. */
  stdins: PassThrough[];
}

/** A transport whose exec channel hosts a fake helper that answers the handshake. */
function harness(options: {
  remoteExists: boolean;
  remoteHash?: string | null;
  handshakeResult?: Record<string, unknown>;
  /** Pushed on the stream just BEFORE the handshake reply, as the helper does when a
   *  waiting CLI is forwarded while its listener is still being started. */
  eventBeforeReply?: { event: string; data: unknown };
}): Harness {
  const session = {
    exists: vi.fn(async () => options.remoteExists),
    mkdirp: vi.fn(async () => undefined),
    uploadExecutable: vi.fn(async () => undefined),
    replaceExecutable: vi.fn(async () => undefined),
    end: vi.fn(),
  };
  const handshakes: Array<Record<string, unknown>> = [];
  const launches: string[] = [];
  const stdins: PassThrough[] = [];
  const transport = {
    exec: vi.fn(async (command: string) => {
      if (command === 'uname -sm') return { stdout: 'Linux x86_64\n', stderr: '', code: 0 };
      if (command.endsWith(' version')) {
        return options.remoteHash == null
          ? { stdout: '', stderr: 'boom', code: 1 }
          : { stdout: `${options.remoteHash}\n`, stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }),
    beginProvision: vi.fn(async () => session),
    execStream: vi.fn(async (command: string) => {
      launches.push(command);
      const stdin = new PassThrough();
      stdins.push(stdin);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const decoder = new FrameDecoder();
      stdin.on('data', (chunk: Buffer) => {
        for (const msg of decoder.push(chunk)) {
          const req = msg as { id: number; method: string; params: Record<string, unknown> };
          if (req.method === 'handshake') {
            handshakes.push(req.params);
            if (options.eventBeforeReply) stdout.write(encodeFrame(options.eventBeforeReply));
          }
          stdout.write(
            encodeFrame({
              id: req.id,
              result: options.handshakeResult ?? { protocolVersion: 2, pid: 4242 },
              error: null,
            }),
          );
        }
      });
      return { stdin, stdout, stderr };
    }),
  };
  return {
    transport: transport as unknown as RemoteTransport,
    session,
    handshakes,
    launches,
    stdins,
  };
}

describe('handshake and the launched helper', () => {
  it('names the project in the handshake and keeps what the helper reports', async () => {
    const h = harness({
      remoteExists: false,
      handshakeResult: {
        protocolVersion: 2,
        pid: 4242,
        callbackSock: '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock',
        cliPath: '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit',
      },
    });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir(), {
      projectId: 'proj-1',
    }).launch();
    expect(h.handshakes).toEqual([{ protocolVersion: 2, projectId: 'proj-1' }]);
    expect(launched.handshake).toMatchObject({
      pid: 4242,
      callbackSock: '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock',
      cliPath: '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit',
    });
    expect(launched.client.isClosed).toBe(false);
    launched.channel.close();
  });

  it('sends no project id when none was given, so the helper starts no listener', async () => {
    const h = harness({ remoteExists: false });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.handshakes).toEqual([{ protocolVersion: 2 }]);
    expect(launched.handshake.callbackSock).toBeUndefined();
    launched.channel.close();
  });

  it('launches the helper from its home-relative path', async () => {
    const h = harness({ remoteExists: false });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.launches).toEqual([
      'exec "$HOME/.agent-cockpit/helper-0.1.0-aaaaaaaaaaaa-linux-amd64"',
    ]);
    launched.channel.close();
  });

  it('re-provisions and relaunches once on a protocol mismatch, then fails with a handshake error', async () => {
    const h = harness({
      remoteExists: true,
      remoteHash: SOURCE_HASH,
      handshakeResult: { protocolVersion: 1, pid: 1 },
    });
    await expect(
      new RemoteHelperLauncher(h.transport, await distDir(), { projectId: 'p' }).launch(),
    ).rejects.toMatchObject({ name: 'HelperLaunchError', phase: 'handshake' });
    expect(h.launches).toHaveLength(2);
    expect(h.handshakes).toHaveLength(2);
  });
});

describe('provisioning', () => {
  it('uploads a binary that is absent ATOMICALLY too: the final name never holds a partial file', async () => {
    const h = harness({ remoteExists: false });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.session.mkdirp).toHaveBeenCalledWith('./.agent-cockpit');
    expect(h.session.replaceExecutable.mock.calls).toEqual([
      [expect.stringMatching(/helper-0\.1\.0-linux-amd64$/), KEYED_PATH, 0o755],
    ]);
    // A direct upload to the final name is what a dropped connection leaves truncated.
    expect(h.session.uploadExecutable).not.toHaveBeenCalled();
    launched.channel.close();
  });

  it('leaves an up-to-date binary alone', async () => {
    const h = harness({ remoteExists: true, remoteHash: SOURCE_HASH });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.session.uploadExecutable).not.toHaveBeenCalled();
    expect(h.session.replaceExecutable).not.toHaveBeenCalled();
    launched.channel.close();
  });

  it.each([
    ['a different build', 'b'.repeat(64)],
    ['a binary that cannot report its version', null],
  ])('replaces %s ATOMICALLY, never overwriting in place', async (_name, remoteHash) => {
    const h = harness({ remoteExists: true, remoteHash });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.session.replaceExecutable).toHaveBeenCalledTimes(1);
    expect(h.session.replaceExecutable.mock.calls[0]).toEqual([
      expect.stringMatching(/helper-0\.1\.0-linux-amd64$/),
      KEYED_PATH,
      0o755,
    ]);
    // An in-place overwrite of a binary some helper is running from fails with
    // "text file busy"; upload-beside-then-rename does not.
    expect(h.session.uploadExecutable).not.toHaveBeenCalled();
    launched.channel.close();
  });

  it('keeps the legacy existence-only check for a manifest without a source hash', async () => {
    const h = harness({ remoteExists: true, remoteHash: 'whatever' });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir(false)).launch();
    expect(h.session.uploadExecutable).not.toHaveBeenCalled();
    expect(h.session.replaceExecutable).not.toHaveBeenCalled();
    // ...and keeps the unkeyed name there is nothing to key it on.
    expect(h.session.exists).toHaveBeenCalledWith(UNKEYED_PATH);
    expect(h.launches).toEqual([`exec "$HOME/${UNKEYED_PATH.slice(2)}"`]);
    launched.channel.close();
  });
});

describe('the remote file is keyed on the build', () => {
  it('names the file by version, source-hash prefix, os and arch', async () => {
    const h = harness({ remoteExists: false });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(launched.remotePath).toBe(KEYED_PATH);
    expect(h.session.exists).toHaveBeenCalledWith(KEYED_PATH);
    launched.channel.close();
  });

  it('gives two builds two files, so neither build can overwrite the other', async () => {
    const first = harness({ remoteExists: false });
    const second = harness({ remoteExists: false });
    const a = await new RemoteHelperLauncher(
      first.transport,
      await distDir(true, 'a'.repeat(64)),
    ).launch();
    const b = await new RemoteHelperLauncher(
      second.transport,
      await distDir(true, 'b'.repeat(64)),
    ).launch();
    expect(a.remotePath).toBe('./.agent-cockpit/helper-0.1.0-aaaaaaaaaaaa-linux-amd64');
    expect(b.remotePath).toBe('./.agent-cockpit/helper-0.1.0-bbbbbbbbbbbb-linux-amd64');
    expect(a.remotePath).not.toBe(b.remotePath);
    // Each build writes only its own file.
    expect(first.session.replaceExecutable.mock.calls.map((c) => c[1])).toEqual([a.remotePath]);
    expect(second.session.replaceExecutable.mock.calls.map((c) => c[1])).toEqual([b.remotePath]);
    a.channel.close();
    b.channel.close();
  });

  it('a build that finds ANOTHER build already on the host leaves it alone and uses its own file', async () => {
    // The other build lives at its own keyed name; this build's name is absent.
    const h = harness({ remoteExists: false });
    h.session.exists.mockImplementation(
      async (path: string) => path === './.agent-cockpit/helper-0.1.0-bbbbbbbbbbbb-linux-amd64',
    );
    const launched = await new RemoteHelperLauncher(h.transport, await distDir()).launch();
    expect(h.session.replaceExecutable.mock.calls.map((c) => c[1])).toEqual([KEYED_PATH]);
    expect(h.session.replaceExecutable.mock.calls.map((c) => c[1])).not.toContain(
      './.agent-cockpit/helper-0.1.0-bbbbbbbbbbbb-linux-amd64',
    );
    launched.channel.close();
  });

  describe('remoteHelperFilename', () => {
    const binary = { os: 'darwin', arch: 'arm64', filename: 'helper-0.1.0-darwin-arm64' };
    it('keys on the first 12 hex characters of the source hash', () => {
      expect(
        remoteHelperFilename(
          { version: '0.1.0', sourceHash: '0123456789abcdef'.repeat(4) },
          binary,
        ),
      ).toBe('helper-0.1.0-0123456789ab-darwin-arm64');
    });
    it.each([
      ['absent', undefined],
      ['empty', ''],
      ['too short', 'abc123'],
      ['not hex', 'z'.repeat(64)],
      ['upper case', 'A'.repeat(64)],
      ['shell metacharacters', '"; rm -rf ~; "'],
    ])('keeps the manifest name for a source hash that is %s', (_label, sourceHash) => {
      expect(remoteHelperFilename({ version: '0.1.0', sourceHash }, binary)).toBe(binary.filename);
    });
  });
});

describe('onClient (before the handshake)', () => {
  it('runs before the handshake is sent and sees an event pushed ahead of the handshake reply', async () => {
    const event = { event: 'callback', data: { connId: 7, request: { v: 1, id: 1, op: 'open' } } };
    const h = harness({ remoteExists: false, eventBeforeReply: event });
    const handshakesAtHook: number[] = [];
    const seen: unknown[] = [];
    const launched = await new RemoteHelperLauncher(h.transport, await distDir(), {
      projectId: 'p',
      onClient: (client) => {
        handshakesAtHook.push(h.handshakes.length);
        client.onEvent('callback', (data) => seen.push(data));
      },
    }).launch();
    expect(handshakesAtHook).toEqual([0]);
    expect(seen).toEqual([event.data]);

    // The control that shows why the hook exists: a handler registered once launch()
    // has returned is too late for an event the handshake overtook.
    const late: unknown[] = [];
    launched.client.onEvent('callback', (data) => late.push(data));
    expect(late).toEqual([]);
    launched.channel.close();
  });

  it('is called with a new client for each launch attempt', async () => {
    const h = harness({
      remoteExists: true,
      remoteHash: SOURCE_HASH,
      handshakeResult: { protocolVersion: 1, pid: 1 },
    });
    const clients: unknown[] = [];
    await expect(
      new RemoteHelperLauncher(h.transport, await distDir(), {
        projectId: 'p',
        onClient: (client) => clients.push(client),
      }).launch(),
    ).rejects.toMatchObject({ phase: 'handshake' });
    expect(clients).toHaveLength(2);
    expect(clients[0]).not.toBe(clients[1]);
  });

  it('fails the launch without a handshake, and ends the helper channel, when the hook throws', async () => {
    const h = harness({ remoteExists: false });
    await expect(
      new RemoteHelperLauncher(h.transport, await distDir(), {
        projectId: 'p',
        onClient: () => {
          throw new Error('no bridge');
        },
      }).launch(),
    ).rejects.toMatchObject({
      name: 'HelperLaunchError',
      phase: 'launch',
      message: expect.stringContaining('no bridge'),
    });
    expect(h.handshakes).toEqual([]);
    expect(h.launches).toHaveLength(1); // not retried: only a handshake failure re-provisions
    expect(h.stdins[0]!.writableEnded).toBe(true);
  });

  it('is optional', async () => {
    const h = harness({ remoteExists: false });
    const launched = await new RemoteHelperLauncher(h.transport, await distDir(), {
      projectId: 'p',
    }).launch();
    expect(launched.handshake.protocolVersion).toBe(2);
    launched.channel.close();
  });
});
