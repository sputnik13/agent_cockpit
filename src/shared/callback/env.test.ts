/**
 * The terminal-environment contract (docs/design/terminal-callback-socket.md,
 * "Environment injection"; requirements 6 and 13 of docs/requirements/terminal-callback-socket.md): which variables exist, how they map onto
 * tmux `update-environment` elements, and the validated per-project value set.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCallbackEnvironment,
  CALLBACK_SOCK_ENV,
  CALLBACK_TMUX_ENV_NAMES,
  CALLBACK_UPDATE_ENVIRONMENT_FIRST_INDEX,
  CALLBACK_VERSION_ENV,
  callbackEnvironmentEntries,
  callbackMuxOperands,
  callbackUpdateEnvironmentOption,
  NO_CALLBACK_ENVIRONMENT,
} from './env';
import {
  CALLBACK_CLI_ENV,
  CALLBACK_ENV_PREFIX,
  CALLBACK_MUX_KEY_ENV,
  CALLBACK_PROTOCOL_VERSION,
} from './protocol';

const SOCK = '/Users/me/Library/Application Support/Agent Cockpit/callback/0123456789ab.sock';
const CLI = '/Users/me/Library/Application Support/Agent Cockpit/callback/bin/cockpit';

describe('callback environment names', () => {
  it('are exactly the three tmux variables, in update-environment index order', () => {
    expect(CALLBACK_TMUX_ENV_NAMES).toEqual([
      'COCKPIT_CALLBACK_SOCK',
      'COCKPIT_CALLBACK_VERSION',
      'COCKPIT_CLI',
    ]);
  });

  it('keep the mux key OUT of the tmux set (mux only; it never goes through tmux)', () => {
    expect(CALLBACK_TMUX_ENV_NAMES as readonly string[]).not.toContain(CALLBACK_MUX_KEY_ENV);
    expect(CALLBACK_MUX_KEY_ENV).toBe('COCKPIT_CALLBACK_MUX_KEY');
  });

  it('all fall under the names the startup scrub removes', () => {
    for (const name of CALLBACK_TMUX_ENV_NAMES) {
      expect(name === CALLBACK_CLI_ENV || name.startsWith(CALLBACK_ENV_PREFIX)).toBe(true);
    }
    expect(CALLBACK_MUX_KEY_ENV.startsWith(CALLBACK_ENV_PREFIX)).toBe(true);
  });
});

describe('tmux update-environment elements (requirement 13)', () => {
  it('give each name its own indexed element, [100], [101], [102]', () => {
    expect(CALLBACK_UPDATE_ENVIRONMENT_FIRST_INDEX).toBe(100);
    expect(callbackUpdateEnvironmentOption('COCKPIT_CALLBACK_SOCK')).toBe(
      'update-environment[100]',
    );
    expect(callbackUpdateEnvironmentOption('COCKPIT_CALLBACK_VERSION')).toBe(
      'update-environment[101]',
    );
    expect(callbackUpdateEnvironmentOption('COCKPIT_CLI')).toBe('update-environment[102]');
  });

  it('never collide with the low indices tmux uses for its own defaults', () => {
    for (const name of CALLBACK_TMUX_ENV_NAMES) {
      const index = Number(/\[(\d+)\]/.exec(callbackUpdateEnvironmentOption(name))![1]);
      expect(index).toBeGreaterThan(50);
    }
  });
});

describe('buildCallbackEnvironment', () => {
  it('assembles the three variables; the version is the protocol constant', () => {
    const environment = buildCallbackEnvironment({ sock: SOCK, cli: CLI });
    expect(environment).toEqual({
      vars: {
        COCKPIT_CALLBACK_SOCK: SOCK,
        COCKPIT_CALLBACK_VERSION: String(CALLBACK_PROTOCOL_VERSION),
        COCKPIT_CLI: CLI,
      },
    });
    expect(environment?.vars[CALLBACK_VERSION_ENV]).toBe('1');
  });

  it('accepts any character a path can carry, except NUL and line breaks', () => {
    for (const awkward of [
      "/tmp/My Apps/$HOME;~#'x'/a.sock",
      '/tmp/日本語 émoji 🙂/a.sock',
      '/tmp/back\\slash "dq" `bt` {b} [r] *?!%/a.sock',
      '  leading and trailing  ',
    ]) {
      expect(buildCallbackEnvironment({ sock: awkward, cli: CLI })?.vars[CALLBACK_SOCK_ENV]).toBe(
        awkward,
      );
    }
  });

  it('refuses to build a partial or unusable set', () => {
    for (const bad of ['', 'a\0b', 'a\nb', 'a\r\nb', 'trailing\n']) {
      expect(buildCallbackEnvironment({ sock: bad, cli: CLI })).toBeUndefined();
      expect(buildCallbackEnvironment({ sock: SOCK, cli: bad })).toBeUndefined();
    }
  });
});

describe('callbackEnvironmentEntries', () => {
  it('lists the pairs in the fixed index order', () => {
    const environment = buildCallbackEnvironment({ sock: SOCK, cli: CLI })!;
    expect(callbackEnvironmentEntries(environment)).toEqual([
      ['COCKPIT_CALLBACK_SOCK', SOCK],
      ['COCKPIT_CALLBACK_VERSION', '1'],
      ['COCKPIT_CLI', CLI],
    ]);
  });
});

describe('callbackMuxOperands (the env operands of the mux trampoline)', () => {
  const environment = buildCallbackEnvironment({ sock: SOCK, cli: CLI })!;

  it('are NAME=value argv elements: the project variables, then the app-chosen terminal key', () => {
    expect(callbackMuxOperands(environment, 'term-7')).toEqual([
      `COCKPIT_CALLBACK_SOCK=${SOCK}`,
      'COCKPIT_CALLBACK_VERSION=1',
      `COCKPIT_CLI=${CLI}`,
      'COCKPIT_CALLBACK_MUX_KEY=term-7',
    ]);
  });

  it('keep spaces inside one operand (argv, not a shell string)', () => {
    const operands = callbackMuxOperands(environment, 'k')!;
    expect(operands).toHaveLength(4);
    expect(operands[0]).toContain('Application Support');
  });

  it('are refused for an empty or non-injectable key', () => {
    expect(callbackMuxOperands(environment, '')).toBeUndefined();
    expect(callbackMuxOperands(environment, 'a\nb')).toBeUndefined();
    expect(callbackMuxOperands(environment, 'a\0b')).toBeUndefined();
  });
});

describe('NO_CALLBACK_ENVIRONMENT', () => {
  it('supplies nothing', () => {
    expect(NO_CALLBACK_ENVIRONMENT()).toBeUndefined();
  });
});
