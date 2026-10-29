/**
 * The terminal-environment contract of the callback socket: which variables the
 * app puts in a pane's environment, the tmux `update-environment` indices that
 * carry them, and the per-project value set every injection path consumes
 * (docs/design/terminal-callback-socket.md, "Environment injection").
 *
 * Pure and dependency-light so main's openers, the remote control manager and
 * the mux manager (and their tests) share ONE description of the variables.
 *
 * The values are per PROJECT (socket path, protocol version, CLI path); per-pane
 * identity is not injected for tmux (`TMUX_PANE` comes for free) and for the mux
 * is the app-chosen terminal key, added per spawn by {@link callbackMuxOperands}.
 */
import {
  CALLBACK_CLI_ENV,
  CALLBACK_MUX_KEY_ENV,
  CALLBACK_PROTOCOL_VERSION,
  isInjectableEnvValue,
} from './protocol';

// Literal types (not template strings) so they can key `CallbackEnvironment.vars`.
// Both sit under `CALLBACK_ENV_PREFIX`, which the startup scrub removes wholesale.
export const CALLBACK_SOCK_ENV = 'COCKPIT_CALLBACK_SOCK';
export const CALLBACK_VERSION_ENV = 'COCKPIT_CALLBACK_VERSION';

/**
 * The variables the tmux backends carry, in index order. `COCKPIT_CALLBACK_MUX_KEY`
 * is mux-only (it never goes through tmux) and is deliberately not listed.
 */
export const CALLBACK_TMUX_ENV_NAMES = [
  CALLBACK_SOCK_ENV,
  CALLBACK_VERSION_ENV,
  CALLBACK_CLI_ENV,
] as const;
export type CallbackTmuxEnvName = (typeof CALLBACK_TMUX_ENV_NAMES)[number];

/**
 * First index of tmux's `update-environment` array that this app owns. tmux's own
 * defaults (`SSH_AUTH_SOCK`, `DISPLAY`, …) occupy the low indices on current
 * releases, so owning a high, fixed range neither grows the option across opens
 * (setting an element is idempotent) nor disturbs the defaults. ONE element per
 * variable name: an element holds exactly one name.
 */
export const CALLBACK_UPDATE_ENVIRONMENT_FIRST_INDEX = 100;

/** The `update-environment` option name (with its element index) that carries `name`. */
export function callbackUpdateEnvironmentOption(name: CallbackTmuxEnvName): string {
  return `update-environment[${CALLBACK_UPDATE_ENVIRONMENT_FIRST_INDEX + CALLBACK_TMUX_ENV_NAMES.indexOf(name)}]`;
}

/** A project's complete, validated set of injectable values. */
export interface CallbackEnvironment {
  readonly vars: Readonly<Record<CallbackTmuxEnvName, string>>;
}

/**
 * Provider-side "callback environment for this project": the values to inject
 * into a terminal created NOW, or `undefined` when the project has none (no
 * listener bound, CLI location unknown, or the backend's values are not
 * available yet). Evaluated at every spawn/attach, never cached, so a listener
 * that rebinds or a helper that reconnects is picked up by the next terminal.
 *
 * Local projects derive it from the broker's live socket; remote projects will
 * derive it from the helper handshake (`callbackSock`/`cliPath`).
 */
export type CallbackEnvironmentSource = () => CallbackEnvironment | undefined;

/** The source of a backend that has no values (yet): nothing is injected. */
export const NO_CALLBACK_ENVIRONMENT: CallbackEnvironmentSource = () => undefined;

/**
 * Assemble a project's environment from its two location-dependent values (the
 * version is the protocol constant). `undefined` when either is empty or cannot
 * survive an environment block / tmux command line (NUL or a line break), so a
 * caller never injects a partial or unusable set.
 */
export function buildCallbackEnvironment(values: {
  sock: string;
  cli: string;
}): CallbackEnvironment | undefined {
  const vars: Record<CallbackTmuxEnvName, string> = {
    [CALLBACK_SOCK_ENV]: values.sock,
    [CALLBACK_VERSION_ENV]: String(CALLBACK_PROTOCOL_VERSION),
    [CALLBACK_CLI_ENV]: values.cli,
  };
  for (const name of CALLBACK_TMUX_ENV_NAMES) {
    if (vars[name].length === 0 || !isInjectableEnvValue(vars[name])) return undefined;
  }
  return { vars };
}

/** The environment's variables as `[name, value]` pairs in the fixed index order. */
export function callbackEnvironmentEntries(
  environment: CallbackEnvironment,
): Array<[CallbackTmuxEnvName, string]> {
  return CALLBACK_TMUX_ENV_NAMES.map((name) => [name, environment.vars[name]]);
}

/**
 * `NAME=value` operands for the mux's `/usr/bin/env … /bin/sh -c …` trampoline:
 * the project's variables plus `COCKPIT_CALLBACK_MUX_KEY=<key>`, the app-chosen
 * terminal key (known before the pane exists; it wins over a stale `TMUX_PANE`
 * in pane identity). Operands are argv, so spaces and shell metacharacters in a
 * value are safe. `undefined` when the key is empty or not injectable.
 */
export function callbackMuxOperands(
  environment: CallbackEnvironment,
  key: string,
): string[] | undefined {
  if (key.length === 0 || !isInjectableEnvValue(key)) return undefined;
  return [
    ...callbackEnvironmentEntries(environment).map(([name, value]) => `${name}=${value}`),
    `${CALLBACK_MUX_KEY_ENV}=${key}`,
  ];
}
