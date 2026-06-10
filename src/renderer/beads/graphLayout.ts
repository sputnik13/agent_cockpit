import type { BeadsIssue, BeadsTaskGraph } from '@shared/ipc/channels';
import { deriveState, isTerminal, type WorkgraphState } from './graphSelectors';

/** Edge classes drawn in the focused graph. `blocks` is an explicit dependency;
 *  `parent-child` is the structural hierarchy pointer; `reverse-block` is the
 *  derived "open child blocks its epic" edge (a parent-child edge whose child is
 *  still open) — surfaced distinctly so the epic↔child reverse-block is explicit. */
export type GraphEdgeKind = 'blocks' | 'parent-child' | 'reverse-block';

export interface LaidOutEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface LaidOutNode {
  id: string;
  issue: BeadsIssue;
  state: WorkgraphState;
  x: number;
  y: number;
  rank: number;
}

export interface LaidOutGraph {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

const NODE_W = 220;
const NODE_H = 56;
const COL_GAP = 60;
const ROW_GAP = 24;

const PARENT_TYPES = new Set(['parent', 'parent-child']);

/**
 * Builds a focused subgraph around `centerId`, traversing BOTH explicit `blocks`
 * dependencies and `parent-child` hierarchy edges up to `hops`. Direction: for
 * any edge `{from, to}` the `to` is the upstream node (a `blocks` blocker, or a
 * parent), placed at a lower rank; `from` (the dependent / child) is downstream.
 * Edges are returned tagged by class so the renderer can style explicit deps,
 * hierarchy, and the derived reverse-block (open child → epic) distinctly.
 */
export function focusedSubgraph(
  graph: BeadsTaskGraph,
  centerId: string,
  hops: number,
): LaidOutGraph {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const downstream = new Map<string, string[]>();
  const upstream = new Map<string, string[]>();
  for (const d of graph.deps) {
    if (d.type !== 'blocks' && !PARENT_TYPES.has(d.type)) continue;
    downstream.set(d.to, [...(downstream.get(d.to) ?? []), d.from]);
    upstream.set(d.from, [...(upstream.get(d.from) ?? []), d.to]);
  }
  const inRank = new Map<string, number>();
  inRank.set(centerId, 0);
  const queue: Array<{ id: string; rank: number }> = [{ id: centerId, rank: 0 }];
  while (queue.length) {
    const { id, rank } = queue.shift()!;
    if (Math.abs(rank) >= hops) continue;
    for (const next of upstream.get(id) ?? []) {
      if (!inRank.has(next)) {
        inRank.set(next, rank - 1);
        queue.push({ id: next, rank: rank - 1 });
      }
    }
    for (const next of downstream.get(id) ?? []) {
      if (!inRank.has(next)) {
        inRank.set(next, rank + 1);
        queue.push({ id: next, rank: rank + 1 });
      }
    }
  }

  const byRank = new Map<number, string[]>();
  for (const [id, rank] of inRank.entries()) {
    const arr = byRank.get(rank) ?? [];
    arr.push(id);
    byRank.set(rank, arr);
  }
  const ranks = Array.from(byRank.keys()).sort((a, b) => a - b);
  const nodes: LaidOutNode[] = [];
  let height = 0;
  for (let c = 0; c < ranks.length; c++) {
    const rank = ranks[c]!;
    const ids = (byRank.get(rank) ?? []).sort();
    for (let r = 0; r < ids.length; r++) {
      const id = ids[r]!;
      const issue = byId.get(id);
      if (!issue) continue;
      nodes.push({
        id,
        issue,
        state: deriveState(graph, issue),
        x: c * (NODE_W + COL_GAP),
        y: r * (NODE_H + ROW_GAP),
        rank,
      });
      height = Math.max(height, (r + 1) * (NODE_H + ROW_GAP));
    }
  }
  const width = ranks.length * (NODE_W + COL_GAP);

  const edges: LaidOutEdge[] = [];
  for (const d of graph.deps) {
    if (!inRank.has(d.from) || !inRank.has(d.to)) continue;
    if (d.type === 'blocks') {
      edges.push({ from: d.from, to: d.to, kind: 'blocks' });
    } else if (PARENT_TYPES.has(d.type)) {
      // parent-child edge `{from=child, to=parent}`. If the child is still open
      // it actively blocks the parent epic → surface as a reverse-block edge.
      const child = byId.get(d.from);
      const kind: GraphEdgeKind = child && !isTerminal(child.status) ? 'reverse-block' : 'parent-child';
      edges.push({ from: d.from, to: d.to, kind });
    }
  }
  return { nodes, edges, width, height };
}

export const layoutConsts = { NODE_W, NODE_H };
