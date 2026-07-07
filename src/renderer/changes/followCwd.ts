/**
 * followCwd — auto-follow active terminal pane's worktree in the Changes view.
 *
 * Two concerns live here:
 *
 * 1. `worktreeForCwd(worktrees, cwd)` — pure mapper. Returns the path of the
 *    worktree whose path is the LONGEST path-segment-aware prefix of `cwd`, or
 *    `null` when no worktree contains `cwd`.
 *
 * 2. `useFollowTerminalCwd()` — React hook. When `followTerminalCwd` is enabled
 *    and the active project has a live control session, polls the active control
 *    pane's `#{pane_current_path}` every ~1.5 s via the existing tmux command
 *    path, maps cwd → worktree, and calls `worktreeStore.setWorktree` only when
 *    the mapped worktree differs from the current `activeWorktree`. Stops polling
 *    when disabled or when no live session is present.
 *
 * The hook MUST be wired into the Changes panel host (ChangesPanel.tsx), not
 * into ControlTerminalPanel.tsx (separate fix domain) — see CLAUDE.md guardrails.
 */
import { useEffect, useRef } from 'react';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore, useSessionStore, isConnected } from '@renderer/providerClient';
import { useTmuxStore } from '@renderer/tmux/tmuxStore';
import { useWorktreeStore } from '@renderer/worktree/worktreeStore';

const POLL_INTERVAL_MS = 1500;

/**
 * Returns the path of the worktree whose path is the longest path-segment-aware
 * prefix of `cwd`, or `null` when no worktree contains `cwd`.
 *
 * "Path-segment-aware" means we only consider matches on a path separator
 * boundary — `/repo` matches `/repo/src` but NOT `/repo-fork/src`. An exact
 * match (`cwd === worktree.path`) is accepted as a prefix of itself.
 */
export function worktreeForCwd(worktrees: WorktreeRecord[], cwd: string): string | null {
  if (!cwd) return null;

  // Normalize: strip trailing slash from cwd for consistent comparison.
  const normalizedCwd = cwd.endsWith('/') && cwd.length > 1 ? cwd.slice(0, -1) : cwd;

  let best: string | null = null;
  let bestLen = -1;

  for (const wt of worktrees) {
    const wtPath = wt.path.endsWith('/') && wt.path.length > 1 ? wt.path.slice(0, -1) : wt.path;
    if (!wtPath) continue;

    // Accept as prefix only when cwd is exactly the worktree path OR cwd
    // starts with the worktree path followed by a path separator.
    if (normalizedCwd === wtPath || normalizedCwd.startsWith(wtPath + '/')) {
      if (wtPath.length > bestLen) {
        bestLen = wtPath.length;
        best = wt.path;
      }
    }
  }

  return best;
}

/**
 * Hook: poll the active terminal pane's `#{pane_current_path}` while
 * `followTerminalCwd` is enabled and the active project has a live control
 * session with a known active pane. On each poll, map the cwd to a worktree and
 * call `worktreeStore.setWorktree` when it differs from the current selection.
 *
 * Wire this into ChangesPanel (or its host), not ControlTerminalPanel.
 */
export function useFollowTerminalCwd(): void {
  const enabled = useSettingsStore((s) => s.settings.followTerminalCwd);
  const activeId = useProjectsStore((s) => s.activeId);
  const connected = useSessionStore(isConnected(activeId));

  // Read activePaneId and isOpen from the tmux store for the active project.
  const activePaneId = useTmuxStore((s) => {
    const view = activeId ? s.byProject[activeId] : undefined;
    return view?.activePaneId ?? null;
  });
  const sessionOpen = useTmuxStore((s) => {
    const view = activeId ? s.byProject[activeId] : undefined;
    return view?.isOpen ?? false;
  });

  // Keep a stable ref to the latest activeId / activePaneId so the interval
  // callback always reads the current values without being recreated on every
  // pane-change. The interval is only recreated when enabled/connected/sessionOpen
  // changes.
  const stateRef = useRef({ activeId, activePaneId });
  stateRef.current = { activeId, activePaneId };

  const shouldPoll = enabled && connected && sessionOpen;

  useEffect(() => {
    if (!shouldPoll) return;

    const tick = (): void => {
      const { activeId: pid, activePaneId: paneId } = stateRef.current;
      if (!pid || !paneId) return;

      void useTmuxStore
        .getState()
        .command(`display-message -p -t ${paneId} '#{pane_current_path}'`)
        .then((r) => {
          const cwd = r.lines[0]?.trim() ?? '';
          if (!cwd) return;

          const worktreeState = useWorktreeStore.getState();
          const slice = worktreeState.byProject[pid];
          if (!slice) return;

          const { worktrees, activeWorktree } = slice;
          const matched = worktreeForCwd(worktrees, cwd);
          if (matched !== null && matched !== activeWorktree) {
            worktreeState.setWorktree(pid, matched);
          }
        })
        .catch(() => {
          // Swallow: session may have closed; the shouldPoll guard will stop
          // the interval on the next render cycle.
        });
    };

    // Run once immediately, then on each interval tick.
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [shouldPoll]);
}
