import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SESSION_IDLE_TIMEOUT_MAX_MIN,
  normalizeSettings,
} from './settings';

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
