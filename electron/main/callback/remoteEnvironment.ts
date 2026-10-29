/**
 * A REMOTE project's callback environment: the provider-side "callback
 * environment for this project" for a remote session
 * (docs/design/terminal-callback-socket.md, "Environment injection").
 *
 * Unlike a local project (whose socket is the broker's own listener), a remote
 * project's values come from its helper's handshake answer:
 *
 *  - `COCKPIT_CALLBACK_SOCK` is `callbackSock`, the socket the helper listens on
 *    ON THE HOST (its location, including the short `/tmp` fallback, never
 *    matters to main: the helper reports the real path);
 *  - `COCKPIT_CLI` is `cliPath`, the `cockpit` link the helper made on the host;
 *  - `COCKPIT_CALLBACK_VERSION` is the protocol constant.
 *
 * It is evaluated at every control-channel attach and every mux spawn, never
 * cached. It yields `undefined` (nothing injected) when the helper reported no
 * socket or CLI, when the helper's stream is already gone (a dead helper serves
 * nothing, so a new terminal must not point at it: the variable is absent, and the
 * documented `"${COCKPIT_CLI:?…}"` form explains why), and when the reported
 * values cannot be injected (a NUL or line break) — one log line per project in
 * that last case, rather than a partial set.
 */
import { buildCallbackEnvironment, type CallbackEnvironmentSource } from '@shared/callback/env';
import { logger } from '../logger';

/** What the helper's handshake reported for a project. */
export interface HelperCallbackValues {
  callbackSock?: string | undefined;
  cliPath?: string | undefined;
}

export interface RemoteEnvironmentDeps {
  /**
   * The values from the project's CURRENT helper, or undefined when there is no
   * live helper (not connected yet, disconnected, or its stream ended).
   */
  helperValues: () => HelperCallbackValues | undefined;
}

export function remoteCallbackEnvironmentSource(
  projectId: string,
  deps: RemoteEnvironmentDeps,
): CallbackEnvironmentSource {
  let warned = false;
  return () => {
    const values = deps.helperValues();
    if (!values?.callbackSock || !values.cliPath) return undefined;
    const environment = buildCallbackEnvironment({
      sock: values.callbackSock,
      cli: values.cliPath,
    });
    if (!environment && !warned) {
      warned = true;
      logger.warn(
        `callback env unavailable project=${projectId} reason=not-injectable detail="the helper-reported socket or CLI path contains NUL or a line break"`,
        'callback',
      );
    }
    return environment;
  };
}
