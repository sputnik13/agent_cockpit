import { describe, expect, it } from 'vitest';
import { TERMINAL_SCROLLBACK } from './scrollback';
import { TMUX_SERVER_OPTIONS, tmuxServerOptionArgs, tmuxServerOptionShell } from './terminalConfig';

// Regression: in-pane apps (e.g. Claude Code) reported terminal focus events as
// unavailable. tmux defaults `focus-events` to off, so unless the shared server
// option source enables it, tmux never forwards DECSET 1004 focus-in/out to a
// pane's app. These tests pin `focus-events on` at the single source consumed by
// both the local (argv) and remote (shell) openers.
describe('tmux server options — focus-events', () => {
  it('enables focus-events on (so tmux forwards 1004 focus events to pane apps)', () => {
    const opt = TMUX_SERVER_OPTIONS.find((o) => o.name === 'focus-events');
    expect(opt).toBeDefined();
    expect(opt?.value).toBe('on');
    expect(opt?.append ?? false).toBe(false);
  });

  it('emits `set -g focus-events on` in the local (argv) opener', () => {
    const args = tmuxServerOptionArgs();
    const i = args.indexOf('focus-events');
    expect(i).toBeGreaterThan(-1);
    // tmuxServerOptionArgs flat-maps [';','set',flag,name,value]; assert the
    // surrounding tokens form `set -g focus-events on`.
    expect(args.slice(i - 2, i + 2)).toEqual(['set', '-g', 'focus-events', 'on']);
  });

  it('emits `set -g focus-events on` in the remote (shell) opener', () => {
    expect(tmuxServerOptionShell()).toContain("set -g focus-events 'on'");
  });
});

// Scenario 10 (opener and ephemeral assertions). The server is started by a
// variable-free process, and the next client that carries a project's callback
// variables must never be the one that starts it. An `exit-empty on` server with
// no session exits at once, so an isolated/ephemeral opener (AC_TMUX_EPHEMERAL=1)
// must keep `exit-empty off` too, and isolated runs end the server with an
// explicit `kill-server` instead (will-quit and the run guardians).
describe('ephemeral tmux server options', () => {
  it('keeps exit-empty off in every opener, isolated and ephemeral runs included', () => {
    const args = tmuxServerOptionArgs();
    const i = args.indexOf('exit-empty');
    expect(args.slice(i - 2, i + 2)).toEqual(['set', '-g', 'exit-empty', 'off']);
    // There is no option left that turns it on: a stale caller passing the old
    // `exitEmpty` flag still gets `off`, so it cannot reintroduce the leak.
    const stale = (tmuxServerOptionArgs as (o: object) => string[])({ exitEmpty: true });
    expect(stale).toEqual(args);
    expect(tmuxServerOptionShell()).toContain("set -g exit-empty 'off'");
  });
});

// Regression: control-mode tab titles drifted to the last command and opening a
// new window relabeled existing ones. tmux's default `automatic-rename on`
// re-derives every window name from its foreground process on a server refresh
// (which `new-window` triggers) and emits %window-renamed. Pin it OFF at the
// single source so the cockpit owns window titles (dir-basename default + the
// double-click rename) and they stay stable.
describe('tmux server options — automatic-rename', () => {
  it('disables automatic-rename (stable, cockpit-owned window titles)', () => {
    const opt = TMUX_SERVER_OPTIONS.find((o) => o.name === 'automatic-rename');
    expect(opt).toBeDefined();
    expect(opt?.value).toBe('off');
    expect(opt?.append ?? false).toBe(false);
  });

  it('emits `set -g automatic-rename off` in both openers', () => {
    const args = tmuxServerOptionArgs();
    const i = args.indexOf('automatic-rename');
    expect(i).toBeGreaterThan(-1);
    expect(args.slice(i - 2, i + 2)).toEqual(['set', '-g', 'automatic-rename', 'off']);
    expect(tmuxServerOptionShell()).toContain("set -g automatic-rename 'off'");
  });
});

// Regression: selecting terminal text only reached the tmux paste-buffer, never
// the system clipboard. `set-clipboard on` plus advertising the OSC 52 clipboard
// terminfo cap (`Ms`) makes tmux emit OSC 52 to the client when text is copied;
// the renderer xterm then writes it to the system clipboard.
describe('tmux server options — system clipboard (OSC 52)', () => {
  it('enables set-clipboard on', () => {
    const opt = TMUX_SERVER_OPTIONS.find((o) => o.name === 'set-clipboard');
    expect(opt?.value).toBe('on');
  });

  it('advertises the OSC 52 clipboard cap (Ms) via an appended terminal-overrides', () => {
    const ms = TMUX_SERVER_OPTIONS.find(
      (o) => o.name === 'terminal-overrides' && o.value.includes('Ms='),
    );
    expect(ms).toBeDefined();
    expect(ms?.append).toBe(true);
    // The canonical OSC 52 set-clipboard terminfo string.
    expect(ms?.value).toContain('Ms=\\E]52;%p1%s;%p2%s\\007');
  });

  it('emits set-clipboard + the Ms cap in both openers', () => {
    const shell = tmuxServerOptionShell();
    expect(shell).toContain("set -g set-clipboard 'on'");
    expect(shell).toContain('Ms=\\E]52;%p1%s;%p2%s\\007');
    const args = tmuxServerOptionArgs();
    expect(args).toContain('set-clipboard');
    expect(args.some((a) => a.includes('Ms=\\E]52;%p1%s;%p2%s\\007'))).toBe(true);
  });
});

// Scenario 9 (config half) and the LOCAL-ONLY rule: the callback variables reach
// a pane through tmux's `update-environment`, applied as ONE indexed element per
// name. A plain `set -g update-environment` would replace tmux's defaults
// (SSH_AUTH_SOCK, DISPLAY, ...) and repeated `-ga` would grow the option on every
// open, so neither may ever be emitted. The remote shell openers never carry the
// entries: a remote variable-less attach must not strip.
describe('tmux server options — callback update-environment (local only)', () => {
  const ELEMENTS = [
    ['update-environment[100]', 'COCKPIT_CALLBACK_SOCK'],
    ['update-environment[101]', 'COCKPIT_CALLBACK_VERSION'],
    ['update-environment[102]', 'COCKPIT_CLI'],
  ] as const;
  const callbackOptions = TMUX_SERVER_OPTIONS.filter((o) =>
    o.name.startsWith('update-environment'),
  );

  it('has exactly one indexed element per variable name, flagged local-only and never appended', () => {
    expect(callbackOptions.map((o) => [o.name, o.value])).toEqual(ELEMENTS);
    for (const o of callbackOptions) {
      expect(o.localOnly).toBe(true);
      expect(o.append ?? false).toBe(false);
    }
  });

  it('flags nothing else local-only', () => {
    expect(TMUX_SERVER_OPTIONS.filter((o) => o.localOnly)).toEqual(callbackOptions);
  });

  it('puts the three elements LAST in the local chain (a failing indexed set must stop nothing else)', () => {
    const args = tmuxServerOptionArgs();
    expect(args.slice(-ELEMENTS.length * 5)).toEqual(
      ELEMENTS.flatMap(([name, value]) => [';', 'set', '-g', name, value]),
    );
  });

  it('leaves every pre-existing option, in its original order, ahead of them', () => {
    const legacy = TMUX_SERVER_OPTIONS.filter((o) => !o.localOnly).flatMap((o) => [
      ';',
      'set',
      o.append ? '-ga' : '-g',
      o.name,
      o.value,
    ]);
    expect(tmuxServerOptionArgs().slice(0, legacy.length)).toEqual(legacy);
    expect(tmuxServerOptionArgs({ callbackEnvironment: false })).toEqual(legacy);
  });

  it('is applied as `set -g update-environment[N] NAME`: never a plain set of the option, never -ga', () => {
    const args = tmuxServerOptionArgs();
    expect(args).not.toContain('update-environment');
    for (const [name, value] of ELEMENTS) {
      const i = args.indexOf(name);
      expect(args.slice(i - 2, i + 2)).toEqual(['set', '-g', name, value]);
    }
    for (let i = 0; i < args.length; i += 1) {
      if (args[i]?.startsWith('update-environment')) expect(args[i - 1]).toBe('-g');
    }
    // One element per name, whatever the number of opens.
    expect(args.filter((a) => a.startsWith('update-environment'))).toHaveLength(3);
  });

  it('is filtered out of the remote shell opener, which never carries it', () => {
    const shell = tmuxServerOptionShell();
    expect(shell).not.toContain('update-environment');
    expect(shell).not.toContain('COCKPIT');
    // ...while the rest of the shell chain is untouched.
    expect(shell).toContain("set -g history-limit '");
    expect(shell).toContain("set -g automatic-rename 'off'");
    expect(shell).toContain("set -g exit-empty 'off'");
  });

  it('can be omitted by a naming object that shares its sessions across installs', () => {
    const without = tmuxServerOptionArgs({ callbackEnvironment: false });
    expect(without.some((a) => a.startsWith('update-environment'))).toBe(false);
    expect(without).toContain('history-limit');
    expect(without).toContain('automatic-rename');
  });
});

// The opener chains that existed BEFORE the callback entries, pinned as literals
// (captured from the pre-change source, not derived from the option table) so the
// remote shell chain is demonstrably byte-identical and the local chain's old
// prefix is untouched: history-limit still precedes the first new-session,
// automatic-rename stays off, start-server stays in front of the remote chain.
describe('existing opener chains are unchanged', () => {
  const LEGACY_SHELL =
    "set -g exit-empty 'off' \\; " +
    `set -g history-limit '${TERMINAL_SCROLLBACK}' \\; ` +
    "set -g automatic-rename 'off' \\; " +
    "set -g mouse 'on' \\; " +
    "set -g focus-events 'on' \\; " +
    "set -g default-terminal 'screen-256color' \\; " +
    "set -ga terminal-overrides ',*:Tc' \\; " +
    "set -g set-clipboard 'on' \\; " +
    "set -ga terminal-overrides ',*:Ms=\\E]52;%p1%s;%p2%s\\007'";
  const LEGACY_ARGS = [
    ...[';', 'set', '-g', 'exit-empty', 'off'],
    ...[';', 'set', '-g', 'history-limit', String(TERMINAL_SCROLLBACK)],
    ...[';', 'set', '-g', 'automatic-rename', 'off'],
    ...[';', 'set', '-g', 'mouse', 'on'],
    ...[';', 'set', '-g', 'focus-events', 'on'],
    ...[';', 'set', '-g', 'default-terminal', 'screen-256color'],
    ...[';', 'set', '-ga', 'terminal-overrides', ',*:Tc'],
    ...[';', 'set', '-g', 'set-clipboard', 'on'],
    ...[';', 'set', '-ga', 'terminal-overrides', ',*:Ms=\\E]52;%p1%s;%p2%s\\007'],
  ];

  it('keeps the remote shell chain byte-identical (no callback entry, nothing reordered)', () => {
    expect(tmuxServerOptionShell()).toBe(LEGACY_SHELL);
  });

  it('keeps the local argv chain identical up to its callback tail', () => {
    expect(tmuxServerOptionArgs().slice(0, LEGACY_ARGS.length)).toEqual(LEGACY_ARGS);
    expect(tmuxServerOptionArgs({ callbackEnvironment: false })).toEqual(LEGACY_ARGS);
  });

  it('applies history-limit before anything can create a session: it is in the server-start chain, ahead of the callback tail', () => {
    const args = tmuxServerOptionArgs();
    expect(args.indexOf('history-limit')).toBeGreaterThan(-1);
    expect(args.indexOf('history-limit')).toBeLessThan(args.indexOf('update-environment[100]'));
    expect(args).not.toContain('new-session');
  });
});
