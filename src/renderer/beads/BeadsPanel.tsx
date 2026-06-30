import { useEffect, useState } from 'react';
import * as RDropdown from '@radix-ui/react-dropdown-menu';
import {
  Badge,
  Button,
  EmptyState,
  Panel,
  PanelBody,
  PanelHeader,
  Row,
  Spinner,
  StatusDot,
  Toolbar,
  cn,
} from '../ui';
import { GraphView } from './GraphView';
import { TreeView } from './TreeView';
import { ColumnsView } from './ColumnsView';
import { PinButton } from './PinButton';
import { useActiveBeads, useBeadsStore, type WorkgraphView } from './beadsStore';
import { useSettingsStore } from '../settings';
import { readFocus, writeFocus } from '@renderer/workspace/focusMemory';
import {
  WG_STATES,
  WG_STATE_LABEL,
  STATE_TONE,
  groupByState,
  openBlockerCount,
  openChildCount,
  priorityLabel,
  type WorkgraphState,
} from './graphSelectors';
import type { BeadsTaskGraph } from '@shared/ipc/channels';
import { useProjectsStore, useSessionStore, isDisconnected } from '../providerClient';

/** Default-visible states: everything except terminal `done`. The red
 *  flag-blocked group sorts first; the two yellow derived-blocked groups sort
 *  below the actionable in_progress/ready groups (WG_STATES order). */
const DEFAULT_VISIBLE: Set<WorkgraphState> = new Set(WG_STATES.filter((s) => s !== 'done'));

/** Read the persisted per-project state filter (FA-5); defaults to
 *  {@link DEFAULT_VISIBLE} when absent. An empty stored value round-trips to an
 *  empty set (the user hid every state) rather than the default. */
function readFilter(projectId: string | null): Set<WorkgraphState> {
  const raw = readFocus('wg-filter', projectId);
  if (raw == null) return new Set(DEFAULT_VISIBLE);
  const known = new Set<string>(WG_STATES);
  return new Set(raw.split(',').filter((s): s is WorkgraphState => known.has(s)));
}

/** Persist the per-project state filter (comma-joined). */
function writeFilter(projectId: string | null, states: Set<WorkgraphState>): void {
  writeFocus('wg-filter', projectId, [...states].join(','));
}

/** Beads workgraph: issues grouped by status, selectable into the detail view. */
export function BeadsPanel(): JSX.Element {
  const { graph, loading, error, selectedId, focusId, view, focusEpicIds } = useActiveBeads();
  const select = useBeadsStore((s) => s.select);
  const setView = useBeadsStore((s) => s.setView);
  const setFocus = useBeadsStore((s) => s.setFocus);
  const pinEpic = useBeadsStore((s) => s.pinEpic);
  const unpinEpic = useBeadsStore((s) => s.unpinEpic);
  const columnsSoftCap = useSettingsStore((s) => s.settings.workgraphColumnsSoftCap);
  const activeId = useProjectsStore((s) => s.activeId);
  const disconnected = useSessionStore(isDisconnected(activeId));

  // Filter state is component-local but persisted per project (FA-5). Restore on
  // project switch; writes happen synchronously in the toggle handler under the
  // current activeId, so a switch never persists a stale filter to the new
  // project.
  const [visibleStates, setVisibleStates] = useState<Set<WorkgraphState>>(() => readFilter(activeId));
  const [searchText, setSearchText] = useState('');
  useEffect(() => {
    setVisibleStates(readFilter(activeId));
  }, [activeId]);

  // Data load/refresh is orchestrated by panelDataSync off per-session
  // connection status + watch events — not panel mount (FR1/FR4).

  // Bind the active project to the keyed store actions so the panel stays a pure
  // reader of the active slice.
  const selectActive = (id: string | null): void => {
    if (activeId) select(activeId, id);
  };
  const setViewActive = (v: WorkgraphView): void => {
    if (activeId) setView(activeId, v);
  };
  const onFocus = (id: string): void => {
    if (activeId) setFocus(activeId, id);
  };
  const onExitFocus = (): void => {
    if (activeId) setFocus(activeId, null);
  };
  const onUnpinEpic = (id: string): void => {
    if (activeId) unpinEpic(activeId, id);
  };
  const onTogglePin = (id: string): void => {
    if (!activeId) return;
    if (focusEpicIds.includes(id)) unpinEpic(activeId, id);
    else pinEpic(activeId, id);
  };
  const pinnedEpicIds = new Set(focusEpicIds);

  // Escape exits focus (FA-5), in tree or graph view.
  useEffect(() => {
    if (!focusId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && activeId) setFocus(activeId, null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusId, activeId, setFocus]);

  const hasGraph = graph != null && graph.issues.length > 0;
  const focusIssue = focusId && graph ? graph.issues.find((i) => i.id === focusId) ?? null : null;

  function toggleState(group: WorkgraphState): void {
    setVisibleStates((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      writeFilter(activeId, next);
      return next;
    });
  }

  return (
    <Panel>
      <PanelHeader
        title="Workgraph"
        actions={hasGraph ? <ViewToggle view={view} onChange={setViewActive} /> : undefined}
      />
      {hasGraph && (
        <Toolbar>
          <StatesDropdown visibleStates={visibleStates} onToggle={toggleState} />
          <input
            aria-label="Search tasks"
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search…"
            className={cn(
              'h-7 min-w-0 flex-1 rounded border border-edge bg-bg px-2 text-[13px] text-fg',
              'outline-none placeholder:text-dim hover:border-accent',
              'focus-visible:ring-2 focus-visible:ring-accent/60',
            )}
          />
        </Toolbar>
      )}
      {focusIssue && (
        <div className="flex items-center gap-2 border-b border-accent/40 bg-accent/10 px-2 py-1 text-[12px] text-fg">
          <span className="shrink-0 text-dim">Focused:</span>
          <span className="min-w-0 flex-1 truncate font-medium" title={`${focusIssue.id} · ${focusIssue.title}`}>
            {focusIssue.title}
          </span>
          <button
            type="button"
            onClick={onExitFocus}
            aria-label="Exit focus"
            className="shrink-0 rounded px-1.5 py-0.5 text-dim hover:bg-elev hover:text-fg"
          >
            × Exit focus
          </button>
        </div>
      )}
      <PanelBody>
        {disconnected ? (
          <EmptyState title="Disconnected" hint="Reconnect to view tasks." />
        ) : (
          renderBody({
            graph,
            loading,
            error,
            selectedId,
            focusId,
            view,
            select: selectActive,
            onFocus,
            onExitFocus,
            visibleStates,
            searchText,
            focusEpicIds,
            pinnedEpicIds,
            onUnpin: onUnpinEpic,
            onTogglePin,
            columnsSoftCap,
          })
        )}
      </PanelBody>
    </Panel>
  );
}

function ViewToggle({
  view,
  onChange,
}: {
  view: WorkgraphView;
  onChange: (view: WorkgraphView) => void;
}): JSX.Element {
  const OPTIONS: { value: WorkgraphView; label: string; aria: string }[] = [
    { value: 'flat', label: 'List', aria: 'List view' },
    { value: 'tree', label: 'Tree', aria: 'Tree view' },
    { value: 'graph', label: 'Graph', aria: 'Graph view' },
    { value: 'columns', label: 'Columns', aria: 'Columns view' },
  ];
  return (
    <div role="radiogroup" aria-label="Workgraph view" className="flex gap-0.5">
      {OPTIONS.map((o) => (
        <Button
          key={o.value}
          size="sm"
          variant={view === o.value ? 'primary' : 'ghost'}
          role="radio"
          aria-checked={view === o.value}
          aria-label={o.aria}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

function StatesDropdown({
  visibleStates,
  onToggle,
}: {
  visibleStates: Set<WorkgraphState>;
  onToggle: (group: WorkgraphState) => void;
}): JSX.Element {
  const allVisible = WG_STATES.every((g) => visibleStates.has(g));
  const label = allVisible ? 'States ▾' : `States (${visibleStates.size}) ▾`;

  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>
        <Button size="sm" variant="ghost" aria-label="Filter by state">
          {label}
        </Button>
      </RDropdown.Trigger>
      <RDropdown.Portal>
        <RDropdown.Content
          className="z-50 min-w-[160px] rounded-md border border-edge bg-panel p-1 text-[13px] text-fg shadow-xl outline-none"
          sideOffset={4}
          align="start"
        >
          {WG_STATES.map((group) => (
            <RDropdown.CheckboxItem
              key={group}
              checked={visibleStates.has(group)}
              onCheckedChange={() => onToggle(group)}
              // Keep the menu open across toggles so several states can be flipped
              // in one pass; it still closes on Escape / outside click.
              onSelect={(e) => e.preventDefault()}
              className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1 outline-none data-[highlighted]:bg-accent/20"
            >
              <RDropdown.ItemIndicator>
                <span aria-hidden>✓</span>
              </RDropdown.ItemIndicator>
              <span className={!visibleStates.has(group) ? 'opacity-40' : ''}>
                {WG_STATE_LABEL[group]}
              </span>
            </RDropdown.CheckboxItem>
          ))}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

interface BodyProps {
  graph: BeadsTaskGraph | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  focusId: string | null;
  view: WorkgraphView;
  select: (id: string | null) => void;
  onFocus: (id: string) => void;
  onExitFocus: () => void;
  visibleStates: Set<WorkgraphState>;
  searchText: string;
  focusEpicIds: string[];
  pinnedEpicIds: Set<string>;
  onUnpin: (id: string) => void;
  onTogglePin: (id: string) => void;
  columnsSoftCap: number;
}

function renderBody({
  graph,
  loading,
  error,
  selectedId,
  focusId,
  view,
  select,
  onFocus,
  onExitFocus,
  visibleStates,
  searchText,
  focusEpicIds,
  pinnedEpicIds,
  onUnpin,
  onTogglePin,
  columnsSoftCap,
}: BodyProps): JSX.Element {
  // Cold-load spinner ONLY: show it while loading when there is no graph to show
  // yet. A refresh-while-loaded (e.g. after a bead action from Task Detail, or a
  // .beads watch event) keeps the current view MOUNTED so the data updates in
  // place — unmounting it for a spinner would reset TreeView's per-row collapse
  // state (local useState) and flash a full reload. See CLAUDE.md.
  if (loading && graph == null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error != null) {
    return <EmptyState title="Failed to load workgraph" hint={error} />;
  }
  if (graph == null || graph.issues.length === 0) {
    return (
      <EmptyState
        title="No beads found"
        hint="This project has no Beads issue database."
      />
    );
  }

  if (view === 'graph') {
    return (
      <GraphView
        graph={graph}
        selectedId={selectedId}
        onSelect={select}
        focusId={focusId}
        searchNeedle={searchText}
        pinnedEpicIds={pinnedEpicIds}
        onTogglePin={onTogglePin}
        visibleStates={visibleStates}
      />
    );
  }

  if (view === 'tree') {
    return (
      <TreeView
        graph={graph}
        selectedId={selectedId}
        onSelect={select}
        visibleStates={visibleStates}
        focusId={focusId}
        onFocus={onFocus}
        onExitFocus={onExitFocus}
        searchNeedle={searchText}
        pinnedEpicIds={pinnedEpicIds}
        onTogglePin={onTogglePin}
      />
    );
  }

  if (view === 'columns') {
    return (
      <ColumnsView
        graph={graph}
        focusEpicIds={focusEpicIds}
        selectedId={selectedId}
        onSelect={select}
        visibleStates={visibleStates}
        searchNeedle={searchText}
        onUnpin={onUnpin}
        softCap={columnsSoftCap}
      />
    );
  }

  const needle = searchText.trim().toLowerCase();

  const groups = groupByState(graph)
    .filter((g) => visibleStates.has(g.state))
    .map(({ state, issues }) => ({
      state,
      issues: needle
        ? issues.filter((i) => {
            const shortId = i.id.split('-').pop() ?? i.id;
            return (
              i.id.toLowerCase().includes(needle) ||
              shortId.toLowerCase().includes(needle) ||
              i.title.toLowerCase().includes(needle)
            );
          })
        : issues,
    }))
    .filter((g) => g.issues.length > 0);

  if (groups.length === 0) {
    return <EmptyState title="No tasks match the filter" hint="Adjust the state filter or search text." />;
  }

  return (
    <div role="list">
      {groups.map(({ state, issues }) => (
        <section key={state} aria-label={WG_STATE_LABEL[state]}>
          <div className="flex items-center gap-2 border-b border-edge px-2 py-1 text-[11px] uppercase tracking-wide text-dim">
            <StatusDot tone={STATE_TONE[state]} />
            <span>{WG_STATE_LABEL[state]}</span>
            <span className="text-dim/70">{issues.length}</span>
          </div>
          {issues.map((issue) => {
            // Secondary, informational signals shown independent of the primary
            // state color (FR6): both are yellow. A flag-blocked (red) issue with
            // open deps still shows the count; an in_progress epic shows children.
            const blockerN = openBlockerCount(graph, issue);
            const childN = openChildCount(graph, issue);
            return (
              <Row
                key={issue.id}
                role="listitem"
                active={issue.id === selectedId}
                onClick={() => select(issue.id)}
                prefix={
                  <Badge tone={STATE_TONE[state]} title={`${issue.issueType} · ${priorityLabel(issue.priority)}`}>
                    {priorityLabel(issue.priority)} {issue.issueType}
                  </Badge>
                }
                suffix={
                  issue.issueType === 'epic' || blockerN > 0 || childN > 0 ? (
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
                      {issue.issueType === 'epic' && (
                        <PinButton
                          pinned={pinnedEpicIds.has(issue.id)}
                          onToggle={() => onTogglePin(issue.id)}
                          label={`${pinnedEpicIds.has(issue.id) ? 'Unpin' : 'Pin'} epic ${issue.title} (columns)`}
                        />
                      )}
                    </span>
                  ) : undefined
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
            );
          })}
        </section>
      ))}
    </div>
  );
}
