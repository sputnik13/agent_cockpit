import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:child_process so we can drive the sysctl/arch probes deterministically
// without touching the host. The factory returns a vi.fn we reconfigure per test.
const spawnSync = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync }));

import { withNativeArch, __resetNativeArchCacheForTests } from './nativeArch';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  spawnSync.mockReset();
  __resetNativeArchCacheForTests();
});
afterEach(() => {
  setPlatform(realPlatform);
  __resetNativeArchCacheForTests();
});

describe('withNativeArch', () => {
  it('is identity on non-macOS regardless of probes', () => {
    setPlatform('linux');
    const out = withNativeArch('tmux', ['-V']);
    expect(out).toEqual({ file: 'tmux', args: ['-V'] });
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('rewrites to arch -arm64 when translated and the probe succeeds', () => {
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sysctl') return { status: 0, stdout: '1\n' };
      if (cmd === 'arch' && args[0] === '-arm64') return { status: 0 };
      return { status: 1 };
    });
    const out = withNativeArch('tmux', ['-L', 'agent-cockpit', '-CC']);
    expect(out).toEqual({ file: 'arch', args: ['-arm64', 'tmux', '-L', 'agent-cockpit', '-CC'] });
  });

  it('wraps a start-server spawn when translated (server-creating, not a query)', () => {
    // tmuxControl.open() runs `start-server ; set -g …` to materialize the shared
    // server BEFORE the `-CC new-session`. That server forks every pane, so it
    // must be born native: a start-server argv must be rewritten, not left alone.
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sysctl') return { status: 0, stdout: '1\n' };
      if (cmd === 'arch' && args[0] === '-arm64') return { status: 0 };
      return { status: 1 };
    });
    const out = withNativeArch('tmux', ['-L', 'agent-cockpit', 'start-server', ';', 'set']);
    expect(out).toEqual({
      file: 'arch',
      args: ['-arm64', 'tmux', '-L', 'agent-cockpit', 'start-server', ';', 'set'],
    });
  });

  it('is identity when NOT translated (native arm64 / Intel)', () => {
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string) =>
      cmd === 'sysctl' ? { status: 0, stdout: '0\n' } : { status: 0 },
    );
    expect(withNativeArch('tmux', [])).toEqual({ file: 'tmux', args: [] });
  });

  it('is identity when sysctl key is absent (non-zero status)', () => {
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string) =>
      cmd === 'sysctl' ? { status: 1, stdout: '' } : { status: 0 },
    );
    expect(withNativeArch('zsh', [])).toEqual({ file: 'zsh', args: [] });
  });

  it('is identity when translated but the arch -arm64 probe fails', () => {
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'sysctl') return { status: 0, stdout: '1' };
      return { status: 1 }; // arch -arm64 true fails
    });
    expect(withNativeArch('tmux', ['-V'])).toEqual({ file: 'tmux', args: ['-V'] });
  });

  it('memoizes the decision (probes run once across calls)', () => {
    setPlatform('darwin');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'sysctl') return { status: 0, stdout: '1' };
      if (cmd === 'arch' && args[0] === '-arm64') return { status: 0 };
      return { status: 1 };
    });
    withNativeArch('tmux', []);
    const callsAfterFirst = spawnSync.mock.calls.length;
    withNativeArch('zsh', []);
    expect(spawnSync.mock.calls.length).toBe(callsAfterFirst);
  });
});
