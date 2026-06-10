import type { BeadsDep, BeadsIssue, BeadsTaskGraph } from '@shared/ipc/channels';

/** Status buckets rendered, in display order. Attention-needing work first:
 *  blocked → in_progress → ready → closed (FR1). */
export const STATUS_GROUPS = ['blocked', 'in_progress', 'ready', 'closed'] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];

const KNOWN = new Set<string>(STATUS_GROUPS);

/** Maps a raw issue status onto a render bucket; unknown statuses fall to ready. */
export function statusGroup(status: string): StatusGroup {
  return KNOWN.has(status) ? (status as StatusGroup) : 'ready';
}

export const GROUP_LABEL: Record<StatusGroup, string> = {
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  closed: 'Closed',
};

const TERMINAL_STATUSES = new Set(['closed', 'tombstone', 'deleted']);

/**
 * True when an issue's status is terminal/done. beads_rust deletion produces a
 * `tombstone`; `closed`, `tombstone`, and a soft-`deleted` state are all treated
 * identically as done for blocking computation and coloring.
 */
export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * True when `issue` is blocked by at least one open `blocks` dependency.
 *
 * Direction (beads_rust): a dependency row is stored as `(issue_id,
 * depends_on_id)` meaning *issue_id depends on depends_on_id* — i.e. for a
 * `blocks` edge `BeadsDep{from=issue_id, to=depends_on_id}`, **`to` blocks
 * `from`**. So `issue` is dep-blocked when it is the `from` of a `blocks` edge
 * whose `to` dependency is present and non-terminal. (A missing `to` is treated
 * as terminal/tombstoned and therefore not blocking.)
 */
export function hasOpenBlockers(graph: BeadsTaskGraph, issue: BeadsIssue): boolean {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  return graph.deps.some((d) => {
    if (d.type !== 'blocks' || d.from !== issue.id) return false;
    const blocker = byId.get(d.to);
    return blocker != null && !isTerminal(blocker.status);
  });
}

/**
 * Resolves the render bucket for an issue, deriving 'blocked' from open
 * dependencies (Review Resolution OQ-1 = DERIVE). A non-terminal issue with
 * open `blocks` predecessors groups as 'blocked' regardless of its stored
 * status (so a dep-blocked `open` task no longer hides in 'ready'); otherwise
 * it groups by status. Display-only — stored status is never mutated.
 */
export function groupOf(graph: BeadsTaskGraph, issue: BeadsIssue): StatusGroup {
  if (!isTerminal(issue.status) && hasOpenBlockers(graph, issue)) return 'blocked';
  return statusGroup(issue.status);
}

export interface IssueGroup {
  group: StatusGroup;
  issues: BeadsIssue[];
}

/** Stable sibling/group order: priority ascending (0 = highest), then id (FR3). */
export function compareIssues(a: BeadsIssue, b: BeadsIssue): number {
  return a.priority - b.priority || a.id.localeCompare(b.id);
}

/** Buckets issues by (derived) status group; priority ascending, then id. */
export function groupIssues(graph: BeadsTaskGraph): IssueGroup[] {
  const buckets = new Map<StatusGroup, BeadsIssue[]>();
  for (const g of STATUS_GROUPS) buckets.set(g, []);
  for (const issue of graph.issues) {
    buckets.get(groupOf(graph, issue))!.push(issue);
  }
  return STATUS_GROUPS.map((group) => ({
    group,
    issues: buckets.get(group)!.slice().sort(compareIssues),
  }));
}

export interface IssueEdges {
  /** Issues this one blocks (this -> other via `blocks`). */
  blocks: BeadsIssue[];
  /** Issues that block this one (other -> this via `blocks`). */
  blockedBy: BeadsIssue[];
  /** Parent issues via `parent-child` / `parent` edges. */
  parents: BeadsIssue[];
}

const PARENT_TYPES = new Set(['parent', 'parent-child']);

/** Resolves the dependency edges incident to `issueId` into issue objects. */
export function edgesFor(graph: BeadsTaskGraph, issueId: string): IssueEdges {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const resolve = (deps: BeadsDep[], pick: (d: BeadsDep) => string): BeadsIssue[] =>
    deps
      .map((d) => byId.get(pick(d)))
      .filter((i): i is BeadsIssue => i != null);

  // Direction (beads_rust): for a `blocks` edge, `to` (depends_on_id) blocks
  // `from` (issue_id). So the issues that BLOCK `issueId` are the `to` of edges
  // where `issueId` is the `from`; the issues `issueId` BLOCKS (downstream) are
  // the `from` of edges where `issueId` is the `to`.
  return {
    blocks: resolve(
      graph.deps.filter((d) => d.type === 'blocks' && d.to === issueId),
      (d) => d.from,
    ),
    blockedBy: resolve(
      graph.deps.filter((d) => d.type === 'blocks' && d.from === issueId),
      (d) => d.to,
    ),
    parents: resolve(
      graph.deps.filter((d) => PARENT_TYPES.has(d.type) && d.from === issueId),
      (d) => d.to,
    ),
  };
}

/** A node in the parent-child tree projection. */
export interface TreeNode {
  issue: BeadsIssue;
  children: TreeNode[];
}

/**
 * Projects the parent-child dependency edges into a forest. Roots are issues
 * with no parent edge; siblings and roots are ordered by the six-state key
 * (derived-state order, then priority ascending, then id). A visited set guards
 * against cycles in the parent edges so a malformed graph cannot infinite-loop
 * (a node already on the current path is dropped from its second parent). Pure
 * so it can be unit-tested without the panel.
 */
export function buildTree(graph: BeadsTaskGraph): TreeNode[] {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  // child -> parent (a child may declare multiple parent edges; first wins so
  // each issue appears once). parent edges are `from = child`, `to = parent`.
  const parentOf = new Map<string, string>();
  for (const d of graph.deps) {
    if (!PARENT_TYPES.has(d.type)) continue;
    if (!byId.has(d.from) || !byId.has(d.to)) continue;
    if (!parentOf.has(d.from)) parentOf.set(d.from, d.to);
  }
  const childIdsByParent = new Map<string, string[]>();
  for (const [child, parent] of parentOf) {
    const list = childIdsByParent.get(parent) ?? [];
    list.push(child);
    childIdsByParent.set(parent, list);
  }

  const order = (a: BeadsIssue, b: BeadsIssue): number => compareByState(graph, a, b);

  const build = (id: string, path: Set<string>): TreeNode => {
    const issue = byId.get(id)!;
    const next = new Set(path).add(id);
    const children = (childIdsByParent.get(id) ?? [])
      .filter((c) => !next.has(c)) // cycle guard
      .map((c) => byId.get(c)!)
      .sort(order)
      .map((c) => build(c.id, next));
    return { issue, children };
  };

  return graph.issues
    .filter((i) => !parentOf.has(i.id))
    .slice()
    .sort(order)
    .map((i) => build(i.id, new Set<string>()));
}

/**
 * The chain of ancestor issues of `id` via `parent-child`/`parent` edges, ordered
 * root-first and excluding `id` itself. First-declared parent wins (matching
 * {@link buildTree}); a cycle guard stops a malformed graph from looping. Used by
 * the tree focus mode (FA-5) to render the context path above a focused subtree.
 */
export function ancestorsOf(graph: BeadsTaskGraph, id: string): BeadsIssue[] {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  const parentOf = new Map<string, string>();
  for (const d of graph.deps) {
    if (!PARENT_TYPES.has(d.type)) continue;
    if (!byId.has(d.from) || !byId.has(d.to)) continue;
    if (!parentOf.has(d.from)) parentOf.set(d.from, d.to);
  }
  const chain: BeadsIssue[] = [];
  const seen = new Set<string>([id]);
  let cur = parentOf.get(id);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const issue = byId.get(cur);
    if (issue) chain.push(issue);
    cur = parentOf.get(cur);
  }
  return chain.reverse(); // root first
}

/** Depth-first lookup of the {@link TreeNode} for `id` in a tree forest (the
 *  focused subtree, with the focus node's full descendants). */
export function findTreeNode(nodes: TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.issue.id === id) return n;
    const found = findTreeNode(n.children, id);
    if (found) return found;
  }
  return null;
}

/**
 * Resolves which issue the graph view should center on. Precedence: the current
 * selection (when still present in the graph), else the first in-progress issue,
 * else the highest-priority ready issue, else the first issue overall; each
 * fallback bucket is ordered by priority ascending then id. Returns null for an
 * empty graph. Pure so the panel and tests can exercise it without the store.
 */
export function resolveAnchorId(
  graph: BeadsTaskGraph,
  selectedId: string | null,
): string | null {
  if (selectedId != null && graph.issues.some((i) => i.id === selectedId)) {
    return selectedId;
  }
  const byPriority = (a: BeadsIssue, b: BeadsIssue): number =>
    a.priority - b.priority || a.id.localeCompare(b.id);
  const sorted = graph.issues.slice().sort(byPriority);
  const firstWith = (group: StatusGroup): BeadsIssue | undefined =>
    sorted.find((i) => statusGroup(i.status) === group);
  return (firstWith('in_progress') ?? firstWith('ready') ?? sorted[0])?.id ?? null;
}

const PRIORITY_LABEL: Record<number, string> = {
  0: 'P0',
  1: 'P1',
  2: 'P2',
  3: 'P3',
};

export function priorityLabel(priority: number): string {
  return PRIORITY_LABEL[priority] ?? `P${priority}`;
}

// ---------------------------------------------------------------------------
// Six-state model (three kinds of "blocked"). This is the authoritative state
// model consumed by the List/Tree/Graph/Detail views. There are three distinct
// kinds of blocked from three sources, with different urgency:
//   - `blocked`        — stored `status === 'blocked'` (a DELIBERATE flag): red,
//                        urgent, sorted first.
//   - `dep_blocked`    — DERIVED: ≥1 open `blocks` dependency: yellow,
//                        informational.
//   - `child_blocked`  — DERIVED: a parent/epic with ≥1 open child: yellow,
//                        informational.
// Only the explicit flag is red; both derived reasons are yellow. The derived
// reasons are also exposed as independent counts (FR6) so a node whose primary
// state masks another reason still surfaces it via a secondary badge.
// ---------------------------------------------------------------------------

/** Render states in List/sort order: red flag-blocked first, the two yellow
 *  derived-blocked groups below the actionable in_progress/ready, done last. */
export const WG_STATES = [
  'blocked',
  'in_progress',
  'ready',
  'dep_blocked',
  'child_blocked',
  'done',
] as const;
export type WorkgraphState = (typeof WG_STATES)[number];

export const WG_STATE_LABEL: Record<WorkgraphState, string> = {
  blocked: 'Blocked',
  in_progress: 'In progress',
  ready: 'Ready',
  dep_blocked: 'Blocked by deps',
  child_blocked: 'Blocked by children',
  done: 'Done',
};

/** Badge/StatusDot tone per state — the existing Solarized tones already cover
 *  the four colors: red=removed, green=added, blue=accent, yellow=warn. */
export type WgTone = 'neutral' | 'accent' | 'added' | 'removed' | 'warn';
export const STATE_TONE: Record<WorkgraphState, WgTone> = {
  blocked: 'removed', // red
  in_progress: 'added', // green
  ready: 'accent', // blue
  dep_blocked: 'warn', // yellow
  child_blocked: 'warn', // yellow
  done: 'neutral', // muted
};

/** Theme-token color per state (for inline SVG styling in the graph view). */
export const STATE_COLOR: Record<WorkgraphState, string> = {
  blocked: 'var(--color-removed)',
  in_progress: 'var(--color-added)',
  ready: 'var(--color-accent)',
  dep_blocked: 'var(--color-warn)',
  child_blocked: 'var(--color-warn)',
  done: 'var(--color-dim)',
};

const WG_STATE_ORDER: Record<WorkgraphState, number> = WG_STATES.reduce(
  (acc, s, i) => {
    acc[s] = i;
    return acc;
  },
  {} as Record<WorkgraphState, number>,
);

/** Children of `id` via `parent-child`/`parent` edges (edges where `id` is the
 *  parent `to`); returns the child issue objects. */
export function childrenOf(graph: BeadsTaskGraph, id: string): BeadsIssue[] {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  return graph.deps
    .filter((d) => PARENT_TYPES.has(d.type) && d.to === id)
    .map((d) => byId.get(d.from))
    .filter((i): i is BeadsIssue => i != null);
}

/** Count of an issue's open (non-terminal) `blocks` dependencies. */
export function openBlockerCount(graph: BeadsTaskGraph, issue: BeadsIssue): number {
  const byId = new Map(graph.issues.map((i) => [i.id, i]));
  return graph.deps.reduce((n, d) => {
    if (d.type !== 'blocks' || d.from !== issue.id) return n;
    const blocker = byId.get(d.to);
    return blocker != null && !isTerminal(blocker.status) ? n + 1 : n;
  }, 0);
}

/** Count of an issue's open (non-terminal) children. */
export function openChildCount(graph: BeadsTaskGraph, issue: BeadsIssue): number {
  return childrenOf(graph, issue.id).filter((c) => !isTerminal(c.status)).length;
}

/** True when the issue has ≥1 open child (the epic↔child reverse-block). */
export function hasOpenChildren(graph: BeadsTaskGraph, issue: BeadsIssue): boolean {
  return openChildCount(graph, issue) > 0;
}

/**
 * The single source mapping `(status, edges)` to one render state. Precedence
 * (top wins): `done > blocked(flag) > in_progress > dep_blocked > child_blocked
 * > ready`. Only the deliberate `status === 'blocked'` flag is red; the two
 * derived reasons are yellow/informational. Pure — unit-tested without a store.
 */
export function deriveState(graph: BeadsTaskGraph, issue: BeadsIssue): WorkgraphState {
  if (isTerminal(issue.status)) return 'done';
  if (issue.status === 'blocked') return 'blocked';
  if (issue.status === 'in_progress') return 'in_progress';
  if (hasOpenBlockers(graph, issue)) return 'dep_blocked';
  if (hasOpenChildren(graph, issue)) return 'child_blocked';
  return 'ready';
}

/** Stable order key for the six-state model: state order, then priority asc,
 *  then id — used for List grouping and Tree sibling/root ordering. */
export function compareByState(
  graph: BeadsTaskGraph,
  a: BeadsIssue,
  b: BeadsIssue,
): number {
  return (
    WG_STATE_ORDER[deriveState(graph, a)] - WG_STATE_ORDER[deriveState(graph, b)] ||
    compareIssues(a, b)
  );
}

export interface StateGroup {
  state: WorkgraphState;
  issues: BeadsIssue[];
}

/** Buckets issues by `deriveState`, in WG_STATES order; siblings priority asc. */
export function groupByState(graph: BeadsTaskGraph): StateGroup[] {
  const buckets = new Map<WorkgraphState, BeadsIssue[]>();
  for (const s of WG_STATES) buckets.set(s, []);
  for (const issue of graph.issues) buckets.get(deriveState(graph, issue))!.push(issue);
  return WG_STATES.map((state) => ({
    state,
    issues: buckets.get(state)!.slice().sort(compareIssues),
  }));
}
