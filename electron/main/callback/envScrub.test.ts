import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalPaneEnv } from '@shared/tmux/terminalConfig';
import { CALLBACK_TMUX_ENV_NAMES } from '@shared/callback/env';
import { isCallbackEnvName, scrubCallbackEnv, withoutCallbackEnv } from './envScrub';

const INHERITED = {
  COCKPIT_CALLBACK_SOCK: '/Users/me/Library/Application Support/Agent Cockpit/callback/abc.sock',
  COCKPIT_CALLBACK_VERSION: '1',
  COCKPIT_CALLBACK_MUX_KEY: 'term-1',
  COCKPIT_CALLBACK_FUTURE_SETTING: 'x',
  COCKPIT_CLI: '/Users/me/Library/Application Support/Agent Cockpit/callback/bin/cockpit',
};

const KEPT = {
  COCKPIT_MUX_HOME: '/tmp/mux-home',
  COCKPIT_MUX_BIN: '/tmp/mux-bin',
  COCKPIT_MUX_EPHEMERAL: '1',
  COCKPIT_PLAYWRIGHT_HEADLESS: '1',
  AC_TMUX_SOCKET: 'isolated',
  PATH: '/usr/bin:/bin',
  // Lookalikes that are NOT callback variables.
  COCKPIT_CLIENT: 'x',
  COCKPIT_CLI_EXTRA: 'x',
  COCKPIT_CALLBACK: 'x',
  cockpit_cli: 'x',
};

describe('startup environment scrub (scenario 10, scrub assertions)', () => {
  it('removes every COCKPIT_CALLBACK_* variable and COCKPIT_CLI, and reports only their names', () => {
    const env: NodeJS.ProcessEnv = { ...INHERITED, ...KEPT };
    const removed = scrubCallbackEnv(env);
    expect(removed).toEqual(Object.keys(INHERITED).sort());
    for (const name of Object.keys(INHERITED)) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(removed)).not.toContain('Agent Cockpit'); // names, never values
  });

  it('keeps the deliberate isolation overrides and everything else', () => {
    const env: NodeJS.ProcessEnv = { ...INHERITED, ...KEPT };
    scrubCallbackEnv(env);
    expect(env).toEqual(KEPT);
    for (const name of ['COCKPIT_MUX_HOME', 'COCKPIT_MUX_BIN', 'COCKPIT_MUX_EPHEMERAL']) {
      expect(env[name]).toBe(KEPT[name as keyof typeof KEPT]);
    }
  });

  it('is unconditional: nothing in the environment or settings gates it', () => {
    for (const gate of [
      {},
      { AC_TMUX_EPHEMERAL: '1' },
      { COCKPIT_MUX_EPHEMERAL: '1' },
      { AC_TMUX_EPHEMERAL: '1', COCKPIT_MUX_EPHEMERAL: '1' },
    ]) {
      const env: NodeJS.ProcessEnv = { ...INHERITED, ...gate };
      expect(scrubCallbackEnv(env)).toEqual(Object.keys(INHERITED).sort());
      expect(env).toEqual(gate);
    }
  });

  it('is a no-op on a clean environment', () => {
    const env: NodeJS.ProcessEnv = { ...KEPT };
    expect(scrubCallbackEnv(env)).toEqual([]);
    expect(env).toEqual(KEPT);
  });

  describe('against the real process.env', () => {
    afterEach(() => {
      for (const name of Object.keys(INHERITED)) delete process.env[name];
    });

    it('defaults to process.env', () => {
      Object.assign(process.env, INHERITED);
      expect(scrubCallbackEnv()).toEqual(Object.keys(INHERITED).sort());
      for (const name of Object.keys(INHERITED)) expect(process.env[name]).toBeUndefined();
    });

    it('leaves nothing for a spawned terminal to inherit (no cross-app callback)', () => {
      Object.assign(process.env, INHERITED);
      scrubCallbackEnv();
      const paneEnv = terminalPaneEnv(process.env);
      for (const name of Object.keys(paneEnv)) {
        expect(name === 'COCKPIT_CLI' || name.startsWith('COCKPIT_CALLBACK_')).toBe(false);
      }
    });
  });

  describe('startup wiring', () => {
    const mainSource = (): string => readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');

    afterEach(() => {
      for (const name of [...Object.keys(INHERITED), 'COCKPIT_MUX_HOME']) delete process.env[name];
    });

    it('scrubs process.env as a side effect of importing the startup module, and reports the names', async () => {
      Object.assign(process.env, INHERITED, { COCKPIT_MUX_HOME: '/tmp/mux-home-kept' });
      vi.resetModules();
      const startup = await import('./startupScrub');
      expect(startup.scrubbedCallbackEnv).toEqual(Object.keys(INHERITED).sort());
      for (const name of Object.keys(INHERITED)) expect(process.env[name]).toBeUndefined();
      expect(process.env['COCKPIT_MUX_HOME']).toBe('/tmp/mux-home-kept');
    });

    it('is the FIRST import of main, so it runs before any other module is evaluated', () => {
      const source = mainSource();
      const first = /^import\s[^;]*?from\s+'([^']+)';/m.exec(source);
      expect(first?.[1]).toBe('./callback/startupScrub');
      // The scrub itself lives in that module; the entry only reads its result.
      expect(source).not.toMatch(/\bscrubCallbackEnv\(/);
      expect(source.match(/from '\.\/callback\/startupScrub'/g)).toHaveLength(1);
      expect(source.indexOf("from './callback/startupScrub'")).toBeLessThan(
        source.indexOf("from 'electron'"),
      );
    });

    it('evaluates the scrub at module scope of the startup module, with no gate', () => {
      const startup = readFileSync(join(__dirname, 'startupScrub.ts'), 'utf8');
      expect(startup).toMatch(/^export const scrubbedCallbackEnv[^=]*= scrubCallbackEnv\(\);$/m);
    });

    it('stops every callback listener again at will-quit, as an idempotent backstop to closeAll', () => {
      const quit = /app\.on\('will-quit', \(\) => \{([\s\S]*?)\n\}\);/.exec(mainSource());
      expect(quit?.[1]).toContain('sessionManager.closeAll()');
      expect(quit?.[1]).toContain('callbackBroker.stopAll()');
    });
  });
});

describe('withoutCallbackEnv (the environment of a spawn that must carry none)', () => {
  it('returns a COPY without any callback variable, keeping everything else', () => {
    const env: NodeJS.ProcessEnv = { ...INHERITED, ...KEPT };
    const copy = withoutCallbackEnv(env);
    expect(copy).toEqual(KEPT);
    expect(copy).not.toBe(env);
    // The source is left alone (unlike the startup scrub, which mutates process.env).
    for (const name of Object.keys(INHERITED)) expect(env).toHaveProperty(name);
  });

  it('removes the same names the startup scrub removes', () => {
    const copy = withoutCallbackEnv({ ...INHERITED, ...KEPT });
    const scrubbed: NodeJS.ProcessEnv = { ...INHERITED, ...KEPT };
    scrubCallbackEnv(scrubbed);
    expect(copy).toEqual(scrubbed);
  });

  it('removes every variable the app injects (tmux set and the mux key)', () => {
    for (const name of [...CALLBACK_TMUX_ENV_NAMES, 'COCKPIT_CALLBACK_MUX_KEY']) {
      expect(isCallbackEnvName(name)).toBe(true);
      expect(withoutCallbackEnv({ [name]: 'x', PATH: '/bin' })).toEqual({ PATH: '/bin' });
    }
  });

  it('keeps lookalikes and the deliberate isolation overrides', () => {
    for (const name of Object.keys(KEPT)) expect(isCallbackEnvName(name)).toBe(false);
  });

  it('defaults to process.env without mutating it', () => {
    Object.assign(process.env, INHERITED);
    try {
      const copy = withoutCallbackEnv();
      for (const name of Object.keys(INHERITED)) {
        expect(copy[name]).toBeUndefined();
        expect(process.env[name]).toBe(INHERITED[name as keyof typeof INHERITED]);
      }
    } finally {
      for (const name of Object.keys(INHERITED)) delete process.env[name];
    }
  });
});
