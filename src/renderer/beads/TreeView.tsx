import { useState, type MouseEvent } from 'react';
import { Badge, EmptyState, Row, cn } from '../ui';
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
 * ancestor context path plus its full subtree. The state filter is suspended
 * (all states shown for full context) and collapse is ignored so the ancestor
 * path is always visible. Double-clicking a row enters focus; double-clicking
 * the focused row exits.
 */
export function TreeView({
  graph,
  selectedId,
  onSelect,
  visibleStates,
  focusId,
  onFocus,
  onExitFocus,
}: TreeViewProps): JSX.Element {
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
            {ancestor.title}
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
          focusMode
        />
      </div>
    );
  }

  const roots = buildTree(graph).filter((n) => visibleStates.has(deriveState(graph, n.issue)));

  if (roots.length === 0) {
    return (
      <EmptyState
        title="No tasks match the filter"
        hint="Adjust the state filter to show more tasks."
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
  /** Inside the focused subtree: always expanded (collapse ignored). */
  focusMode?: boolean;
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
  focusMode = false,
}: TreeRowProps): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  // Focus mode ignores collapse so the full ancestor path/subtree stays visible.
  const expanded = focusMode ? true : !collapsed;
  const { issue } = node;
  const state = deriveState(graph, issue);
  const isFocused = issue.id === focusId;
  const blockerN = openBlockerCount(graph, issue);
  const childN = openChildCount(graph, issue);
  const visibleChildren = node.children.filter((c) => visibleStates.has(deriveState(graph, c.issue)));
  const hasChildren = visibleChildren.length > 0;

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    if (!focusMode) setCollapsed((v) => !v);
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
            {hasChildren && !focusMode ? (
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
          blockerN > 0 || childN > 0 ? (
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
            </span>
          ) : undefined
        }
      >
        {issue.title}
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
              focusMode={focusMode}
            />
          ))}
        </div>
      )}
    </div>
  );
}
