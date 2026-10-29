/**
 * Startup environment scrub (requirement 7). The app is routinely launched from
 * inside a cockpit pane, which carries the OUTER app's callback variables. Left
 * in `process.env` they would be inherited by every terminal this app spawns and
 * by its persistent mux daemon, so panes would call back into the outer app,
 * including when `deterministicSessionNames` is on.
 *
 * The scrub is UNCONDITIONAL (no setting or mode gates it) and runs before any
 * spawn. It deliberately keeps `COCKPIT_MUX_HOME`, `COCKPIT_MUX_BIN` and
 * `COCKPIT_MUX_EPHEMERAL`: those are isolation overrides a harness sets on
 * purpose. This app's own values for a project are added explicitly to each
 * spawn's environment, never to `process.env`.
 */
import { CALLBACK_CLI_ENV, CALLBACK_ENV_PREFIX } from '@shared/callback/protocol';

/** Whether `name` is one of the variables this app owns in a terminal's environment. */
export function isCallbackEnvName(name: string): boolean {
  return name === CALLBACK_CLI_ENV || name.startsWith(CALLBACK_ENV_PREFIX);
}

/** Remove inherited `COCKPIT_CALLBACK_*` and `COCKPIT_CLI`; returns the removed NAMES (never values). */
export function scrubCallbackEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed = Object.keys(env).filter(isCallbackEnvName);
  for (const name of removed) delete env[name];
  return removed.sort();
}

/**
 * A COPY of `env` without any callback variable. Every spawn that must not carry
 * them (the process that starts a shared tmux server, whose environment becomes
 * every project's global environment) builds its environment through this, so it
 * stays variable-free even if something put a value into `process.env` after the
 * startup scrub.
 */
export function withoutCallbackEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isCallbackEnvName(name)));
}
