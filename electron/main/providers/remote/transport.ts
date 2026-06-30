/**
 * Ssh2Transport — the default `RemoteTransport` implementation, backed by a
 * single ssh2 `Client`. It owns the wire mechanism: connect/auth lifecycle,
 * one-shot and streaming exec, PTY channels (control-mode + terminals), and the
 * SFTP file-provisioning session. It maps ssh2's untyped error events into typed
 * `RemoteTransportError`s with a `phase`.
 *
 * THIS IS THE ONLY FILE PERMITTED TO IMPORT `ssh2` (enforced by ESLint
 * `no-restricted-imports`). All other remote code depends on the
 * `RemoteTransport` interface in `transportTypes.ts`. The raw-byte invariant
 * (CLAUDE.md) is preserved here: ssh2 yields `Buffer`s with no encoding set, and
 * every channel passes them through undecoded.
 *
 * Security: this module never logs key material, key paths beyond the basename,
 * passwords, or full identity contents.
 */
import { Client, utils as ssh2Utils } from 'ssh2';
import type {
  Client as Ssh2Client,
  ClientChannel,
  ConnectConfig,
  SFTPWrapper,
  VerifyCallback,
} from 'ssh2';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ConnectionState, RemoteConnectionSpec } from '../types';
import { resolveSshConfig } from './sshConfigResolve';
import { logger } from '../../logger';
import { TERMINAL_TERM } from '@shared/tmux';
import {
  RemoteTransportError,
  type DuplexChannel,
  type ExecOptions,
  type ExecResult,
  type HostKeyPolicy,
  type OpenPtyOptions,
  type OpenShellOptions,
  type ProvisionSession,
  type PtyChannel,
  type RemoteConnectOptions,
  type RemoteTransport,
} from './transportTypes';

/** Default time to wait for the SSH handshake before failing. */
const DEFAULT_READY_TIMEOUT_MS = 20_000;

/**
 * Wrap an ssh2 `ClientChannel` (which is a PTY/exec stream) as a `PtyChannel`.
 * ssh2 yields raw `Buffer`s (no encoding set), preserving the raw-byte invariant.
 */
function asPtyChannel(channel: ClientChannel): PtyChannel {
  return {
    write: (data: string | Uint8Array) => {
      channel.write(data);
    },
    onData: (cb: (chunk: Uint8Array) => void) => {
      channel.on('data', cb);
    },
    onClose: (cb: () => void) => {
      channel.on('close', cb);
    },
    close: () => channel.close(),
    // ssh2's setWindow takes rows FIRST, then cols.
    resize: (cols: number, rows: number) => channel.setWindow(rows, cols, 0, 0),
  };
}

export class Ssh2Transport implements RemoteTransport {
  private conn: Ssh2Client | null = null;
  private stateValue: ConnectionState = 'disconnected';
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();

  /** Current connection state. */
  state(): ConnectionState {
    return this.stateValue;
  }

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(cb: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  private setState(state: ConnectionState): void {
    this.stateValue = state;
    for (const cb of this.stateHandlers) cb(state);
  }

  /**
   * Construct the underlying ssh2 client. Exists as a protected seam so unit
   * tests can inject a fake `Client` (there is no other injection point).
   */
  protected createClient(): Ssh2Client {
    return new Client();
  }

  /**
   * The live, connected ssh2 client, or `null` after `reject`ing — so callers
   * inside a Promise executor surface a rejection (not a synchronous throw) when
   * not connected, satisfying the "exec rejects when not connected" contract.
   * Private — the ssh2 handle must never leak past this file (no `client()`).
   */
  private tryClient(reject: (err: RemoteTransportError) => void): Ssh2Client | null {
    if (!this.conn || this.stateValue !== 'connected') {
      reject(new RemoteTransportError('SSH client is not connected', '', 'connect'));
      return null;
    }
    return this.conn;
  }

  /**
   * Open the SSH connection. Resolves on `ready`; rejects with a
   * `RemoteTransportError` on error or handshake timeout, transitioning state to
   * `failed`. Auth uses the explicit identity key when provided, otherwise falls
   * through to the SSH agent at `$SSH_AUTH_SOCK`. The host key is verified
   * against known_hosts (a mismatch rejects with `phase:'hostkey'`).
   */
  async connect(spec: RemoteConnectionSpec, opts?: RemoteConnectOptions): Promise<void> {
    if (this.conn) {
      await this.disconnect();
    }

    this.setState('connecting');

    const config = await this.buildConnectConfig(spec, opts).catch((err: unknown) => {
      this.setState('failed');
      throw err;
    });

    const conn = this.createClient();
    this.conn = conn;

    // Display target: show the alias AND what it resolved to, so a failure makes
    // it obvious whether ~/.ssh/config resolution happened.
    const target =
      config.host === spec.host
        ? `${spec.host}:${config.port}`
        : `${spec.host} -> ${config.host}:${config.port}`;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        conn.removeListener('ready', onReady);
        conn.removeListener('error', onError);
        conn.removeListener('timeout', onTimeout);
      };

      const onReady = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.attachLifecycleListeners(conn);
        this.setState('connected');
        resolve();
      };

      const fail = (
        phase: RemoteTransportError['phase'],
        message: string,
        cause?: unknown,
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.conn = null;
        this.setState('failed');
        try {
          conn.end();
        } catch {
          // best-effort teardown; the connection already failed.
        }
        reject(new RemoteTransportError(message, spec.host, phase, cause));
      };

      const onError = (err: Error & { level?: string }): void => {
        // A host-key rejection from our hostVerifier surfaces as an ssh2 error
        // whose message/level mentions host-key verification.
        if (/host key verification|hostkey|host-key/i.test(err.message)) {
          fail('hostkey', `Host key verification failed for ${target}: ${err.message}`, err);
          return;
        }
        const phase = /authentication/i.test(err.message) ? 'auth' : 'connect';
        fail(phase, `SSH connection to ${target} failed: ${err.message}`, err);
      };

      const onTimeout = (): void => {
        fail('timeout', `SSH connection to ${target} timed out`);
      };

      conn.once('ready', onReady);
      conn.once('error', onError);
      conn.once('timeout', onTimeout);

      try {
        conn.connect(config);
      } catch (err) {
        fail('connect', `Failed to initiate SSH connection to ${target}`, err);
      }
    });
  }

  /** Cleanly end the connection. Idempotent. */
  async disconnect(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) {
      this.setState('disconnected');
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      conn.once('close', finish);
      conn.once('end', finish);
      try {
        conn.end();
      } catch {
        finish();
      }
      // Fallback in case neither event fires (already-dead socket).
      setTimeout(finish, 1_000).unref?.();
    });

    this.setState('disconnected');
  }

  /**
   * Listeners that keep `stateValue` in sync after a successful connect. An
   * unexpected close transitions to `disconnected` (reconnect is a later task).
   */
  private attachLifecycleListeners(conn: Ssh2Client): void {
    conn.once('close', () => {
      if (this.conn === conn) {
        this.conn = null;
        this.setState('disconnected');
      }
    });
  }

  /**
   * Run a one-shot command. stdout/stderr captured separately; `code` is `null`
   * on signal death. Never rejects on a non-zero exit (lenient — callers decide).
   * Rejects with `RemoteTransportError` when not connected. `timeoutMs`
   * force-closes the channel and resolves with whatever was collected.
   */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const conn = this.tryClient(reject);
      if (!conn) return;
      conn.exec(command, (err, channel) => {
        if (err) {
          reject(new RemoteTransportError(`exec failed: ${err.message}`, '', 'connect', err));
          return;
        }
        let out = '';
        let errOut = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ stdout: out, stderr: errOut, code });
        };
        if (opts?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            channel.close();
            finish(null);
          }, opts.timeoutMs);
          timer.unref?.();
        }
        channel.on('data', (d: Buffer) => {
          out += d.toString('utf8');
        });
        channel.stderr?.on('data', (d: Buffer) => {
          errOut += d.toString('utf8');
        });
        channel.on('close', (code: number | null) => finish(code ?? null));
      });
    });
  }

  /**
   * Open a long-lived stdio duplex (raw bytes) — the helper RPC transport. An
   * ssh2 exec channel is both a writable (stdin) and a readable (stdout) and
   * emits `'data'`/`'end'`/`'error'`, satisfying `DuplexChannel` directly.
   */
  execStream(command: string): Promise<DuplexChannel> {
    return new Promise<DuplexChannel>((resolve, reject) => {
      const conn = this.tryClient(reject);
      if (!conn) return;
      conn.exec(command, (err, channel) => {
        if (err) {
          reject(new RemoteTransportError(`execStream failed: ${err.message}`, '', 'connect', err));
          return;
        }
        resolve({ stdin: channel, stdout: channel, stderr: channel.stderr });
      });
    });
  }

  /**
   * Open a non-login SSH exec channel **with a PTY** — the byobu-safe method for
   * tmux control-mode:
   * - `exec` (not `shell`) skips /etc/profile.d/*byobu* and login scripts that
   *   auto-start tmux/byobu on interactive login channels.
   * - `pty:true` is required by tmux's `-CC` mode (it needs a tty).
   *
   * PTY modes: ECHO=0 disables local echo on the remote PTY so bytes written to
   * the control channel (tmux commands like `new-window\n`) are not echoed back
   * on stdout into the control stream. ISIG=0 disables signal generation
   * (SIGINT/SIGQUIT) from Ctrl-C in the control channel. These are control-PTY
   * hygiene. The returned channel yields raw Buffers (no encoding set),
   * preserving the CLAUDE.md raw-byte invariant.
   */
  openPty(command: string, opts: OpenPtyOptions): Promise<PtyChannel> {
    return new Promise<PtyChannel>((resolve, reject) => {
      const conn = this.tryClient(reject);
      if (!conn) return;
      conn.exec(
        command,
        {
          pty: {
            term: TERMINAL_TERM,
            cols: opts.cols,
            rows: opts.rows,
            width: 0,
            height: 0,
            modes: { ECHO: 0, ISIG: 0 },
          },
        },
        (err, channel) => {
          if (err) {
            reject(new RemoteTransportError(`openPty failed: ${err.message}`, '', 'connect', err));
            return;
          }
          resolve(asPtyChannel(channel));
        },
      );
    });
  }

  /**
   * Open a login/interactive shell channel (raw bytes) — terminals. `term`
   * defaults to `TERMINAL_TERM` (`xterm-256color`).
   */
  openShell(opts: OpenShellOptions): Promise<PtyChannel> {
    return new Promise<PtyChannel>((resolve, reject) => {
      const conn = this.tryClient(reject);
      if (!conn) return;
      conn.shell(
        { term: opts.term ?? TERMINAL_TERM, cols: opts.cols, rows: opts.rows },
        (err, channel) => {
          if (err) {
            reject(new RemoteTransportError(`openShell failed: ${err.message}`, '', 'connect', err));
            return;
          }
          resolve(asPtyChannel(channel));
        },
      );
    });
  }

  /**
   * Begin a file-provisioning session over a SINGLE SFTP session, matching the
   * prior open-once / end-in-finally behavior.
   */
  beginProvision(): Promise<ProvisionSession> {
    return new Promise<ProvisionSession>((resolve, reject) => {
      const conn = this.tryClient(reject);
      if (!conn) return;
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new RemoteTransportError(`failed to open SFTP: ${err.message}`, '', 'connect', err));
          return;
        }
        resolve(new Ssh2ProvisionSession(sftp));
      });
    });
  }

  /**
   * Build the ssh2 connect config, resolving the identity key if specified.
   *
   * When `spec.host` is a `~/.ssh/config` `Host` alias, its
   * `HostName`/`Port`/`User`/`IdentityFile` are resolved and merged in. ssh2 does
   * not read `~/.ssh/config`, so without this an alias-based host fails with
   * `getaddrinfo ENOTFOUND <alias>`. Precedence is spec-explicit > config >
   * default (OQ-1): the resolved `HostName` always replaces the alias; config
   * `User`/`IdentityFile` apply only when the spec leaves them empty; config
   * `Port` applies only when the spec port is the default (22). A plain
   * hostname/IP yields an empty resolution and behaves exactly as before (FR4).
   */
  private async buildConnectConfig(
    spec: RemoteConnectionSpec,
    opts?: RemoteConnectOptions,
  ): Promise<ConnectConfig> {
    const resolved = resolveSshConfig(spec.host);
    const host = resolved.hostName ?? spec.host;
    const port = spec.port === 22 ? (resolved.port ?? spec.port) : spec.port;
    const username = spec.user || resolved.user || spec.user;
    const identityPath = spec.identityPath ?? resolved.identityFile;

    // Diagnostic: surface whether ~/.ssh/config resolved the host. A connect
    // failure otherwise can't be told apart from "resolution never ran". No
    // secrets — alias, resolved host/port/user and identity basename only.
    logger.info(
      `ssh-config resolve: "${spec.host}" -> host=${host} port=${port} user=${username} ` +
        `identity=${identityPath ? basename(identityPath) : 'agent'} ` +
        (resolved.hostName
          ? '(resolved from ~/.ssh/config)'
          : '(no HostName matched in ~/.ssh/config; using host as-is)'),
      'remote-connect',
    );

    const config: ConnectConfig = {
      host,
      port,
      username,
      readyTimeout: opts?.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      // Verify the host key against the RESOLVED host (FR3), not the alias, so
      // the known_hosts token matches the real host.
      hostVerifier: this.buildHostVerifier(host, port, opts?.hostKeyPolicy),
      // Offer SSH transport compression, preferred over none. The RPC payloads
      // (unified diffs, file content, JSON frames) are highly compressible text,
      // so a server that supports zlib shrinks the dominant bytes on the wire.
      // `none` stays in the list as a fallback so a server without zlib still
      // negotiates successfully — compression is best-effort, never required.
      algorithms: { compress: ['zlib@openssh.com', 'zlib', 'none'] },
    };

    const agentSock = process.env.SSH_AUTH_SOCK;

    if (identityPath) {
      let keyBuf: Buffer;
      try {
        keyBuf = await readFile(identityPath);
      } catch (err) {
        throw new RemoteTransportError(
          `Failed to read SSH identity file "${basename(identityPath)}"`,
          spec.host,
          'identity',
          err,
        );
      }

      // ssh2 parses `privateKey` SYNCHRONOUSLY inside conn.connect() and THROWS
      // when it can't parse the key — overwhelmingly because the key is
      // passphrase-protected and no passphrase is supplied (we have no UI to
      // collect one). parseKey() reports that as a returned Error (it does not
      // throw), so we gate on it here: a usable key is passed as privateKey; an
      // unusable one falls back to the SSH agent (where a decrypted copy of the
      // key typically lives — which is why native `ssh` works), exactly as the
      // agent-only branch below. Only when no agent is available do we fail, with
      // an actionable message instead of an opaque synchronous connect throw.
      const parsed = ssh2Utils.parseKey(keyBuf);
      if (parsed instanceof Error) {
        if (agentSock) {
          config.agent = agentSock;
          logger.warn(
            `SSH identity "${basename(identityPath)}" is not usable directly ` +
              `(${parsed.message}); falling back to the SSH agent`,
            'remote-connect',
          );
        } else {
          throw new RemoteTransportError(
            `SSH identity "${basename(identityPath)}" is passphrase-protected or ` +
              `unparseable, and no SSH agent is available (SSH_AUTH_SOCK is unset). ` +
              `Load the key with \`ssh-add\` and retry.`,
            spec.host,
            'identity',
            parsed,
          );
        }
      } else {
        config.privateKey = keyBuf;
        // Offer the agent as an additional auth method when present, matching
        // native ssh (which also tries agent keys). Harmless when the key works.
        if (agentSock) config.agent = agentSock;
      }
    } else {
      if (!agentSock) {
        throw new RemoteTransportError(
          'No SSH identity provided and SSH_AUTH_SOCK is not set (no agent available)',
          spec.host,
          'auth',
        );
      }
      config.agent = agentSock;
    }

    return config;
  }

  /**
   * Build the ssh2 `hostVerifier`. The presented host key (raw SSH wire bytes)
   * is compared against the entries in known_hosts for this host:port. An entry
   * that exists but does NOT match is always rejected (closes the silent-accept
   * MITM gap). An unknown host is accepted only under TOFU (the default), which
   * preserves the prior connect-anywhere behavior for first contact.
   *
   * `host`/`port` are the RESOLVED values (after `~/.ssh/config` alias
   * resolution), so the known_hosts lookup matches the real host (FR3).
   */
  private buildHostVerifier(
    host: string,
    port: number,
    policy?: HostKeyPolicy,
  ): (key: Buffer, verify: VerifyCallback) => void {
    const tofu = policy?.tofu ?? true;
    const path = policy?.knownHostsPath ?? join(homedir(), '.ssh', 'known_hosts');
    return (key: Buffer, verify: VerifyCallback): void => {
      const presented = parsePublicKeyBytes(key);
      if (!presented) {
        // We could not parse the presented key; under TOFU accept, else reject.
        verify(tofu);
        return;
      }
      const entries = loadKnownHostKeys(path, host, port);
      if (entries.length === 0) {
        // Host not in known_hosts: accept under TOFU.
        verify(tofu);
        return;
      }
      const match = entries.some((e) => e.equals(presented));
      // Known host: accept iff a recorded key matches; a mismatch is rejected.
      verify(match);
    };
  }
}

/** A scoped SFTP-backed provisioning session. */
class Ssh2ProvisionSession implements ProvisionSession {
  private ended = false;
  constructor(private readonly sftp: SFTPWrapper) {}

  exists(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.sftp.exists(path, (has) => resolve(has));
    });
  }

  mkdirp(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.mkdir(dir, (err) => {
        // Tolerate "already exists" (ssh2 surfaces it as a generic failure);
        // re-check existence to decide whether this is fatal.
        if (!err) {
          resolve();
          return;
        }
        this.sftp.exists(dir, (exists) => {
          if (exists) resolve();
          else reject(new RemoteTransportError(`failed to create ${dir}: ${err.message}`, '', 'connect', err));
        });
      });
    });
  }

  uploadExecutable(localPath: string, remotePath: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.fastPut(localPath, remotePath, (putErr) => {
        if (putErr) {
          reject(new RemoteTransportError(`upload failed: ${putErr.message}`, '', 'connect', putErr));
          return;
        }
        this.sftp.chmod(remotePath, mode, (chmodErr) => {
          if (chmodErr) {
            reject(new RemoteTransportError(`chmod failed: ${chmodErr.message}`, '', 'connect', chmodErr));
          } else {
            resolve();
          }
        });
      });
    });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    try {
      this.sftp.end();
    } catch {
      // already closed
    }
  }
}

/**
 * Parse the raw SSH-format public key bytes ssh2 hands the hostVerifier into a
 * canonical public-SSH byte buffer for comparison. Returns null if unparseable.
 */
function parsePublicKeyBytes(key: Buffer): Buffer | null {
  const parsed = ssh2Utils.parseKey(key);
  if (parsed instanceof Error) return null;
  try {
    return parsed.getPublicSSH();
  } catch {
    return null;
  }
}

/**
 * Read the recorded host keys for `host`/`port` from a known_hosts file. Returns
 * canonical public-SSH byte buffers. Hashed (`|1|...`) entries are ignored
 * (cannot match a plaintext host token); non-default ports use the
 * `[host]:port` token form. Any read/parse failure yields an empty list (treated
 * as "unknown host").
 */
function loadKnownHostKeys(path: string, host: string, port: number): Buffer[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const target = port === 22 ? host : `[${host}]:${port}`;
  const altTarget = host; // some files store default-port hosts plainly
  const keys: Buffer[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostsField, keyType, keyB64] = parts;
    if (!hostsField || !keyType || !keyB64) continue;
    if (hostsField.startsWith('|')) continue; // hashed entry — cannot plain-match
    const hostTokens = hostsField.split(',');
    if (!hostTokens.includes(target) && !(port === 22 && hostTokens.includes(altTarget))) {
      continue;
    }
    const parsed = ssh2Utils.parseKey(`${keyType} ${keyB64}`);
    if (parsed instanceof Error) continue;
    try {
      keys.push(parsed.getPublicSSH());
    } catch {
      // skip unparseable entry
    }
  }
  return keys;
}
