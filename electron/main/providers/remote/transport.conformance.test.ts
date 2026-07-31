/**
 * Ssh2Transport interface-conformance tests with ssh2 stubbed via the protected
 * `createClient()` seam — no live SSH host. Asserts:
 *   - connect builds the expected config for privateKey and for agent fallback,
 *     and errors when neither is available (FR7);
 *   - the installed hostVerifier rejects a mismatched key with phase 'hostkey'
 *     and accepts an unknown host under TOFU (FR8);
 *   - exec captures stdout/stderr separately, returns code (null on signal),
 *     never rejects on non-zero, rejects when not connected (OQ-3);
 *   - openPty uses xterm-256color + modes {ECHO:0,ISIG:0}; openShell defaults
 *     to xterm-256color; resize maps to setWindow rows-first;
 *   - execStream/openPty/openShell deliver raw bytes — a >0x7E powerline
 *     sequence (0xE2 0x96 0x88) survives unmodified end to end (FR4).
 */
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_BYTES_CAP } from '@shared/providers/fileBytesCap';
import type { RemoteConnectionSpec } from '../types';
import { Ssh2Transport } from './transport';
import { RemoteTransportError } from './transportTypes';
import { readFileBytesOverTransport } from './index';

/** A fake ssh2 exec/shell channel: an EventEmitter with write/close/setWindow + stderr. */
class FakeChannel extends EventEmitter {
  written: Array<string | Uint8Array> = [];
  closed = false;
  setWindowArgs: number[] | null = null;
  readonly stderr = new EventEmitter();
  write(data: string | Uint8Array): boolean {
    this.written.push(data);
    return true;
  }
  close(): void {
    this.closed = true;
  }
  end(): void {
    this.closed = true;
  }
  setWindow(rows: number, cols: number, height: number, width: number): void {
    this.setWindowArgs = [rows, cols, height, width];
  }
}

interface ExecCall {
  command: string;
  opts: Record<string, unknown> | null;
  channel: FakeChannel;
}

/** A fake ssh2 SFTP read stream — a REAL Readable so the transport's
 *  `.once('close', ...)` / `.once('error', ...)` wiring behaves exactly as it
 *  would against a genuine ssh2 ReadStream. `failImmediately` simulates a
 *  mid-read failure (emits 'error' instead of ever pushing data). */
class FakeSftpReadStream extends Readable {
  private sent = false;
  constructor(
    private readonly chunk: Buffer,
    private readonly failImmediately: boolean,
  ) {
    super();
  }
  override _read(): void {
    if (this.failImmediately) {
      queueMicrotask(() => this.emit('error', new Error('simulated SFTP read failure')));
      return;
    }
    if (!this.sent) {
      this.sent = true;
      this.push(this.chunk);
      return;
    }
    this.push(null);
  }
}

/** Structural stand-in for ssh2's `Stats` (only the members `Ssh2Transport.stat`
 *  actually reads). Deliberately NOT `import('ssh2').Stats` — this test stays
 *  off the single-ssh2-import-site invariant just like every other file. */
interface FakeStats {
  size: number;
  mtime: number;
  isDirectory(): boolean;
}

/** A fake ssh2 `SFTPWrapper`: `stat`/`createReadStream` over a canned buffer,
 *  plus an `end()` call counter so tests can assert the D2 channel-per-call
 *  lifecycle (opened fresh per operation, released exactly once). */
class FakeSftp {
  endCallCount = 0;
  /** Options passed to the most recent createReadStream() call on this
   *  session — lets a test assert NO range was requested. */
  lastReadStreamOpts: { start?: number; end?: number } | undefined;
  constructor(
    private readonly data: Buffer,
    private readonly missing: boolean,
    private readonly streamFails: boolean,
  ) {}

  stat(path: string, cb: (err: Error | undefined, stats?: FakeStats) => void): void {
    queueMicrotask(() => {
      if (this.missing) {
        cb(new Error(`no such file: ${path}`));
        return;
      }
      cb(undefined, {
        size: this.data.length,
        mtime: 1_700_000_000, // seconds since epoch (ssh2 convention)
        isDirectory: () => false,
      });
    });
  }

  createReadStream(_path: string, opts?: { start?: number; end?: number }): FakeSftpReadStream {
    this.lastReadStreamOpts = opts;
    const start = opts?.start ?? 0;
    const end = opts?.end ?? this.data.length - 1;
    return new FakeSftpReadStream(this.data.subarray(start, end + 1), this.streamFails);
  }

  end(): void {
    this.endCallCount += 1;
  }
}

/** A fake ssh2 Client. Records connect config and exec/shell calls. */
class FakeClient extends EventEmitter {
  connectConfig: Record<string, unknown> | null = null;
  execCalls: ExecCall[] = [];
  shellCalls: Array<{ opts: Record<string, unknown>; channel: FakeChannel }> = [];
  /** When set, the next connect runs the hostVerifier with this key then proceeds. */
  presentHostKey: Buffer | null = null;
  /** Every FakeSftp session opened via sftp() (D2: one per call). */
  sftpInstances: FakeSftp[] = [];
  /** Data served by the NEXT sftp() session's stat/createReadStream. Consumed
   *  (not reset) across calls within a test unless overwritten, so a test that
   *  issues several reads sets it before each call it cares about. */
  nextSftpData: Buffer = Buffer.alloc(0);
  /** One-shot: the next sftp() session's stat() reports the path missing. */
  nextSftpMissing = false;
  /** One-shot: the next sftp() session's createReadStream() fails on read. */
  nextSftpStreamFails = false;
  /** STICKY (not one-shot): when true, EVERY subsequently-opened FakeSftp's
   *  createReadStream() fails on read — not just the next one. Needed because
   *  a readFileBytesOverTransport read opens a stat session first, which would
   *  otherwise consume the one-shot `nextSftpStreamFails` before the stream
   *  session ever opens. Additive: default false preserves every existing
   *  test's behavior (only the one-shot flag applies). */
  allSftpStreamsFail = false;
  /** One-shot: the next sftp() call itself fails to open the SFTP channel. */
  failNextSftpOpen: Error | null = null;

  sftp(cb: (err: Error | undefined, sftp: FakeSftp) => void): void {
    if (this.failNextSftpOpen) {
      const err = this.failNextSftpOpen;
      this.failNextSftpOpen = null;
      queueMicrotask(() => cb(err, undefined as unknown as FakeSftp));
      return;
    }
    const inst = new FakeSftp(
      this.nextSftpData,
      this.nextSftpMissing,
      this.allSftpStreamsFail || this.nextSftpStreamFails,
    );
    this.nextSftpMissing = false;
    this.nextSftpStreamFails = false;
    this.sftpInstances.push(inst);
    queueMicrotask(() => cb(undefined, inst));
  }

  connect(config: Record<string, unknown>): void {
    this.connectConfig = config;
    // Drive host verification if a key is staged, mirroring ssh2's flow.
    const verifier = config['hostVerifier'] as
      | ((key: Buffer, verify: (ok: boolean) => void) => void)
      | undefined;
    queueMicrotask(() => {
      if (verifier && this.presentHostKey) {
        verifier(this.presentHostKey, (ok: boolean) => {
          if (!ok) {
            this.emit('error', new Error('Host key verification failed'));
            return;
          }
          this.emit('ready');
        });
        return;
      }
      this.emit('ready');
    });
  }

  exec(
    command: string,
    optsOrCb: Record<string, unknown> | ((err: Error | undefined, ch: FakeChannel) => void),
    maybeCb?: (err: Error | undefined, ch: FakeChannel) => void,
  ): void {
    const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb)!;
    const channel = new FakeChannel();
    this.execCalls.push({ command, opts, channel });
    queueMicrotask(() => cb(undefined, channel));
  }

  shell(
    opts: Record<string, unknown>,
    cb: (err: Error | undefined, ch: FakeChannel) => void,
  ): void {
    const channel = new FakeChannel();
    this.shellCalls.push({ opts, channel });
    queueMicrotask(() => cb(undefined, channel));
  }

  end(): void {
    this.emit('close');
  }
}

/** Subclass exposing the fake client through the protected createClient() seam. */
class TestTransport extends Ssh2Transport {
  readonly fake = new FakeClient();
  protected override createClient(): never {
    return this.fake as never;
  }
}

const SPEC: RemoteConnectionSpec = {
  kind: 'remote',
  host: 'host.invalid',
  user: 'deploy',
  port: 2222,
  remotePath: '/srv/repo',
};

/** Encode an SSH `string` field: 4-byte big-endian length prefix + bytes. */
function sshString(buf: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(buf.length, 0);
  return Buffer.concat([header, buf]);
}

/**
 * Generate a fresh ed25519 key and return both its raw SSH wire form (the bytes
 * ssh2 hands the hostVerifier) and the `known_hosts` line form. Built with
 * node:crypto so this test does not import `ssh2` (encapsulation invariant —
 * ssh2 is imported by exactly one file).
 */
function makeKey(): { wire: Buffer; sshLine: string } {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  // ed25519 SPKI ends with the 32-byte raw public key.
  const raw = der.subarray(der.length - 32);
  const wire = Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(raw)]);
  const sshLine = `ssh-ed25519 ${wire.toString('base64')}`;
  return { wire, sshLine };
}

/**
 * A real, unencrypted private key in PKCS#1 PEM form (`BEGIN RSA PRIVATE KEY`),
 * which ssh2's `parseKey` accepts. The transport now gates `privateKey` on
 * `parseKey` succeeding (so a passphrase-protected key falls back to the agent),
 * so identity-file fixtures must contain a genuinely parseable key. Generated
 * with node:crypto to honor the single-`ssh2`-import invariant. Generated once —
 * RSA keygen is the slow part.
 */
const USABLE_KEY_PEM: string = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
}).privateKey;

let tmp: string;
let prevAuthSock: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kh-'));
  prevAuthSock = process.env.SSH_AUTH_SOCK;
  prevHome = process.env.HOME;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (prevAuthSock === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = prevAuthSock;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
});

/**
 * Point `~/.ssh/config` at a fixture under `tmp` (via HOME) so the transport's
 * `resolveSshConfig(spec.host)` reads our alias block. Returns the home dir.
 */
function writeSshConfig(contents: string): string {
  const home = join(tmp, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'config'), contents);
  process.env.HOME = home;
  return home;
}

/** Build a transport whose hostKeyPolicy points at an empty known_hosts (TOFU). */
function tofuPolicy() {
  const path = join(tmp, 'known_hosts_empty');
  writeFileSync(path, '');
  return { knownHostsPath: path, tofu: true };
}

describe('Ssh2Transport conformance (ssh2 stubbed via createClient)', () => {
  it('connect builds config with privateKey when identityPath is set (FR7)', async () => {
    delete process.env.SSH_AUTH_SOCK; // assert the pure-privateKey path (no co-fallback)
    const keyPath = join(tmp, 'id');
    writeFileSync(keyPath, USABLE_KEY_PEM);
    const t = new TestTransport();
    await t.connect({ ...SPEC, identityPath: keyPath }, { hostKeyPolicy: tofuPolicy() });
    expect(t.fake.connectConfig?.['username']).toBe('deploy');
    expect(t.fake.connectConfig?.['port']).toBe(2222);
    expect(Buffer.isBuffer(t.fake.connectConfig?.['privateKey'])).toBe(true);
    expect(t.fake.connectConfig?.['agent']).toBeUndefined();
  });

  it('connect offers the agent alongside a usable identity key when both exist (FR7)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const keyPath = join(tmp, 'id_both');
    writeFileSync(keyPath, USABLE_KEY_PEM);
    const t = new TestTransport();
    await t.connect({ ...SPEC, identityPath: keyPath }, { hostKeyPolicy: tofuPolicy() });
    expect(Buffer.isBuffer(t.fake.connectConfig?.['privateKey'])).toBe(true);
    expect(t.fake.connectConfig?.['agent']).toBe('/tmp/agent.sock');
  });

  it('connect falls back to the agent when the identity key is unparseable (passphrase-protected)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const keyPath = join(tmp, 'id_encrypted');
    // Not a parseable key (stands in for an encrypted key with no passphrase).
    writeFileSync(keyPath, 'KEY-MATERIAL');
    const t = new TestTransport();
    await t.connect({ ...SPEC, identityPath: keyPath }, { hostKeyPolicy: tofuPolicy() });
    expect(t.fake.connectConfig?.['privateKey']).toBeUndefined();
    expect(t.fake.connectConfig?.['agent']).toBe('/tmp/agent.sock');
  });

  it('connect errors phase "identity" when the key is unparseable and no agent is available', async () => {
    delete process.env.SSH_AUTH_SOCK;
    const keyPath = join(tmp, 'id_encrypted_noagent');
    writeFileSync(keyPath, 'KEY-MATERIAL');
    const t = new TestTransport();
    await expect(
      t.connect({ ...SPEC, identityPath: keyPath }, { hostKeyPolicy: tofuPolicy() }),
    ).rejects.toMatchObject({ phase: 'identity' });
    expect(t.state()).toBe('failed');
  });

  it('connect falls back to the agent when no identity is set (FR7)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const t = new TestTransport();
    await t.connect(SPEC, { hostKeyPolicy: tofuPolicy() });
    expect(t.fake.connectConfig?.['agent']).toBe('/tmp/agent.sock');
    expect(t.fake.connectConfig?.['privateKey']).toBeUndefined();
  });

  it('connect errors when neither identity nor agent is available (FR7)', async () => {
    delete process.env.SSH_AUTH_SOCK;
    const t = new TestTransport();
    await expect(t.connect(SPEC, { hostKeyPolicy: tofuPolicy() })).rejects.toMatchObject({
      phase: 'auth',
    });
    expect(t.state()).toBe('failed');
  });

  it('hostVerifier rejects a mismatched known_hosts key with phase "hostkey" (FR8)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const recorded = makeKey();
    const presented = makeKey();
    const khPath = join(tmp, 'known_hosts');
    // Record a DIFFERENT key for this host:port — presenting `presented` must reject.
    writeFileSync(khPath, `[${SPEC.host}]:${SPEC.port} ${recorded.sshLine}\n`);
    const t = new TestTransport();
    t.fake.presentHostKey = presented.wire;
    await expect(
      t.connect(SPEC, { hostKeyPolicy: { knownHostsPath: khPath, tofu: true } }),
    ).rejects.toMatchObject({ phase: 'hostkey' });
    expect(t.state()).toBe('failed');
  });

  it('hostVerifier accepts a matching known_hosts key (FR8)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const recorded = makeKey();
    const khPath = join(tmp, 'known_hosts');
    writeFileSync(khPath, `[${SPEC.host}]:${SPEC.port} ${recorded.sshLine}\n`);
    const t = new TestTransport();
    t.fake.presentHostKey = recorded.wire;
    await t.connect(SPEC, { hostKeyPolicy: { knownHostsPath: khPath, tofu: false } });
    expect(t.state()).toBe('connected');
  });

  it('hostVerifier accepts an unknown host under TOFU (FR8)', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    const t = new TestTransport();
    t.fake.presentHostKey = makeKey().wire;
    await t.connect(SPEC, { hostKeyPolicy: tofuPolicy() });
    expect(t.state()).toBe('connected');
  });

  describe('connected operations', () => {
    let t: TestTransport;
    beforeEach(async () => {
      process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
      t = new TestTransport();
      await t.connect(SPEC, { hostKeyPolicy: tofuPolicy() });
    });

    it('exec captures stdout/stderr separately and returns the exit code (OQ-3)', async () => {
      const p = t.exec('whoami');
      await Promise.resolve();
      const call = t.fake.execCalls.at(-1)!;
      call.channel.emit('data', Buffer.from('out-bytes'));
      call.channel.stderr.emit('data', Buffer.from('err-bytes'));
      call.channel.emit('close', 0);
      const res = await p;
      expect(res).toEqual({ stdout: 'out-bytes', stderr: 'err-bytes', code: 0 });
    });

    it('exec never rejects on a non-zero exit (OQ-3)', async () => {
      const p = t.exec('false');
      await Promise.resolve();
      const call = t.fake.execCalls.at(-1)!;
      call.channel.emit('close', 3);
      await expect(p).resolves.toMatchObject({ code: 3 });
    });

    it('exec returns code null on signal death (OQ-3)', async () => {
      const p = t.exec('killed');
      await Promise.resolve();
      const call = t.fake.execCalls.at(-1)!;
      call.channel.emit('close', null);
      await expect(p).resolves.toMatchObject({ code: null });
    });

    it('openPty uses xterm-256color + modes {ECHO:0,ISIG:0}', async () => {
      await t.openPty('tmux -CC', { cols: 220, rows: 50 });
      const call = t.fake.execCalls.at(-1)!;
      const pty = call.opts?.['pty'] as Record<string, unknown>;
      expect(pty['term']).toBe('xterm-256color');
      expect(pty['modes']).toEqual({ ECHO: 0, ISIG: 0 });
      expect(pty['cols']).toBe(220);
      expect(pty['rows']).toBe(50);
    });

    it('openShell defaults term to xterm-256color and resize maps to rows-first setWindow', async () => {
      const ch = await t.openShell({ cols: 80, rows: 24 });
      expect(t.fake.shellCalls.at(-1)!.opts['term']).toBe('xterm-256color');
      ch.resize(120, 40);
      expect(t.fake.shellCalls.at(-1)!.channel.setWindowArgs).toEqual([40, 120, 0, 0]);
    });

    it('execStream delivers raw >0x7E bytes undecoded (FR4)', async () => {
      const dup = await t.execStream('exec helper');
      const call = t.fake.execCalls.at(-1)!;
      const received: Buffer[] = [];
      dup.stdout.on('data', (b: Buffer) => received.push(b));
      const powerline = Buffer.from([0xe2, 0x96, 0x88]); // U+2588 full block
      call.channel.emit('data', powerline);
      await Promise.resolve();
      expect(Buffer.concat(received).equals(powerline)).toBe(true);
    });

    it('execStream exposes stderr and delivers its raw bytes undecoded', async () => {
      const dup = await t.execStream('exec helper');
      const call = t.fake.execCalls.at(-1)!;
      const received: Buffer[] = [];
      dup.stderr.on('data', (b: Buffer) => received.push(b));
      const err = Buffer.from([0xe2, 0x96, 0x88]); // raw bytes on stderr
      call.channel.stderr.emit('data', err);
      await Promise.resolve();
      expect(Buffer.concat(received).equals(err)).toBe(true);
    });

    it('openPty delivers raw >0x7E bytes undecoded (FR4)', async () => {
      const pty = await t.openPty('tmux -CC', { cols: 80, rows: 24 });
      const call = t.fake.execCalls.at(-1)!;
      const received: Uint8Array[] = [];
      pty.onData((b) => received.push(b));
      const powerline = Buffer.from([0xe2, 0x96, 0x88]);
      call.channel.emit('data', powerline);
      await Promise.resolve();
      expect(Buffer.concat(received.map((u) => Buffer.from(u))).equals(powerline)).toBe(true);
    });

    it('openShell delivers raw >0x7E bytes undecoded (FR4)', async () => {
      const shell = await t.openShell({ cols: 80, rows: 24 });
      const ch = t.fake.shellCalls.at(-1)!.channel;
      const received: Uint8Array[] = [];
      shell.onData((b) => received.push(b));
      const powerline = Buffer.from([0xe2, 0x96, 0x88]);
      ch.emit('data', powerline);
      await Promise.resolve();
      expect(Buffer.concat(received.map((u) => Buffer.from(u))).equals(powerline)).toBe(true);
    });
  });

  it('exec rejects when not connected (OQ-3)', async () => {
    const t = new TestTransport();
    await expect(t.exec('true')).rejects.toBeInstanceOf(RemoteTransportError);
  });

  describe('~/.ssh/config alias resolution (f2ng)', () => {
    /** Spec whose host is a config alias and whose user/port are defaults. */
    const ALIAS_SPEC: RemoteConnectionSpec = {
      kind: 'remote',
      host: 'prod',
      user: '',
      port: 22,
      remotePath: '/srv/repo',
    };

    it('resolves HostName/Port/User/IdentityFile from an alias block (FR1/FR2)', async () => {
      const home = writeSshConfig(
        ['Host prod', '  HostName 10.0.0.5', '  Port 2200', '  User deploy', `  IdentityFile ${join(tmp, 'id_prod')}`].join(
          '\n',
        ),
      );
      writeFileSync(join(tmp, 'id_prod'), USABLE_KEY_PEM);
      const khPath = join(home, '.ssh', 'known_hosts');
      writeFileSync(khPath, '');
      const t = new TestTransport();
      t.fake.presentHostKey = makeKey().wire;
      await t.connect(ALIAS_SPEC, { hostKeyPolicy: { knownHostsPath: khPath, tofu: true } });
      expect(t.fake.connectConfig?.['host']).toBe('10.0.0.5');
      expect(t.fake.connectConfig?.['port']).toBe(2200);
      expect(t.fake.connectConfig?.['username']).toBe('deploy');
      expect(Buffer.isBuffer(t.fake.connectConfig?.['privateKey'])).toBe(true);
    });

    it('host-key lookup uses the RESOLVED HostName, not the alias (FR3)', async () => {
      const home = writeSshConfig(['Host prod', '  HostName 10.0.0.5'].join('\n'));
      const recorded = makeKey();
      const khPath = join(home, '.ssh', 'known_hosts');
      // Record the key under the RESOLVED host token (default port → plain host).
      writeFileSync(khPath, `10.0.0.5 ${recorded.sshLine}\n`);
      process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
      const t = new TestTransport();
      t.fake.presentHostKey = recorded.wire;
      // tofu:false → only a known_hosts match (keyed by resolved host) accepts.
      await t.connect(ALIAS_SPEC, { hostKeyPolicy: { knownHostsPath: khPath, tofu: false } });
      expect(t.state()).toBe('connected');
    });

    it('spec-explicit user/port/identity take precedence over config (FR2/OQ-1)', async () => {
      writeSshConfig(
        ['Host host.invalid', '  HostName 10.0.0.9', '  Port 2200', '  User configuser'].join('\n'),
      );
      const keyPath = join(tmp, 'spec_id');
      writeFileSync(keyPath, USABLE_KEY_PEM);
      const khPath = join(tmp, 'kh');
      writeFileSync(khPath, '');
      const t = new TestTransport();
      t.fake.presentHostKey = makeKey().wire;
      // SPEC has user 'deploy', port 2222 (non-default), explicit identityPath.
      await t.connect(
        { ...SPEC, identityPath: keyPath },
        { hostKeyPolicy: { knownHostsPath: khPath, tofu: true } },
      );
      expect(t.fake.connectConfig?.['host']).toBe('10.0.0.9'); // HostName always wins
      expect(t.fake.connectConfig?.['port']).toBe(2222); // spec non-default port kept
      expect(t.fake.connectConfig?.['username']).toBe('deploy'); // spec user kept
      expect(Buffer.isBuffer(t.fake.connectConfig?.['privateKey'])).toBe(true);
    });

    it('a plain host with no matching alias is unchanged (FR4)', async () => {
      writeSshConfig(['Host other', '  HostName 10.0.0.5'].join('\n'));
      process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
      const khPath = join(tmp, 'kh');
      writeFileSync(khPath, '');
      const t = new TestTransport();
      t.fake.presentHostKey = makeKey().wire;
      await t.connect(SPEC, { hostKeyPolicy: { knownHostsPath: khPath, tofu: true } });
      expect(t.fake.connectConfig?.['host']).toBe('host.invalid');
      expect(t.fake.connectConfig?.['port']).toBe(2222);
      expect(t.fake.connectConfig?.['username']).toBe('deploy');
    });
  });
});

/**
 * SFTP read primitive (Download capability, br ynz8.1): `stat` and
 * `createReadStream` over the fake sftp() seam added to FakeClient above.
 * Asserts: whole-file read and INCLUSIVE {start,end} ranged reads return
 * exact byte windows (including raw bytes > 0x7E, per the raw-byte
 * invariant); a stream read error propagates to the consumer; the SFTP
 * channel is opened fresh per call and released exactly once (D2), including
 * on an errored read and an early consumer destroy(); stat maps
 * size/isDir/mtime (seconds -> ISO) and resolves exists:false for a missing
 * path rather than rejecting; both reject with RemoteTransportError when the
 * SFTP channel cannot be opened, and when not connected at all.
 */
describe('SFTP read primitive (stat + createReadStream) — Download capability', () => {
  // 'hello-' (6 bytes) + a 3-byte >0x7E powerline sequence + '-world'.
  const SAMPLE = Buffer.concat([
    Buffer.from('hello-'),
    Buffer.from([0xe2, 0x96, 0x88]), // U+2588 full block
    Buffer.from('-world'),
  ]);

  function collect(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  let t: TestTransport;
  beforeEach(async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    t = new TestTransport();
    await t.connect(SPEC, { hostKeyPolicy: tofuPolicy() });
  });

  it('createReadStream returns the whole file, including raw bytes > 0x7E undecoded', async () => {
    t.fake.nextSftpData = SAMPLE;
    const stream = await t.createReadStream('/srv/repo/file.bin');
    const got = await collect(stream);
    expect(got.equals(SAMPLE)).toBe(true);
  });

  it('createReadStream honors an inclusive {start,end} range', async () => {
    t.fake.nextSftpData = SAMPLE;
    // Bytes 6..8 are the 3-byte powerline sequence; end is INCLUSIVE.
    const stream = await t.createReadStream('/srv/repo/file.bin', { start: 6, end: 8 });
    const got = await collect(stream);
    expect(got.equals(SAMPLE.subarray(6, 9))).toBe(true);
  });

  it('propagates a stream read error to the consumer (never swallowed)', async () => {
    t.fake.nextSftpData = SAMPLE;
    t.fake.nextSftpStreamFails = true;
    const stream = await t.createReadStream('/srv/repo/file.bin');
    await expect(collect(stream)).rejects.toThrow(/simulated/);
  });

  it('ends the SFTP channel exactly once per read, including on error and an early destroy (D2)', async () => {
    // Two ordinary sequential reads -> two fresh FakeSftp sessions, one end() each.
    t.fake.nextSftpData = SAMPLE;
    await collect(await t.createReadStream('/f1'));
    t.fake.nextSftpData = SAMPLE;
    await collect(await t.createReadStream('/f2'));
    expect(t.fake.sftpInstances).toHaveLength(2);
    expect(t.fake.sftpInstances.map((s) => s.endCallCount)).toEqual([1, 1]);

    // An errored read still ends its channel exactly once.
    t.fake.nextSftpData = SAMPLE;
    t.fake.nextSftpStreamFails = true;
    const errored = await t.createReadStream('/f3');
    await expect(collect(errored)).rejects.toThrow();
    expect(t.fake.sftpInstances).toHaveLength(3);
    expect(t.fake.sftpInstances[2]!.endCallCount).toBe(1);

    // An early destroy() (consumer abort, no error passed) still ends its
    // channel exactly once, via 'close' rather than 'error'.
    t.fake.nextSftpData = SAMPLE;
    const aborted = await t.createReadStream('/f4');
    aborted.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.fake.sftpInstances).toHaveLength(4);
    expect(t.fake.sftpInstances[3]!.endCallCount).toBe(1);
  });

  it('stat maps size/isDir/mtime (seconds -> ISO) for an existing path, ending its channel', async () => {
    t.fake.nextSftpData = SAMPLE;
    const st = await t.stat('/srv/repo/file.bin');
    expect(st).toEqual({
      exists: true,
      size: SAMPLE.length,
      isDir: false,
      mtime: new Date(1_700_000_000 * 1000).toISOString(),
    });
    expect(t.fake.sftpInstances).toHaveLength(1);
    expect(t.fake.sftpInstances[0]!.endCallCount).toBe(1);
  });

  it('stat resolves exists:false for a missing path rather than rejecting', async () => {
    t.fake.nextSftpMissing = true;
    const st = await t.stat('/srv/repo/nope.bin');
    expect(st).toEqual({ exists: false, size: 0, isDir: false, mtime: null });
  });

  it('stat and createReadStream both reject with RemoteTransportError when the SFTP channel cannot be opened', async () => {
    t.fake.failNextSftpOpen = new Error('channel open refused');
    await expect(t.stat('/srv/repo/file.bin')).rejects.toBeInstanceOf(RemoteTransportError);
    t.fake.failNextSftpOpen = new Error('channel open refused');
    await expect(t.createReadStream('/srv/repo/file.bin')).rejects.toBeInstanceOf(RemoteTransportError);
  });

  it('stat and createReadStream both reject with RemoteTransportError when not connected', async () => {
    const disconnected = new TestTransport();
    await expect(disconnected.stat('/x')).rejects.toBeInstanceOf(RemoteTransportError);
    await expect(disconnected.createReadStream('/x')).rejects.toBeInstanceOf(RemoteTransportError);
  });
});

/**
 * readFileBytesOverTransport (bounded binary-preview read primitive, br
 * ynz8-sx0i.1): the remote byte source behind `WorkspaceProvider.readFileBytes`.
 * Reuses the same TestTransport/FakeClient/FakeSftp harness and connected
 * transport as the SFTP primitive suite above — RemoteProvider itself has no
 * transport-injection seam, so the exported helper is exercised directly
 * against a connected TestTransport (which satisfies `Pick<RemoteTransport,
 * 'stat' | 'createReadStream'>` structurally) rather than through a
 * RemoteProvider instance.
 */
describe('readFileBytesOverTransport (bounded byte preview over SFTP)', () => {
  // 'hello-' (6 bytes) + a 3-byte >0x7E powerline sequence + '-world'.
  const SAMPLE = Buffer.concat([
    Buffer.from('hello-'),
    Buffer.from([0xe2, 0x96, 0x88]), // U+2588 full block
    Buffer.from('-world'),
  ]);

  let t: TestTransport;
  beforeEach(async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    t = new TestTransport();
    await t.connect(SPEC, { hostKeyPolicy: tofuPolicy() });
  });

  it('reads bytes undecoded and returns a correct base64 round-trip, with sizeBytes and reason null', async () => {
    t.fake.nextSftpData = SAMPLE;
    const res = await readFileBytesOverTransport(t, '/srv/repo/file.bin');
    expect(res.reason).toBeNull();
    expect(res.exists).toBe(true);
    expect(res.sizeBytes).toBe(SAMPLE.length);
    expect(Buffer.from(res.bytesBase64!, 'base64').equals(SAMPLE)).toBe(true);
  });

  it('requests no range from the SFTP stream (whole-file read only)', async () => {
    t.fake.nextSftpData = SAMPLE;
    await readFileBytesOverTransport(t, '/srv/repo/file.bin');
    // Index 0 is the stat() session; index 1 is the createReadStream() session.
    expect(t.fake.sftpInstances).toHaveLength(2);
    const streamSession = t.fake.sftpInstances[1]!;
    expect(streamSession.lastReadStreamOpts?.start).toBeUndefined();
    expect(streamSession.lastReadStreamOpts?.end).toBeUndefined();
  });

  it('rejects when the SFTP read stream errors (never resolves silent empty bytes)', async () => {
    t.fake.nextSftpData = SAMPLE;
    // Sticky, not one-shot: the one-shot flag would be consumed by the stat
    // session's own sftp() call before the stream session ever opens.
    t.fake.allSftpStreamsFail = true;
    await expect(readFileBytesOverTransport(t, '/srv/repo/file.bin')).rejects.toThrow();
  });

  it('opens exactly two SFTP sessions for a successful read and ends each exactly once', async () => {
    t.fake.nextSftpData = SAMPLE;
    await readFileBytesOverTransport(t, '/srv/repo/file.bin');
    expect(t.fake.sftpInstances).toHaveLength(2);
    expect(t.fake.sftpInstances.map((s) => s.endCallCount)).toEqual([1, 1]);
  });

  it('still ends the stream session exactly once when the read errors', async () => {
    t.fake.nextSftpData = SAMPLE;
    t.fake.allSftpStreamsFail = true;
    await expect(readFileBytesOverTransport(t, '/srv/repo/file.bin')).rejects.toThrow();
    expect(t.fake.sftpInstances).toHaveLength(2);
    expect(t.fake.sftpInstances[1]!.endCallCount).toBe(1);
  });

  it('short-circuits on a missing path: reason "missing", only the stat session is opened', async () => {
    t.fake.nextSftpMissing = true;
    const res = await readFileBytesOverTransport(t, '/srv/repo/nope.bin');
    expect(res).toEqual({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
    expect(t.fake.sftpInstances).toHaveLength(1);
  });

  it('refuses an over-cap file without ever opening a stream (refuse, not truncate)', async () => {
    t.fake.nextSftpData = Buffer.alloc(FILE_BYTES_CAP + 1);
    const res = await readFileBytesOverTransport(t, '/srv/repo/big.bin');
    expect(res).toEqual({
      bytesBase64: null,
      sizeBytes: FILE_BYTES_CAP + 1,
      exists: true,
      reason: 'too-large',
    });
    // Refused before any stream session was opened — only the stat session.
    expect(t.fake.sftpInstances).toHaveLength(1);
  });
});
