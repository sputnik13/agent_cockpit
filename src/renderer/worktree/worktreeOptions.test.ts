import { describe, it, expect } from 'vitest';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { worktreeSelectOptions, workspaceName } from './worktreeOptions';

function wt(path: string, branch: string | null, over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return { path, branch, head: 'abcdef1234567890', locked: false, prunable: false, detached: false, ...over };
}

describe('workspaceName', () => {
  it('returns the last path segment', () => {
    expect(workspaceName('/Users/me/Developer/agent_cockpit')).toBe('agent_cockpit');
    expect(workspaceName('/Users/me/Developer/agent_cockpit-publish')).toBe('agent_cockpit-publish');
  });
  it('tolerates trailing slashes and Windows separators', () => {
    expect(workspaceName('/a/b/c/')).toBe('c');
    expect(workspaceName('C:\\repos\\proj')).toBe('proj');
  });
});

describe('worktreeSelectOptions', () => {
  it('labels each entry "<workspace> - <branch>" with the path as value', () => {
    const opts = worktreeSelectOptions([wt('/dev/agent_cockpit', 'main')]);
    expect(opts).toEqual([{ value: '/dev/agent_cockpit', label: 'agent_cockpit - main' }]);
  });

  it('pins the primary (first) worktree at the top and sorts the rest by workspace name', () => {
    // git lists the main worktree first; the rest arrive in arbitrary order.
    const opts = worktreeSelectOptions([
      wt('/dev/agent_cockpit', 'main'), // primary
      wt('/dev/agent_cockpit-zeta', 'zeta'),
      wt('/dev/agent_cockpit-alpha', 'alpha'),
      wt('/dev/agent_cockpit-publish', 'publish'),
    ]);
    expect(opts.map((o) => o.label)).toEqual([
      'agent_cockpit - main', // primary stays first even though it is not alphabetically first
      'agent_cockpit-alpha - alpha',
      'agent_cockpit-publish - publish',
      'agent_cockpit-zeta - zeta',
    ]);
  });

  it('shows a short HEAD for a detached / branchless worktree', () => {
    const opts = worktreeSelectOptions([
      wt('/dev/agent_cockpit', 'main'),
      wt('/dev/detached-wt', null, { detached: true, head: 'deadbeefcafef00d' }),
    ]);
    expect(opts[1]).toEqual({ value: '/dev/detached-wt', label: 'detached-wt - deadbee' });
  });

  it('returns [] for no worktrees', () => {
    expect(worktreeSelectOptions([])).toEqual([]);
  });
});
