/**
 * Pure builders for the tmux commands the control client issues on stdin. tmux
 * targets keep their sigils: panes are `%<n>`, windows are `@<n>`. Each builder
 * returns the command argument string (without a trailing newline); the host
 * appends `\n` when it writes to the control stream.
 *
 * Keeping these here (shared, pure) lets both the local and remote managers and
 * their unit tests build identical commands without duplicating quoting rules.
 */
import { toHex } from './codec';

/** `new-window` in the current session (optionally named, optional cwd). */
export function newWindow(opts?: { name?: string; cwd?: string }): string {
  let cmd = 'new-window';
  if (opts?.name) cmd += ` -n ${shellQuote(opts.name)}`;
  if (opts?.cwd) cmd += ` -c ${shellQuote(opts.cwd)}`;
  return cmd;
}

/** `split-window` of a target pane, horizontally (`lr`) or vertically (`tb`). */
export function splitWindow(paneId: string, dir: 'lr' | 'tb', opts?: { cwd?: string }): string {
  const flag = dir === 'lr' ? '-h' : '-v';
  let cmd = `split-window ${flag} -t ${paneId}`;
  if (opts?.cwd) cmd += ` -c ${shellQuote(opts.cwd)}`;
  return cmd;
}

export function killPane(paneId: string): string {
  return `kill-pane -t ${paneId}`;
}

export function killWindow(windowId: string): string {
  return `kill-window -t ${windowId}`;
}

export function selectWindow(windowId: string): string {
  return `select-window -t ${windowId}`;
}

export function selectPane(paneId: string): string {
  return `select-pane -t ${paneId}`;
}

export function renameWindow(windowId: string, name: string): string {
  return `rename-window -t ${windowId} ${shellQuote(name)}`;
}

/** Resize a pane to an absolute width and/or height in cells. */
export function resizePane(paneId: string, opts: { x?: number; y?: number }): string {
  let cmd = `resize-pane -t ${paneId}`;
  if (opts.x != null) cmd += ` -x ${Math.max(1, Math.floor(opts.x))}`;
  if (opts.y != null) cmd += ` -y ${Math.max(1, Math.floor(opts.y))}`;
  return cmd;
}

/** Report the control client's overall size; tmux re-emits layout. */
export function refreshClientSize(cols: number, rows: number): string {
  return `refresh-client -C ${Math.max(1, Math.floor(cols))}x${Math.max(1, Math.floor(rows))}`;
}

/**
 * Send literal input bytes to a pane as hex pairs (`-H`), which avoids all
 * shell quoting/escaping pitfalls for control keys, paste, and multibyte input.
 * Accepts a string (UTF-8 encoded) or a pre-built hex string.
 */
export function sendKeysHex(paneId: string, hexOrInput: string | Uint8Array): string {
  const hex = isHex(hexOrInput) ? (hexOrInput as string) : toHex(hexOrInput);
  return `send-keys -t ${paneId} -H ${hex}`;
}

/** `capture-pane -peJ` history seed for a pane (optionally from `-S -<n>`). */
export function capturePane(paneId: string, opts?: { startLine?: number }): string {
  let cmd = `capture-pane -peJ -t ${paneId}`;
  if (opts?.startLine != null) cmd += ` -S -${Math.max(0, Math.floor(opts.startLine))}`;
  return cmd;
}

/** List windows with a stable id+name+layout format for initial enumeration. */
export function listWindows(): string {
  return `list-windows -F '#{window_id} #{window_name} #{window_layout}'`;
}

/** List panes with id+geometry+title for initial enumeration. */
export function listPanes(): string {
  return `list-panes -s -F '#{window_id} #{pane_id} #{pane_width} #{pane_height} #{pane_active}'`;
}

/**
 * List a window's panes with their alternate-screen flag, for hard-refresh
 * gating. A pane on the alternate screen (`#{alternate_on}` == 1) is running a
 * full-screen TUI (vim, htop, Claude Code) and MUST NOT be re-seeded from
 * `capture-pane` — the app's own redraw would overlay the seeded lines and scroll
 * them away. Reply lines: `%<n> <0|1>`.
 */
export function listPanesAltScreen(windowId: string): string {
  return `list-panes -t ${windowId} -F '#{pane_id} #{alternate_on}'`;
}

/** True when the value is already a space-separated lowercase hex-pair string. */
function isHex(v: string | Uint8Array): boolean {
  return typeof v === 'string' && /^([0-9a-f]{2})( [0-9a-f]{2})*$/.test(v);
}

/** Single-quote a value for safe interpolation into a tmux/shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
