/**
 * Scenario 8, mux, against a LIVE local daemon: the variables and the app-chosen
 * key reach the first pane, a split and a new window of a real cockpit-mux daemon
 * started from the checked-out artifact (no daemon protocol change; the env
 * operands ride the existing `/usr/bin/env … /bin/sh -c …` trampoline).
 *
 * Isolation, as in mux.test.ts: the daemon runs under a private mux home with
 * COCKPIT_MUX_EPHEMERAL=1 (owner-pipe shutdown), never the user's mux home or
 * Electron profile, and `SHELL=/bin/sh` keeps the panes deterministic (no user rc
 * files). The remote mux (a live host) is NOT exercised here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';
import { paneFromEnv } from '@shared/callback/protocol';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../config', () => ({
  loadSettings: () => ({
    terminalBackend: 'cockpit-mux',
    muxPersistScrollback: true,
    muxScrollbackLines: 10_000,
    deterministicSessionNames: false,
  }),
}));

import { loadMuxArtifactManifest, selectMuxArtifact } from '../muxArtifacts';
import { LocalProvider } from './index';
import { stopLocalMuxOwners } from './mux';

const ENV = buildCallbackEnvironment({
  sock: "/tmp/My Apps/it's $HOME;~#/aaaaaaaaaaaa.sock",
  cli: '/tmp/My Apps/callback/bin/cock pit',
})!;

const SAVED = [
  'COCKPIT_MUX_HOME',
  'COCKPIT_MUX_BIN',
  'COCKPIT_MUX_EPHEMERAL',
  'SHELL',
  'TMUX_PANE',
] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let provider: LocalProvider | null = null;

beforeEach(async () => {
  for (const name of SAVED) saved[name] = process.env[name];
  root = await mkdtemp(join(tmpdir(), 'cockpit-mux-inj-'));
});

afterEach(async () => {
  try {
    await provider?.disconnect();
  } finally {
    provider = null;
    await stopLocalMuxOwners();
    for (const name of SAVED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function eventually<T>(assertion: () => T | Promise<T>, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('timed out');
}

describe('local mux callback injection (live daemon, private mux home)', () => {
  it('delivers the variables and the app-chosen key to the first pane, a split and a new window', async (ctx) => {
    const dist = join(process.cwd(), 'cockpit-mux', 'dist');
    const artifact = selectMuxArtifact(
      await loadMuxArtifactManifest(dist),
      process.platform === 'darwin' ? 'darwin' : 'linux',
      process.arch === 'arm64' ? 'arm64' : 'amd64',
    );
    if (!artifact) return ctx.skip();

    process.env['COCKPIT_MUX_HOME'] = join(root, 'mux');
    process.env['COCKPIT_MUX_BIN'] = join(dist, artifact.filename);
    process.env['COCKPIT_MUX_EPHEMERAL'] = '1';
    process.env['SHELL'] = '/bin/sh'; // the daemon (and so every pane) inherits it
    // An app launched from a tmux pane makes its mux daemon inherit a STALE TMUX_PANE.
    process.env['TMUX_PANE'] = '%99';
    provider = new LocalProvider('inj-mux', root, { callbackEnvironment: () => ENV });

    /** Make the pane's shell write its real process environment, and read it back. */
    async function paneEnv(id: string): Promise<Map<string, string>> {
      const dump = join(root, `env.${id}`);
      await provider!.writeTerminal(id, `env > ${dump}.tmp && mv ${dump}.tmp ${dump}\n`);
      await eventually(() => {
        if (!existsSync(dump)) throw new Error(`no environment dump for ${id}`);
      });
      const env = new Map<string, string>();
      for (const line of readFileSync(dump, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) env.set(line.slice(0, eq), line.slice(eq + 1));
      }
      return env;
    }

    await provider.openTerminal({ cols: 80, rows: 24, key: 't-root' });
    await provider.splitMuxTerminal('t-root', 't-split', 'vertical');
    await provider.newMuxWindow('t-root', 't-window');

    for (const key of ['t-root', 't-split', 't-window']) {
      const env = await paneEnv(key);
      // Every value arrives exactly, spaces and shell metacharacters included.
      expect(env.get('COCKPIT_CALLBACK_SOCK')).toBe(ENV.vars.COCKPIT_CALLBACK_SOCK);
      expect(env.get('COCKPIT_CALLBACK_VERSION')).toBe('1');
      expect(env.get('COCKPIT_CLI')).toBe(ENV.vars.COCKPIT_CLI);
      // The per-pane identity is the app-chosen key of THIS pane.
      expect(env.get('COCKPIT_CALLBACK_MUX_KEY')).toBe(key);
      expect(env.get('BYOBU_DISABLE')).toBe('1');
      // Pane identity as the CLI reads it: the app-chosen key WINS over the stale TMUX_PANE.
      expect(env.get('TMUX_PANE')).toBe('%99');
      expect(paneFromEnv(Object.fromEntries(env))).toEqual({ kind: 'mux', id: key });
    }
  }, 40_000);
});
