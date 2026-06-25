import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SESSION_IDLE_TIMEOUT_MAX_MIN,
  WORKGRAPH_COLUMNS_SOFT_CAP_MAX,
  normalizeSettings,
} from './settings';

describe('normalizeSettings — workgraphColumnsSoftCap bounds', () => {
  it('defaults to 2 when absent', () => {
    expect(normalizeSettings({}).workgraphColumnsSoftCap).toBe(2);
    expect(DEFAULT_SETTINGS.workgraphColumnsSoftCap).toBe(2);
  });
  it('keeps a valid value and floors fractionals', () => {
    expect(normalizeSettings({ workgraphColumnsSoftCap: 3 }).workgraphColumnsSoftCap).toBe(3);
    expect(normalizeSettings({ workgraphColumnsSoftCap: 3.9 }).workgraphColumnsSoftCap).toBe(3);
  });
  it('clamps above the max and rejects < 1 / non-numbers to the default', () => {
    expect(normalizeSettings({ workgraphColumnsSoftCap: 99 }).workgraphColumnsSoftCap).toBe(
      WORKGRAPH_COLUMNS_SOFT_CAP_MAX,
    );
    expect(normalizeSettings({ workgraphColumnsSoftCap: 0 }).workgraphColumnsSoftCap).toBe(2);
    expect(
      normalizeSettings({ workgraphColumnsSoftCap: '3' as unknown as number }).workgraphColumnsSoftCap,
    ).toBe(2);
  });
});

describe('normalizeSettings — tmuxPauseMode', () => {
  it('defaults to false (opt-in)', () => {
    expect(normalizeSettings({}).tmuxPauseMode).toBe(false);
    expect(DEFAULT_SETTINGS.tmuxPauseMode).toBe(false);
  });
  it('is true only for an exact boolean true', () => {
    expect(normalizeSettings({ tmuxPauseMode: true }).tmuxPauseMode).toBe(true);
    expect(normalizeSettings({ tmuxPauseMode: 'yes' as unknown as boolean }).tmuxPauseMode).toBe(
      false,
    );
  });
});

describe('normalizeSettings — tmuxFormatSubscriptions', () => {
  it('defaults to false (opt-in)', () => {
    expect(normalizeSettings({}).tmuxFormatSubscriptions).toBe(false);
    expect(DEFAULT_SETTINGS.tmuxFormatSubscriptions).toBe(false);
  });
  it('is true only for an exact boolean true', () => {
    expect(normalizeSettings({ tmuxFormatSubscriptions: true }).tmuxFormatSubscriptions).toBe(true);
    expect(
      normalizeSettings({ tmuxFormatSubscriptions: 1 as unknown as boolean }).tmuxFormatSubscriptions,
    ).toBe(false);
  });
});

describe('normalizeSettings — wrapLines', () => {
  it('defaults to false (horizontal scroll)', () => {
    expect(normalizeSettings({}).wrapLines).toBe(false);
    expect(DEFAULT_SETTINGS.wrapLines).toBe(false);
  });
  it('is true only for an exact boolean true', () => {
    expect(normalizeSettings({ wrapLines: true }).wrapLines).toBe(true);
    expect(normalizeSettings({ wrapLines: 'on' as unknown as boolean }).wrapLines).toBe(false);
  });
});

describe('normalizeSettings — sessionIdleTimeoutMin bounds', () => {
  it('defaults to 20 when absent', () => {
    expect(normalizeSettings({}).sessionIdleTimeoutMin).toBe(20);
    expect(DEFAULT_SETTINGS.sessionIdleTimeoutMin).toBe(20);
  });

  it('keeps 0 (disabled) verbatim', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: 0 }).sessionIdleTimeoutMin).toBe(0);
  });

  it('keeps a valid in-range value', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: 45 }).sessionIdleTimeoutMin).toBe(45);
  });

  it('floors fractional values to an integer', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: 12.9 }).sessionIdleTimeoutMin).toBe(12);
  });

  it('clamps to the upper sanity bound', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: 99999 }).sessionIdleTimeoutMin).toBe(
      SESSION_IDLE_TIMEOUT_MAX_MIN,
    );
  });

  it('rejects negatives -> default', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: -5 }).sessionIdleTimeoutMin).toBe(20);
  });

  it('rejects non-numbers -> default', () => {
    expect(normalizeSettings({ sessionIdleTimeoutMin: '30' as unknown as number }).sessionIdleTimeoutMin).toBe(20);
    expect(normalizeSettings({ sessionIdleTimeoutMin: NaN }).sessionIdleTimeoutMin).toBe(20);
    expect(normalizeSettings({ sessionIdleTimeoutMin: Infinity }).sessionIdleTimeoutMin).toBe(20);
  });
});

describe('normalizeSettings — showRunPanel', () => {
  it('defaults to false when absent', () => {
    expect(normalizeSettings({}).showRunPanel).toBe(false);
    expect(DEFAULT_SETTINGS.showRunPanel).toBe(false);
  });

  it('keeps true verbatim', () => {
    expect(normalizeSettings({ showRunPanel: true }).showRunPanel).toBe(true);
  });

  it('coerces non-true (incl. truthy non-boolean) to false', () => {
    expect(normalizeSettings({ showRunPanel: false }).showRunPanel).toBe(false);
    expect(normalizeSettings({ showRunPanel: 1 as unknown as boolean }).showRunPanel).toBe(false);
    expect(normalizeSettings({ showRunPanel: 'yes' as unknown as boolean }).showRunPanel).toBe(false);
  });
});

describe('normalizeSettings — byobuKeybindings', () => {
  it('defaults to false when absent', () => {
    expect(normalizeSettings({}).byobuKeybindings).toBe(false);
    expect(DEFAULT_SETTINGS.byobuKeybindings).toBe(false);
  });

  it('keeps true verbatim', () => {
    expect(normalizeSettings({ byobuKeybindings: true }).byobuKeybindings).toBe(true);
  });

  it('coerces non-true (incl. truthy non-boolean) to false', () => {
    expect(normalizeSettings({ byobuKeybindings: false }).byobuKeybindings).toBe(false);
    expect(normalizeSettings({ byobuKeybindings: 1 as unknown as boolean }).byobuKeybindings).toBe(false);
  });
});

describe('normalizeSettings — devEnv', () => {
  it('defaults to systemd-scope at 16384 MB when absent', () => {
    expect(normalizeSettings({}).devEnv).toEqual({ mode: 'systemd-scope', memoryMaxMb: 16384 });
    expect(DEFAULT_SETTINGS.devEnv).toEqual({ mode: 'systemd-scope', memoryMaxMb: 16384 });
  });

  it('keeps a valid mode + memory', () => {
    expect(normalizeSettings({ devEnv: { mode: 'tmux', memoryMaxMb: 8192 } }).devEnv).toEqual({
      mode: 'tmux',
      memoryMaxMb: 8192,
    });
  });

  it('falls back the mode on an unknown value (incl. reserved devcontainer)', () => {
    expect(normalizeSettings({ devEnv: { mode: 'devcontainer' } }).devEnv.mode).toBe('systemd-scope');
    expect(normalizeSettings({ devEnv: { mode: 'nonsense' } }).devEnv.mode).toBe('systemd-scope');
  });

  it('rejects an out-of-range / non-numeric memory cap and floors fractions', () => {
    expect(normalizeSettings({ devEnv: { mode: 'systemd-scope', memoryMaxMb: 0 } }).devEnv.memoryMaxMb).toBe(16384);
    expect(normalizeSettings({ devEnv: { mode: 'systemd-scope', memoryMaxMb: 10 } }).devEnv.memoryMaxMb).toBe(16384);
    expect(
      normalizeSettings({ devEnv: { mode: 'systemd-scope', memoryMaxMb: 'lots' as unknown as number } }).devEnv
        .memoryMaxMb,
    ).toBe(16384);
    expect(normalizeSettings({ devEnv: { mode: 'systemd-scope', memoryMaxMb: 4096.7 } }).devEnv.memoryMaxMb).toBe(4096);
  });
});

describe('normalizeSettings — terminalRenderer', () => {
  it('defaults to dom when absent or unknown', () => {
    expect(normalizeSettings({}).terminalRenderer).toBe('dom');
    expect(normalizeSettings({ terminalRenderer: 'nope' as never }).terminalRenderer).toBe('dom');
    expect(DEFAULT_SETTINGS.terminalRenderer).toBe('dom');
  });
  it('preserves dom / webgl (xterm adapter) and accepts wterm', () => {
    expect(normalizeSettings({ terminalRenderer: 'dom' }).terminalRenderer).toBe('dom');
    expect(normalizeSettings({ terminalRenderer: 'webgl' }).terminalRenderer).toBe('webgl');
    expect(normalizeSettings({ terminalRenderer: 'wterm' }).terminalRenderer).toBe('wterm');
  });
});

describe('normalizeSettings — followTerminalCwd', () => {
  it('defaults to false when absent', () => {
    expect(normalizeSettings({}).followTerminalCwd).toBe(false);
    expect(DEFAULT_SETTINGS.followTerminalCwd).toBe(false);
  });

  it('keeps true verbatim', () => {
    expect(normalizeSettings({ followTerminalCwd: true }).followTerminalCwd).toBe(true);
  });

  it('coerces non-true (incl. truthy non-boolean) to false', () => {
    expect(normalizeSettings({ followTerminalCwd: false }).followTerminalCwd).toBe(false);
    expect(normalizeSettings({ followTerminalCwd: 1 as unknown as boolean }).followTerminalCwd).toBe(false);
    expect(normalizeSettings({ followTerminalCwd: 'yes' as unknown as boolean }).followTerminalCwd).toBe(false);
  });
});
