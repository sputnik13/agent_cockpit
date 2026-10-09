import type { MuxTopologyLayoutNode, MuxTopologyPane, MuxTopologySnapshot } from '@shared/providers/types';

/** Renderer-side projection of the daemon's authoritative topology catalog. */
export const EMPTY_MUX_TOPOLOGY: MuxTopologySnapshot = { epoch: '', revision: 0, sessions: [] };

/**
 * IPC requests can finish out of order. Keep the newest daemon snapshot and
 * reject a late response rather than rebuilding tabs from an obsolete catalog.
 */
export function reconcileMuxTopology(
  current: MuxTopologySnapshot,
  incoming: MuxTopologySnapshot,
  retiredEpochs: ReadonlySet<string> = new Set(),
): MuxTopologySnapshot {
  if (incoming.epoch !== current.epoch && retiredEpochs.has(incoming.epoch)) return current;
  if (incoming.epoch !== current.epoch) return incoming;
  if (incoming.revision < current.revision) return current;
  // `session.topology` assigns a monotonically increasing observation revision
  // to every read, including the idle poll.  Keep the current object when its
  // daemon-owned content is unchanged: otherwise each poll re-renders the
  // active window and the focus-restoration effect steals focus from unrelated
  // controls such as Settings and Run inputs.
  if (
    incoming.activeSessionId === current.activeSessionId &&
    JSON.stringify(incoming.sessions) === JSON.stringify(current.sessions)
  ) {
    // Advance the observation watermark so a delayed older mutation cannot
    // subsequently replace this read, but reuse the nested catalog objects.
    // Effects that depend on the active session/window therefore remain idle
    // and cannot steal browser focus on every poll.
    return incoming.revision === current.revision ? current : { ...incoming, sessions: current.sessions };
  }
  return incoming;
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

interface PaneBounds {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Find the nearest pane sharing the requested physical edge. Center-only
 * comparisons incorrectly make a full-height left pane's ArrowDown jump into
 * the lower-right quadrant; that edge has no inverse. Restricting candidates
 * to touching rectangles prevents a full-height left pane's ArrowDown from
 * jumping into the lower-right quadrant. Branch-return preference is owned by
 * the interaction layer, which has the user's preceding directional move.
 */
export function adjacentMuxPane(
  layout: MuxTopologyLayoutNode | null,
  panes: MuxTopologyPane[],
  activePaneId: string,
  direction: PaneDirection,
): MuxTopologyPane | null {
  const bounds = muxPaneBounds(layout);
  const active = bounds.find((item) => item.paneId === activePaneId);
  if (!active) return null;
  const target = nearestDirectionalBound(bounds, active, direction);
  if (!target) return null;
  return target ? (panes.find((pane) => pane.paneId === target.paneId) ?? null) : null;
}

function nearestDirectionalBound(
  bounds: PaneBounds[],
  active: PaneBounds,
  direction: PaneDirection,
): PaneBounds | undefined {
  return bounds
    .filter((candidate) => candidate.paneId !== active.paneId && sharesDirectionalEdge(active, candidate, direction))
    .sort((left, right) => paneDistance(active, left, direction) - paneDistance(active, right, direction))[0];
}

function sharesDirectionalEdge(active: PaneBounds, candidate: PaneBounds, direction: PaneDirection): boolean {
  const epsilon = 1e-6;
  if (direction === 'left')
    return candidate.x + candidate.width <= active.x + epsilon && overlaps(active.y, active.height, candidate.y, candidate.height);
  if (direction === 'right')
    return candidate.x >= active.x + active.width - epsilon && overlaps(active.y, active.height, candidate.y, candidate.height);
  if (direction === 'up')
    return candidate.y + candidate.height <= active.y + epsilon && overlaps(active.x, active.width, candidate.x, candidate.width);
  return candidate.y >= active.y + active.height - epsilon && overlaps(active.x, active.width, candidate.x, candidate.width);
}

function overlaps(start: number, length: number, otherStart: number, otherLength: number): boolean {
  return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart) > 1e-6;
}

function muxPaneBounds(
  layout: MuxTopologyLayoutNode | null,
  x = 0,
  y = 0,
  width = 1,
  height = 1,
): PaneBounds[] {
  if (!layout) return [];
  if (layout.paneId) return [{ paneId: layout.paneId, x, y, width, height }];
  const ratio = layout.ratio ?? 0.5;
  if (layout.direction === 'vertical') {
    return [
      ...muxPaneBounds(layout.first, x, y, width, height * ratio),
      ...muxPaneBounds(layout.second, x, y + height * ratio, width, height * (1 - ratio)),
    ];
  }
  return [
    ...muxPaneBounds(layout.first, x, y, width * ratio, height),
    ...muxPaneBounds(layout.second, x + width * ratio, y, width * (1 - ratio), height),
  ];
}

function paneDistance(active: PaneBounds, candidate: PaneBounds, direction: PaneDirection): number {
  const horizontal = direction === 'left' || direction === 'right';
  const primary = horizontal
    ? Math.abs(candidate.x + candidate.width / 2 - (active.x + active.width / 2))
    : Math.abs(candidate.y + candidate.height / 2 - (active.y + active.height / 2));
  const cross = horizontal
    ? Math.abs(candidate.y + candidate.height / 2 - (active.y + active.height / 2))
    : Math.abs(candidate.x + candidate.width / 2 - (active.x + active.width / 2));
  return primary + cross * 2;
}
