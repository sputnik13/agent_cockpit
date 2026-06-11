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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteConnectionSpec } from '../types';
import { Ssh2Transport } from './transport';
import { RemoteTransportError } from './transportTypes';

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

/** A fake ssh2 Client. Records connect config and exec/shell calls. */
class FakeClient extends EventEmitter {
  connectConfig: Record<string, unknown> | null = null;
  execCalls: ExecCall[] = [];
  shellCalls: Array<{ opts: Record<string, unknown>; channel: FakeChannel }> = [];
  /** When set, the next connect runs the hostVerifier with this key then proceeds. */
  presentHostKey: Buffer | null = null;

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
    const keyPath = join(tmp, 'id');
    writeFileSync(keyPath, 'KEY-MATERIAL');
    const t = new TestTransport();
    await t.connect({ ...SPEC, identityPath: keyPath }, { hostKeyPolicy: tofuPolicy() });
    expect(t.fake.connectConfig?.['username']).toBe('deploy');
    expect(t.fake.connectConfig?.['port']).toBe(2222);
    expect(Buffer.isBuffer(t.fake.connectConfig?.['privateKey'])).toBe(true);
    expect(t.fake.connectConfig?.['agent']).toBeUndefined();
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
      writeFileSync(join(tmp, 'id_prod'), 'KEY-MATERIAL');
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
      writeFileSync(keyPath, 'SPEC-KEY');
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
