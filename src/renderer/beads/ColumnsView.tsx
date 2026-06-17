import { Badge, EmptyState, IconButton } from '../ui';
import { TreeView } from './TreeView';
import { deriveState, priorityLabel, STATE_TONE, type WorkgraphState } from './graphSelectors';
import type { BeadsTaskGraph } from '@shared/ipc/channels';

interface ColumnsViewProps {
  graph: BeadsTaskGraph;
  /** Pinned epic ids, in pin order (the focus set). */
  focusEpicIds: string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Shared derived-state filter (same control as the other views). */
  visibleStates: Set<WorkgraphState>;
  /** Shared search needle (already trimmed/lowercased by the caller is fine; the
   *  tree normalizes again). */
  searchNeedle: string;
  /** Remove an epic from the focus set (the column's × control). */
  onUnpin: (id: string) => void;
  /** Comfortable column count (setting). Beyond it, columns are still shown
   *  (warn-and-allow) with a non-blocking density notice. */
  softCap: number;
}

/**
 * Side-by-side epic columns: one column per pinned epic (in pin order), each
 * rendering that epic's subtree via {@link TreeView} in single-root mode and
 * scrolling independently. Selection is shared with the rest of the workgraph, so
 * clicking a task in any column drives the one TaskDetail. An empty focus set
 * shows a prompt to pin epics rather than a blank panel.
 */
export function ColumnsView({
  graph,
  focusEpicIds,
  selectedId,
  onSelect,
  visibleStates,
  searchNeedle,
  onUnpin,
  softCap,
}: ColumnsViewProps): JSX.Element {
  // Defensive: the store reconciles the set to existing epics on load, but guard
  // against a transient stale id here too.
  const epics = focusEpicIds
    .map((id) => graph.issues.find((i) => i.id === id && i.issueType === 'epic'))
    .filter((i): i is NonNullable<typeof i> => i != null);

  if (epics.length === 0) {
    return (
      <EmptyState
        title="No epics pinned"
        hint="Pin epics (★) in the List, Tree, or Graph view to compare them side by side here."
      />
    );
  }

  const overCap = epics.length > softCap;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {overCap && (
        <div
          role="status"
          className="shrink-0 border-b border-warn/40 bg-warn/10 px-2 py-1 text-[12px] text-fg"
        >
          {epics.length} columns shown — more than {softCap} can get dense. Unpin an epic, or
          raise “Workgraph side-by-side columns” in Preferences.
        </div>
      )}
      <div
        role="list"
        aria-label="Epic columns"
        className="flex min-h-0 flex-1 gap-px overflow-x-auto bg-edge"
      >
      {epics.map((epic) => (
        <section
          key={epic.id}
          role="listitem"
          aria-label={`Epic ${epic.title}`}
          // flex-1 so columns split the panel evenly and shrink to fit; min-w is a
          // usability floor — below it the row scrolls horizontally rather than
          // squeezing columns into illegibility.
          className="flex h-full min-h-0 min-w-[80px] flex-1 flex-col bg-panel"
        >
          <header className="flex items-center gap-1.5 border-b border-edge px-2 py-1">
            <Badge
              tone={STATE_TONE[deriveState(graph, epic)]}
              title={`epic · ${priorityLabel(epic.priority)}`}
            >
              {priorityLabel(epic.priority)} epic
            </Badge>
            <code
              className="shrink-0 rounded bg-elev px-0.5 font-mono text-[9px] text-dim"
              title={epic.id}
            >
              {epic.id.split('-').pop() ?? epic.id}
            </code>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={epic.title}>
              {epic.title}
            </span>
            <IconButton label={`Unpin ${epic.title}`} size="sm" onClick={() => onUnpin(epic.id)}>
              ×
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TreeView
              graph={graph}
              selectedId={selectedId}
              onSelect={onSelect}
              visibleStates={visibleStates}
              searchNeedle={searchNeedle}
              rootId={epic.id}
            />
          </div>
        </section>
      ))}
      </div>
    </div>
  );
}
