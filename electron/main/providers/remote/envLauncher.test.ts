import { describe, it, expect, vi } from 'vitest';
import type { DevEnvConfig } from '@shared/settings';
import {
  createEnvLauncher,
  systemdScopeWrap,
  preflightReason,
  EnvLauncherError,
  DEV_ENV_SCOPE_UNIT,
  type EnvLauncherContext,
} from './envLauncher';

const SERVER_CMD = 'tmux -L agent-cockpit start-server \\; set -g exit-empty off \\; set -g history-limit 5000';

function fakeCtx(probeStdout: string): { ctx: EnvLauncherContext; calls: string[] } {
  const calls: string[] = [];
  const exec = vi.fn(async (cmd: string) => {
    calls.push(cmd);
    if (cmd.includes('stat -fc')) return { stdout: probeStdout, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  });
  return {
    ctx: { transport: { exec }, scopeUnit: DEV_ENV_SCOPE_UNIT, hostLabel: 'me@host', serverStartCmd: SERVER_CMD },
    calls,
  };
}

const CAPABLE = 'cg=cgroup2fs\nVersion=257\nLinger=yes\n';

describe('systemdScopeWrap', () => {
  it('builds the --user scope wrapper with cap + OOMPolicy + bus-denial', () => {
    const s = systemdScopeWrap({ scopeUnit: 'cockpit-devenv', memoryMaxMb: 16384 }, SERVER_CMD);
    expect(s).toContain('systemd-run --user --scope --unit=cockpit-devenv');
    expect(s).toContain('-p MemoryMax=16384M');
    expect(s).toContain('-p MemorySwapMax=0');
    expect(s).toContain('-p TasksMax=512');
    // surgical OOM: kill the runaway, keep the server alive
    expect(s).toContain('-p OOMPolicy=continue');
    // deny tmux the systemd bus so panes can't escape into tmux-spawn-*.scope
    expect(s).toContain('env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR BYOBU_DISABLE=1');
    expect(s.endsWith(SERVER_CMD)).toBe(true);
  });
});

describe('preflightReason', () => {
  it('passes (null) on a capable host', () => {
    expect(preflightReason(CAPABLE)).toBeNull();
  });
  it('flags missing cgroup v2', () => {
    expect(preflightReason('cg=tmpfs\nVersion=257\nLinger=yes')).toMatch(/cgroup v2/);
  });
  it('flags unreachable user bus', () => {
    expect(preflightReason('cg=cgroup2fs\nVersion=\nLinger=yes')).toMatch(/user bus/);
  });
  it('flags lingering off with the fix', () => {
    expect(preflightReason('cg=cgroup2fs\nVersion=257\nLinger=no')).toMatch(/enable-linger/);
  });
});

describe('createEnvLauncher', () => {
  const dev = (mode: string, memoryMaxMb = 16384): DevEnvConfig =>
    ({ mode, memoryMaxMb }) as DevEnvConfig;

  it('tmux mode: ensure is a no-op, wrapExec is identity', async () => {
    const { ctx, calls } = fakeCtx(CAPABLE);
    const l = createEnvLauncher(dev('tmux'), ctx);
    await l.ensure();
    expect(calls).toEqual([]); // no exec at all
    expect(l.wrapExec('X')).toBe('X');
  });

  it('systemd-scope on a capable host: probes then issues the capped server start', async () => {
    const { ctx, calls } = fakeCtx(CAPABLE);
    const l = createEnvLauncher(dev('systemd-scope', 16384), ctx);
    await l.ensure();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('stat -fc'); // preflight probe
    expect(calls[1]).toContain('is-active cockpit-devenv.scope');
    expect(calls[1]).toContain('systemd-run --user --scope --unit=cockpit-devenv');
    expect(calls[1]).toContain('-p MemoryMax=16384M');
    expect(l.wrapExec('X')).toBe('X'); // identity (cap is on the server)
  });

  it('systemd-scope on an uncapable host: falls back (no systemd-run) without throwing', async () => {
    const { ctx, calls } = fakeCtx('cg=cgroup2fs\nVersion=257\nLinger=no\n');
    const l = createEnvLauncher(dev('systemd-scope'), ctx);
    await expect(l.ensure()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1); // only the probe; no scope start
    expect(calls[0]).toContain('stat -fc');
  });

  it('devcontainer (reserved) throws not-implemented', async () => {
    const { ctx } = fakeCtx(CAPABLE);
    const l = createEnvLauncher(dev('devcontainer'), ctx);
    await expect(l.ensure()).rejects.toBeInstanceOf(EnvLauncherError);
    await expect(l.ensure()).rejects.toMatchObject({ phase: 'not-implemented' });
  });
});
