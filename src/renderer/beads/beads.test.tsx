// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import type { BeadsTaskGraph } from '@shared/ipc/channels';

// `cockpit` captures `window.api` at module import time, so the fake bridge
// must be installed before the store/panels are imported. `vi.hoisted` runs
// ahead of the (hoisted) import statements below.
const api = vi.hoisted(() => {
  const provider = {
    detectBeads: vi.fn(),
    getTaskGraph: vi.fn(),
    getTask: vi.fn(),
  };
  // Capture the onWatch handler so tests can dispatch synthetic watch events.
  const watchHandlers: ((e: { event?: { paths?: string[] } }) => void)[] = [];
  const events = {
    onWatch: (h: (e: { event?: { paths?: string[] } }) => void) => {
      watchHandlers.push(h);
      return () => {
        const i = watchHandlers.indexOf(h);
        if (i >= 0) watchHandlers.splice(i, 1);
      };
    },
  };
  const fake = { provider, events, __watchHandlers: watchHandlers };
  (globalThis as unknown as { window: { api: unknown } }).window.api = fake;
  return fake;
});

function dispatchWatch(paths: string[], projectId = 'test-project'): void {
  for (const h of api.__watchHandlers) h({ projectId, event: { paths } });
}

import { BeadsPanel } from './BeadsPanel';
import { TaskDetail } from './TaskDetail';
import { useBeadsStore } from './beadsStore';
import {
  STATUS_GROUPS,
  buildTree,
  groupIssues,
  groupOf,
  resolveAnchorId,
} from './graphSelectors';
import { useProjectsStore } from '@renderer/providerClient';

const FIXTURE: BeadsTaskGraph = {
  source: { kind: 'jsonl', path: '/repo/.beads/issues.jsonl' },
  schemaCompatible: true,
  issues: [
    {
      id: 'bd-1',
      title: 'Ready issue',
      body: 'A ready task body.',
      status: 'ready',
      priority: 1,
      issueType: 'task',
      labels: ['frontend'],
      externalRef: null,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
    {
      id: 'bd-2',
      title: 'Blocked issue',
      body: 'Waiting on bd-1.',
      status: 'blocked',
      priority: 0,
      issueType: 'feature',
      labels: [],
      externalRef: null,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
    {
      id: 'bd-3',
      title: 'Closed issue',
      body: '',
      status: 'closed',
      priority: 2,
      issueType: 'bug',
      labels: [],
      externalRef: null,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
  ],
  // bd-2 depends on bd-1 (from=issue, to=depends_on) -> open bd-1 blocks bd-2.
  deps: [{ from: 'bd-2', to: 'bd-1', type: 'blocks' }],
};

const PROJECT = 'test-project';

function installApi(graph: BeadsTaskGraph | null): void {
  api.provider.detectBeads.mockResolvedValue(graph != null);
  api.provider.getTaskGraph.mockResolvedValue(graph);
  api.provider.getTask.mockResolvedValue(null);
}

/** Load the active project's slice (panelDataSync drives this in the app). */
async function loadSlice(): Promise<void> {
  await act(async () => {
    await useBeadsStore.getState().load(PROJECT);
  });
}

beforeEach(() => {
  useBeadsStore.setState({ byProject: {} });
  // The active slice selector reads byProject[activeId]; tests need an active id.
  useProjectsStore.setState({ activeId: PROJECT });
});

afterEach(() => {
  cleanup();
});

describe('BeadsPanel', () => {
  it('groups issues by status after load (closed hidden by default)', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    expect(useBeadsStore.getState().byProject[PROJECT]!.graph).not.toBeNull();

    const ready = screen.getByRole('region', { name: 'Ready' });
    expect(within(ready).getByText('Ready issue')).toBeInTheDocument();

    const blocked = screen.getByRole('region', { name: 'Blocked' });
    expect(within(blocked).getByText('Blocked issue')).toBeInTheDocument();
    // bd-2 is blocked by open bd-1, so it should be flagged.
    expect(within(blocked).getByLabelText('blocked by open work')).toBeInTheDocument();

    // Closed is hidden by default — the filter's default state excludes it.
    expect(screen.queryByRole('region', { name: 'Closed' })).not.toBeInTheDocument();
    expect(screen.queryByText('Closed issue')).not.toBeInTheDocument();
  });

  it('shows the empty state when no beads are present', async () => {
    installApi(null);
    render(<BeadsPanel />);
    await loadSlice();

    expect(screen.getByText('No beads found')).toBeInTheDocument();
  });

  it('selecting a row updates TaskDetail', async () => {
    installApi(FIXTURE);
    render(
      <>
        <BeadsPanel />
        <TaskDetail />
      </>,
    );
    await loadSlice();

    expect(screen.getByText('No task selected')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Blocked issue'));

    expect(useBeadsStore.getState().byProject[PROJECT]!.selectedId).toBe('bd-2');
    // Detail header shows the selected id and its dependency edge to bd-1. The
    // body now renders as markdown (async), so await it.
    expect(await screen.findByText('Waiting on bd-1.')).toBeInTheDocument();
    const blockedBy = screen.getByRole('region', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('Ready issue')).toBeInTheDocument();
  });

  it('clicking a related bead selects it and switches the detail (qkvr.14)', async () => {
    installApi(FIXTURE);
    render(
      <>
        <BeadsPanel />
        <TaskDetail />
      </>,
    );
    await loadSlice();
    await act(async () => {
      useBeadsStore.getState().select(PROJECT, 'bd-2');
    });

    const blockedBy = screen.getByRole('region', { name: 'Blocked by' });
    fireEvent.click(within(blockedBy).getByText('Ready issue'));

    // Clicking the related bead re-points the shared selection; the detail
    // switches to bd-1.
    expect(useBeadsStore.getState().byProject[PROJECT]!.selectedId).toBe('bd-1');
    expect(await screen.findByText('A ready task body.')).toBeInTheDocument();
  });

  it('strikes through a completed (closed) blocked-by item (qkvr.13)', async () => {
    installApi({
      ...FIXTURE,
      deps: [
        { from: 'bd-2', to: 'bd-1', type: 'blocks' }, // open blocker → not struck
        { from: 'bd-2', to: 'bd-3', type: 'blocks' }, // closed blocker → struck
      ],
    });
    render(<TaskDetail />);
    await loadSlice();
    await act(async () => {
      useBeadsStore.getState().select(PROJECT, 'bd-2');
    });

    const blockedBy = screen.getByRole('region', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('Closed issue')).toHaveClass('line-through');
    expect(within(blockedBy).getByText('Ready issue')).not.toHaveClass('line-through');
  });

  it('reloads on a .beads/* watch event and ignores unrelated paths (via panelDataSync)', async () => {
    installApi(FIXTURE);
    const { initPanelDataSync } = await import('@renderer/workspace/panelDataSync');
    render(<BeadsPanel />);
    await loadSlice();

    // panelDataSync routes watch events (tagged with projectId) by category to
    // the addressed project's slice — the panel itself no longer subscribes.
    const off = initPanelDataSync();
    const baseline = api.provider.getTaskGraph.mock.calls.length;

    await act(async () => {
      dispatchWatch(['src/some/file.ts']);
    });
    expect(api.provider.getTaskGraph.mock.calls.length).toBe(baseline);

    // beads.db-wal must NOT trigger a refresh: a WAL-mode read bumps the -wal
    // mtime, so refreshing on it makes the workgraph's own open-read-close read
    // re-fire the watch in a self-sustaining loop (local_repo_explorer-fg5z
    // regression). Only committed-write signals (beads.db, issues.jsonl) refresh.
    await act(async () => {
      dispatchWatch(['.beads/beads.db-wal']);
    });
    expect(api.provider.getTaskGraph.mock.calls.length).toBe(baseline);

    await act(async () => {
      dispatchWatch(['.beads/beads.db']);
    });
    expect(api.provider.getTaskGraph.mock.calls.length).toBe(baseline + 1);

    await act(async () => {
      dispatchWatch(['.beads/issues.jsonl']);
    });
    expect(api.provider.getTaskGraph.mock.calls.length).toBe(baseline + 2);

    off();
  });

  it('toggles between the flat list and the graph view', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);

    await loadSlice();

    // Starts in flat view: status regions are present.
    expect(screen.getByRole('region', { name: 'Ready' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Dependency graph' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Graph view' }));

    // Graph view: the SVG renders, and the anchor (bd-1) plus its blocked
    // neighbour (bd-2) appear as nodes.
    expect(screen.getByRole('img', { name: 'Dependency graph' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Ready' })).not.toBeInTheDocument();
    expect(screen.getByText('Ready issue')).toBeInTheDocument();
    expect(screen.getByText('Blocked issue')).toBeInTheDocument();
    expect(useBeadsStore.getState().byProject[PROJECT]!.view).toBe('graph');

    fireEvent.click(screen.getByRole('radio', { name: 'List view' }));
    expect(screen.getByRole('region', { name: 'Ready' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Dependency graph' })).not.toBeInTheDocument();
  });
});

describe('BeadsPanel filter', () => {
  it('hides closed issues by default', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);

    await loadSlice();

    // ready and blocked are visible by default
    expect(screen.getByText('Ready issue')).toBeInTheDocument();
    expect(screen.getByText('Blocked issue')).toBeInTheDocument();
    // closed is hidden by default
    expect(screen.queryByRole('region', { name: 'Closed' })).not.toBeInTheDocument();
    expect(screen.queryByText('Closed issue')).not.toBeInTheDocument();
  });

  it('text search filters by title (case-insensitive)', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);

    await loadSlice();

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'READY' } });

    expect(screen.getByText('Ready issue')).toBeInTheDocument();
    expect(screen.queryByText('Blocked issue')).not.toBeInTheDocument();
  });

  it('text search filters by id (case-insensitive)', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);

    await loadSlice();

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'bd-2' } });

    // bd-2 is "Blocked issue"
    expect(screen.queryByText('Ready issue')).not.toBeInTheDocument();
    expect(screen.getByText('Blocked issue')).toBeInTheDocument();
  });

  it('shows empty state when all groups are filtered out', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);

    await loadSlice();

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'xyzzy-no-match' } });

    expect(screen.getByText('No tasks match the filter')).toBeInTheDocument();
  });
});

describe('resolveAnchorId', () => {
  const issue = (id: string, status: string, priority: number) => ({
    id,
    title: id,
    body: '',
    status,
    priority,
    issueType: 'task',
    labels: [],
    externalRef: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  });
  const graphOf = (issues: ReturnType<typeof issue>[]): BeadsTaskGraph => ({
    source: { kind: 'jsonl', path: '/x' },
    schemaCompatible: true,
    issues,
    deps: [],
  });

  it('returns null for an empty graph', () => {
    expect(resolveAnchorId(graphOf([]), null)).toBeNull();
  });

  it('keeps a valid selection but ignores one absent from the graph', () => {
    const g = graphOf([issue('a', 'ready', 1)]);
    expect(resolveAnchorId(g, 'a')).toBe('a');
    expect(resolveAnchorId(g, 'missing')).toBe('a');
  });

  it('prefers in_progress, then highest-priority ready, then first overall', () => {
    const ip = graphOf([issue('r', 'ready', 0), issue('p', 'in_progress', 3)]);
    expect(resolveAnchorId(ip, null)).toBe('p');

    const ready = graphOf([issue('lo', 'ready', 2), issue('hi', 'ready', 0)]);
    expect(resolveAnchorId(ready, null)).toBe('hi');

    const closedOnly = graphOf([issue('z', 'closed', 2), issue('a', 'closed', 1)]);
    expect(resolveAnchorId(closedOnly, null)).toBe('a');
  });
});

// --- T1/T2/T3 selectors ---------------------------------------------------

const mkIssue = (id: string, status: string, priority = 1) => ({
  id,
  title: id,
  body: '',
  status,
  priority,
  issueType: 'task',
  labels: [] as string[],
  externalRef: null,
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-05-01T00:00:00Z',
});
const mkGraph = (
  issues: ReturnType<typeof mkIssue>[],
  deps: BeadsTaskGraph['deps'] = [],
): BeadsTaskGraph => ({
  source: { kind: 'jsonl', path: '/x' },
  schemaCompatible: true,
  issues,
  deps,
});

describe('STATUS_GROUPS order (T1, FR1)', () => {
  it('is blocked → in_progress → ready → closed', () => {
    expect([...STATUS_GROUPS]).toEqual(['blocked', 'in_progress', 'ready', 'closed']);
  });

  it('groupIssues yields groups in that order, each sorted by priority then id', () => {
    const g = mkGraph([
      mkIssue('r2', 'ready', 1),
      mkIssue('r1', 'ready', 0),
      mkIssue('c', 'closed', 0),
      mkIssue('ip', 'in_progress', 0),
    ]);
    const groups = groupIssues(g);
    expect(groups.map((x) => x.group)).toEqual(['blocked', 'in_progress', 'ready', 'closed']);
    const ready = groups.find((x) => x.group === 'ready')!;
    // priority asc (r1=0 before r2=1)
    expect(ready.issues.map((i) => i.id)).toEqual(['r1', 'r2']);
  });
});

describe('blocked derivation (T2, OQ-1 = DERIVE)', () => {
  it('groups an open issue with non-terminal blockers as blocked', () => {
    const g = mkGraph(
      [mkIssue('blocker', 'in_progress'), mkIssue('waiter', 'open')],
      // waiter depends on blocker (from=waiter, to=blocker) → open blocker blocks waiter.
      [{ from: 'waiter', to: 'blocker', type: 'blocks' }],
    );
    expect(groupOf(g, g.issues[1]!)).toBe('blocked');
    // The blocker itself has no open dependency → grouped by status.
    expect(groupOf(g, g.issues[0]!)).toBe('in_progress');
  });

  it('does NOT derive blocked when the only blocker is closed', () => {
    const g = mkGraph(
      [mkIssue('blocker', 'closed'), mkIssue('waiter', 'open')],
      // waiter depends on a CLOSED blocker → no open dependency.
      [{ from: 'waiter', to: 'blocker', type: 'blocks' }],
    );
    // open with no OPEN blockers → unknown status falls to ready bucket.
    expect(groupOf(g, g.issues[1]!)).toBe('ready');
  });

  it('does NOT re-bucket a terminal (closed) issue even with open blockers', () => {
    const g = mkGraph(
      [mkIssue('blocker', 'in_progress'), mkIssue('done', 'closed')],
      // done depends on an open blocker, but done is terminal → stays closed.
      [{ from: 'done', to: 'blocker', type: 'blocks' }],
    );
    expect(groupOf(g, g.issues[1]!)).toBe('closed');
  });
});

describe('buildTree (T3, FR2/FR3/FR5)', () => {
  it('builds roots + children from parent edges and orders siblings (FR3)', () => {
    const g = mkGraph(
      [
        mkIssue('epic', 'ready', 1),
        mkIssue('c-lo', 'ready', 2),
        mkIssue('c-hi', 'ready', 0),
        mkIssue('lone', 'ready', 0),
      ],
      [
        { from: 'c-lo', to: 'epic', type: 'parent-child' },
        { from: 'c-hi', to: 'epic', type: 'parent' },
      ],
    );
    const tree = buildTree(g);
    // Two roots: epic (priority 1) and lone (priority 0) → lone first.
    expect(tree.map((n) => n.issue.id)).toEqual(['lone', 'epic']);
    const epic = tree.find((n) => n.issue.id === 'epic')!;
    // children sorted by priority asc: c-hi(0) before c-lo(2).
    expect(epic.children.map((n) => n.issue.id)).toEqual(['c-hi', 'c-lo']);
  });

  it('renders a leaf with no children', () => {
    const g = mkGraph([mkIssue('solo', 'ready')]);
    const tree = buildTree(g);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toEqual([]);
  });

  it('orders roots by derived state (in_progress/ready above informational dep_blocked)', () => {
    const g = mkGraph(
      [mkIssue('blk', 'open', 0), mkIssue('rdy', 'ready', 0), mkIssue('src', 'in_progress', 0)],
      // blk depends on src (from=blk, to=src) → open src blocks blk (dep_blocked).
      [{ from: 'blk', to: 'src', type: 'blocks' }],
    );
    // Six-state order: in_progress, ready, then the informational dep_blocked.
    expect(buildTree(g).map((n) => n.issue.id)).toEqual(['src', 'rdy', 'blk']);
  });

  it('guards against parent-edge cycles (no infinite loop)', () => {
    const g = mkGraph(
      [mkIssue('a', 'ready'), mkIssue('b', 'ready')],
      [
        { from: 'a', to: 'b', type: 'parent' },
        { from: 'b', to: 'a', type: 'parent' },
      ],
    );
    // Both have a parent → no roots; the build must terminate.
    expect(() => buildTree(g)).not.toThrow();
    expect(buildTree(g)).toEqual([]);
  });
});

describe('TreeView render (T3, FR2/FR4)', () => {
  const TREE_FIXTURE = mkGraph(
    [
      mkIssue('epic', 'ready', 1),
      mkIssue('child', 'open', 0),
      mkIssue('closed-child', 'closed', 0),
    ],
    [
      { from: 'child', to: 'epic', type: 'parent-child' },
      { from: 'closed-child', to: 'epic', type: 'parent-child' },
    ],
  );

  it('shows tree nesting, hides closed by default, and selects on click', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));
    expect(useBeadsStore.getState().byProject[PROJECT]!.view).toBe('tree');

    const tree = screen.getByRole('tree', { name: 'Task tree' });
    // The short-suffix badge also shows the id text when id has no '-' (e.g. 'epic'),
    // so use getAllByText to handle the badge + title-span duplication.
    expect(within(tree).getAllByText('epic').length).toBeGreaterThan(0);
    expect(within(tree).getAllByText('child').length).toBeGreaterThan(0);
    // Closed child hidden by default (OQ-2).
    expect(within(tree).queryByText('closed-child')).not.toBeInTheDocument();

    // Click the title span directly (the truncate span inside the tree row).
    fireEvent.click(within(tree).getAllByText('child')[0]!);
    expect(useBeadsStore.getState().byProject[PROJECT]!.selectedId).toBe('child');
  });

  it('collapses and expands a parent without selecting it', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();
    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    const tree = screen.getByRole('tree', { name: 'Task tree' });
    expect(within(tree).getAllByText('child').length).toBeGreaterThan(0);

    fireEvent.click(within(tree).getByRole('button', { name: 'Collapse' }));
    expect(within(tree).queryByText('child')).not.toBeInTheDocument();
    // Caret click must not select the parent.
    expect(useBeadsStore.getState().byProject[PROJECT]!.selectedId).toBeNull();

    fireEvent.click(within(tree).getByRole('button', { name: 'Expand' }));
    expect(within(tree).getAllByText('child').length).toBeGreaterThan(0);
  });

  it('allows collapsing subtrees inside focus mode (e009)', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();
    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    // Enter focus on the epic (double-click the row).
    const tree = screen.getByRole('tree', { name: 'Task tree' });
    fireEvent.doubleClick(within(tree).getAllByText('epic')[0]!);

    // Focused tree must still offer a working collapse toggle (parity with the
    // normal tree) — the old focus mode force-expanded and hid the caret.
    const focused = screen.getByRole('tree', { name: 'Task tree (focused)' });
    expect(within(focused).getAllByText('child').length).toBeGreaterThan(0);
    fireEvent.click(within(focused).getByRole('button', { name: 'Collapse' }));
    expect(within(focused).queryByText('child')).not.toBeInTheDocument();
    fireEvent.click(within(focused).getByRole('button', { name: 'Expand' }));
    expect(within(focused).getAllByText('child').length).toBeGreaterThan(0);
  });
});

describe('search filter in tree view (gxfq)', () => {
  const TREE_FIXTURE = mkGraph(
    [
      mkIssue('epic', 'ready', 1),
      mkIssue('child', 'open', 0),
    ],
    [{ from: 'child', to: 'epic', type: 'parent-child' }],
  );

  it('filters tree rows to matching nodes by title (case-insensitive)', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'CHILD' } });

    // child matches; epic is the ancestor context so it stays visible.
    // Both ids have no '-', so the short-suffix badge also shows the id — use getAllByText.
    expect(screen.getAllByText('child').length).toBeGreaterThan(0);
    expect(screen.getAllByText('epic').length).toBeGreaterThan(0);
  });

  it('hides tree rows that do not match the needle (and have no matching descendant)', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    const input = screen.getByPlaceholderText('Search…');
    // 'epic' title matches only the root, not the child.
    fireEvent.change(input, { target: { value: 'epic' } });

    expect(screen.getAllByText('epic').length).toBeGreaterThan(0);
    expect(screen.queryByText('child')).not.toBeInTheDocument();
  });

  it('shows empty state when no tree nodes match the needle', async () => {
    installApi(TREE_FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'zzznomatch' } });

    expect(screen.getByText('No tasks match the filter')).toBeInTheDocument();
  });

  it('filters by short id suffix in tree view', async () => {
    installApi(FIXTURE); // ids: bd-1, bd-2, bd-3
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    const input = screen.getByPlaceholderText('Search…');
    // short suffix '1' matches 'bd-1' (Ready issue)
    fireEvent.change(input, { target: { value: '1' } });

    expect(screen.getByText('Ready issue')).toBeInTheDocument();
    // bd-2 (Blocked issue) short suffix is '2', doesn't match '1'
    expect(screen.queryByText('Blocked issue')).not.toBeInTheDocument();
  });
});

describe('search filter in graph view (gxfq)', () => {
  it('dims non-matching graph nodes when needle is set', async () => {
    installApi(FIXTURE); // bd-1 Ready issue, bd-2 Blocked issue
    render(<BeadsPanel />);
    await loadSlice();

    // Select bd-1 so it is the graph anchor
    await act(async () => {
      useBeadsStore.getState().select(PROJECT, 'bd-1');
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Graph view' }));

    const input = screen.getByPlaceholderText('Search…');
    fireEvent.change(input, { target: { value: 'Ready' } });

    // The graph renders as SVG; nodes use foreignObject. "Ready issue" should be visible.
    expect(screen.getByText('Ready issue')).toBeInTheDocument();
    // "Blocked issue" is in the subgraph (2 hops from bd-1) but does not match the needle.
    // It should still be rendered (dimmed) — confirm it's present in DOM.
    expect(screen.getByText('Blocked issue')).toBeInTheDocument();
  });
});

describe('short suffix badge (dds9)', () => {
  // FIXTURE ids: bd-1, bd-2, bd-3 → short suffixes: 1, 2, 3

  it('shows short suffix badge in the flat list', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    // bd-1 short suffix is '1', bd-2 is '2'
    const badges = screen.getAllByTitle('bd-1');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveTextContent('1');
  });

  it('shows short suffix badge in the tree view', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    fireEvent.click(screen.getByRole('radio', { name: 'Tree view' }));

    // bd-1 code badge in tree view
    const badges = screen.getAllByTitle('bd-1');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveTextContent('1');
  });

  it('shows short suffix badge in graph view', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    await act(async () => {
      useBeadsStore.getState().select(PROJECT, 'bd-1');
    });

    fireEvent.click(screen.getByRole('radio', { name: 'Graph view' }));

    // Graph node for bd-1 should show its short suffix '1' in the code badge
    const badges = screen.getAllByTitle('bd-1');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]).toHaveTextContent('1');
  });
});

describe('WorkgraphView persistence (T3, FR2)', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it('persists the tree view per project and restores it on reload', async () => {
    installApi(FIXTURE);
    render(<BeadsPanel />);
    await loadSlice();

    useBeadsStore.getState().setView(PROJECT, 'tree');
    expect(useBeadsStore.getState().byProject[PROJECT]!.view).toBe('tree');

    // Evict the in-memory slice; a fresh load() (e.g. project switch back)
    // restores the persisted view from localStorage.
    useBeadsStore.getState().evict(PROJECT);
    await loadSlice();
    expect(useBeadsStore.getState().byProject[PROJECT]!.view).toBe('tree');
  });
});

describe('Columns view (side-by-side epics, qkav.4)', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const COLS = mkGraph(
    [
      { ...mkIssue('e1', 'ready', 1), issueType: 'epic' },
      mkIssue('e1c', 'open', 0),
      { ...mkIssue('e2', 'ready', 1), issueType: 'epic' },
      mkIssue('e2c', 'open', 0),
    ],
    [
      { from: 'e1c', to: 'e1', type: 'parent-child' },
      { from: 'e2c', to: 'e2', type: 'parent-child' },
    ],
  );

  it('shows empty state, one column per pinned epic, shared selection, and unpin', async () => {
    installApi(COLS);
    render(<BeadsPanel />);
    await loadSlice();
    fireEvent.click(screen.getByRole('radio', { name: 'Columns view' }));

    // Empty focus set → prompt, not a blank panel.
    expect(screen.getByText('No epics pinned')).toBeInTheDocument();

    // Pin two epics (store action; the row/node pin affordance lands in qkav.5).
    act(() => {
      useBeadsStore.getState().pinEpic(PROJECT, 'e1');
      useBeadsStore.getState().pinEpic(PROJECT, 'e2');
    });

    const cols = screen.getByRole('list', { name: 'Epic columns' });
    expect(within(cols).getAllByRole('listitem')).toHaveLength(2);
    // Each column renders its own epic's child subtree.
    expect(within(cols).getAllByText('e1c').length).toBeGreaterThan(0);
    expect(within(cols).getAllByText('e2c').length).toBeGreaterThan(0);

    // Selecting a task in a column drives the one shared selection.
    fireEvent.click(within(cols).getAllByText('e1c')[0]!);
    expect(useBeadsStore.getState().byProject[PROJECT]!.selectedId).toBe('e1c');

    // Unpin e1 via its × → one column remains.
    fireEvent.click(within(cols).getByRole('button', { name: 'Unpin e1' }));
    expect(
      within(screen.getByRole('list', { name: 'Epic columns' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });
});

describe('Columns pin affordance + density (qkav.5)', () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
      setItem: (k: string, v: string) => void storage.set(k, String(v)),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const epic = (id: string) => ({ ...mkIssue(id, 'ready', 1), issueType: 'epic' });

  it('pins an epic from the List view via its ☆ toggle (and flips to Unpin)', async () => {
    installApi(mkGraph([epic('e1'), mkIssue('a', 'open', 0)]));
    render(<BeadsPanel />);
    await loadSlice();
    // Default List view shows the epic row with a pin toggle.
    fireEvent.click(screen.getByRole('button', { name: 'Pin epic e1 (columns)' }));
    expect(useBeadsStore.getState().byProject[PROJECT]!.focusEpicIds).toEqual(['e1']);
    // The toggle now offers to unpin.
    expect(screen.getByRole('button', { name: 'Unpin epic e1 (columns)' })).toBeInTheDocument();
  });

  it('shows a density notice when pinned columns exceed the soft cap (default 2)', async () => {
    installApi(mkGraph([epic('e1'), epic('e2'), epic('e3')]));
    render(<BeadsPanel />);
    await loadSlice();
    act(() => {
      useBeadsStore.getState().pinEpic(PROJECT, 'e1');
      useBeadsStore.getState().pinEpic(PROJECT, 'e2');
      useBeadsStore.getState().pinEpic(PROJECT, 'e3');
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Columns view' }));
    // 3 columns > soft cap 2 → non-blocking density status; all three still shown.
    expect(screen.getByRole('status')).toHaveTextContent('3 columns shown');
    expect(
      within(screen.getByRole('list', { name: 'Epic columns' })).getAllByRole('listitem'),
    ).toHaveLength(3);
  });
});
