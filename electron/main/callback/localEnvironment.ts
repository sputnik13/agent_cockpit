/**
 * A LOCAL project's callback environment: the provider-side "callback
 * environment for this project" for a local session
 * (docs/design/terminal-callback-socket.md, "Environment injection").
 *
 *  - `COCKPIT_CALLBACK_SOCK` is the socket the project's broker listener is bound
 *    to RIGHT NOW (null when it is not bound: callback is disabled for the
 *    project, so nothing is injected and a variable-less attach strips any stale
 *    value).
 *  - `COCKPIT_CLI` is the CLI the app links for local panes at
 *    `<userData>/callback/bin/cockpit`. Creating that link is the CLI package's
 *    job; until then the path dangles (a pane gets "No such file or directory",
 *    which names the missing file).
 *  - `COCKPIT_CALLBACK_VERSION` is the protocol constant.
 *
 * Remote projects have no local listener; their source comes from the helper
 * handshake (`callbackSock`/`cliPath`) and is `undefined` until that exists.
 */
import { join, resolve } from 'node:path';
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { logger } from '../logger';

/** Where the app links the `cockpit` CLI for local panes. */
export function localCliPath(userDataDir: string): string {
  return join(resolve(userDataDir), 'callback', 'bin', 'cockpit');
}

export interface LocalEnvironmentDeps {
  /** The broker's live socket for a project, or null when none is bound. */
  localSocketPath: (projectId: string) => string | null;
  /** Electron's userData directory. Read at each evaluation, never cached. */
  userDataDir: () => string;
}

/**
 * The source for one local project. Evaluated at every terminal creation or
 * attach, so a listener that rebinds is picked up by the next terminal. A set that
 * cannot be injected (a NUL or line break in the userData path) yields `undefined`
 * with one log line per project, rather than a partial set.
 */
export function localCallbackEnvironmentSource(
  projectId: string,
  deps: LocalEnvironmentDeps,
): CallbackEnvironmentSource {
  let warned = false;
  return () => {
    const sock = deps.localSocketPath(projectId);
    if (sock === null) return undefined;
    const environment = buildCallbackEnvironment({
      sock,
      cli: localCliPath(deps.userDataDir()),
    });
    if (!environment && !warned) {
      warned = true;
      logger.warn(
        `callback env unavailable project=${projectId} reason=not-injectable detail="the socket or CLI path contains NUL or a line break"`,
        'callback',
      );
    }
    return environment;
  };
}
