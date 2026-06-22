/**
 * tmux version parsing + comparison.
 *
 * tmux point releases use lettered suffixes (`3.0`, `3.0a`, `3.0b`, …) that sort
 * ABOVE the unlettered base (`3.0 < 3.0a < 3.1`), so a naive `parseFloat('3.6a')`
 * is both lossy and wrong. We encode a version as a single comparable integer
 * `major*10000 + minor*100 + letter` (letter `a`=1, `b`=2, …, none=0), mirroring
 * iTerm2's lettered-release scheme. This leaves room for two-digit minors
 * (`3.10` = 31000 > `3.2` = 30200) and 26 point letters.
 *
 * Used to gate control-mode features by server capability (e.g. pause-mode and
 * format subscriptions require tmux >= 3.2). An unknown/unparseable version is
 * treated as "below any target" by {@link tmuxAtLeast} so a new feature stays
 * OFF rather than being enabled against a server that may not support it.
 *
 * Pure: no I/O. The caller obtains the raw version string (`tmux -V`, the
 * `%begin` banner, or a remote probe) and passes it here.
 */

/** Matches the `MAJOR.MINOR[letter]` core of a tmux version anywhere in a string
 *  (tolerates prefixes/suffixes like `tmux 3.2`, `next-3.4`, `openbsd-7.5`). */
const VERSION_RE = /(\d+)\.(\d+)([a-z])?/;

/**
 * Parse a tmux version string into a comparable integer, or `null` if no
 * `MAJOR.MINOR` core is present.
 *
 * Examples: `"3.2"` → 30200, `"3.0a"` → 30001, `"tmux 3.6a"` → 30602,
 * `"next-3.4"` → 30400, `"garbage"` → null.
 */
export function parseTmuxVersion(raw: string): number | null {
  const m = VERSION_RE.exec(raw);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;
  // Single lowercase letter → 1..26; absent → 0.
  const letter = m[3] ? m[3].charCodeAt(0) - 0x60 : 0;
  return major * 10000 + minor * 100 + letter;
}

/**
 * True iff `version` is at least `target`.
 *
 * `version` may be a raw string (parsed here), a pre-parsed integer, or `null`.
 * A `null`/unparseable `version` returns `false` (conservative: gate features
 * OFF when the server capability is unknown). `target` must be a valid version
 * string; an unparseable target also returns `false`.
 */
export function tmuxAtLeast(version: string | number | null, target: string): boolean {
  const v = typeof version === 'number' ? version : version == null ? null : parseTmuxVersion(version);
  const t = parseTmuxVersion(target);
  if (v == null || t == null) return false;
  return v >= t;
}
