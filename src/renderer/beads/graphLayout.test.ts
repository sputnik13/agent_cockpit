import { describe, it, expect } from 'vitest';
import type { BeadsDep, BeadsIssue, BeadsTaskGraph } from '@shared/ipc/channels';
import { focusedSubgraph } from './graphLayout';

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

describe('focusedSubgraph', () => {
  it('includes both blocks and parent-child neighbours within hops', () => {
    const g = mkGraph(
      [
        mkIssue('epic', 'open', { issueType: 'epic' }),
        mkIssue('child', 'open'),
        mkIssue('dep', 'in_progress'),
      ],
      [
        { from: 'child', to: 'epic', type: 'parent-child' },
        { from: 'epic', to: 'dep', type: 'blocks' },
      ],
    );
    const laid = focusedSubgraph(g, 'epic', 2);
    expect(laid.nodes.map((n) => n.id).sort()).toEqual(['child', 'dep', 'epic']);
  });

  it('tags an open child of an epic as a reverse-block edge', () => {
    const g = mkGraph(
      [mkIssue('epic', 'open', { issueType: 'epic' }), mkIssue('child', 'open')],
      [{ from: 'child', to: 'epic', type: 'parent-child' }],
    );
    const e = focusedSubgraph(g, 'epic', 2).edges.find((x) => x.from === 'child' && x.to === 'epic');
    expect(e?.kind).toBe('reverse-block');
  });

  it('tags a closed child as a plain parent-child edge (not reverse-block)', () => {
    const g = mkGraph(
      [mkIssue('epic', 'open', { issueType: 'epic' }), mkIssue('child', 'closed')],
      [{ from: 'child', to: 'epic', type: 'parent-child' }],
    );
    const e = focusedSubgraph(g, 'epic', 2).edges.find((x) => x.from === 'child' && x.to === 'epic');
    expect(e?.kind).toBe('parent-child');
  });

  it('tags explicit dependencies as blocks edges and carries node state', () => {
    const g = mkGraph(
      [mkIssue('a', 'open'), mkIssue('b', 'in_progress')],
      [{ from: 'a', to: 'b', type: 'blocks' }],
    );
    const laid = focusedSubgraph(g, 'a', 2);
    expect(laid.edges).toEqual([{ from: 'a', to: 'b', kind: 'blocks' }]);
    // a depends on open b → dep_blocked; b is in_progress.
    expect(laid.nodes.find((n) => n.id === 'a')?.state).toBe('dep_blocked');
    expect(laid.nodes.find((n) => n.id === 'b')?.state).toBe('in_progress');
  });
});
