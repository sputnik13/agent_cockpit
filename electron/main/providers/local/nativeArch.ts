/**
 * Native-arch spawn wrapper (macOS / Apple Silicon).
 *
 * macOS makes the x86_64 "spawn preference" sticky across the whole process
 * tree: when agent_cockpit is launched from a Rosetta-translated parent (e.g. an
 * x86_64 tmux server, or an Electron started under Rosetta), every universal
 * child — including `/bin/zsh` and `tmux` — also launches x86_64. So `uname -m`
 * reports `x86_64` inside the terminal despite the hardware being arm64, and any
 * native-arm64 tooling the user expects runs translated.
 *
 * {@link withNativeArch} detects, via `sysctl.proc_translated`, whether the
 * current process is itself translated; if so (and only after probing that
 * `arch -arm64` actually works on this host) it rewrites a spawn into
 * `arch -arm64 <file> <args…>` so the child runs native. The decision is
 * memoized — translation state and CPU capability do not change during a process
 * lifetime. On non-macOS, on native launches, or on any probe failure it returns
 * the spawn unchanged, so all other platforms/paths are completely unaffected.
 *
 * SERVER- and SESSION-CREATING spawns must be wrapped: the `-CC`/shell pty
 * children AND the `start-server` that materializes the shared `agent-cockpit`
 * server (the process that forks every pane). Wrapping only the pty child is not
 * enough — if `start-server` runs translated first, the long-lived server is born
 * x86_64 and a later arch-wrapped `new-session -A` merely ATTACHES to it, so every
 * pane runs translated regardless of the client's arch.
 *
 * Pure server-QUERY calls that talk to an already-running server over the socket
 * (`-V`, `ls`, `kill-session`, `kill-server`) are intentionally left alone: the
 * arch of the query process is irrelevant, and a server already running x86_64
 * keeps forking translated shells until it is killed once regardless.
 */
import { spawnSync } from 'node:child_process';

/** A spawn target: the executable and its argv (excluding the executable). */
export interface SpawnSpec {
  file: string;
  args: string[];
}

type Wrapper = (file: string, args: string[]) => SpawnSpec;

const identity: Wrapper = (file, args) => ({ file, args });

let cached: Wrapper | null = null;

/** Build the wrapper once by probing the host. Pure of side effects beyond the
 *  two read-only `sysctl`/`arch` probes. */
function detectWrapper(): Wrapper {
  if (process.platform !== 'darwin') return identity;
  // `sysctl.proc_translated`: 1 = running under Rosetta, 0 = native, and the key
  // is absent on Intel Macs (non-zero status / empty) — all non-1 cases mean "do
  // not rewrite".
  let translated = false;
  try {
    const res = spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' });
    translated = res.status === 0 && typeof res.stdout === 'string' && res.stdout.trim() === '1';
  } catch {
    return identity;
  }
  if (!translated) return identity;
  // Confirm `arch -arm64` is actually usable before relying on it.
  try {
    const probe = spawnSync('arch', ['-arm64', 'true'], { stdio: 'ignore' });
    if (probe.status !== 0) return identity;
  } catch {
    return identity;
  }
  return (file, args) => ({ file: 'arch', args: ['-arm64', file, ...args] });
}

/**
 * Rewrite a session-creating spawn to run native arm64 when the current process
 * is Rosetta-translated on Apple Silicon; otherwise return it unchanged.
 */
export function withNativeArch(file: string, args: string[]): SpawnSpec {
  if (!cached) cached = detectWrapper();
  return cached(file, args);
}

/** Test-only: clear the memoized decision so a test can re-probe with new stubs. */
export function __resetNativeArchCacheForTests(): void {
  cached = null;
}
