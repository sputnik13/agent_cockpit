/**
 * The `deterministicSessionNames` gate (requirement 12 of
 * docs/requirements/terminal-callback-socket.md).
 *
 * That setting makes different machines and installs share ONE tmux session, so
 * the socket written by whichever client attached last would make panes open
 * files in another install's app. The decision is therefore taken from the value
 * that NAMED the session being attached, held with the object that names it
 * (a provider for remote and session-per-tab, each lazily created local
 * control-mode manager) and never from a later live settings read. A gated
 * object injects nothing, sets no `update-environment` entry itself (so it enables
 * no stripping), and records this note.
 *
 * The entries are SERVER-global, though: ones that a non-gated object set earlier
 * on the same tmux server still apply to a gated object's attaches, and its
 * variable-less client then strips the callback variables of the session it
 * attaches (tmux leaves `-COCKPIT_*` removal markers and drops any value). That is
 * accepted: this app never puts values into a shared session, so at most a stale
 * value that something else set there is removed.
 *
 * Mux sessions are namespaced by the raw project id, not by the session-name
 * setting, so mux injection is deliberately NOT gated.
 */
import { logger } from '../logger';

export type SharedSessionBackend = 'session-per-tab' | 'control-mode';

/** Record (once per naming object) that callback injection is off because its sessions are shared. */
export function noteCallbackDisabledForSharedSessions(
  projectId: string,
  backend: SharedSessionBackend,
): void {
  logger.info(
    `callback injection disabled project=${projectId} backend=${backend} reason=deterministic-session-names ` +
      'detail="the tmux session is shared across installs; nothing is injected and no update-environment entry is set for it"',
    'callback',
  );
}
