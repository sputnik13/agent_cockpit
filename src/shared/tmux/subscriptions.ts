/**
 * Format-subscription naming + routing for control-mode titles and mouse flags
 * (tmux >= 3.2 `refresh-client -B`). Subscription names encode their target so a
 * pushed `%subscription-changed` can be routed without extra bookkeeping:
 *   - `cockpit-title-<windowId>`  → that window's active-pane title
 *   - `cockpit-mouse-<paneId>`    → that pane's mouse-tracking flags
 *
 * The subscribe/unsubscribe command builders (renderer) and `parseSubscriptionName`
 * (store reducer) are the two sides of this contract; keep them in one module so
 * they cannot drift. Pure — no I/O.
 */
import { refreshClientSubscribe, refreshClientUnsubscribe } from './commands';

export const TITLE_SUB_PREFIX = 'cockpit-title-';
export const MOUSE_SUB_PREFIX = 'cockpit-mouse-';

/** Subscribe a window's active-pane title (`#{pane_title}`). */
export function titleSubscribeCmd(windowId: string): string {
  return refreshClientSubscribe(`${TITLE_SUB_PREFIX}${windowId}`, windowId, '#{pane_title}');
}
export function titleUnsubscribeCmd(windowId: string): string {
  return refreshClientUnsubscribe(`${TITLE_SUB_PREFIX}${windowId}`);
}

/** Subscribe a pane's mouse-tracking flags (`#{mouse_any_flag} #{mouse_sgr_flag}`). */
export function mouseSubscribeCmd(paneId: string): string {
  return refreshClientSubscribe(
    `${MOUSE_SUB_PREFIX}${paneId}`,
    paneId,
    '#{mouse_any_flag} #{mouse_sgr_flag}',
  );
}
export function mouseUnsubscribeCmd(paneId: string): string {
  return refreshClientUnsubscribe(`${MOUSE_SUB_PREFIX}${paneId}`);
}

export type ParsedSubscription =
  | { kind: 'title'; windowId: string }
  | { kind: 'mouse'; paneId: string }
  | null;

/** Classify a `%subscription-changed` name back to its target, or null if it is
 *  not one of ours. */
export function parseSubscriptionName(name: string): ParsedSubscription {
  if (name.startsWith(TITLE_SUB_PREFIX)) {
    return { kind: 'title', windowId: name.slice(TITLE_SUB_PREFIX.length) };
  }
  if (name.startsWith(MOUSE_SUB_PREFIX)) {
    return { kind: 'mouse', paneId: name.slice(MOUSE_SUB_PREFIX.length) };
  }
  return null;
}

export interface MouseFlags {
  any: boolean;
  sgr: boolean;
}

/** Parse a `#{mouse_any_flag} #{mouse_sgr_flag}` value (e.g. "1 0"). */
export function parseMouseFlagsValue(value: string): MouseFlags {
  const [any, sgr] = value.trim().split(/\s+/);
  return { any: any === '1', sgr: sgr === '1' };
}
