import { describe, expect, it } from 'vitest';
import {
  TMUX_SERVER_OPTIONS,
  tmuxServerOptionArgs,
  tmuxServerOptionShell,
} from './terminalConfig';

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
