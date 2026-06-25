/**
 * Single source for the tmux global (`set -g`) server options and the
 * per-terminal-pane environment, consumed by every opener (local/remote ×
 * control-mode/session-per-tab).
 *
 * These configure the tmux/pty layer, NOT the renderer, so they are
 * backend-agnostic — a pane rendered by xterm.js or by wterm inherits the same
 * terminal type, color support, scrollback, and mouse behavior.
 */
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
}

/**
 * Global tmux options applied to the shared server before the first session.
 * Every entry must be valid on any tmux the app targets (an unknown-option error
 * would break the remote `&&` opener chain) — `terminal-overrides` stores an
 * arbitrary capability string, so the `:Tc` truecolor cap is safe on all versions.
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
];

/**
 * Option args to chain after a tmux command (e.g. `start-server`), using `';'`
 * as the literal tmux command separator (for argv-based spawns).
 */
export function tmuxServerOptionArgs(): string[] {
  return TMUX_SERVER_OPTIONS.flatMap((o) => [';', 'set', o.append ? '-ga' : '-g', o.name, o.value]);
}

/**
 * Option commands for a remote shell, joined with the literal `\;` separator the
 * shell passes through to tmux. Values are single-quoted so glob/special chars
 * (e.g. the `*` in `terminal-overrides`) reach tmux verbatim. Does NOT include a
 * leading separator — callers chain it after `start-server`.
 */
export function tmuxServerOptionShell(): string {
  return TMUX_SERVER_OPTIONS.map(
    (o) => `set ${o.append ? '-ga' : '-g'} ${o.name} '${o.value}'`,
  ).join(' \\; ');
}

/** Env for a terminal-hosting process (node-pty): modern TERM + truecolor. */
export function terminalPaneEnv(base: Record<string, string | undefined>): Record<string, string> {
  return { ...base, TERM: TERMINAL_TERM, COLORTERM: TERMINAL_COLORTERM } as Record<string, string>;
}
