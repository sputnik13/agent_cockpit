// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BeadsTaskGraph } from '@shared/ipc/channels';

const mockDetectBeads = vi.fn<() => Promise<boolean>>();
const mockGetTaskGraph = vi.fn<() => Promise<BeadsTaskGraph>>();
const mockBeadsClose = vi.fn();
const mockBeadsReopen = vi.fn();
const mockBeadsComment = vi.fn();
const mockBeadsCreate = vi.fn();
const mockBeadsListComments = vi.fn();

vi.stubGlobal('window', {
  api: {
    provider: {
      detectBeads: mockDetectBeads,
      getTaskGraph: mockGetTaskGraph,
      beadsClose: mockBeadsClose,
      beadsReopen: mockBeadsReopen,
      beadsComment: mockBeadsComment,
      beadsCreate: mockBeadsCreate,
      beadsListComments: mockBeadsListComments,
    },
    events: {
      onWatch: vi.fn(() => () => {}),
    },
  },
});

let _activeId: string | null = 'project-a';

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: {
    provider: {
      detectBeads: (...args: unknown[]) => mockDetectBeads(...args),
      getTaskGraph: (...args: unknown[]) => mockGetTaskGraph(...args),
      beadsClose: (...args: unknown[]) => mockBeadsClose(...args),
      beadsReopen: (...args: unknown[]) => mockBeadsReopen(...args),
      beadsComment: (...args: unknown[]) => mockBeadsComment(...args),
      beadsCreate: (...args: unknown[]) => mockBeadsCreate(...args),
      beadsListComments: (...args: unknown[]) => mockBeadsListComments(...args),
    },
    events: {
      onWatch: vi.fn(() => () => {}),
    },
  },
  useProjectsStore: Object.assign(
    (selector: (s: { activeId: string | null }) => unknown) => selector({ activeId: _activeId }),
    {
      getState: () => ({ activeId: _activeId }),
    },
  ),
}));

import { useBeadsStore } from './beadsStore';

const GRAPH_A: BeadsTaskGraph = {
  source: { kind: 'jsonl', path: '.beads/issues.jsonl' },
  schemaCompatible: true,
  issues: [
    {
      id: 'a1',
      title: 'Task A',
      body: '',
      status: 'open',
      priority: 2,
      issueType: 'task',
      labels: [],
      externalRef: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
  deps: [],
};

const GRAPH_B: BeadsTaskGraph = {
  ...GRAPH_A,
  issues: [{ ...GRAPH_A.issues[0]!, id: 'b1', title: 'Task B' }],
};

function resetStore(): void {
  useBeadsStore.setState({ byProject: {} });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  _activeId = 'project-a';
});

describe('beadsStore byProject slices (T4)', () => {
  it('loads the graph into the addressed project slice (reads addressed by id)', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValue(GRAPH_A);

    await useBeadsStore.getState().load('project-a');

    const slice = useBeadsStore.getState().byProject['project-a']!;
    expect(slice.graph).toEqual(GRAPH_A);
    expect(slice.error).toBeNull();
    expect(mockDetectBeads).toHaveBeenCalledWith('project-a');
    expect(mockGetTaskGraph).toHaveBeenCalledWith('project-a');
  });

  it('isolates graphs per project (no cross-project bleed)', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A).mockResolvedValueOnce(GRAPH_B);

    await useBeadsStore.getState().load('project-a');
    await useBeadsStore.getState().load('project-b');

    expect(useBeadsStore.getState().byProject['project-a']!.graph).toEqual(GRAPH_A);
    expect(useBeadsStore.getState().byProject['project-b']!.graph).toEqual(GRAPH_B);
  });

  it('drops a stale resolution when the slice was evicted mid-load', async () => {
    mockDetectBeads.mockResolvedValue(true);
    let resolveGraph!: (v: BeadsTaskGraph) => void;
    mockGetTaskGraph.mockReturnValue(new Promise<BeadsTaskGraph>((r) => { resolveGraph = r; }));

    const loadPromise = useBeadsStore.getState().load('project-a');
    useBeadsStore.getState().evict('project-a');
    resolveGraph(GRAPH_A);
    await loadPromise;

    expect(useBeadsStore.getState().byProject['project-a']).toBeUndefined();
  });

  it('sets an error when no graph is held and the read fails', async () => {
    mockDetectBeads.mockRejectedValue(new Error('connect failed'));

    await useBeadsStore.getState().load('project-a');

    const slice = useBeadsStore.getState().byProject['project-a']!;
    expect(slice.graph).toBeNull();
    expect(slice.error).toBeTruthy();
  });

  it('keeps last-good graph on transient error for the same project (no flap)', async () => {
    useBeadsStore.setState({
      byProject: {
        'project-a': { graph: GRAPH_A, loading: false, error: null, selectedId: null, view: 'flat' },
      },
    });
    mockDetectBeads.mockRejectedValue(new Error('transient SQLITE_BUSY'));

    await useBeadsStore.getState().load('project-a');

    const slice = useBeadsStore.getState().byProject['project-a']!;
    expect(slice.graph).toEqual(GRAPH_A);
    expect(slice.error).toBeNull();
  });
});

describe('beadsStore per-project selection memory (focus)', () => {
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

  it('does not bleed the selected task across projects', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    useBeadsStore.getState().select('project-a', 'a1');
    expect(useBeadsStore.getState().byProject['project-a']!.selectedId).toBe('a1');

    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_B);
    await useBeadsStore.getState().load('project-b');
    expect(useBeadsStore.getState().byProject['project-b']!.selectedId).toBeNull();
  });

  it('restores the per-project selection on reload when still present', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    useBeadsStore.getState().select('project-a', 'a1');

    // Drop the in-memory slice; a fresh load restores selection from focus.
    useBeadsStore.getState().evict('project-a');
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    expect(useBeadsStore.getState().byProject['project-a']!.selectedId).toBe('a1');
  });

  it('drops a saved selection that no longer exists in the freshly loaded graph', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    useBeadsStore.getState().select('project-a', 'a1');

    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_B);
    await useBeadsStore.getState().load('project-a');
    expect(useBeadsStore.getState().byProject['project-a']!.selectedId).toBeNull();
  });

  it('persists + restores the focus anchor per project, dropping a stale one (FA-5)', async () => {
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    useBeadsStore.getState().setFocus('project-a', 'a1');
    expect(useBeadsStore.getState().byProject['project-a']!.focusId).toBe('a1');

    // Drop the in-memory slice; a fresh load restores focus from persistence.
    useBeadsStore.getState().evict('project-a');
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    await useBeadsStore.getState().load('project-a');
    expect(useBeadsStore.getState().byProject['project-a']!.focusId).toBe('a1');

    // A graph that no longer contains the focused id clears focus.
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_B);
    await useBeadsStore.getState().load('project-a');
    expect(useBeadsStore.getState().byProject['project-a']!.focusId).toBeNull();
  });
});

describe('beadsStore clearForDisconnect / evict (D3/FR4/FR7)', () => {
  it('clearForDisconnect() resets the slice but keeps the key', () => {
    useBeadsStore.setState({
      byProject: {
        'project-a': { graph: GRAPH_A, loading: false, error: null, selectedId: 'a1', view: 'flat' },
      },
    });
    useBeadsStore.getState().clearForDisconnect('project-a');
    const slice = useBeadsStore.getState().byProject['project-a']!;
    expect(slice.graph).toBeNull();
    expect(slice.loading).toBe(false);
    expect(slice.error).toBeNull();
  });

  it('evict() deletes the slice key entirely', () => {
    useBeadsStore.setState({
      byProject: {
        'project-a': { graph: GRAPH_A, loading: false, error: null, selectedId: null, view: 'flat' },
      },
    });
    useBeadsStore.getState().evict('project-a');
    expect(useBeadsStore.getState().byProject['project-a']).toBeUndefined();
  });
});

describe('beadsStore write actions (FA-6b)', () => {
  it('beadsClose calls the provider then reloads the graph, returning null on success', async () => {
    mockBeadsClose.mockResolvedValueOnce(undefined);
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    const err = await useBeadsStore.getState().beadsClose('project-a', 'a1', 'done');
    expect(err).toBeNull();
    expect(mockBeadsClose).toHaveBeenCalledWith('a1', 'done', 'project-a');
    expect(mockGetTaskGraph).toHaveBeenCalled(); // reloaded
    expect(useBeadsStore.getState().byProject['project-a']!.graph).toEqual(GRAPH_A);
  });

  it('returns br’s message (stripped of IPC noise) and does NOT reload on failure', async () => {
    mockBeadsReopen.mockRejectedValueOnce(
      new Error("Error invoking remote method 'provider:beads-reopen': Error: no such issue"),
    );
    const err = await useBeadsStore.getState().beadsReopen('project-a', 'nope');
    expect(err).toBe('no such issue');
    expect(mockGetTaskGraph).not.toHaveBeenCalled();
  });

  it('beadsComment does not reload the graph (comments are not graph shape)', async () => {
    mockBeadsComment.mockResolvedValueOnce(undefined);
    const err = await useBeadsStore.getState().beadsComment('project-a', 'a1', 'hello');
    expect(err).toBeNull();
    expect(mockBeadsComment).toHaveBeenCalledWith('a1', 'hello', 'project-a');
    expect(mockGetTaskGraph).not.toHaveBeenCalled();
  });

  it('beadsCreate reloads on success', async () => {
    mockBeadsCreate.mockResolvedValueOnce('new-id');
    mockDetectBeads.mockResolvedValue(true);
    mockGetTaskGraph.mockResolvedValueOnce(GRAPH_A);
    const err = await useBeadsStore.getState().beadsCreate('project-a', { title: 'T', parent: 'a1', priority: 2 });
    expect(err).toBeNull();
    expect(mockBeadsCreate).toHaveBeenCalledWith({ title: 'T', parent: 'a1', priority: 2 }, 'project-a');
    expect(mockGetTaskGraph).toHaveBeenCalled();
  });

  it('beadsListComments returns {comments,error}; error captured on failure', async () => {
    mockBeadsListComments.mockResolvedValueOnce([
      { id: 1, issueId: 'a1', author: 'me', text: 'hi', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    const ok = await useBeadsStore.getState().beadsListComments('project-a', 'a1');
    expect(ok.error).toBeNull();
    expect(ok.comments).toHaveLength(1);

    mockBeadsListComments.mockRejectedValueOnce(new Error('Error: db locked'));
    const bad = await useBeadsStore.getState().beadsListComments('project-a', 'a1');
    expect(bad.comments).toEqual([]);
    expect(bad.error).toBe('db locked');
  });
});
