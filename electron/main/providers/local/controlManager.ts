/**
 * Construction of a project's LOCAL control-mode manager (the lazily created one
 * `ipc/index.ts` keeps per project) as ONE decision: the settings read that NAMES
 * the tmux session is the very value that decides whether callback injection may
 * write to it (requirement 12 of
 * docs/requirements/terminal-callback-socket.md; see
 * `callback/sharedSessions.ts`).
 *
 * The value is passed in ONCE and used for both the session token and the gate,
 * so the two cannot diverge, and nothing re-reads the setting afterwards: turning
 * it off while a shared session is live, then closing and reopening control mode,
 * builds a NEW manager (new read, a different session name) and never writes to
 * the shared one.
 */
import type { CallbackEnvironmentSource } from '@shared/callback/env';
import { noteCallbackDisabledForSharedSessions } from '../../callback/sharedSessions';
import { sessionNameToken } from '../sessionKey';
import { LocalTmuxControlManager } from './tmuxControl';

export interface LocalControlManagerInput {
  projectId: string;
  rootPath: string;
  /** `loadSettings().deterministicSessionNames`, read ONCE by the caller for this manager. */
  deterministicSessionNames: boolean;
  /** The project's local callback environment (consulted at every `open()`). */
  callbackEnvironment: CallbackEnvironmentSource;
  /** Tests: a private tmux socket and config file. */
  socket?: string;
  configPath?: string;
}

export function createLocalControlManager(
  input: LocalControlManagerInput,
): LocalTmuxControlManager {
  const shared = input.deterministicSessionNames;
  const token = sessionNameToken(shared, input.projectId, input.rootPath);
  if (shared) noteCallbackDisabledForSharedSessions(input.projectId, 'control-mode');
  return new LocalTmuxControlManager(
    token,
    input.rootPath,
    input.socket,
    input.configPath,
    shared ? undefined : input.callbackEnvironment,
  );
}
