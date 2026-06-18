/**
 * Line-note anchoring helpers. A line note stores a snapshot of the anchored
 * line's text (`anchorText`); when the live line's text drifts from that
 * snapshot the note is "outdated" — the code it commented on has changed.
 */

/**
 * True when a note's anchor no longer matches the live line. Comparison is
 * whitespace-trimmed so pure reindentation does not flag every note. A note
 * with no anchor snapshot (project/file-level, or pre-feature) is never
 * outdated; an anchored note whose line has disappeared (no live text) is.
 */
export function isOutdated(
  anchorText: string | null | undefined,
  liveText: string | null | undefined,
): boolean {
  if (anchorText == null) return false;
  if (liveText == null) return true;
  return anchorText.trim() !== liveText.trim();
}
