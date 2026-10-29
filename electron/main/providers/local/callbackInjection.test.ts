/**
 * Scenarios 8, 9 and 10 (local tmux): callback injection through REAL tmux on
 * private `-L` sockets, for both local tmux openers (control-mode and
 * session-per-tab). Panes dump their real process environment, so every
 * assertion is about what a pane PROCESS received.
 *
 * Isolation: each test owns a private socket, config (`-f`) and temp directory
 * (see tmuxTestKit); nothing here touches the persistent `agent-cockpit` server,
 * the user's tmux config, the Electron profile or a mux home. Skipped (reported
 * as skipped, not passed) when tmux is not installed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { TERMINAL_SCROLLBACK } from '@shared/tmux';
import { sessionKey } from '../sessionKey';
import { createLocalControlManager } from './controlManager';
import { LocalTerminalManager } from './terminal';
import { LocalTmuxControlManager } from './tmuxControl';
import { createTmuxSandbox, tmuxInstalled, type TmuxSandbox } from './tmuxTestKit';

const ENV_A = buildCallbackEnvironment({
  sock: '/tmp/My Apps/A $HOME;~#/aaaaaaaaaaaa.sock',
  cli: '/tmp/My Apps/A $HOME;~#/bin/cockpit',
})!;
const ENV_B = buildCallbackEnvironment({
  sock: '/tmp/My Apps/B/bbbbbbbbbbbb.sock',
  cli: '/tmp/My Apps/B/bin/cockpit',
})!;
const sourceOf =
  (environment: ReturnType<CallbackEnvironmentSource>): CallbackEnvironmentSource =>
  () =>
    environment;

/** What the outer app's panes would have leaked into a process.env that was not scrubbed. */
const CONTAMINATION = {
  COCKPIT_CALLBACK_SOCK: '/leak/outer-app.sock',
  COCKPIT_CALLBACK_VERSION: '9',
  COCKPIT_CLI: '/leak/outer-cli',
  COCKPIT_CALLBACK_MUX_KEY: 'outer-key',
};
const CALLBACK_NAMES = [
  'COCKPIT_CALLBACK_SOCK',
  'COCKPIT_CALLBACK_VERSION',
  'COCKPIT_CLI',
] as const;

let box: TmuxSandbox;
const managers: LocalTmuxControlManager[] = [];
const terminals: LocalTerminalManager[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  box = createTmuxSandbox('inj');
  for (const name of ['AC_TMUX_EPHEMERAL', ...Object.keys(CONTAMINATION)]) {
    savedEnv[name] = process.env[name];
  }
});

afterEach(() => {
  for (const mgr of managers.splice(0)) mgr.close();
  for (const term of terminals.splice(0)) term.closeAll();
  box.dispose();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/**
 * Open `mgr` and wait until it is ATTACHED to its session: the first command's
 * reply only arrives once tmux serves the control client, whether the session was
 * just created or already existed (a re-attach replays no `%window-add`).
 */
async function openAttached(mgr: LocalTmuxControlManager): Promise<LocalTmuxControlManager> {
  managers.push(mgr);
  mgr.open({ cols: 80, rows: 24 });
  const reply = await Promise.race([
    mgr.command("display-message -p '#{session_name}'"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('control client never attached')), 8_000).unref(),
    ),
  ]);
  expect(reply.lines[0]?.trim()).toBe(mgr.sessionName());
  return mgr;
}

/** A control-mode manager on the sandbox, opened and attached. */
const attach = (
  token: string,
  source: CallbackEnvironmentSource | undefined,
): Promise<LocalTmuxControlManager> =>
  openAttached(new LocalTmuxControlManager(token, box.dir, box.socket, box.conf, source));

/** Ids of the panes of `session` (creation order). */
const panesOf = (session: string): string[] =>
  box.tmux('list-panes', '-s', '-t', `=${session}`, '-F', '#{pane_id}').split('\n').filter(Boolean);

const callbackLines = (lines: string[]): string[] => lines.filter((l) => /COCKPIT_/.test(l));
const callbackEnvOf = (env: Map<string, string>): Record<string, string> =>
  Object.fromEntries([...env].filter(([name]) => /^COCKPIT_/.test(name)));
const valuesOf = (
  environment: NonNullable<ReturnType<CallbackEnvironmentSource>>,
): Record<string, string> => ({ ...environment.vars });

describe.skipIf(!tmuxInstalled)('local control-mode injection (real tmux, private socket)', () => {
  it('delivers the variables to the first pane, a later window, a split and a respawned pane, and keeps the global environment clean', async () => {
    const mgr = await attach('proj-a', sourceOf(ENV_A));
    const session = mgr.sessionName();

    const [first] = panesOf(session);
    expect(callbackEnvOf(await box.paneEnv(first!))).toEqual(valuesOf(ENV_A));

    // A later window.
    await mgr.newWindow();
    const second = panesOf(session).find((p) => p !== first)!;
    expect(callbackEnvOf(await box.paneEnv(second))).toEqual(valuesOf(ENV_A));

    // A split.
    await mgr.splitWindow(second, 'lr');
    const third = panesOf(session).find((p) => p !== first && p !== second)!;
    expect(callbackEnvOf(await box.paneEnv(third))).toEqual(valuesOf(ENV_A));

    // respawn-pane -k re-reads the session environment.
    box.forgetPane(first!);
    await mgr.command(`respawn-pane -k -t ${first}`);
    expect(callbackEnvOf(await box.paneEnv(first!))).toEqual(valuesOf(ENV_A));

    // Every pane also has tmux's own pane identity, which the CLI reads.
    for (const pane of [first!, second, third]) {
      expect((await box.paneEnv(pane)).get('TMUX_PANE')).toBe(pane);
    }

    // The session carries the values; the GLOBAL environment never did.
    expect(callbackLines(box.sessionEnv(session)).sort()).toEqual(
      Object.entries(ENV_A.vars)
        .map(([n, v]) => `${n}=${v}`)
        .sort(),
    );
    expect(callbackLines(box.globalEnv())).toEqual([]);
  });

  it('starts the server from a variable-free process even if process.env was contaminated after the startup scrub', async () => {
    Object.assign(process.env, CONTAMINATION);
    const mgr = await attach('proj-a', sourceOf(ENV_A));
    const [first] = panesOf(mgr.sessionName());
    const env = await box.paneEnv(first!);

    // The pane got THIS project's values, not the leaked ones...
    expect(callbackEnvOf(env)).toEqual(valuesOf(ENV_A));
    // ...and nothing leaked into the server's global environment, which every
    // project's panes would have inherited.
    expect(callbackLines(box.globalEnv())).toEqual([]);
  });

  it('keeps the global environment clean and injects nothing for a project that has no values (unbound listener)', async () => {
    Object.assign(process.env, CONTAMINATION);
    const mgr = await attach('proj-a', sourceOf(undefined));
    const [first] = panesOf(mgr.sessionName());
    expect(callbackEnvOf(await box.paneEnv(first!))).toEqual({});
    expect(callbackLines(box.globalEnv())).toEqual([]);
  });

  it('sets one update-environment element per name, keeps tmux defaults, and is idempotent across repeated opens', async () => {
    await attach('proj-a', sourceOf(ENV_A));
    const first = box.updateEnvironment();
    expect(first.get(100)).toBe('COCKPIT_CALLBACK_SOCK');
    expect(first.get(101)).toBe('COCKPIT_CALLBACK_VERSION');
    expect(first.get(102)).toBe('COCKPIT_CLI');
    // tmux's own defaults are intact (a plain `set -g` would have replaced them).
    const defaults = [...first.values()];
    expect(defaults).toContain('SSH_AUTH_SOCK');
    expect(defaults).toContain('DISPLAY');
    expect([...first.keys()].filter((i) => i >= 100)).toEqual([100, 101, 102]);

    // Close and reopen, with another project too: the option must not grow.
    for (const token of ['proj-a', 'proj-b', 'proj-a']) {
      managers.splice(0).forEach((m) => m.close());
      await attach(token, sourceOf(ENV_A));
    }
    const after = box.updateEnvironment();
    expect(after.size).toBe(first.size);
    expect([...after.entries()]).toEqual([...first.entries()]);
  });

  it('refreshes the values of an existing session on a new-session -A re-attach, and later windows see them', async () => {
    const original = await attach('proj-a', sourceOf(ENV_A));
    const session = original.sessionName();
    expect(callbackLines(box.sessionEnv(session))).toContain(
      `COCKPIT_CALLBACK_SOCK=${ENV_A.vars.COCKPIT_CALLBACK_SOCK}`,
    );
    original.close();
    await vi.waitFor(() => expect(original.isOpen()).toBe(false));

    const reattached = await attach('proj-a', sourceOf(ENV_B));
    expect(reattached.sessionName()).toBe(session);
    expect(box.sessions()).toEqual([session]); // attached to the SAME session, not a new one
    expect(callbackLines(box.sessionEnv(session)).sort()).toEqual(
      Object.entries(ENV_B.vars)
        .map(([n, v]) => `${n}=${v}`)
        .sort(),
    );

    const before = panesOf(session);
    await reattached.newWindow();
    const fresh = panesOf(session).find((p) => !before.includes(p))!;
    expect(callbackEnvOf(await box.paneEnv(fresh))).toEqual(valuesOf(ENV_B));
  });

  it('strips ONLY the callback variables when a variable-less client attaches', async () => {
    const original = await attach('proj-a', sourceOf(ENV_A));
    const session = original.sessionName();
    box.tmux('set-environment', '-t', `=${session}`, 'FOO', 'bar');
    original.close();
    await vi.waitFor(() => expect(original.isOpen()).toBe(false));

    const bare = await attach('proj-a', sourceOf(undefined));
    const lines = box.sessionEnv(session);
    // tmux marks a stripped variable `-NAME`; the values are gone.
    for (const name of CALLBACK_NAMES) expect(lines).toContain(`-${name}`);
    expect(lines.filter((l) => /^COCKPIT_.*=/.test(l))).toEqual([]);
    expect(lines).toContain('FOO=bar'); // not a callback variable: untouched

    const before = panesOf(session);
    await bare.newWindow();
    const fresh = panesOf(session).find((p) => !before.includes(p))!;
    const env = await box.paneEnv(fresh);
    expect(callbackEnvOf(env)).toEqual({});
    expect(env.get('FOO')).toBe('bar');
  });

  it('with injection disabled for the manager, sets no update-environment element and injects nothing', async () => {
    Object.assign(process.env, CONTAMINATION);
    const mgr = await attach('proj-a', undefined);
    const [first] = panesOf(mgr.sessionName());
    expect(callbackEnvOf(await box.paneEnv(first!))).toEqual({});
    const elements = box.updateEnvironment();
    expect([...elements.keys()].filter((i) => i >= 100)).toEqual([]);
    expect(callbackLines(box.globalEnv())).toEqual([]);
    expect(callbackLines(box.sessionEnv(mgr.sessionName()))).toEqual([]);
  });

  it('never turns exit-empty on, even in an ephemeral (AC_TMUX_EPHEMERAL=1) run', async () => {
    process.env['AC_TMUX_EPHEMERAL'] = '1';
    await attach('proj-a', sourceOf(ENV_A));
    expect(box.tmux('show-options', '-gv', 'exit-empty').trim()).toBe('off');
  });

  it('keeps two projects on one shared server apart: each pane sees only its own values', async () => {
    const a = await attach('proj-a', sourceOf(ENV_A));
    const b = await attach('proj-b', sourceOf(ENV_B));
    expect(box.sessions().sort()).toEqual([a.sessionName(), b.sessionName()].sort());

    const [paneA] = panesOf(a.sessionName());
    const [paneB] = panesOf(b.sessionName());
    expect(callbackEnvOf(await box.paneEnv(paneA!))).toEqual(valuesOf(ENV_A));
    expect(callbackEnvOf(await box.paneEnv(paneB!))).toEqual(valuesOf(ENV_B));

    // A new window in A still carries A's values even though B attached last.
    await a.newWindow();
    const freshA = panesOf(a.sessionName()).find((p) => p !== paneA)!;
    expect(callbackEnvOf(await box.paneEnv(freshA))).toEqual(valuesOf(ENV_A));
    expect(callbackLines(box.globalEnv())).toEqual([]);
  });

  it('survives a source that throws: the open still succeeds and the pane simply has no variables', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const mgr = await attach('proj-a', () => {
      throw new Error('boom');
    });
    const [first] = panesOf(mgr.sessionName());
    expect(callbackEnvOf(await box.paneEnv(first!))).toEqual({});
    expect(callbackLines(box.globalEnv())).toEqual([]);
  });

  it('keeps the existing opener behavior: history-limit reaches the first pane and window names stay stable', async () => {
    const mgr = await attach('proj-a', sourceOf(ENV_A));
    const [first] = panesOf(mgr.sessionName());
    const reply = await mgr.command(`display-message -p -t ${first} '#{history_limit}'`);
    expect(reply.lines[0]?.trim()).toBe(String(TERMINAL_SCROLLBACK));
    expect(box.tmux('show-options', '-gv', 'automatic-rename').trim()).toBe('off');
  });
});

describe.skipIf(!tmuxInstalled)(
  'local session-per-tab injection (real tmux, private socket)',
  () => {
    function terminalManager(
      token: string,
      source: CallbackEnvironmentSource | undefined,
    ): LocalTerminalManager {
      const mgr = new LocalTerminalManager(box.dir, token, {
        socket: box.socket,
        configPath: box.conf,
        ...(source ? { callbackEnvironment: source } : {}),
      });
      terminals.push(mgr);
      return mgr;
    }

    const sessionOf = async (name: string): Promise<string> => {
      await vi.waitFor(() => expect(box.sessions()).toContain(name), { timeout: 8_000 });
      return name;
    };

    it("delivers the variables to a new session's first pane and keeps the global environment clean", async () => {
      const mgr = terminalManager('tok-a', sourceOf(ENV_A));
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      const session = await sessionOf('agent-cockpit-terminal-tok-a-k1');
      await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
      const [pane] = panesOf(session);
      expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual(valuesOf(ENV_A));
      expect(callbackLines(box.globalEnv())).toEqual([]);
      const elements = box.updateEnvironment();
      expect(elements.get(100)).toBe('COCKPIT_CALLBACK_SOCK');
      expect(elements.get(101)).toBe('COCKPIT_CALLBACK_VERSION');
      expect(elements.get(102)).toBe('COCKPIT_CLI');
    });

    it('splits the server start into its own variable-free spawn even when process.env was contaminated', async () => {
      Object.assign(process.env, CONTAMINATION);
      const mgr = terminalManager('tok-a', sourceOf(ENV_A));
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      const session = await sessionOf('agent-cockpit-terminal-tok-a-k1');
      await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
      const [pane] = panesOf(session);
      expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual(valuesOf(ENV_A));
      // The server was started BEFORE the attaching client existed, by a process
      // that carried none of the variables, so its global environment is clean.
      expect(callbackLines(box.globalEnv())).toEqual([]);
    });

    it('gives each tab session of two projects only its own project values', async () => {
      const a = terminalManager('tok-a', sourceOf(ENV_A));
      const b = terminalManager('tok-b', sourceOf(ENV_B));
      a.open({ cols: 80, rows: 24, key: 'k1' });
      a.open({ cols: 80, rows: 24, key: 'k2' });
      b.open({ cols: 80, rows: 24, key: 'k1' });
      const wanted = {
        'agent-cockpit-terminal-tok-a-k1': ENV_A,
        'agent-cockpit-terminal-tok-a-k2': ENV_A,
        'agent-cockpit-terminal-tok-b-k1': ENV_B,
      };
      for (const [name, environment] of Object.entries(wanted)) {
        const session = await sessionOf(name);
        await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
        const [pane] = panesOf(session);
        expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual(valuesOf(environment));
      }
      expect(callbackLines(box.globalEnv())).toEqual([]);
    });

    it('injects nothing and sets no update-environment element when the manager is disabled', async () => {
      Object.assign(process.env, CONTAMINATION);
      const mgr = terminalManager('tok-a', undefined);
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      const session = await sessionOf('agent-cockpit-terminal-tok-a-k1');
      await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
      const [pane] = panesOf(session);
      expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual({});
      expect([...box.updateEnvironment().keys()].filter((i) => i >= 100)).toEqual([]);
      expect(callbackLines(box.globalEnv())).toEqual([]);
    });

    it('survives a source that throws: the terminal still opens, without variables', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const mgr = terminalManager('tok-a', () => {
        throw new Error('boom');
      });
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      const session = await sessionOf('agent-cockpit-terminal-tok-a-k1');
      await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
      const [pane] = panesOf(session);
      expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual({});
    });

    it('never turns exit-empty on, even in an ephemeral (AC_TMUX_EPHEMERAL=1) run', async () => {
      process.env['AC_TMUX_EPHEMERAL'] = '1';
      const mgr = terminalManager('tok-a', sourceOf(ENV_A));
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      await sessionOf('agent-cockpit-terminal-tok-a-k1');
      expect(box.tmux('show-options', '-gv', 'exit-empty').trim()).toBe('off');
    });

    it('keeps the shared server options on the first terminal (history-limit and stable window names)', async () => {
      const mgr = terminalManager('tok-a', sourceOf(ENV_A));
      mgr.open({ cols: 80, rows: 24, key: 'k1' });
      const session = await sessionOf('agent-cockpit-terminal-tok-a-k1');
      await vi.waitFor(() => expect(panesOf(session)).toHaveLength(1));
      const [pane] = panesOf(session);
      expect(box.tmux('display-message', '-p', '-t', pane!, '#{history_limit}').trim()).toBe(
        String(TERMINAL_SCROLLBACK),
      );
      expect(box.tmux('show-options', '-gv', 'automatic-rename').trim()).toBe('off');
    });
  },
);

describe.skipIf(!tmuxInstalled)(
  'shared session names disable injection (scenario 11, control-mode)',
  () => {
    // The project root must exist (it is the pty's cwd); its hash names the shared session.
    const make = (deterministicSessionNames: boolean, source: CallbackEnvironmentSource) =>
      createLocalControlManager({
        projectId: 'proj-a',
        rootPath: box.dir,
        deterministicSessionNames,
        callbackEnvironment: source,
        socket: box.socket,
        configPath: box.conf,
      });

    const attachManager = async (mgr: LocalTmuxControlManager): Promise<void> => {
      await openAttached(mgr);
    };

    it('uses the value that named the session: a shared-name manager never injects and never consults the source', async () => {
      const source = vi.fn(() => ENV_A);
      Object.assign(process.env, CONTAMINATION);
      const gated = make(true, source);
      expect(gated.sessionName()).toBe(`agent-cockpit-${sessionKey(box.dir)}`); // the shared, machine-independent name
      await attachManager(gated);

      expect(source).not.toHaveBeenCalled();
      expect(callbackLines(box.sessionEnv(gated.sessionName()))).toEqual([]);
      const [pane] = panesOf(gated.sessionName());
      expect(callbackEnvOf(await box.paneEnv(pane!))).toEqual({});
      expect([...box.updateEnvironment().keys()].filter((i) => i >= 100)).toEqual([]);
      expect(callbackLines(box.globalEnv())).toEqual([]);
    });

    it('a shared session is never written to after the setting is turned off, including after a close and reopen', async () => {
      const source = vi.fn(() => ENV_A);
      const gated = make(true, source);
      await attachManager(gated);
      const shared = gated.sessionName();

      // The setting is turned off. The live manager keeps the gate it was created
      // with, even when it is closed and reopened (the same object, the same name).
      gated.close();
      await vi.waitFor(() => expect(gated.isOpen()).toBe(false));
      gated.open({ cols: 80, rows: 24 });
      await vi.waitFor(() => expect(gated.isOpen()).toBe(true));
      expect(source).not.toHaveBeenCalled();

      // `tmuxControl.close` discards the manager and the next acquire rebuilds it
      // from a NEW settings read (now off): a different session name, so the shared
      // session is not the one attached, and it is never written to.
      gated.close();
      const rebuilt = make(false, source);
      expect(rebuilt.sessionName()).toBe('agent-cockpit-proj-a');
      expect(rebuilt.sessionName()).not.toBe(shared);
      await attachManager(rebuilt);
      expect(source).toHaveBeenCalled();

      expect(callbackEnvOf(await box.paneEnv(panesOf(rebuilt.sessionName())[0]!))).toEqual(
        valuesOf(ENV_A),
      );
      expect(callbackLines(box.sessionEnv(shared)).filter((l) => /=/.test(l))).toEqual([]);
      for (const pane of panesOf(shared))
        expect(callbackEnvOf(await box.paneEnv(pane))).toEqual({});
    });

    it('does NOT make the server stop stripping: entries a non-gated manager set earlier still apply to a gated attach', async () => {
      // A non-gated manager (another project) sets the SERVER-global entries first.
      const other = createLocalControlManager({
        projectId: 'other',
        rootPath: box.dir,
        deterministicSessionNames: false,
        callbackEnvironment: () => ENV_A,
        socket: box.socket,
        configPath: box.conf,
      });
      await attachManager(other);
      expect([...box.updateEnvironment().keys()].filter((i) => i >= 100)).toEqual([100, 101, 102]);

      // The shared session already holds a value (as if something else had put it there).
      const shared = `agent-cockpit-${sessionKey(box.dir)}`;
      box.tmux('new-session', '-d', '-s', shared, '-c', box.dir);
      box.tmux('set-environment', '-t', `=${shared}`, 'COCKPIT_CALLBACK_SOCK', '/elsewhere/x.sock');
      expect(callbackLines(box.sessionEnv(shared))).toContain(
        'COCKPIT_CALLBACK_SOCK=/elsewhere/x.sock',
      );

      const source = vi.fn(() => ENV_A);
      const gated = make(true, source);
      expect(gated.sessionName()).toBe(shared);
      await attachManager(gated);

      // It still injects nothing and sets no entry of its own...
      expect(source).not.toHaveBeenCalled();
      // ...but the entries are server-global, so its variable-less client strips the session.
      const lines = box.sessionEnv(shared);
      for (const name of CALLBACK_NAMES) expect(lines).toContain(`-${name}`);
      expect(lines.filter((l) => /^COCKPIT_.*=/.test(l))).toEqual([]);
    });

    it('an unshared manager injects, so the gate (not the setting) is what differs', async () => {
      const source = vi.fn(() => ENV_A);
      const live = make(false, source);
      expect(live.sessionName()).toBe('agent-cockpit-proj-a');
      await attachManager(live);
      expect(source).toHaveBeenCalledTimes(1);
      expect(callbackEnvOf(await box.paneEnv(panesOf(live.sessionName())[0]!))).toEqual(
        valuesOf(ENV_A),
      );
    });
  },
);
