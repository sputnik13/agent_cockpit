/**
 * Typed model for the tmux control-mode (`-CC`) protocol, shared by the host
 * control-session managers and the renderer store. This module is pure: no I/O,
 * no Electron, no node-pty. tmux ids keep their sigils so they round-trip
 * verbatim into commands (`%<pane>` for panes, `@<win>` for windows,
 * `$<session>` for sessions).
 */

/** A tmux pane id, e.g. `%3`. */
export type PaneId = string;
/** A tmux window id, e.g. `@1`. */
export type WindowId = string;
/** A tmux session id, e.g. `$0`. */
export type SessionId = string;

/** Split direction in a tmux window-layout tree. */
export type LayoutDir = 'lr' | 'tb';

/** A leaf in the layout tree: a single pane with its cell geometry. */
export interface LayoutLeaf {
  type: 'leaf';
  paneId: PaneId;
  /** Cell width/height and top-left origin, in terminal cells. */
  w: number;
  h: number;
  x: number;
  y: number;
}

/** An internal node: a left/right (`lr`) or top/bottom (`tb`) split. */
export interface LayoutSplit {
  type: 'split';
  dir: LayoutDir;
  w: number;
  h: number;
  x: number;
  y: number;
  children: LayoutNode[];
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

/** Parsed `%layout-change` window layout: the four-hex checksum plus the tree. */
export interface WindowLayout {
  /** The leading 4-hex checksum tmux prepends (kept for fidelity; unverified). */
  checksum: string;
  root: LayoutNode;
}

// ---- Typed notifications (one discriminated union the renderer reduces) -----

export interface OutputNotification {
  type: 'output';
  paneId: PaneId;
  /** Decoded bytes for this pane (octal escapes already resolved). */
  bytes: Uint8Array;
}

export interface WindowAddNotification {
  type: 'window-add';
  windowId: WindowId;
}
export interface UnlinkedWindowAddNotification {
  type: 'unlinked-window-add';
  windowId: WindowId;
}
export interface WindowCloseNotification {
  type: 'window-close';
  windowId: WindowId;
}
export interface WindowRenamedNotification {
  type: 'window-renamed';
  windowId: WindowId;
  name: string;
}
export interface WindowPaneChangedNotification {
  type: 'window-pane-changed';
  windowId: WindowId;
  paneId: PaneId;
}

export interface LayoutChangeNotification {
  type: 'layout-change';
  windowId: WindowId;
  layout: WindowLayout;
  /** The visible (zoomed-aware) layout string, parsed when present. */
  visibleLayout: WindowLayout | null;
  flags: string | null;
}

export interface SessionChangedNotification {
  type: 'session-changed';
  sessionId: SessionId;
  name: string;
}
export interface SessionRenamedNotification {
  type: 'session-renamed';
  name: string;
}
export interface SessionsChangedNotification {
  type: 'sessions-changed';
}
export interface SessionWindowChangedNotification {
  type: 'session-window-changed';
  sessionId: SessionId;
  windowId: WindowId;
}
export interface ClientSessionChangedNotification {
  type: 'client-session-changed';
  client: string;
  sessionId: SessionId;
  name: string;
}
export interface ClientDetachedNotification {
  type: 'client-detached';
  client: string;
}

export interface PaneModeChangedNotification {
  type: 'pane-mode-changed';
  paneId: PaneId;
}
export interface ExitNotification {
  type: 'exit';
  reason: string | null;
}
export interface ContinueNotification {
  type: 'continue';
  paneId: PaneId;
}
export interface PauseNotification {
  type: 'pause';
  paneId: PaneId;
}

/**
 * A `%subscription-changed` push: tmux re-evaluated a format the client
 * subscribed to via `refresh-client -B` (tmux >= 3.2). `name` is the
 * client-chosen subscription name (which may encode its target, e.g. a pane);
 * `value` is the evaluated format (after the ` : ` delimiter). The intermediate
 * session/window/pane context fields are not modeled (consumers key off `name`).
 */
export interface SubscriptionChangedNotification {
  type: 'subscription-changed';
  name: string;
  value: string;
}

/**
 * A completed command reply: the lines emitted between `%begin <ts> <num>` and
 * the matching `%end`/`%error <ts> <num>`. `num` correlates to the command the
 * host issued. `error` is true when the block closed with `%error`.
 */
export interface ReplyNotification {
  type: 'reply';
  num: number;
  error: boolean;
  /** Reply body lines (without the framing `%begin`/`%end` lines). */
  lines: string[];
}

/** A `%`-line tmux emitted that this parser does not model yet. */
export interface UnknownNotification {
  type: 'unknown';
  /** The raw line including the leading `%`. */
  line: string;
}

export type TmuxNotification =
  | OutputNotification
  | WindowAddNotification
  | UnlinkedWindowAddNotification
  | WindowCloseNotification
  | WindowRenamedNotification
  | WindowPaneChangedNotification
  | LayoutChangeNotification
  | SessionChangedNotification
  | SessionRenamedNotification
  | SessionsChangedNotification
  | SessionWindowChangedNotification
  | ClientSessionChangedNotification
  | ClientDetachedNotification
  | PaneModeChangedNotification
  | ExitNotification
  | ContinueNotification
  | PauseNotification
  | SubscriptionChangedNotification
  | ReplyNotification
  | UnknownNotification;

export type TmuxNotificationType = TmuxNotification['type'];

/**
 * JSON-safe variant of {@link TmuxNotification} for crossing the IPC boundary.
 * Identical to {@link TmuxNotification} except `%output` bytes are carried as a
 * `number[]` (Uint8Array does not survive every IPC serialization path cleanly,
 * and a plain array keeps the renderer store trivially testable). The renderer
 * reconstructs a Uint8Array on receipt.
 */
export type TmuxWireNotification =
  | (Omit<OutputNotification, 'bytes'> & { bytes: number[] })
  | Exclude<TmuxNotification, OutputNotification>;

/** Convert a parsed notification into its JSON-safe wire form. */
export function toWireNotification(n: TmuxNotification): TmuxWireNotification {
  if (n.type === 'output') return { type: 'output', paneId: n.paneId, bytes: Array.from(n.bytes) };
  return n;
}

/** Reconstruct a parsed notification from its JSON-safe wire form. */
export function fromWireNotification(n: TmuxWireNotification): TmuxNotification {
  if (n.type === 'output') return { type: 'output', paneId: n.paneId, bytes: Uint8Array.from(n.bytes) };
  return n;
}
