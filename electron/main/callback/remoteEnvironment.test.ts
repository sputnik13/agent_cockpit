import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { remoteCallbackEnvironmentSource } from './remoteEnvironment';

const SOCK = '/run/user/1000/agent-cockpit/callback/aaaaaaaa-bbbbbbbbbbbb.sock';
const CLI = '/home/deploy/.agent-cockpit/bin/linux-amd64/cockpit';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('remote callback environment (from the helper handshake)', () => {
  it('describes the three tmux variables with the helper-reported host paths', () => {
    const source = remoteCallbackEnvironmentSource('p', {
      helperValues: () => ({ callbackSock: SOCK, cliPath: CLI }),
    });
    expect(source()?.vars).toEqual({
      COCKPIT_CALLBACK_SOCK: SOCK,
      COCKPIT_CALLBACK_VERSION: '1',
      COCKPIT_CLI: CLI,
    });
  });

  it('supplies nothing when the helper reported no socket or no CLI', () => {
    for (const values of [
      {},
      { callbackSock: SOCK },
      { cliPath: CLI },
      { callbackSock: '', cliPath: CLI },
      { callbackSock: SOCK, cliPath: '' },
    ]) {
      expect(
        remoteCallbackEnvironmentSource('p', { helperValues: () => values })(),
      ).toBeUndefined();
    }
  });

  it('supplies nothing without a live helper (not connected, disconnected, or its stream ended)', () => {
    expect(
      remoteCallbackEnvironmentSource('p', { helperValues: () => undefined })(),
    ).toBeUndefined();
  });

  it('reads the values at every evaluation, never caching them', () => {
    let values: { callbackSock?: string; cliPath?: string } | undefined;
    const source = remoteCallbackEnvironmentSource('p', { helperValues: () => values });
    expect(source()).toBeUndefined();
    values = { callbackSock: SOCK, cliPath: CLI };
    expect(source()).toBeDefined();
    values = undefined; // the helper went away
    expect(source()).toBeUndefined();
  });

  it('refuses a value that cannot be injected, with one log line per project', () => {
    const warn = vi.spyOn(logger, 'warn');
    const source = remoteCallbackEnvironmentSource('p', {
      helperValues: () => ({ callbackSock: '/tmp/a\nb.sock', cliPath: CLI }),
    });
    expect(source()).toBeUndefined();
    expect(source()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('reason=not-injectable');
  });

  it('accepts spaces and shell metacharacters (they travel as argv or quoted tmux arguments)', () => {
    const source = remoteCallbackEnvironmentSource('p', {
      helperValues: () => ({
        callbackSock: "/home/it's me/$x;y/a b.sock",
        cliPath: "/home/it's me/cockpit",
      }),
    });
    expect(source()?.vars.COCKPIT_CALLBACK_SOCK).toBe("/home/it's me/$x;y/a b.sock");
  });
});
