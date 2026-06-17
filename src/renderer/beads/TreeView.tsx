import { useState, type MouseEvent } from 'react';
import { Badge, EmptyState, Row, cn } from '../ui';
import { PinButton } from './PinButton';
import {
  ancestorsOf,
  buildTree,
  deriveState,
  findTreeNode,
  openBlockerCount,
  openChildCount,
  priorityLabel,
  STATE_TONE,
  WG_STATES,
  type WorkgraphState,
  type TreeNode,
} from './graphSelectors';
import type { BeadsTaskGraph } from '@shared/ipc/channels';

/** Every state — used to suspend the filter inside focus mode (FA-5). */
const ALL_STATES: Set<WorkgraphState> = new Set(WG_STATES);

/** True when a node's id (or short suffix) or title matches the needle. */
function nodeMatchesNeedle(id: string, title: string, needle: string): boolean {
  const shortId = id.split('-').pop() ?? id;
  return (
    id.toLowerCase().includes(needle) ||
    shortId.toLowerCase().includes(needle) ||
    title.toLowerCase().includes(needle)
  );
}

/** True when the node or any descendant matches the needle (ancestor-context
 *  pruning: keep parent if a child matches so the tree stays legible). */
function subtreeMatchesNeedle(node: TreeNode, needle: string): boolean {
  if (nodeMatchesNeedle(node.issue.id, node.issue.title, needle)) return true;
  return node.children.some((c) => subtreeMatchesNeedle(c, needle));
}

interface TreeViewProps {
  graph: BeadsTaskGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Derived-state visibility filter, shared with the flat list. */
  visibleStates: Set<WorkgraphState>;
  /** Tree focus anchor (FA-5); null = normal forest. */
  focusId?: string | null;
  /** Enter focus on a node (double-click). */
  onFocus?: (id: string) => void;
  /** Leave focus (double-click the focused row, or banner ×/Escape). */
  onExitFocus?: () => void;
  /** Search needle (case-insensitive). Filters tree to matching nodes with
   *  ancestor context. Empty = no filtering. */
  searchNeedle?: string;
  /** Single-root mode (used by the side-by-side Columns view): render ONLY this
   *  node's subtree as the sole root — no ancestor breadcrumb, no focus chrome —
   *  with normal collapse/selection and the shared state filter. Takes precedence
   *  over `focusId`. */
  rootId?: string;
  /** Epic ids currently in the Columns focus set (drives the ★/☆ pin state). */
  pinnedEpicIds?: Set<string>;
  /** Toggle an epic's membership in the Columns focus set. When provided, epic
   *  rows show a pin toggle. */
  onTogglePin?: (id: string) => void;
}

/**
 * Parent-child hierarchy of the workgraph (epic → children). Roots render at
 * the top level with nested, collapsible children. Each node reuses the flat
 * list's derived state color + priority badge + secondary blocked badges and
 * selects via the shared `select()` action so the detail/graph views react
 * identically (FR7). An epic with open children renders yellow `child_blocked`.
 * Respects the same visible-state filter as the flat list — a node whose derived
 * state is filtered out (done by default) is hidden along with its subtree.
 *
 * Focus mode (FA-5): when `focusId` is set, the tree prunes to that node's
 * ancestor context path plus its subtree. The state filter is suspended (all
 * states shown for full context). The ancestor breadcrumb is always visible
 * (rendered as separate rows), but subtrees within the focused node remain
 * collapsible, exactly like the normal tree. Double-clicking a row enters focus;
 * double-clicking the focused row exits.
 */
export function TreeView({
  graph,
  selectedId,
  onSelect,
  visibleStates,
  focusId,
  onFocus,
  onExitFocus,
  searchNeedle,
  rootId,
  pinnedEpicIds,
  onTogglePin,
}: TreeViewProps): JSX.Element {
  const needle0 = searchNeedle?.trim().toLowerCase() ?? '';

  // Single-root mode (Columns view): the epic identity lives in the column
  // header, so render only its CHILDREN here (each as its own subtree) — never the
  // epic row again, which would duplicate it.
  if (rootId) {
    const node = findTreeNode(buildTree(graph), rootId);
    if (!node) {
      return <EmptyState title="Epic not found" hint="It may have been closed or removed." />;
    }
    const kids = node.children.filter(
      (c) =>
        visibleStates.has(deriveState(graph, c.issue)) &&
        (!needle0 || subtreeMatchesNeedle(c, needle0)),
    );
    if (kids.length === 0) {
      return (
        <div className="px-2 py-3 text-center text-[12px] text-dim">
          {needle0 ? 'No matching child tasks.' : 'No child tasks.'}
        </div>
      );
    }
    return (
      <div role="tree" aria-label="Epic subtree">
        {kids.map((child) => (
          <TreeRow
            key={child.issue.id}
            node={child}
            depth={0}
            graph={graph}
            selectedId={selectedId}
            onSelect={onSelect}
            visibleStates={visibleStates}
            focusId={focusId ?? null}
            onFocus={onFocus}
            onExitFocus={onExitFocus}
            searchNeedle={needle0}
            pinnedEpicIds={pinnedEpicIds}
            onTogglePin={onTogglePin}
          />
        ))}
      </div>
    );
  }

  const focusNode = focusId ? findTreeNode(buildTree(graph), focusId) : null;

  // Focus mode: ancestor breadcrumb (context) + the focused subtree, filter
  // suspended and always expanded.
  if (focusId && focusNode) {
    const path = ancestorsOf(graph, focusId);
    return (
      <div role="tree" aria-label="Task tree (focused)">
        {path.map((ancestor, i) => (
          <Row
            key={ancestor.id}
            interactive
            className="opacity-70"
            onClick={() => onSelect(ancestor.id)}
            onDoubleClick={() => onFocus?.(ancestor.id)}
            prefix={
              <span className="flex items-center" style={{ paddingLeft: `${i * 14}px` }}>
                <span className="mr-1 inline-block w-3 shrink-0 text-dim" aria-hidden>
                  ↳
                </span>
                <Badge tone={STATE_TONE[deriveState(graph, ancestor)]}>
                  {priorityLabel(ancestor.priority)} {ancestor.issueType}
                </Badge>
              </span>
            }
          >
            <span className="flex min-w-0 items-baseline gap-1.5">
              <code
                className="shrink-0 rounded bg-elev px-0.5 font-mono text-[9px] text-dim"
                title={ancestor.id}
              >
                {ancestor.id.split('-').pop() ?? ancestor.id}
              </code>
              <span className="truncate">{ancestor.title}</span>
            </span>
          </Row>
        ))}
        <TreeRow
          node={focusNode}
          depth={path.length}
          graph={graph}
          selectedId={selectedId}
          onSelect={onSelect}
          visibleStates={ALL_STATES}
          focusId={focusId}
          onFocus={onFocus}
          onExitFocus={onExitFocus}
          pinnedEpicIds={pinnedEpicIds}
          onTogglePin={onTogglePin}
        />
      </div>
    );
  }

  const needle = searchNeedle?.trim().toLowerCase() ?? '';

  const roots = buildTree(graph).filter(
    (n) =>
      visibleStates.has(deriveState(graph, n.issue)) &&
      (!needle || subtreeMatchesNeedle(n, needle)),
  );

  if (roots.length === 0) {
    return (
      <EmptyState
        title="No tasks match the filter"
        hint={needle ? 'Adjust the search text or state filter.' : 'Adjust the state filter to show more tasks.'}
      />
    );
  }

  return (
    <div role="tree" aria-label="Task tree">
      {roots.map((node) => (
        <TreeRow
          key={node.issue.id}
          node={node}
          depth={0}
          graph={graph}
          selectedId={selectedId}
          onSelect={onSelect}
          visibleStates={visibleStates}
          focusId={focusId ?? null}
          onFocus={onFocus}
          onExitFocus={onExitFocus}
          searchNeedle={needle}
          pinnedEpicIds={pinnedEpicIds}
          onTogglePin={onTogglePin}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  graph: BeadsTaskGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  visibleStates: Set<WorkgraphState>;
  focusId?: string | null;
  onFocus?: (id: string) => void;
  onExitFocus?: () => void;
  /** Propagated needle for child subtree pruning. */
  searchNeedle?: string;
  pinnedEpicIds?: Set<string>;
  onTogglePin?: (id: string) => void;
}

function TreeRow({
  node,
  depth,
  graph,
  selectedId,
  onSelect,
  visibleStates,
  focusId,
  onFocus,
  onExitFocus,
  searchNeedle,
  pinnedEpicIds,
  onTogglePin,
}: TreeRowProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const expanded = !collapsed;
  const { issue } = node;
  const state = deriveState(graph, issue);
  const isFocused = issue.id === focusId;
  const blockerN = openBlockerCount(graph, issue);
  const childN = openChildCount(graph, issue);
  const visibleChildren = node.children.filter(
    (c) =>
      visibleStates.has(deriveState(graph, c.issue)) &&
      (!searchNeedle || subtreeMatchesNeedle(c, searchNeedle)),
  );
  const hasChildren = visibleChildren.length > 0;

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    setCollapsed((v) => !v);
  }

  // Double-click toggles focus: enter on any row, exit when it is the focused row.
  function onDoubleClick(): void {
    if (isFocused) onExitFocus?.();
    else onFocus?.(issue.id);
  }

  return (
    <div role="treeitem" aria-expanded={hasChildren ? expanded : undefined} aria-selected={issue.id === selectedId}>
      <Row
        active={issue.id === selectedId}
        onClick={() => onSelect(issue.id)}
        onDoubleClick={onDoubleClick}
        className={cn(isFocused && 'ring-1 ring-inset ring-accent/60')}
        prefix={
          <span className="flex items-center" style={{ paddingLeft: `${depth * 14}px` }}>
            {hasChildren ? (
              <button
                type="button"
                aria-label={expanded ? 'Collapse' : 'Expand'}
                onClick={toggle}
                className="mr-1 w-3 shrink-0 text-dim hover:text-fg"
              >
                {expanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="mr-1 inline-block w-3 shrink-0" aria-hidden />
            )}
            <Badge tone={STATE_TONE[state]} title={`${issue.issueType} · ${priorityLabel(issue.priority)}`}>
              {priorityLabel(issue.priority)} {issue.issueType}
            </Badge>
          </span>
        }
        suffix={
          (() => {
            const showPin = issue.issueType === 'epic' && onTogglePin != null;
            if (!showPin && blockerN === 0 && childN === 0) return undefined;
            return (
              <span className="flex items-center gap-1">
                {blockerN > 0 && (
                  <Badge tone="warn" aria-label="blocked by open work">
                    blocked by {blockerN}
                  </Badge>
                )}
                {childN > 0 && (
                  <Badge tone="warn" aria-label="blocked by open children">
                    {childN} open {childN === 1 ? 'child' : 'children'}
                  </Badge>
                )}
                {showPin && (
                  <PinButton
                    pinned={pinnedEpicIds?.has(issue.id) ?? false}
                    onToggle={() => onTogglePin(issue.id)}
                    label={`${pinnedEpicIds?.has(issue.id) ? 'Unpin' : 'Pin'} epic ${issue.title} (columns)`}
                  />
                )}
              </span>
            );
          })()
        }
      >
        <span className="flex min-w-0 items-baseline gap-1.5">
          <code
            className="shrink-0 rounded bg-elev px-0.5 font-mono text-[9px] text-dim"
            title={issue.id}
          >
            {issue.id.split('-').pop() ?? issue.id}
          </code>
          <span className="truncate">{issue.title}</span>
        </span>
      </Row>
      {hasChildren && expanded && (
        <div role="group">
          {visibleChildren.map((child: TreeNode) => (
            <TreeRow
              key={child.issue.id}
              node={child}
              depth={depth + 1}
              graph={graph}
              selectedId={selectedId}
              onSelect={onSelect}
              visibleStates={visibleStates}
              focusId={focusId}
              onFocus={onFocus}
              onExitFocus={onExitFocus}
              searchNeedle={searchNeedle}
              pinnedEpicIds={pinnedEpicIds}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      )}
    </div>
  );
}
