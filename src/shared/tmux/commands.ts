/**
 * Pure builders for the tmux commands the control client issues on stdin. tmux
 * targets keep their sigils: panes are `%<n>`, windows are `@<n>`. Each builder
 * returns the command argument string (without a trailing newline); the host
 * appends `\n` when it writes to the control stream.
 *
 * Keeping these here (shared, pure) lets both the local and remote managers and
 * their unit tests build identical commands without duplicating quoting rules.
 */
import { chunkBytesForSendKeys, fromHex, MAX_SEND_KEYS_CHUNK_BYTES, toHex } from './codec';

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

/** Seconds a pane may run ahead of the client before tmux auto-pauses it. */
export const PAUSE_AFTER_SECONDS = 3;

/** `display-message -p '#{version}'` — query the running tmux version (control
 *  stream; works on both transports). Used to gate version-specific features. */
export function tmuxVersionQuery(): string {
  return `display-message -p '#{version}'`;
}

/** Enable pause-mode flow control: tmux pauses a pane once the client is more
 *  than `seconds` behind (and switches `%output`→`%extended-output`). tmux>=3.2. */
export function refreshClientPauseAfter(seconds: number = PAUSE_AFTER_SECONDS): string {
  return `refresh-client -f pause-after=${Math.max(1, Math.floor(seconds))}`;
}

/** Resume a paused pane (`refresh-client -A %<pane>:continue`). The caller must
 *  re-seed the pane afterward — output produced while paused was dropped. */
export function refreshClientContinue(paneId: string): string {
  return `refresh-client -A ${paneId}:continue`;
}

/**
 * Subscribe to a format via `refresh-client -B name:what:format` (tmux >= 3.2):
 * tmux pushes `%subscription-changed` whenever the evaluated format changes,
 * replacing screen-scraping / polling. `what` is the target context (e.g. a pane
 * `%3`, or empty for the client's active target); `format` is a tmux format
 * string (e.g. `#{pane_title}`). `name` is the caller's chosen subscription id.
 */
export function refreshClientSubscribe(name: string, what: string, format: string): string {
  return `refresh-client -B ${shellQuote(`${name}:${what}:${format}`)}`;
}

/** Remove a subscription: an empty format (`name::`) cancels it (tmux >= 3.2). */
export function refreshClientUnsubscribe(name: string): string {
  return `refresh-client -B ${shellQuote(`${name}::`)}`;
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

/** Normalize input to raw bytes: a pre-built hex string is decoded, a plain
 *  string is UTF-8 encoded, a Uint8Array is used as-is. */
function toInputBytes(input: string | Uint8Array): Uint8Array {
  if (typeof input !== 'string') return input;
  return isHex(input) ? fromHex(input) : new TextEncoder().encode(input);
}

/**
 * Build the ordered `send-keys` commands for arbitrary pane input. Sends every
 * byte via `send-keys -H` (raw hex), chunked only for size so no command line
 * exceeds tmux's control-command limit (an over-long single `send-keys` is
 * silently dropped — the large-paste bug). Returns `[]` for empty input.
 *
 * CRITICAL — do NOT split by byte class (e.g. printable via `-l`, controls via
 * `-H`): that separates the ESC byte from the rest of an escape sequence into
 * different commands. Sent as two `send-keys` they arrive back-to-back locally
 * but over SSH the inter-command latency exceeds the receiving app's
 * escape-sequence timeout, so mouse reports / arrow keys / bracketed-paste
 * markers are misread as literal text (remote-only regression). All-`-H` keeps
 * each input event's bytes contiguous: a mouse report / small paste is one
 * atomic command, and a large paste's bracketed markers stay at the ends while
 * the receiving app buffers `200~`..`201~` across the size chunks.
 */
export function buildSendKeysCommands(paneId: string, input: string | Uint8Array): string[] {
  return chunkBytesForSendKeys(toInputBytes(input), MAX_SEND_KEYS_CHUNK_BYTES).map((chunk) =>
    sendKeysHex(paneId, chunk),
  );
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
