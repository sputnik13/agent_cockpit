/**
 * Scenario 11 for LocalProvider (session-per-tab) and the mux: the
 * `deterministicSessionNames` gate is the value captured when the provider was
 * created — the same single settings read that named its sessions — and never a
 * later live read. Mux injection is deliberately not gated: mux sessions are
 * namespaced by the raw project id. (Control-mode's per-manager gate is covered
 * with real tmux in callbackInjection.test.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';
import { subscribe, type LogEntry } from '../../logger';

const hoisted = vi.hoisted(() => ({
  settings: {
    deterministicSessionNames: false,
    terminalBackend: 'control-mode',
    muxPersistScrollback: true,
    muxScrollbackLines: 10_000,
  },
}));
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../config', () => ({ loadSettings: () => hoisted.settings }));

import { LocalProvider } from './index';

const ENV = buildCallbackEnvironment({
  sock: '/tmp/a/aaaaaaaaaaaa.sock',
  cli: '/tmp/a/bin/cockpit',
})!;

interface Internals {
  terminals: {
    options: { callbackEnvironment?: unknown };
    sessionName(kind: string, key: string): string;
  };
  muxTerminalManager(): { shellArgs(key: string): string[] };
}
const internals = (p: LocalProvider): Internals => p as unknown as Internals;

let logs: LogEntry[];
let unsubscribe: () => void;
beforeEach(() => {
  hoisted.settings.deterministicSessionNames = false;
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

describe('LocalProvider session-per-tab gate', () => {
  it('enables injection for an unshared provider', () => {
    const provider = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    expect(internals(provider).terminals.options.callbackEnvironment).toBeTypeOf('function');
    expect(logs.filter((l) => /callback injection disabled/.test(l.message))).toEqual([]);
  });

  it('disables injection for a provider whose sessions are shared, and records a diagnostics note', () => {
    hoisted.settings.deterministicSessionNames = true;
    const provider = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    expect(internals(provider).terminals.options.callbackEnvironment).toBeUndefined();
    const note = logs.find((l) => /callback injection disabled project=p1/.test(l.message));
    expect(note?.message).toContain('backend=session-per-tab');
    expect(note?.message).toContain('reason=deterministic-session-names');
    expect(note?.context).toBe('callback');
  });

  it('uses the value captured at construction: a later toggle reaches neither direction', () => {
    const unshared = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    hoisted.settings.deterministicSessionNames = true;
    const shared = new LocalProvider('p2', '/repo', { callbackEnvironment: () => ENV });
    // Toggle both ways after construction.
    hoisted.settings.deterministicSessionNames = false;
    expect(internals(unshared).terminals.options.callbackEnvironment).toBeTypeOf('function');
    expect(internals(shared).terminals.options.callbackEnvironment).toBeUndefined();
    hoisted.settings.deterministicSessionNames = true;
    expect(internals(unshared).terminals.options.callbackEnvironment).toBeTypeOf('function');
    expect(internals(shared).terminals.options.callbackEnvironment).toBeUndefined();
  });

  it('names the sessions from the very same read that decides the gate', () => {
    hoisted.settings.deterministicSessionNames = true;
    const shared = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    expect(internals(shared).terminals.sessionName('terminal', 'k1')).not.toContain('p1'); // machine-independent token
    hoisted.settings.deterministicSessionNames = false;
    const own = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    expect(internals(own).terminals.sessionName('terminal', 'k1')).toContain('p1');
  });

  it('is disabled when the provider is built without a callback environment (legacy construction)', () => {
    const provider = new LocalProvider('p1', '/repo');
    expect(internals(provider).terminals.options.callbackEnvironment).toBeUndefined();
    expect(logs.filter((l) => /callback injection disabled/.test(l.message))).toEqual([]);
  });
});

describe('LocalProvider mux injection', () => {
  it("gives the local mux manager the project's environment", () => {
    const provider = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    const args = internals(provider).muxTerminalManager().shellArgs('t1');
    expect(args).toEqual([
      'BYOBU_DISABLE=1',
      'COCKPIT_CALLBACK_SOCK=/tmp/a/aaaaaaaaaaaa.sock',
      'COCKPIT_CALLBACK_VERSION=1',
      'COCKPIT_CLI=/tmp/a/bin/cockpit',
      'COCKPIT_CALLBACK_MUX_KEY=t1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });

  it('is NOT gated by shared session names: mux sessions are namespaced by the raw project id', () => {
    hoisted.settings.deterministicSessionNames = true;
    const provider = new LocalProvider('p1', '/repo', { callbackEnvironment: () => ENV });
    expect(internals(provider).muxTerminalManager().shellArgs('t1')).toContain(
      'COCKPIT_CALLBACK_MUX_KEY=t1',
    );
    expect(logs.filter((l) => /backend=mux/.test(l.message))).toEqual([]);
  });

  it('injects nothing when the provider has no callback environment', () => {
    const provider = new LocalProvider('p1', '/repo');
    expect(internals(provider).muxTerminalManager().shellArgs('t1')).toEqual([
      'BYOBU_DISABLE=1',
      '/bin/sh',
      '-c',
      'exec "${SHELL:-/bin/sh}"',
    ]);
  });
});
