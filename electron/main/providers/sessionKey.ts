import { createHash } from 'node:crypto';

/** tmux session names cannot contain '.' or ':' (whitespace is also unsafe). */
export function sanitizeSessionName(s: string): string {
  return s.replace(/[.:\s]/g, '-');
}

/**
 * Deterministic per-project-root session key: the first 16 hex chars of
 * sha256(project root), with trailing slashes trimmed so `a/` and `a` collide.
 * The same root yields the same key on ANY machine, so the same project opened
 * from different client machines maps to the same tmux session name (and thus
 * attaches to the same session). 64 bits is ample to avoid collision across a
 * user's projects while keeping the tmux name short.
 */
export function sessionKey(root: string): string {
  return createHash('sha256').update(root.replace(/\/+$/, '')).digest('hex').slice(0, 16);
}

/**
 * The token embedded in a project's tmux session names. With deterministic
 * naming ON it is {@link sessionKey}(root) — stable across machines, so clients
 * share one session; OFF (default) it is the per-machine project id (legacy
 * behavior, unchanged). Resolve this ONCE at session-open time and reuse it for
 * the session's lifetime, so toggling the setting never renames a live session.
 */
export function sessionNameToken(deterministic: boolean, projectId: string, root: string): string {
  return deterministic ? sessionKey(root) : sanitizeSessionName(projectId);
}
