/**
 * panelDataSync — the single orchestration module that keeps every live
 * session's per-project panel slices (Changes + Workgraph) current, driven by
 * per-session connection status + watch events (NOT panel focus or `activeId`).
 *
 * It is initialized exactly once (AppShell), replacing the scattered triggers
 * that previously lived on the `activeId`/connection effects in CockpitWorkspace
 * and the panel-mount `initChangesSync`/`initBeadsSync` wiring.
 *
 * Responsibilities:
 *  - On a project → `connected` (initial connect or reconnect): (re)load that
 *    project's Changes + Beads slices fresh. On → `disconnected`/`failed`: clear
 *    them to an explicit disconnected state. Driven by status, not focus (FR1,
 *    FR4) — a backgrounded project stays current.
 *  - On a watch event tagged with `projectId`: refresh that project's addressed
 *    slice by category (git-state → re-list worktrees; working-tree → changeset
 *    refresh; beads → graph reload), targeting reads with that `projectId`.
 *  - On an `activeWorktree` selection transition: refresh Changes AND project
 *    the new selection to main via `watch:set-active-worktree` — main has no
 *    other way to learn which worktree is active, and uses it to (de)establish
 *    the lazy, at-most-one-per-project active-external-worktree watch
 *    (`SessionManager.setActiveWorktree`, local_repo_explorer-g1je). This
 *    module owns no watch-subscription state of its own; it only forwards the
 *    selection `worktreeStore` already owns.
 *  - Evict a project's slices when it disappears from `projects.list()` (FR7).
 *
 * Connection truth flows only from the main `ConnectionMachine` via
 * `sessionStore` (CLAUDE.md NFR2): this module consumes status, never authors it.
 */
import { useChangesStore } from '@renderer/changes';
import { useBeadsStore } from '@renderer/beads';
import { useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { agentCockpit, useSessionStore, useProjectsStore } from '@renderer/providerClient';
import { subscribeWatch } from '@renderer/watch/hub';
import type { ConnectionState } from '@shared/providers/types';

/** (Re)list a project's worktrees. The resulting `activeWorktree` change is
 *  observed by the worktree subscription below, which drives the Changes
 *  refresh — so this owns "what worktrees exist", not "reload the changeset". */
function loadWorktrees(projectId: string): void {
  void useWorktreeStore.getState().loadWorktrees(projectId);
}

/** Load a project's slices fresh (on connect/reconnect). */
function loadProject(projectId: string): void {
  loadWorktrees(projectId);
  void useBeadsStore.getState().load(projectId);
}

/** Clear a project's slices to the disconnected state (status terminal). */
function clearProject(projectId: string): void {
  useWorktreeStore.getState().clearForDisconnect(projectId);
  useChangesStore.getState().clearForDisconnect(projectId);
  useBeadsStore.getState().clearForDisconnect(projectId);
}

/** Evict a project's slices entirely (the project was removed). */
function evictProject(projectId: string): void {
  useWorktreeStore.getState().evict(projectId);
  useChangesStore.getState().evict(projectId);
  useBeadsStore.getState().evict(projectId);
}

/**
 * Initialize the orchestrator. Idempotent per the subscriptions it owns; returns
 * an unsubscribe that detaches all of them. Call once at app start (AppShell).
 */
export function initPanelDataSync(): () => void {
  // ---- worktree selection → Changes refresh ----
  // The worktree store is the single owner of (worktrees, activeWorktree). A
  // selection change — the initial default from `loadWorktrees`, the user
  // picker, or terminal-cwd follow — must drive a Changes refresh, since
  // `worktreeStore.setWorktree` deliberately does not reach across stores.
  // Subscribe FIRST (before the status seed below can trigger a load) so the
  // initial connect's null→path transition is observed. `changesStore.refresh`
  // reads the active worktree from the worktree store, so the transition alone
  // is enough; a same-selection reload (branch switch) is refreshed explicitly
  // by the git-state watch path instead.
  const prevWorktree = new Map<string, string | null>();
  for (const [projectId, slice] of Object.entries(useWorktreeStore.getState().byProject)) {
    prevWorktree.set(projectId, slice.activeWorktree);
  }
  const offWorktree = useWorktreeStore.subscribe((s) => {
    const seen = new Set<string>();
    for (const [projectId, slice] of Object.entries(s.byProject)) {
      seen.add(projectId);
      const prev = prevWorktree.has(projectId) ? prevWorktree.get(projectId)! : null;
      if (prev === slice.activeWorktree) continue;
      prevWorktree.set(projectId, slice.activeWorktree);
      void useChangesStore.getState().refresh(projectId);
      // Project the selection to main on the SAME transition (local_repo_
      // explorer-g1je): main has no other way to learn which worktree is
      // active, and uses this to (de)establish the lazy, at-most-one-per-
      // project active-external-worktree watch (SessionManager.
      // setActiveWorktree). Folded into this existing subscription rather
      // than a second, parallel activeWorktree-diffing effect — one owning
      // site for "detect a worktree-selection transition", per this repo's
      // shared-behavior/no-duplicate-diffing-logic convention. Fires on
      // every transition, including to `null` (clearForDisconnect / evict).
      void agentCockpit.watch.setActiveWorktree(projectId, slice.activeWorktree);
    }
    // Drop bookkeeping for projects whose worktree slice was evicted.
    for (const projectId of [...prevWorktree.keys()]) {
      if (!seen.has(projectId)) prevWorktree.delete(projectId);
    }
  });

  // ---- per-session connection status ----
  // Diff the previous vs current per-project state on every status change so we
  // act only on EDGES: into `connected` → load; into a terminal state → clear.
  const prevState = new Map<string, ConnectionState>();
  // Seed from the current store snapshot so an already-connected session (e.g.
  // cold-boot restore that fired before we subscribed) is loaded once.
  for (const [projectId, status] of Object.entries(useSessionStore.getState().statuses)) {
    prevState.set(projectId, status.state);
    if (status.state === 'connected') loadProject(projectId);
  }

  const offStatus = useSessionStore.subscribe((s) => {
    for (const [projectId, status] of Object.entries(s.statuses)) {
      const prev = prevState.get(projectId);
      if (prev === status.state) continue;
      prevState.set(projectId, status.state);
      if (status.state === 'connected') {
        loadProject(projectId);
      } else if (status.state === 'disconnected' || status.state === 'failed') {
        clearProject(projectId);
      }
    }
  });

  // ---- watch events, routed by (projectId, category) ----
  const offWatch = subscribeWatch({
    interest: ['working-tree', 'git-state', 'beads'],
    onEvent: (event) => {
      const { projectId, categories } = event;
      if (!projectId) return;
      if (categories.includes('git-state')) {
        // Branch switch / commit alters the worktree branch + baseline. Re-list
        // worktrees, then refresh the changeset explicitly: the selected path
        // usually stays the same (no selection transition to observe), but its
        // underlying git state changed, so the changeset must reload.
        void useWorktreeStore
          .getState()
          .loadWorktrees(projectId)
          .then(() => useChangesStore.getState().refresh(projectId));
      } else if (categories.includes('working-tree')) {
        void useChangesStore.getState().refresh(projectId);
      }
      if (categories.includes('beads')) {
        void useBeadsStore.getState().load(projectId);
      }
    },
  });

  // ---- project removal eviction (diff projects.list()) ----
  // A projectId that disappears from the list → evict its slices; a projectId
  // going `disconnected` is handled by the status path above (clear, not evict).
  let knownIds = new Set(useProjectsStore.getState().projects.map((p) => p.id));
  const offProjects = useProjectsStore.subscribe((s) => {
    const nextIds = new Set(s.projects.map((p) => p.id));
    for (const id of knownIds) {
      if (!nextIds.has(id)) {
        evictProject(id);
        prevState.delete(id);
      }
    }
    knownIds = nextIds;
  });

  return () => {
    offWorktree();
    offStatus();
    offWatch();
    offProjects();
  };
}
