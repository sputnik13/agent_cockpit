/**
 * sshConfigResolve — a minimal, dependency-free `~/.ssh/config` resolver for the
 * ssh2 transport path. ssh2 does not read `~/.ssh/config`, so a remote project
 * whose `host` is a `Host` alias fails with `getaddrinfo ENOTFOUND <alias>`.
 * This module resolves the alias's `HostName`/`Port`/`User`/`IdentityFile` so the
 * transport can connect to the real host.
 *
 * SCOPE (intentionally minimal): only `HostName`/`Port`/`User`/`IdentityFile`.
 * No `Match` blocks, no `Include` chains, no ProxyJump/ProxyCommand — those
 * belong to the native-ssh transport. ssh_config "first value wins" semantics
 * are honored per key.
 *
 * ENCAPSULATION INVARIANT (CLAUDE.md / ESLint no-ssh2): this module imports ONLY
 * `node:fs`/`node:os`/`node:path` — never `ssh2` — so it does not trip the
 * single-import rule that pins `ssh2` to `transport.ts`.
 *
 * RESILIENCE (FR5): a missing/unreadable config, or no matching block, yields an
 * empty resolution. This function NEVER throws.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolved ssh_config values for a host alias. All fields are optional. */
export interface ResolvedSshConfig {
  /** The real hostname/IP from `HostName`. */
  hostName?: string;
  /** The port from `Port`. */
  port?: number;
  /** The login user from `User`. */
  user?: string;
  /** The identity file from `IdentityFile`, with a leading `~` expanded. */
  identityFile?: string;
}

/** Options for {@link resolveSshConfig}; injectable for tests. */
export interface ResolveSshConfigOptions {
  /** Override the config path (defaults to `~/.ssh/config`). */
  configPath?: string;
  /** Override the home directory used for `~` expansion (defaults to `os.homedir()`). */
  home?: string;
}

/**
 * Resolve a host `alias` against `~/.ssh/config`, returning the first-wins
 * `HostName`/`Port`/`User`/`IdentityFile` across all matching `Host` blocks.
 *
 * Matching honors ssh_config glob semantics (`*`, `?`) and negation (`!pattern`)
 * within a `Host` line's pattern list. A leading `~` in `IdentityFile` is
 * expanded against the home directory. Returns `{}` on any failure or no match;
 * never throws (FR5).
 */
export function resolveSshConfig(alias: string, opts?: ResolveSshConfigOptions): ResolvedSshConfig {
  const home = opts?.home ?? homedir();
  const configPath = opts?.configPath ?? join(home, '.ssh', 'config');

  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    // Missing or unreadable config — connect with the spec as-is (FR5/FR4).
    return {};
  }

  const result: ResolvedSshConfig = {};
  // first-value-wins per ssh_config: only set a key the first time it is seen
  // inside a matching block.
  let matching = false;

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const { keyword, value } = splitKeyword(line);
    if (!keyword) continue;

    if (keyword === 'host') {
      matching = hostMatches(alias, value);
      continue;
    }

    if (!matching) continue;

    switch (keyword) {
      case 'hostname':
        if (result.hostName === undefined && value) result.hostName = value;
        break;
      case 'port': {
        if (result.port === undefined) {
          const port = Number.parseInt(value, 10);
          if (Number.isInteger(port) && port > 0) result.port = port;
        }
        break;
      }
      case 'user':
        if (result.user === undefined && value) result.user = value;
        break;
      case 'identityfile':
        if (result.identityFile === undefined && value) {
          result.identityFile = expandTilde(value, home);
        }
        break;
      default:
        // Out-of-scope keyword (Match, ProxyJump, Include, …) — ignored.
        break;
    }
  }

  return result;
}

/** Strip a trailing `#`-comment. ssh_config comments run to end of line. */
function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return hash === -1 ? line : line.slice(0, hash);
}

/**
 * Split a config line into a lowercased keyword and its value. ssh_config allows
 * `Keyword value` or `Keyword=value`; the first whitespace/`=` run is the
 * separator. Returns an empty keyword when the line has no value token.
 */
function splitKeyword(line: string): { keyword: string; value: string } {
  const m = /^(\S+?)\s*=\s*(.*)$|^(\S+)\s+(.*)$/.exec(line);
  if (!m) return { keyword: line.toLowerCase(), value: '' };
  const keyword = (m[1] ?? m[3] ?? '').toLowerCase();
  const value = (m[2] ?? m[4] ?? '').trim();
  return { keyword, value };
}

/**
 * Match an `alias` against a `Host` line's space-separated pattern list. A
 * negated pattern (`!pattern`) that matches forces a non-match for the whole
 * block; otherwise any positive pattern that matches makes the block apply
 * (ssh_config semantics).
 */
function hostMatches(alias: string, patterns: string): boolean {
  let matched = false;
  for (const pattern of patterns.split(/\s+/)) {
    if (!pattern) continue;
    const negated = pattern.startsWith('!');
    const bare = negated ? pattern.slice(1) : pattern;
    if (!bare) continue;
    if (globMatch(alias, bare)) {
      if (negated) return false;
      matched = true;
    }
  }
  return matched;
}

/** Match `value` against an ssh_config glob pattern (`*` and `?` wildcards). */
function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexSrc = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(regexSrc).test(value);
}

/** Expand a leading `~` (or `~/`) in a path against the home directory. */
function expandTilde(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}
