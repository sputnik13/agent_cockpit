/**
 * Cockpit tmux session inventory. Lists/kills sessions on the dedicated
 * `cockpit` tmux socket (the one local terminals use), independent of any
 * active project — so orphaned sessions from removed projects are visible and
 * manageable. Local only; remote-host sessions live on their own tmux servers.
 */
import { spawnSync } from 'node:child_process';
import type { TmuxSessionInfo } from '@shared/ipc/channels';
import { tmuxSocket } from './instanceConfig';

// Single source for the socket name (overridable per instance).
const SOCKET = tmuxSocket();

export type { TmuxSessionInfo };

function tmux(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('tmux', ['-L', SOCKET, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

export function listCockpitSessions(): TmuxSessionInfo[] {
  const { status, stdout } = tmux([
    'ls',
    '-F',
    '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}',
  ]);
  if (status !== 0 || !stdout.trim()) return []; // no server / no sessions
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [name = '', windows = '0', attached = '0', created = '0'] = line.split('\t');
      return {
        name,
        windows: Number(windows) || 0,
        attached: attached === '1',
        createdAt: new Date(Number(created) * 1000).toISOString(),
        attachCommand: `tmux -L ${SOCKET} attach -t ${name}`,
      };
    });
}

export function killCockpitSession(name: string): void {
  if (!name) return;
  tmux(['kill-session', '-t', name]);
}

/** Kill every session with no attached client (orphans/background). Returns the
 *  names that were killed. */
export function killDetachedCockpitSessions(): string[] {
  const detached = listCockpitSessions().filter((s) => !s.attached);
  for (const s of detached) tmux(['kill-session', '-t', s.name]);
  return detached.map((s) => s.name);
}
