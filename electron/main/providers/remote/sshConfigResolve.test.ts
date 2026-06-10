/**
 * Unit tests for resolveSshConfig — the in-repo `~/.ssh/config` resolver.
 *
 * Covers: exact alias match, glob (`*`/`?`), negation (`!`), missing/unreadable
 * file, `~` expansion in IdentityFile, first-value-wins precedence, and the
 * `Keyword=value` form. The config path and home dir are injected so no real
 * `~/.ssh/config` is read.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSshConfig } from './sshConfigResolve';

let tmp: string;
let home: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sshcfg-'));
  home = join(tmp, 'home');
  configPath = join(tmp, 'config');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write a config fixture and resolve `alias` against it. */
function resolve(alias: string, config: string) {
  writeFileSync(configPath, config);
  return resolveSshConfig(alias, { configPath, home });
}

describe('resolveSshConfig', () => {
  it('resolves an exact alias to HostName/Port/User/IdentityFile', () => {
    const r = resolve(
      'prod',
      [
        'Host prod',
        '  HostName 10.0.0.5',
        '  Port 2222',
        '  User deploy',
        '  IdentityFile /keys/prod_ed25519',
      ].join('\n'),
    );
    expect(r).toEqual({
      hostName: '10.0.0.5',
      port: 2222,
      user: 'deploy',
      identityFile: '/keys/prod_ed25519',
    });
  });

  it('matches a glob pattern (* and ?)', () => {
    const cfg = ['Host *.internal', '  HostName bastion.example', '  User svc'].join('\n');
    expect(resolve('db1.internal', cfg)).toMatchObject({
      hostName: 'bastion.example',
      user: 'svc',
    });
    const qCfg = ['Host web?', '  HostName web-pool'].join('\n');
    expect(resolve('web3', qCfg)).toMatchObject({ hostName: 'web-pool' });
    expect(resolve('web30', qCfg)).toEqual({});
  });

  it('honors negation: a matching ! pattern excludes the block', () => {
    const cfg = ['Host *.internal !secret.internal', '  HostName shared'].join('\n');
    expect(resolve('app.internal', cfg)).toMatchObject({ hostName: 'shared' });
    expect(resolve('secret.internal', cfg)).toEqual({});
  });

  it('returns {} on a missing/unreadable config file (never throws)', () => {
    expect(resolveSshConfig('anything', { configPath: join(tmp, 'nope'), home })).toEqual({});
  });

  it('returns {} when no Host block matches (plain host unchanged — FR4)', () => {
    const cfg = ['Host prod', '  HostName 10.0.0.5'].join('\n');
    expect(resolve('192.168.1.10', cfg)).toEqual({});
  });

  it('expands a leading ~ in IdentityFile against the home dir', () => {
    const cfg = ['Host gw', '  HostName gw.example', '  IdentityFile ~/.ssh/id_gw'].join('\n');
    expect(resolve('gw', cfg)).toMatchObject({
      identityFile: join(home, '.ssh', 'id_gw'),
    });
  });

  it('applies ssh_config first-value-wins across matching blocks', () => {
    const cfg = [
      'Host prod',
      '  HostName first.example',
      '  User alice',
      'Host *',
      '  HostName second.example',
      '  User bob',
      '  Port 2200',
    ].join('\n');
    // `prod` matches both blocks; the first HostName/User win, but Port comes
    // from the later wildcard block since the first did not set it.
    expect(resolve('prod', cfg)).toEqual({
      hostName: 'first.example',
      user: 'alice',
      port: 2200,
    });
  });

  it('parses the Keyword=value form and ignores comments', () => {
    const cfg = ['Host prod # the prod box', '  HostName=10.0.0.9', '  # Port 9999', '  Port=22'].join(
      '\n',
    );
    expect(resolve('prod', cfg)).toEqual({ hostName: '10.0.0.9', port: 22 });
  });

  it('ignores out-of-scope keywords (ProxyJump, Match, …)', () => {
    const cfg = [
      'Host prod',
      '  ProxyJump bastion',
      '  HostName 10.0.0.5',
      '  ServerAliveInterval 30',
    ].join('\n');
    expect(resolve('prod', cfg)).toEqual({ hostName: '10.0.0.5' });
  });
});
