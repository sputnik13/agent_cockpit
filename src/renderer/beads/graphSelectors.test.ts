import { describe, it, expect } from 'vitest';
import type { BeadsDep, BeadsIssue, BeadsTaskGraph } from '@shared/ipc/channels';
import {
  isTerminal,
  hasOpenBlockers,
  edgesFor,
  deriveState,
  openBlockerCount,
  openChildCount,
  childrenOf,
  hasOpenChildren,
  groupByState,
  WG_STATES,
  STATE_TONE,
  ancestorsOf,
  findTreeNode,
  buildTree,
} from './graphSelectors';

function mkIssue(id: string, status: string, opts: Partial<BeadsIssue> = {}): BeadsIssue {
  return {
    id,
    title: id,
    body: '',
    status,
    priority: 2,
    issueType: 'task',
    labels: [],
    externalRef: null,
    createdAt: '',
    updatedAt: '',
    ...opts,
  };
}

function mkGraph(issues: BeadsIssue[], deps: BeadsDep[] = []): BeadsTaskGraph {
  return { source: { kind: 'jsonl', path: '' }, schemaCompatible: true, issues, deps };
}

describe('isTerminal', () => {
  it('treats closed, tombstone, and deleted identically as terminal', () => {
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('tombstone')).toBe(true);
    expect(isTerminal('deleted')).toBe(true);
    expect(isTerminal('open')).toBe(false);
    expect(isTerminal('blocked')).toBe(false);
  });
});

describe('blocks direction (corrected: to blocks from)', () => {
  // a depends on b (from=a, to=b) => b blocks a. Mirrors `br blocked` truth for
  // local_repo_explorer-l315 (from=l315, to=3xor) → l315 is blocked by 3xor.
  const g = mkGraph(
    [mkIssue('l315', 'open'), mkIssue('3xor', 'in_progress')],
    [{ from: 'l315', to: '3xor', type: 'blocks' }],
  );

  it('marks the dependent (from) blocked, not the dependency (to)', () => {
    expect(hasOpenBlockers(g, g.issues[0]!)).toBe(true); // l315
    expect(hasOpenBlockers(g, g.issues[1]!)).toBe(false); // 3xor
  });

  it('edgesFor: blockedBy = dependency (to); blocks = downstream dependent (from)', () => {
    const l315 = edgesFor(g, 'l315');
    expect(l315.blockedBy.map((i) => i.id)).toEqual(['3xor']);
    expect(l315.blocks).toEqual([]);
    const x3 = edgesFor(g, '3xor');
    expect(x3.blocks.map((i) => i.id)).toEqual(['l315']);
    expect(x3.blockedBy).toEqual([]);
  });

  it('a terminal dependency does not block', () => {
    const g2 = mkGraph(
      [mkIssue('a', 'open'), mkIssue('b', 'closed')],
      [{ from: 'a', to: 'b', type: 'blocks' }],
    );
    expect(hasOpenBlockers(g2, g2.issues[0]!)).toBe(false);
  });
});

describe('children / reverse-block', () => {
  const g = mkGraph(
    [
      mkIssue('epic', 'open', { issueType: 'epic' }),
      mkIssue('c1', 'open'),
      mkIssue('c2', 'closed'),
    ],
    [
      { from: 'c1', to: 'epic', type: 'parent-child' },
      { from: 'c2', to: 'epic', type: 'parent-child' },
    ],
  );
  it('childrenOf resolves children (edges where the issue is the parent `to`)', () => {
    expect(childrenOf(g, 'epic').map((i) => i.id).sort()).toEqual(['c1', 'c2']);
  });
  it('openChildCount counts only non-terminal children', () => {
    expect(openChildCount(g, g.issues[0]!)).toBe(1);
    expect(hasOpenChildren(g, g.issues[0]!)).toBe(true);
  });
});

describe('deriveState precedence (three blocked kinds)', () => {
  it('terminal status → done', () => {
    expect(deriveState(mkGraph([mkIssue('a', 'closed')]), mkIssue('a', 'closed'))).toBe('done');
  });

  it('explicit status flag `blocked` → red blocked (urgent), beats derived reasons', () => {
    const g = mkGraph(
      [mkIssue('a', 'blocked', { issueType: 'epic' }), mkIssue('dep', 'open'), mkIssue('c', 'open')],
      [
        { from: 'a', to: 'dep', type: 'blocks' },
        { from: 'c', to: 'a', type: 'parent-child' },
      ],
    );
    expect(deriveState(g, g.issues[0]!)).toBe('blocked');
    // but the derived reasons are still surfaced independently (FR6)
    expect(openBlockerCount(g, g.issues[0]!)).toBe(1);
    expect(openChildCount(g, g.issues[0]!)).toBe(1);
  });

  it('in_progress wins over derived blocked; the block is a secondary signal', () => {
    const g = mkGraph(
      [mkIssue('a', 'in_progress'), mkIssue('dep', 'open')],
      [{ from: 'a', to: 'dep', type: 'blocks' }],
    );
    expect(deriveState(g, g.issues[0]!)).toBe('in_progress');
    expect(openBlockerCount(g, g.issues[0]!)).toBe(1);
  });

  it('open + open dependency → yellow dep_blocked (the l315 case, NOT red)', () => {
    const g = mkGraph(
      [mkIssue('l315', 'open'), mkIssue('3xor', 'in_progress')],
      [{ from: 'l315', to: '3xor', type: 'blocks' }],
    );
    expect(deriveState(g, g.issues[0]!)).toBe('dep_blocked');
  });

  it('open epic with open children → yellow child_blocked', () => {
    const g = mkGraph(
      [mkIssue('epic', 'open', { issueType: 'epic' }), mkIssue('c', 'open')],
      [{ from: 'c', to: 'epic', type: 'parent-child' }],
    );
    expect(deriveState(g, g.issues[0]!)).toBe('child_blocked');
  });

  it('dep_blocked takes precedence over child_blocked', () => {
    const g = mkGraph(
      [mkIssue('e', 'open', { issueType: 'epic' }), mkIssue('dep', 'open'), mkIssue('c', 'open')],
      [
        { from: 'e', to: 'dep', type: 'blocks' },
        { from: 'c', to: 'e', type: 'parent-child' },
      ],
    );
    expect(deriveState(g, g.issues[0]!)).toBe('dep_blocked');
  });

  it('nothing pending → ready', () => {
    expect(deriveState(mkGraph([mkIssue('a', 'open')]), mkIssue('a', 'open'))).toBe('ready');
  });
});

describe('groupByState', () => {
  it('orders groups red flag-blocked → in_progress → ready → dep_blocked → child_blocked → done', () => {
    const g = mkGraph(
      [
        mkIssue('flag', 'blocked'),
        mkIssue('ip', 'in_progress'),
        mkIssue('rdy', 'open'),
        mkIssue('dep', 'open'),
        mkIssue('blocker', 'in_progress'),
        mkIssue('epic', 'open', { issueType: 'epic' }),
        mkIssue('child', 'open'),
        mkIssue('done', 'closed'),
      ],
      [
        { from: 'dep', to: 'blocker', type: 'blocks' },
        { from: 'child', to: 'epic', type: 'parent-child' },
      ],
    );
    const groups = groupByState(g);
    expect(groups.map((x) => x.state)).toEqual([...WG_STATES]);
    const stateOf = (id: string) =>
      groups.find((grp) => grp.issues.some((i) => i.id === id))!.state;
    expect(stateOf('flag')).toBe('blocked');
    expect(stateOf('dep')).toBe('dep_blocked');
    expect(stateOf('epic')).toBe('child_blocked');
    expect(stateOf('done')).toBe('done');
  });

  it('STATE_TONE maps red/green/blue/yellow/yellow/muted', () => {
    expect(STATE_TONE.blocked).toBe('removed');
    expect(STATE_TONE.in_progress).toBe('added');
    expect(STATE_TONE.ready).toBe('accent');
    expect(STATE_TONE.dep_blocked).toBe('warn');
    expect(STATE_TONE.child_blocked).toBe('warn');
    expect(STATE_TONE.done).toBe('neutral');
  });
});

describe('ancestorsOf / findTreeNode (FA-5 focus)', () => {
  // epic -> feature -> leaf (parent edges are {from=child, to=parent}).
  const g = mkGraph(
    [
      mkIssue('epic', 'open'),
      mkIssue('feat', 'open'),
      mkIssue('leaf', 'open'),
      mkIssue('other', 'open'),
    ],
    [
      { from: 'feat', to: 'epic', type: 'parent-child' },
      { from: 'leaf', to: 'feat', type: 'parent-child' },
    ],
  );

  it('ancestorsOf returns the root-first parent chain, excluding the node', () => {
    expect(ancestorsOf(g, 'leaf').map((i) => i.id)).toEqual(['epic', 'feat']);
    expect(ancestorsOf(g, 'feat').map((i) => i.id)).toEqual(['epic']);
    expect(ancestorsOf(g, 'epic')).toEqual([]);
    expect(ancestorsOf(g, 'other')).toEqual([]);
  });

  it('ancestorsOf is cycle-safe', () => {
    const cyclic = mkGraph(
      [mkIssue('a', 'open'), mkIssue('b', 'open')],
      [
        { from: 'a', to: 'b', type: 'parent-child' },
        { from: 'b', to: 'a', type: 'parent-child' },
      ],
    );
    // Whichever root the forest picks, the walk must terminate.
    expect(ancestorsOf(cyclic, 'a').length).toBeLessThanOrEqual(1);
  });

  it('findTreeNode locates a node and exposes its full subtree', () => {
    const forest = buildTree(g);
    const node = findTreeNode(forest, 'feat');
    expect(node?.issue.id).toBe('feat');
    expect(node?.children.map((c) => c.issue.id)).toEqual(['leaf']);
    expect(findTreeNode(forest, 'missing')).toBeNull();
  });
});
