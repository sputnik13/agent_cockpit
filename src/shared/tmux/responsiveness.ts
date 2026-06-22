/**
 * Control-mode command responsiveness policy (pure).
 *
 * The control managers correlate command replies in a FIFO; if tmux or the SSH
 * link wedges, replies stop and every in-flight `command()` promise would hang
 * forever (they otherwise reject only on transport exit). This module defines
 * the two-stage thresholds the managers apply to the OLDEST in-flight command:
 *
 * - `warn` (>= WARN_MS): surface an "unresponsive" signal (UI/log) but keep
 *   waiting — a merely-slow command should not be torn down. iTerm2 warns at 5s.
 * - `fail` (>= FAIL_MS): give up — the manager rejects all pending commands and
 *   tears down the transport (remote then reattaches), so promises don't hang
 *   and the FIFO can't desync from a late reply on a dead channel.
 *
 * Pure: episode state (warned-once / failed-once) lives in the stateful manager;
 * this only maps an age to an action so it is trivially unit-testable.
 */

/** Oldest-pending age at which to surface an unresponsive warning. */
export const UNRESPONSIVE_WARN_MS = 5_000;

/** Oldest-pending age at which to fail pending commands + tear down the transport. */
export const UNRESPONSIVE_FAIL_MS = 15_000;

/** How often the managers poll the oldest-pending age. */
export const RESPONSIVENESS_POLL_MS = 1_000;

export type ResponsivenessAction = 'none' | 'warn' | 'fail';

/** Surfaced when the oldest in-flight command crosses the unresponsive WARN
 *  threshold (the link is wedged but not yet failed). */
export interface UnresponsiveInfo {
  pendingCount: number;
  oldestAgeMs: number;
}

/**
 * Classify the oldest in-flight command's age into an action. `null` (no pending
 * command) is always `none`.
 */
export function classifyResponsiveness(oldestAgeMs: number | null): ResponsivenessAction {
  if (oldestAgeMs == null) return 'none';
  if (oldestAgeMs >= UNRESPONSIVE_FAIL_MS) return 'fail';
  if (oldestAgeMs >= UNRESPONSIVE_WARN_MS) return 'warn';
  return 'none';
}
