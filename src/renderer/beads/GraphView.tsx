import { useMemo } from 'react';
import type { BeadsTaskGraph } from '@shared/ipc/channels';
import { EmptyState } from '../ui';
import {
  focusedSubgraph,
  layoutConsts,
  type GraphEdgeKind,
  type LaidOutNode,
} from './graphLayout';
import {
  issueMatchesNeedle,
  priorityLabel,
  resolveAnchorId,
  STATE_COLOR,
  type WorkgraphState,
} from './graphSelectors';
import { PinButton } from './PinButton';

const { NODE_W, NODE_H } = layoutConsts;
/** Neighbour hops shown around the anchor; keeps the focused view readable. */
const HOPS = 2;
const PAD = 12;

/** Per-edge-class stroke styling. `blocks` = solid neutral dependency edge;
 *  `parent-child` = dashed structural hierarchy; `reverse-block` = solid yellow
 *  (an open child blocking its epic — the derived reverse-block, surfaced). */
const EDGE_STYLE: Record<
  GraphEdgeKind,
  { stroke: string; dash?: string; marker: string; label: string }
> = {
  blocks: { stroke: 'var(--color-edge-strong)', marker: 'wg-arrow', label: 'blocks' },
  'parent-child': {
    stroke: 'var(--color-edge)',
    dash: '4 3',
    marker: 'wg-arrow',
    label: 'parent / child',
  },
  'reverse-block': {
    stroke: 'var(--color-warn)',
    marker: 'wg-arrow-warn',
    label: 'open child blocks epic',
  },
};

interface GraphViewProps {
  graph: BeadsTaskGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Tree/graph focus anchor (FA-5). When set and present, the graph anchors on
   *  it and expands to the full reachable subgraph instead of the fixed 2 hops. */
  focusId?: string | null;
  /** Search needle (case-insensitive). Matching nodes are highlighted; non-matching
   *  nodes are dimmed. Empty = no filtering. */
  searchNeedle?: string;
  /** Epic ids in the Columns focus set (drives the ★/☆ on epic nodes). */
  pinnedEpicIds?: Set<string>;
  /** Toggle an epic's Columns focus-set membership. When provided, epic nodes
   *  show a pin toggle. */
  onTogglePin?: (id: string) => void;
  /** Derived-state visibility filter, shared with the other views. Nodes whose
   *  state is hidden are dropped (and their incident edges with them). */
  visibleStates: Set<WorkgraphState>;
}

/**
 * Focused dependency-graph rendering of the workgraph. Anchors on the current
 * selection (or a sensible default) and lays out a few hops of `blocks` AND
 * `parent-child` neighbours via {@link focusedSubgraph}, drawing each edge class
 * distinctly (explicit deps, hierarchy, and the derived reverse-block) plus
 * state-coloured node cards. Read-only: clicking a node re-anchors by selecting
 * it. Pure in its props so it renders without the store.
 */
export function GraphView({
  graph,
  selectedId,
  onSelect,
  focusId,
  searchNeedle,
  pinnedEpicIds,
  onTogglePin,
  visibleStates,
}: GraphViewProps): JSX.Element {
  // Focus mode (FA-5 "option B"): anchor on the focused node and expand the full
  // reachable subgraph (Infinity hops). Otherwise anchor on the selection (or a
  // sensible default) at the normal 2-hop neighbourhood.
  const focused = focusId != null && graph.issues.some((i) => i.id === focusId);
  const center = focused ? focusId : resolveAnchorId(graph, selectedId);
  const hops = focused ? Infinity : HOPS;
  const laid = useMemo(
    () => (center == null ? null : focusedSubgraph(graph, center, hops)),
    [graph, center, hops],
  );

  if (center == null || laid == null || laid.nodes.length === 0) {
    return <EmptyState title="No task selected" hint="Select an issue to focus the graph." />;
  }

  const needle = searchNeedle?.trim().toLowerCase() ?? '';

  /** Returns true when the node matches the search needle (id, short suffix, title, or body). */
  function matchesNeedle(n: LaidOutNode): boolean {
    if (!needle) return true;
    return issueMatchesNeedle(n.issue, needle);
  }

  // Honor the shared state filter: drop nodes whose derived state is hidden;
  // edges to a dropped node fall away automatically (the edge render skips any
  // endpoint missing from `pos`).
  const visibleNodes = laid.nodes.filter((n) => visibleStates.has(n.state));
  if (visibleNodes.length === 0) {
    return (
      <EmptyState
        title="No tasks match the filter"
        hint="Adjust the state filter to show more of the graph."
      />
    );
  }
  const pos = new Map(visibleNodes.map((n) => [n.id, n]));

  return (
    <svg
      role="img"
      aria-label="Dependency graph"
      width={laid.width + PAD * 2}
      height={laid.height + PAD * 2}
      className="block"
    >
      <defs>
        <marker
          id="wg-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-edge-strong)" />
        </marker>
        <marker
          id="wg-arrow-warn"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--color-warn)" />
        </marker>
      </defs>
      <g transform={`translate(${PAD},${PAD})`}>
        {laid.edges.map((e) => {
          const from = pos.get(e.from);
          const to = pos.get(e.to);
          if (!from || !to) return null;
          const style = EDGE_STYLE[e.kind];
          const [x1, y1, x2, y2] = edgePoints(from, to);
          return (
            <line
              key={`${e.kind}:${e.from}->${e.to}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={style.stroke}
              strokeWidth={1.5}
              strokeDasharray={style.dash}
              markerEnd={`url(#${style.marker})`}
            >
              <title>{style.label}</title>
            </line>
          );
        })}
        {visibleNodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            active={n.id === selectedId || n.id === center}
            dimmed={needle ? !matchesNeedle(n) : false}
            onSelect={onSelect}
            pinned={pinnedEpicIds?.has(n.id) ?? false}
            onTogglePin={onTogglePin}
          />
        ))}
      </g>
    </svg>
  );
}

/** Endpoints between two node rects: exits the right/left edge by column order,
 *  falls back to vertical mid-points when the nodes share a column. */
function edgePoints(
  from: LaidOutNode,
  to: LaidOutNode,
): [number, number, number, number] {
  const fc = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
  const tc = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
  if (from.x < to.x) return [from.x + NODE_W, fc.y, to.x, tc.y];
  if (from.x > to.x) return [from.x, fc.y, to.x + NODE_W, tc.y];
  return [fc.x, from.y + NODE_H, tc.x, to.y];
}

function NodeCard({
  node,
  active,
  dimmed,
  onSelect,
  pinned,
  onTogglePin,
}: {
  node: LaidOutNode;
  active: boolean;
  /** True when a search needle is active and this node does not match. */
  dimmed: boolean;
  onSelect: (id: string) => void;
  pinned: boolean;
  onTogglePin?: (id: string) => void;
}): JSX.Element {
  const tone = STATE_COLOR[node.state];
  const shortId = node.id.split('-').pop() ?? node.id;
  const showPin = node.issue.issueType === 'epic' && onTogglePin != null;
  return (
    <foreignObject x={node.x} y={node.y} width={NODE_W} height={NODE_H} opacity={dimmed ? 0.3 : 1}>
      {/* relative wrapper so the pin is a SIBLING of the card button, never nested
          inside it (nested <button> is invalid HTML). */}
      <div className="relative h-full w-full">
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          title={`${node.id} · ${node.issue.title}`}
          className="flex h-full w-full flex-col justify-center gap-0.5 rounded border bg-panel px-2 text-left"
          style={{
            borderColor: active ? 'var(--color-accent)' : 'var(--color-edge)',
            borderLeft: `3px solid ${tone}`,
            outline: active ? '1px solid var(--color-accent)' : undefined,
          }}
        >
          <span className="flex items-center gap-1 text-[10px] text-dim">
            <code className="rounded bg-elev px-0.5 font-mono text-[9px]" title={node.id}>
              {shortId}
            </code>
            <span>·</span>
            <span>{priorityLabel(node.issue.priority)}</span>
          </span>
          <span className="truncate text-[12px] text-fg">{node.issue.title}</span>
        </button>
        {showPin && (
          <PinButton
            pinned={pinned}
            onToggle={() => onTogglePin(node.id)}
            label={`${pinned ? 'Unpin' : 'Pin'} epic ${node.issue.title} (columns)`}
            className="absolute right-1 top-1"
          />
        )}
      </div>
    </foreignObject>
  );
}
