/**
 * Per-instance configuration overrides.
 *
 * A normally-running app and a second instance (automated tests, the screenshot
 * harness) share host-level resources. These overrides let the second instance
 * use isolated resources so it never disturbs the running app. With no override
 * set, every value matches the normal app.
 *
 * Overlapping resources and how to isolate them:
 *  - **tmux server/socket** — `--tmux-socket=<name>` or `AC_TMUX_SOCKET` (below).
 *    `tmux -L <name>` selects a distinct server, so sessions never collide.
 *  - **app user-data** (config.json, the SQLite store, projects, layout) — use
 *    Electron's `--user-data-dir=<path>` Chromium switch, which redirects
 *    `app.getPath('userData')` that `config.ts` and `store/sqlite.ts` read from.
 *
 * See docs/BUILD.md ("Running an isolated instance").
 */

/** Value of a `--flag=value` CLI argument, if present. */
function cliValue(flag: string): string | undefined {
  const prefix = `--${flag}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

const DEFAULT_TMUX_SOCKET = 'agent-cockpit';
// `tmux -L` names a socket file under /tmp/tmux-<uid>/; keep it filename-safe.
const SOCKET_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * tmux socket name passed to `tmux -L`. Overridable via `--tmux-socket=<name>`
 * or the `AC_TMUX_SOCKET` env var; falls back to the default when unset or when
 * the value is not a safe socket name.
 */
export function tmuxSocket(): string {
  const raw = cliValue('tmux-socket') ?? process.env.AC_TMUX_SOCKET;
  return raw && SOCKET_NAME.test(raw) ? raw : DEFAULT_TMUX_SOCKET;
}
