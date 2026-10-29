/**
 * Single source for the tmux global (`set -g`) server options and the
 * per-terminal-pane environment, consumed by every opener (local/remote ×
 * control-mode/session-per-tab).
 *
 * These configure the tmux/pty layer, NOT the renderer, so they are
 * backend-agnostic — a pane rendered by xterm.js or by wterm inherits the same
 * terminal type, color support, scrollback, and mouse behavior.
 */
import { CALLBACK_TMUX_ENV_NAMES, callbackUpdateEnvironmentOption } from '../callback/env';
import { TERMINAL_SCROLLBACK } from './scrollback';

/** Terminal type advertised to the tmux client — 256-color for modern color. */
export const TERMINAL_TERM = 'xterm-256color';
/** Advertise 24-bit color so programs emit truecolor. */
export const TERMINAL_COLORTERM = 'truecolor';

interface TmuxServerOption {
  name: string;
  value: string;
  /** Append (`set -ga`) instead of replace (`set -g`). */
  append?: boolean;
  /**
   * Applied by the LOCAL argv opener only; {@link tmuxServerOptionShell} (every
   * remote opener) filters it out. A documented exception to "one option source
   * for both openers": see the callback `update-environment` entries below.
   */
  localOnly?: boolean;
}

/**
 * Global tmux options applied to the shared server before the first session.
 * Every entry must be valid on any tmux the app targets (an unknown-option error
 * would break the remote `&&` opener chain) — `terminal-overrides` stores an
 * arbitrary capability string, so the `:Tc` truecolor cap is safe on all versions.
 * The one exception is the `localOnly` tail, which only the local argv opener
 * applies (its separate spawn cannot block a session, and a failure there is
 * reported by `startTmuxServer`).
 */
export const TMUX_SERVER_OPTIONS: readonly TmuxServerOption[] = [
  // Keep the sessionless server alive between start-server and the first session.
  { name: 'exit-empty', value: 'off' },
  // Scrollback depth — single source with the capture-pane seed + renderer buffer.
  { name: 'history-limit', value: String(TERMINAL_SCROLLBACK) },
  // Keep window names STABLE: with automatic-rename on (tmux default), tmux
  // re-derives every window's name from its active pane's foreground command on
  // a server refresh — which a `new-window` triggers — and emits %window-renamed,
  // so opening a new window relabels existing idle windows and a tab's title
  // drifts to the last command. Off means a window's name only changes when we
  // (or the user) explicitly `rename-window`, so the cockpit owns titles: a
  // creation-time directory-basename default, overridable by double-click. Valid
  // on every tmux the app targets.
  { name: 'automatic-rename', value: 'off' },
  // Wheel → mouse-aware apps; otherwise tmux copy-mode (tmux's scrollback).
  { name: 'mouse', value: 'on' },
  // Forward DECSET 1004 focus-in/out to the focused pane's app. tmux defaults
  // this OFF, so without it apps that rely on focus reporting (e.g. Claude Code)
  // report focus events as unavailable. Safe on every tmux ≥ 1.9.
  { name: 'focus-events', value: 'on' },
  // 256-color terminfo for programs inside tmux (widely present everywhere).
  { name: 'default-terminal', value: 'screen-256color' },
  // Advertise 24-bit truecolor passthrough to the client.
  { name: 'terminal-overrides', value: ',*:Tc', append: true },
  // System-clipboard integration: on copy, tmux emits an OSC 52 sequence to the
  // client to set the system clipboard (so a mouse selection lands on the OS
  // clipboard, not only tmux's paste-buffer). `set-clipboard on` enables it, and
  // the `Ms` terminfo cap advertises OSC 52 support so tmux actually sends it —
  // `default-terminal screen-256color` lacks `Ms`, so we add it as an arbitrary
  // capability override (same mechanism as `:Tc`, safe on all tmux versions).
  // The renderer xterm turns the incoming OSC 52 into a clipboard write.
  { name: 'set-clipboard', value: 'on' },
  { name: 'terminal-overrides', value: ',*:Ms=\\E]52;%p1%s;%p2%s\\007', append: true },
  // Terminal callback socket (docs/design/terminal-callback-socket.md,
  // "Environment injection"): tmux copies these variables from the ATTACHING CLIENT's
  // environment into the session on create and on `-A` attach, and removes them
  // when the client lacks them, so a pane inherits them from its session. Exactly
  // ONE indexed element per name — never a plain `set -g` (it would replace the
  // defaults: SSH_AUTH_SOCK, DISPLAY, …) and never repeated `-ga` (it would grow
  // across opens). LAST in the chain: on an old tmux that rejects the indexed form
  // a failing command stops the rest of a `;` chain, so nothing above is lost.
  // LOCAL ONLY: a remote variable-less attach must never strip, and remote
  // control-mode applies its values with `set-environment` over the channel.
  ...CALLBACK_TMUX_ENV_NAMES.map((name) => ({
    name: callbackUpdateEnvironmentOption(name),
    value: name,
    localOnly: true,
  })),
];

/**
 * Option args to chain after a tmux command (e.g. `start-server`), using `';'`
 * as the literal tmux command separator (for argv-based spawns). This is the
 * LOCAL opener's chain, so it includes the `localOnly` callback
 * `update-environment` entries unless `callbackEnvironment` is false (a naming
 * object that shares its tmux sessions across installs sets no entry of its own).
 *
 * `exit-empty` is always `off`, in isolated/ephemeral runs too: the server is
 * started by a variable-free process and the next client that carries a
 * project's callback variables must never be the one that starts it, which an
 * `exit-empty on` server (exiting at once with no session) would allow. Isolated
 * runs end their server with an explicit `kill-server` instead.
 */
export function tmuxServerOptionArgs(options: { callbackEnvironment?: boolean } = {}): string[] {
  const callbackEnvironment = options.callbackEnvironment ?? true;
  return TMUX_SERVER_OPTIONS.filter((o) => callbackEnvironment || !o.localOnly).flatMap((o) => [
    ';',
    'set',
    o.append ? '-ga' : '-g',
    o.name,
    o.value,
  ]);
}

/**
 * Option commands for a remote shell, joined with the literal `\;` separator the
 * shell passes through to tmux. Values are single-quoted so glob/special chars
 * (e.g. the `*` in `terminal-overrides`) reach tmux verbatim. Does NOT include a
 * leading separator — callers chain it after `start-server`. `localOnly` entries
 * are filtered out: no remote opener carries them.
 */
export function tmuxServerOptionShell(): string {
  return TMUX_SERVER_OPTIONS.filter((o) => !o.localOnly)
    .map((o) => `set ${o.append ? '-ga' : '-g'} ${o.name} '${o.value}'`)
    .join(' \\; ');
}

/** Env for a terminal-hosting process (node-pty): modern TERM + truecolor. */
export function terminalPaneEnv(base: Record<string, string | undefined>): Record<string, string> {
  return { ...base, TERM: TERMINAL_TERM, COLORTERM: TERMINAL_COLORTERM } as Record<string, string>;
}
