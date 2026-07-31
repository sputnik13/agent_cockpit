import { resolve as pathResolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteConnectionSpec } from '../types';
import { RemoteProvider } from './index';
import { Ssh2Transport } from './transport';
import { RemoteTransportError, type RemoteTransport } from './transportTypes';
import { createRemoteTransport } from './transportFactory';

const SPEC: RemoteConnectionSpec = {
  kind: 'remote',
  host: 'example.invalid',
  user: 'deploy',
  port: 22,
  remotePath: '/srv/repo',
};

describe('RemoteProvider (no live SSH server)', () => {
  it('constructs with kind "remote" and the given projectId', () => {
    const p = new RemoteProvider('proj-1', SPEC);
    expect(p.kind).toBe('remote');
    expect(p.projectId).toBe('proj-1');
  });

  it('starts disconnected', () => {
    const p = new RemoteProvider('proj-1', SPEC);
    expect(p.status().state).toBe('disconnected');
  });

  it('rejects read methods before connect (no live helper RPC)', async () => {
    const p = new RemoteProvider('proj-1', SPEC);
    // The read surface is now implemented (br h7a.7.3) but requires a connected
    // helper; without one each call rejects with a clear not-connected error.
    await expect(p.listWorktrees()).rejects.toThrow(/not connected/i);
    await expect(p.readFile('README.md')).rejects.toThrow(/not connected/i);
    await expect(p.readFileBytes('README.md')).rejects.toThrow(/not connected/i);
    await expect(p.detectBeads()).rejects.toThrow(/not connected/i);
    await expect(p.getTaskGraph()).rejects.toThrow(/not connected/i);
    await expect(p.getTask('h1.1')).rejects.toThrow(/not connected/i);
    await expect(p.subscribeWatch(['**/*'], () => {})).rejects.toThrow(/not connected/i);
  });

  it('rejects terminal open before connect (no SSH client)', async () => {
    const p = new RemoteProvider('proj-1', SPEC);
    // Terminal is implemented (br h7a.7.4) via an ssh2 PTY shell; opening one
    // before connect surfaces the transport's not-connected error.
    await expect(p.openTerminal({ cols: 80, rows: 24 })).rejects.toThrow(/not connected/i);
  });

  it('throws for terminal handler registration on an unknown id', () => {
    const p = new RemoteProvider('proj-1', SPEC);
    expect(() => p.onTerminalData('t', () => {})).toThrow(/unknown terminal id/i);
    expect(() => p.onTerminalExit('t', () => {})).toThrow(/unknown terminal id/i);
  });
});

describe('Ssh2Transport (no live SSH server)', () => {
  it('starts in the disconnected state', () => {
    const t = new Ssh2Transport();
    expect(t.state()).toBe('disconnected');
  });

  it('rejects exec before a connection is established', async () => {
    const t = new Ssh2Transport();
    await expect(t.exec('true')).rejects.toBeInstanceOf(RemoteTransportError);
  });

  it('disconnect() is a no-op when never connected', async () => {
    const t = new Ssh2Transport();
    await expect(t.disconnect()).resolves.toBeUndefined();
    expect(t.state()).toBe('disconnected');
  });

  it('reports state transitions via onStateChange', () => {
    const t = new Ssh2Transport();
    const seen: string[] = [];
    const off = t.onStateChange((s) => seen.push(s));
    void t.disconnect();
    off();
    expect(seen).toContain('disconnected');
  });

  it('rejects with a typed error and transitions to failed for an unreachable host', async () => {
    const t = new Ssh2Transport();
    // 127.0.0.1:1 — nothing listens; fail fast via a short ready timeout.
    const spec: RemoteConnectionSpec = {
      kind: 'remote',
      host: '127.0.0.1',
      user: 'nobody',
      port: 1,
      remotePath: '/tmp',
      // Provide an inline agent so we exercise the connect path, not the
      // identity-resolution path. Setting SSH_AUTH_SOCK keeps it deterministic.
    };
    const prev = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/nonexistent-agent.sock';
    try {
      await expect(t.connect(spec, { readyTimeoutMs: 1_000 })).rejects.toBeInstanceOf(
        RemoteTransportError,
      );
      expect(t.state()).toBe('failed');
    } finally {
      if (prev === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prev;
    }
  }, 10_000);
});

describe('createRemoteTransport factory', () => {
  it('returns an Ssh2Transport (FR6)', () => {
    expect(createRemoteTransport()).toBeInstanceOf(Ssh2Transport);
  });

  it('the returned transport satisfies stat/createReadStream through the RemoteTransport interface alone (CLARIFICATION, br ynz8.1)', async () => {
    // Declared as RemoteTransport, NOT Ssh2Transport: this is the swap-seam
    // guarantee itself — a future transport plugged into the factory only
    // needs to satisfy this interface, never Ssh2Transport internals, so the
    // test enforces the abstraction rather than merely documenting it.
    const t: RemoteTransport = createRemoteTransport();
    expect(typeof t.stat).toBe('function');
    expect(typeof t.createReadStream).toBe('function');
    // Not connected -> both reject with RemoteTransportError, exercised
    // strictly through the interface type (no Ssh2Transport-specific access).
    await expect(t.stat('/some/path')).rejects.toBeInstanceOf(RemoteTransportError);
    await expect(t.createReadStream('/some/path')).rejects.toBeInstanceOf(RemoteTransportError);
  });
});

// ---- distDir path math (dev build) ----
// distDir() is not called directly here (it would require Electron's `app`
// object). Instead we verify the raw path arithmetic that it relies on:
// at runtime __dirname is `out/main`; two ".." levels up reaches the repo
// root, and from there `remote-helper/dist` is the correct dist location.
describe('distDir dev-path math', () => {
  it('two levels up from out/main reaches the project root', () => {
    // Simulate __dirname = <repoRoot>/out/main (electron-vite bundle output).
    const fakeOutMain = join('/some/project/root', 'out', 'main');
    const resolved = pathResolve(fakeOutMain, '..', '..', 'remote-helper', 'dist');
    expect(resolved).toBe('/some/project/root/remote-helper/dist');
  });

  it('one level up from out/main reaches out/ (preload precedent)', () => {
    const fakeOutMain = join('/some/project/root', 'out', 'main');
    const preload = pathResolve(fakeOutMain, '..', 'preload', 'index.js');
    expect(preload).toBe('/some/project/root/out/preload/index.js');
  });
});
