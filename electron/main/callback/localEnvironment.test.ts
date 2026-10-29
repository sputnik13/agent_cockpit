/**
 * The provider-side "callback environment for this project" of a LOCAL session
 * (docs/design/terminal-callback-socket.md, "Environment injection"), against
 * fakes: the broker's live socket plus the CLI the app links, evaluated at every
 * terminal creation, `undefined` while no listener is bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe, type LogEntry } from '../logger';
import { localCallbackEnvironmentSource, localCliPath } from './localEnvironment';

const USER_DATA = '/Users/me/Library/Application Support/Agent Cockpit';
const SOCK = `${USER_DATA}/callback/0123456789ab.sock`;

let logs: LogEntry[];
let unsubscribe: () => void;
beforeEach(() => {
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe('localCliPath', () => {
  it('is <userData>/callback/bin/cockpit, spaces and all', () => {
    expect(localCliPath(USER_DATA)).toBe(`${USER_DATA}/callback/bin/cockpit`);
  });

  it('is absolute and normalized', () => {
    expect(localCliPath('/a/b/../c/')).toBe('/a/c/callback/bin/cockpit');
  });
});

describe('localCallbackEnvironmentSource', () => {
  it('has nothing while the project has no bound listener (callback disabled or never started)', () => {
    const source = localCallbackEnvironmentSource('p1', {
      localSocketPath: () => null,
      userDataDir: () => USER_DATA,
    });
    expect(source()).toBeUndefined();
  });

  it('is the bound socket, the protocol version and the linked CLI once the listener is up', () => {
    const asked: string[] = [];
    const source = localCallbackEnvironmentSource('p1', {
      localSocketPath: (id) => {
        asked.push(id);
        return SOCK;
      },
      userDataDir: () => USER_DATA,
    });
    expect(source()).toEqual({
      vars: {
        COCKPIT_CALLBACK_SOCK: SOCK,
        COCKPIT_CALLBACK_VERSION: '1',
        COCKPIT_CLI: `${USER_DATA}/callback/bin/cockpit`,
      },
    });
    expect(asked).toEqual(['p1']); // exactly this project's socket, never another's
  });

  it('is evaluated at every call, so a listener that rebinds reaches the next terminal', () => {
    let socket: string | null = null;
    const source = localCallbackEnvironmentSource('p1', {
      localSocketPath: () => socket,
      userDataDir: () => USER_DATA,
    });
    expect(source()).toBeUndefined();
    socket = SOCK;
    expect(source()?.vars.COCKPIT_CALLBACK_SOCK).toBe(SOCK);
    socket = `${USER_DATA}/callback/ffffffffffff.sock`;
    expect(source()?.vars.COCKPIT_CALLBACK_SOCK).toBe(socket);
    socket = null; // the session ended
    expect(source()).toBeUndefined();
  });

  it('reads userData at each evaluation, never earlier', () => {
    const userDataDir = vi.fn(() => USER_DATA);
    const source = localCallbackEnvironmentSource('p1', {
      localSocketPath: () => SOCK,
      userDataDir,
    });
    expect(userDataDir).not.toHaveBeenCalled();
    source();
    source();
    expect(userDataDir).toHaveBeenCalledTimes(2);
  });

  it('yields nothing, with ONE log line, when the set cannot be injected (hostile userData path)', () => {
    const source = localCallbackEnvironmentSource('p1', {
      localSocketPath: () => '/tmp/ac-cb-501/0123456789ab.sock', // the /tmp fallback is always injectable
      userDataDir: () => '/tmp/Apps\nSupport',
    });
    expect(source()).toBeUndefined();
    expect(source()).toBeUndefined();
    expect(source()).toBeUndefined();
    const warnings = logs.filter((l) => l.level === 'warn' && l.context === 'callback');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toContain('project=p1');
    expect(warnings[0]!.message).toContain('reason=not-injectable');
  });
});
