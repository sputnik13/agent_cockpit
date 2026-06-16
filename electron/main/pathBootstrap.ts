/**
 * PATH bootstrap for GUI launches.
 *
 * macOS apps launched from the Dock/Finder/Spotlight inherit launchd's
 * environment, whose PATH is the minimal `/usr/bin:/bin:/usr/sbin:/sbin`.
 * Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`) and user-local
 * (`~/.local/bin`) install dirs are absent, so tools the app spawns by bare name
 * — `tmux`, `br` — fail with ENOENT even though they are installed. Launched
 * from a terminal it works because the shell's PATH already contains those dirs
 * (which is why the failure looks intermittent / "but it's installed").
 *
 * `bootstrapPath()` runs once at main-process startup, before any spawn, and
 * restores a realistic PATH by importing the user's real login-shell PATH and
 * unioning in a static fallback set. This is the same approach used by other
 * Electron apps (e.g. the `fix-path`/`shell-env` family); it is home-grown here
 * to avoid a runtime dependency and stay inside the existing spawn seams.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number },
) => SpawnSyncReturns<string>;

/**
 * Common install dirs that launchd's minimal GUI PATH omits. Order is priority
 * (Homebrew before user-local). Used as a fallback union so a missing
 * login-shell import still finds Homebrew/user-local tools.
 */
export function staticPathDirs(home: string = homedir()): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.local', 'bin'),
  ];
}

/**
 * Import the user's real PATH by running their login shell. A GUI-launched app
 * otherwise only sees launchd's minimal PATH, so this is the durable way to pick
 * up Homebrew, version managers (mise/asdf/nvm), and any custom dirs the user
 * actually has — it never goes stale as their setup changes.
 *
 * Runs `$SHELL -ilc` (interactive login shell) so the rc/profile files that set
 * PATH are sourced, and delimits the value with a marker so banner/noise printed
 * by the shell is ignored. Returns the PATH string, or `null` when it cannot be
 * determined (no `$SHELL`, non-zero exit, timeout, or empty result).
 */
export function importLoginShellPath(
  opts: { shell?: string | undefined; timeoutMs?: number; spawn?: SpawnSyncFn } = {},
): string | null {
  const shell = opts.shell ?? process.env.SHELL;
  if (!shell) return null;
  const spawn = opts.spawn ?? (spawnSync as unknown as SpawnSyncFn);
  const MARK = '__AC_PATH__';
  let res: SpawnSyncReturns<string>;
  try {
    res = spawn(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 3000,
    });
  } catch {
    return null;
  }
  if (res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
  const m = res.stdout.match(new RegExp(`${MARK}([^]*?)${MARK}`));
  const path = m?.[1];
  return path && path.trim() ? path : null;
}

/**
 * Merge PATH fragments into one deduped, order-preserving PATH string. Empty and
 * duplicate dirs are dropped; the first occurrence wins so earlier fragments
 * keep their resolution priority.
 */
export function mergePathDirs(...fragments: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const frag of fragments) {
    if (!frag) continue;
    for (const dir of frag.split(':')) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(':');
}

/**
 * Restore a realistic PATH for tools the app spawns by bare name, mutating `env`
 * in place. No-op on Windows (POSIX login-shell semantics do not apply). The
 * login-shell PATH wins, then the static fallback dirs, then whatever PATH the
 * process already had — so the user's own resolution order is preserved and the
 * fallbacks only fill gaps.
 */
export function bootstrapPath(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform === 'win32') return;
  const shellPath = importLoginShellPath();
  env.PATH = mergePathDirs(shellPath, staticPathDirs().join(':'), env.PATH);
}

/**
 * Locate an executable named `name` on the given PATH (defaults to the current,
 * post-bootstrap PATH). Returns the absolute path or `null`. Used for honest
 * diagnostics when a tool is genuinely missing — so the error names the
 * effective PATH instead of surfacing a bare ENOENT that reads as a bug.
 */
export function resolveBin(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, fsConstants.X_OK);
      return full;
    } catch {
      /* not here / not executable */
    }
  }
  return null;
}
