import { create } from 'zustand';
import type { BeadsComment, BeadsCreateInput, BeadsTaskGraph } from '@shared/ipc/channels';
import { agentCockpit, useProjectsStore } from '../providerClient';
import { readFocus, writeFocus } from '@renderer/workspace/focusMemory';

/** Strip Electron's IPC wrapper noise from a thrown error so the inline message
 *  shows br's own text (FA-6 / D-2: error message string inline). */
function writeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error:\s*)+/, '')
    .trim();
}

/** Structural equality of two task graphs for refresh dedupe. Compares issue
 *  count + each issue's mutable fields and the dependency edge set; cheap enough
 *  to run on every refresh and avoids re-rendering on a no-op reload. */
function sameGraph(a: BeadsTaskGraph, b: BeadsTaskGraph): boolean {
  if (a.issues.length !== b.issues.length || a.deps.length !== b.deps.length) return false;
  for (let i = 0; i < a.issues.length; i += 1) {
    const x = a.issues[i]!;
    const y = b.issues[i]!;
    if (
      x.id !== y.id ||
      x.status !== y.status ||
      x.title !== y.title ||
      x.priority !== y.priority ||
      x.issueType !== y.issueType ||
      x.updatedAt !== y.updatedAt
    ) {
      return false;
    }
  }
  for (let i = 0; i < a.deps.length; i += 1) {
    const x = a.deps[i]!;
    const y = b.deps[i]!;
    if (x.from !== y.from || x.to !== y.to || x.type !== y.type) return false;
  }
  return true;
}

/** Flat status-grouped list, focused dependency-graph, or parent-child tree. */
export type WorkgraphView = 'flat' | 'graph' | 'tree';

const VIEW_VERSION = 1;
const viewKey = (projectId: string): string =>
  `agent-cockpit:workgraph-view:v${VIEW_VERSION}:${projectId}`;

const VIEWS: readonly WorkgraphView[] = ['flat', 'graph', 'tree'];
function isView(v: string | null): v is WorkgraphView {
  return v != null && (VIEWS as readonly string[]).includes(v);
}

/** Reads the persisted view for a project; defaults to flat. localStorage is
 *  guarded so a renderer without it (or a denied access) falls back cleanly. */
function readView(projectId: string | null): WorkgraphView {
  if (!projectId) return 'flat';
  try {
    const stored = localStorage.getItem(viewKey(projectId));
    return isView(stored) ? stored : 'flat';
  } catch {
    return 'flat';
  }
}

function writeView(projectId: string | null, view: WorkgraphView): void {
  if (!projectId) return;
  try {
    localStorage.setItem(viewKey(projectId), view);
  } catch {
    // Persistence is best-effort; ignore quota/access failures.
  }
}

/**
 * One project's Beads workgraph state. `view` holds the live value; localStorage
 * remains the durable per-project store (persistence is NOT moved into the
 * slice). Every read is addressed by the slice's `projectId`.
 */
export interface BeadsSlice {
  graph: BeadsTaskGraph | null;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  /** Tree/graph focus anchor (FA-5). Persisted per project via `wg-focus`;
   *  null = not focused. Sticky across project switches and app restarts. */
  focusId: string | null;
  view: WorkgraphView;
}

function emptySlice(projectId: string | null): BeadsSlice {
  return {
    graph: null,
    loading: false,
    error: null,
    selectedId: null,
    focusId: readFocus('wg-focus', projectId),
    view: readView(projectId),
  };
}

/**
 * Renderer Beads workgraph store, keyed per project (`byProject`). Each live
 * session owns an isolated slice resident until the session ends, so a switch
 * renders the selected project's graph instantly and never bleeds another
 * project's tasks (FR1–FR3). Every IPC call lives inside an action so the store
 * can be exercised with a faked `window.api` in tests.
 */
interface BeadsState {
  byProject: Record<string, BeadsSlice>;
  load: (projectId: string) => Promise<void>;
  select: (projectId: string, id: string | null) => void;
  /** Set (or clear, with null) the tree/graph focus anchor for a project. */
  setFocus: (projectId: string, id: string | null) => void;
  setView: (projectId: string, view: WorkgraphView) => void;
  // Beads writes (FA-6b). Each calls the provider's `br` seam, then reloads the
  // graph on success so the view reflects the change. Mutations resolve to an
  // error string (null = success) so the UI can render it inline (D-2); reads
  // resolve to a { comments, error } pair.
  beadsClose: (projectId: string, issueId: string, reason?: string) => Promise<string | null>;
  beadsReopen: (projectId: string, issueId: string) => Promise<string | null>;
  beadsComment: (projectId: string, issueId: string, message: string) => Promise<string | null>;
  beadsCreate: (projectId: string, input: BeadsCreateInput) => Promise<string | null>;
  beadsListComments: (
    projectId: string,
    issueId: string,
  ) => Promise<{ comments: BeadsComment[]; error: string | null }>;
  /** Reset a project's slice to the disconnected (empty) state, keeping the key
   *  so its panel shows an explicit disconnected affordance (FR4). */
  clearForDisconnect: (projectId: string) => void;
  /** Delete a project's slice entirely (the project was removed) (FR7). */
  evict: (projectId: string) => void;
}

export const useBeadsStore = create<BeadsState>((set, get) => {
  const patch = (projectId: string, p: Partial<BeadsSlice>): void =>
    set((s) => ({
      byProject: {
        ...s.byProject,
        [projectId]: { ...(s.byProject[projectId] ?? emptySlice(projectId)), ...p },
      },
    }));

  return {
    byProject: {},

    load: async (projectId) => {
      // Restore the per-project view on every (re)load.
      patch(projectId, { view: readView(projectId), loading: true, error: null });
      try {
        const present = await agentCockpit.provider.detectBeads(projectId);
        // Stale-resolution guard: discard if the slice was evicted mid-load.
        if (!get().byProject[projectId]) return;
        if (!present) {
          patch(projectId, { graph: null, loading: false, error: null, selectedId: null });
          return;
        }
        const graph = await agentCockpit.provider.getTaskGraph(projectId);
        if (!get().byProject[projectId]) return;
        // Content-dedupe backstop: if the freshly-read graph is identical to the
        // one we already hold, replace only the loading/error flags and KEEP the
        // existing graph object reference so subscribers don't re-render on a
        // no-op refresh (e.g. a spurious .beads watch event).
        const prev = get().byProject[projectId]?.graph ?? null;
        if (prev && sameGraph(prev, graph)) {
          patch(projectId, { loading: false, error: null });
        } else {
          // Restore the per-project selected task, but only if it still exists
          // in the freshly loaded graph; otherwise leave nothing selected.
          const saved = readFocus('wg-sel', projectId);
          const selectedId = saved && graph.issues.some((i) => i.id === saved) ? saved : null;
          // Restore the per-project focus anchor too, but only if it still
          // exists in the freshly loaded graph; otherwise drop focus.
          const savedFocus = readFocus('wg-focus', projectId);
          const focusId =
            savedFocus && graph.issues.some((i) => i.id === savedFocus) ? savedFocus : null;
          patch(projectId, { graph, loading: false, error: null, selectedId, focusId });
        }
      } catch (e) {
        if (!get().byProject[projectId]) return;
        // The main-side read is open-read-close against the live beads.db and
        // already retries transient SQLITE_BUSY/LOCKED. If a read still fails
        // while we already hold a graph for this project, this is almost always
        // a transient contention window: keep the last-good graph (no flap —
        // locked decision on local_repo_explorer-fg5z).
        if (get().byProject[projectId]?.graph) {
          patch(projectId, { loading: false, error: null });
        } else {
          patch(projectId, { loading: false, error: String(e) });
        }
      }
    },

    select: (projectId, id) => {
      writeFocus('wg-sel', projectId, id);
      patch(projectId, { selectedId: id });
    },

    setFocus: (projectId, id) => {
      writeFocus('wg-focus', projectId, id);
      patch(projectId, { focusId: id });
    },

    setView: (projectId, view) => {
      writeView(projectId, view);
      patch(projectId, { view });
    },

    beadsClose: async (projectId, issueId, reason) => {
      try {
        await agentCockpit.provider.beadsClose(issueId, reason, projectId);
        await get().load(projectId);
        return null;
      } catch (e) {
        return writeError(e);
      }
    },
    beadsReopen: async (projectId, issueId) => {
      try {
        await agentCockpit.provider.beadsReopen(issueId, projectId);
        await get().load(projectId);
        return null;
      } catch (e) {
        return writeError(e);
      }
    },
    beadsComment: async (projectId, issueId, message) => {
      try {
        await agentCockpit.provider.beadsComment(issueId, message, projectId);
        // No graph reload: comments don't change the graph shape. The caller
        // refreshes its comment list.
        return null;
      } catch (e) {
        return writeError(e);
      }
    },
    beadsCreate: async (projectId, input) => {
      try {
        await agentCockpit.provider.beadsCreate(input, projectId);
        await get().load(projectId);
        return null;
      } catch (e) {
        return writeError(e);
      }
    },
    beadsListComments: async (projectId, issueId) => {
      try {
        const comments = await agentCockpit.provider.beadsListComments(issueId, projectId);
        return { comments, error: null };
      } catch (e) {
        return { comments: [], error: writeError(e) };
      }
    },

    clearForDisconnect: (projectId) =>
      set((s) => ({ byProject: { ...s.byProject, [projectId]: emptySlice(projectId) } })),

    evict: (projectId) =>
      set((s) => {
        if (!(projectId in s.byProject)) return s;
        const next = { ...s.byProject };
        delete next[projectId];
        return { byProject: next };
      }),
  };
});

/** The active project's Beads slice (empty when none/cold), as a pure
 *  derivation of `(activeId, byProject)` — never another project's data. */
export function useActiveBeads(): BeadsSlice {
  const activeId = useProjectsStore((s) => s.activeId);
  return useBeadsStore((s) => (activeId ? s.byProject[activeId] : undefined) ?? EMPTY_SLICE);
}

const EMPTY_SLICE: BeadsSlice = emptySlice(null);
