/**
 * SessionManager — owns one live WorkspaceProvider per project plus which
 * project is active. Every live session is fully live (background-live): there
 * is no warm/hot distinction and no `suspend()`/`resume()`. `activate()` only
 * records which project the panels render; backgrounded sessions keep receiving
 * watch events and serving reads. A session ends only by explicit `close()` or
 * idle age-out (separate proposal).
 *
 * Session-owned watch lifecycle: each session owns exactly one PRIMARY watch
 * subscription, started when it reaches `connected` and stopped when it ends.
 * Teardown fires on BOTH the provider's status->disconnected/failed transition
 * AND on eviction, because a plain `disconnect()` keeps the session in the map
 * and does NOT fire `onEviction` (the CLAUDE.md symmetric-teardown trap).
 *
 * A session may ALSO own at most one EXTRA, lazily-established watch rooted at
 * the project's active worktree, IFF that worktree is external to the project
 * root (local_repo_explorer-g1je) — see `setActiveWorktree`'s doc comment.
 * This is never an eager fanout across every known worktree: a worktree's
 * extra watch follows the active SELECTION, not the worktree LIST, mirroring
 * this class's own "liveness is lazy" principle for sessions themselves.
 */
import type {
  ConnectionSpec,
  ConnectionStatus,
  WatchEvent,
  WatchSubscription,
  WorkspaceProvider,
} from './types';
import type { ProviderRegistry } from './registry';

export interface SessionManagerDeps {
  /** Resolve a project's connection spec (defaults to the SQLite project store). */
  loadSpec: (projectId: string) => ConnectionSpec | null;
  /** Persist the active project id (defaults to the SQLite project store). */
  persistActive: (projectId: string | null) => void;
  /**
   * Forward a provider's connection status to the renderer. Wired in open()
   * BEFORE connect so the first connecting/connected transition is delivered.
   */
  onStatus?: (projectId: string, status: ConnectionStatus) => void;
  /**
   * Forward a live session's watch events to the renderer, tagged with the
   * originating projectId. The session lifecycle owns one watch per live
   * session; this delivers its events (the renderer no longer drives
   * watch.subscribe from its activeId effect). `worktreePath` is present only
   * for an event from the EXTRA active-external-worktree watch (see
   * `setActiveWorktree`) — absent (undefined) for the primary watch's events,
   * exactly as before this parameter was added.
   */
  onWatch?: (projectId: string, event: WatchEvent, worktreePath?: string) => void;
  /**
   * Clock for the per-session activity tracker (injected for testable idle
   * aging-out). Defaults to `Date.now`.
   */
  now?: () => number;
}

/** Strip a trailing slash (except a bare `/`), for stable path comparison. */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Whether `path` is EXTERNAL to `base` — neither `base` itself nor nested
 * under it. Both must already be normalized (stripTrailingSlash) by the
 * caller. Mirrors `FoldingView.tsx`'s `toRootRelativePath` classification of
 * a worktree relative to the project root, applied here to decide whether the
 * active worktree needs its OWN extra watch subscription at all.
 */
function isExternalPath(path: string, base: string): boolean {
  return path !== base && !path.startsWith(`${base}/`);
}

export class SessionManager {
  private sessions = new Map<string, WorkspaceProvider>();
  /** Per-session status-subscription disposers, so re-creating a provider
   *  (reconnect) and evicting one (close/failed connect) never leaks listeners. */
  private statusOff = new Map<string, () => void>();
  private activeId: string | null = null;
  /** Listeners called when a provider is evicted for a project (disconnect/
   *  reconnect/close/failed-connect). The IPC layer uses this to dispose its
   *  tmuxControl/tmuxDisposers/termDisposers caches for the pid, ensuring a
   *  reconnected provider always wires fresh subscriptions (fixes D2). */
  private evictionListeners = new Set<(projectId: string) => void>();
  /**
   * Per-session last-activity timestamp (epoch ms), keyed by projectId. Runtime
   * only (not persisted) — it drives idle aging-out (see sessionReaper.ts).
   * Seeded on open() and refreshed on focus / background %output via touch().
   */
  private activityAt = new Map<string, number>();
  /**
   * Per-session live watch subscription, keyed by `(projectId, token)`. Keying
   * by project (not token alone) is about lifecycle ownership: main can start
   * and stop a session's watch independent of `activeId`. At most one live watch
   * exists per session at a time. Exposed size for the NFR1 test seam.
   */
  private watchSubs = new Map<string, { token: string; sub: WatchSubscription }>();
  /**
   * Per-session EXTRA watch subscription rooted at the active worktree, keyed
   * by projectId — present only while that project's active worktree is
   * EXTERNAL to the project root (see `setActiveWorktree`). At most one entry
   * per project, mirroring `watchSubs`'s own per-session bound.
   */
  private worktreeWatchSubs = new Map<string, { path: string; token: string; sub: WatchSubscription }>();
  /**
   * Monotonic per-project call sequence for `setActiveWorktree`, guarding
   * against an in-flight `subscribeWorktreeWatch` resolving after a NEWER
   * call already changed the desired target (rapid worktree switching) — the
   * worktree-watch analog of `startWatch`'s `sessions.get(projectId) !==
   * provider` guard, extended to also cover a superseding call for the same
   * still-live session.
   */
  private worktreeWatchSeq = new Map<string, number>();
  /** Per-session last-known connection state, so we only start a watch on the
   *  EDGE into `connected` and only tear down on the edge into a terminal
   *  state — not on every repeated status emission. */
  private lastState = new Map<string, ConnectionStatus['state']>();
  private readonly now: () => number;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly deps: SessionManagerDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Install (or replace) the status listener after construction. SessionManager
   * is a module singleton built before the IPC `send` exists, so the renderer
   * forwarder is wired in here from registerIpc rather than via the constructor.
   * Re-subscribes any already-open sessions and pushes their current status so
   * the renderer gets a value even for sessions opened before the listener set.
   */
  setStatusListener(onStatus: (projectId: string, status: ConnectionStatus) => void): void {
    this.deps.onStatus = onStatus;
    for (const [projectId, provider] of this.sessions) {
      this.unwireStatus(projectId);
      const off = provider.onStatusChange((status) => this.handleStatus(projectId, status));
      this.statusOff.set(projectId, off);
      this.handleStatus(projectId, provider.status());
    }
  }

  /** Install (or replace) the watch-event forwarder after construction (mirrors
   *  setStatusListener: the IPC `send` does not exist at module-singleton build
   *  time). */
  setWatchListener(
    onWatch: (projectId: string, event: WatchEvent, worktreePath?: string) => void,
  ): void {
    this.deps.onWatch = onWatch;
  }

  /**
   * Single funnel for every provider status emission. Forwards to the renderer
   * (onStatus) and drives the session-owned watch lifecycle on state EDGES:
   * start the watch when a session enters `connected`, stop it when it enters
   * `disconnected`/`failed`. Edge-gated via lastState so repeated emissions of
   * the same state do not start duplicate watchers or tear a live one down.
   */
  private handleStatus(projectId: string, status: ConnectionStatus): void {
    const prev = this.lastState.get(projectId);
    this.lastState.set(projectId, status.state);
    this.deps.onStatus?.(projectId, status);
    if (status.state === 'connected') {
      if (prev !== 'connected') void this.startWatch(projectId);
    } else if (status.state === 'disconnected' || status.state === 'failed') {
      void this.stopWatch(projectId);
    }
  }

  /** Start the session's single live watch (idempotent: a session that already
   *  has a watch is left untouched). */
  private async startWatch(projectId: string): Promise<void> {
    if (this.watchSubs.has(projectId)) return;
    const provider = this.sessions.get(projectId);
    if (!provider) return;
    try {
      const sub = await provider.subscribeWatch(['.'], (event) =>
        this.deps.onWatch?.(projectId, event),
      );
      // The session may have ended while subscribeWatch was in flight; if so,
      // unsubscribe immediately rather than leaking a watcher.
      if (this.sessions.get(projectId) !== provider) {
        void sub.unsubscribe();
        return;
      }
      this.watchSubs.set(projectId, { token: sub.token, sub });
    } catch {
      // Watch is best-effort; a provider that cannot subscribe (e.g. dropped
      // mid-provision) just has no live feed until reconnect.
    }
  }

  /**
   * Stop the session's live watch(es) if present — BOTH the primary watch AND
   * any extra active-worktree watch (local_repo_explorer-g1je). Folding the
   * worktree-watch teardown in here (rather than requiring every caller to
   * remember a second call) is what makes teardown symmetric everywhere this
   * already runs: the status->disconnected/failed edge (`handleStatus`),
   * `notifyEviction` (disconnect/reconnect/close/failed-connect), and
   * `closeAll` — see this repo's CLAUDE.md symmetric-teardown invariant. Do
   * NOT split this back into two independently-called teardown paths.
   */
  private async stopWatch(projectId: string): Promise<void> {
    const entry = this.watchSubs.get(projectId);
    if (entry) {
      this.watchSubs.delete(projectId);
      try {
        await entry.sub.unsubscribe();
      } catch {
        /* best-effort teardown */
      }
    }
    await this.stopWorktreeWatch(projectId);
  }

  /** Stop the session's extra active-worktree watch if present. */
  private async stopWorktreeWatch(projectId: string): Promise<void> {
    const entry = this.worktreeWatchSubs.get(projectId);
    if (!entry) return;
    this.worktreeWatchSubs.delete(projectId);
    try {
      await entry.sub.unsubscribe();
    } catch {
      /* best-effort teardown */
    }
  }

  /**
   * Tell the session which worktree is currently active for `projectId` — the
   * renderer (`panelDataSync`, following `worktreeStore`'s selection) is the
   * SINGLE driver of this; main has no other way to learn the selection and
   * keeps no independent "desired worktree" cache of its own beyond the
   * bookkeeping needed to (de)establish the subscription itself. Establishes
   * a LAZY, at-most-ONE extra watch subscription rooted at `worktreePath`,
   * IFF it is EXTERNAL to the project root (neither the root itself nor
   * nested under it — a nested worktree's files are already observable
   * through the primary root-rooted watch, so a second subscription there
   * would be redundant). `worktreePath: null` (no worktree selected, or the
   * selection is the root/nested-under-root) tears down any existing extra
   * subscription and establishes nothing.
   *
   * Same-target calls are a no-op. A call for a session that is not currently
   * live (no cached provider — e.g. a disconnected/not-yet-opened project)
   * tears down any existing subscription but establishes nothing; a LATER
   * `setActiveWorktree` call (once the session is live) re-evaluates from
   * scratch, so a selection made before connect is not silently lost forever
   * — but it IS the renderer's responsibility to re-send it (which
   * `panelDataSync`'s transition-diff naturally does on the session's own
   * connect-triggered `loadWorktrees`).
   */
  async setActiveWorktree(projectId: string, worktreePath: string | null): Promise<void> {
    const normalizedNew = worktreePath ? stripTrailingSlash(worktreePath) : null;
    const existing = this.worktreeWatchSubs.get(projectId);
    if ((existing?.path ?? null) === normalizedNew) return; // already exactly this target (or already none)

    const seq = (this.worktreeWatchSeq.get(projectId) ?? 0) + 1;
    this.worktreeWatchSeq.set(projectId, seq);

    // A new target always invalidates whatever worktree sub currently exists
    // for this project — including "switch to a different external worktree"
    // and "switch back to the root/nested" (which needs no sub at all).
    await this.stopWorktreeWatch(projectId);

    if (normalizedNew === null) return;

    const spec = this.deps.loadSpec(projectId);
    if (!spec) return; // unknown project; nothing to compare the target against
    const base = stripTrailingSlash(spec.kind === 'local' ? spec.rootPath : spec.remotePath);
    if (!isExternalPath(normalizedNew, base)) return; // root or nested-under-root: no extra watch needed

    const provider = this.sessions.get(projectId);
    if (!provider) return; // session not live; nothing to subscribe to yet

    try {
      const sub = await provider.subscribeWorktreeWatch(normalizedNew, (event) =>
        this.deps.onWatch?.(projectId, event, normalizedNew),
      );
      // The session may have been evicted, or a NEWER setActiveWorktree call
      // may have already superseded this one, while subscribeWorktreeWatch
      // was in flight; if so, unsubscribe immediately rather than leaking a
      // watcher or clobbering the newer call's own result.
      const stillCurrent =
        this.sessions.get(projectId) === provider && this.worktreeWatchSeq.get(projectId) === seq;
      if (!stillCurrent) {
        void sub.unsubscribe();
        return;
      }
      this.worktreeWatchSubs.set(projectId, { path: normalizedNew, token: sub.token, sub });
    } catch {
      // Best-effort, mirrors startWatch: a provider that cannot subscribe
      // (e.g. dropped mid-request) just has no live worktree feed until the
      // next setActiveWorktree call re-attempts it.
    }
  }

  /** Number of live PRIMARY watch subscriptions (NFR1 test seam: assert
   *  exactly N). */
  watchSubCount(): number {
    return this.watchSubs.size;
  }

  /** Number of live EXTRA active-worktree watch subscriptions (test seam,
   *  mirrors `watchSubCount`). */
  worktreeWatchSubCount(): number {
    return this.worktreeWatchSubs.size;
  }

  /**
   * Subscribe to provider eviction events. Called immediately before a provider
   * is evicted (disconnected and removed from the session map). The IPC layer
   * uses this to dispose its per-pid tmuxControl/tmuxDisposers/termDisposers
   * caches so a reconnected provider always wires fresh subscriptions (D2).
   * Returns an unsubscribe function.
   */
  onEviction(listener: (projectId: string) => void): () => void {
    this.evictionListeners.add(listener);
    return () => this.evictionListeners.delete(listener);
  }

  /** Drop a session's status subscription if present. */
  private unwireStatus(projectId: string): void {
    const off = this.statusOff.get(projectId);
    if (off) {
      off();
      this.statusOff.delete(projectId);
    }
  }

  /** Notify all eviction listeners for a project. Also stops the session's
   *  watch: close()/reconnect()/failed-connect evict but a plain disconnect()
   *  does not, so the watch is torn down on BOTH eviction (here) and the
   *  status->disconnected/failed edge (handleStatus) — the CLAUDE.md
   *  symmetric-teardown invariant. */
  private notifyEviction(projectId: string): void {
    void this.stopWatch(projectId);
    this.lastState.delete(projectId);
    // Bounded bookkeeping cleanup (mirrors lastState.delete above): an
    // evicted project's setActiveWorktree call sequence has no further use.
    this.worktreeWatchSeq.delete(projectId);
    for (const l of this.evictionListeners) l(projectId);
  }

  /** Create (if needed) and connect a project's provider without activating it. */
  async open(projectId: string): Promise<WorkspaceProvider> {
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const spec = this.deps.loadSpec(projectId);
    if (!spec) throw new Error(`no project/connection spec for '${projectId}'`);
    const provider = this.registry.create({ projectId, spec });
    this.sessions.set(projectId, provider);
    // Seed the activity clock so a freshly-opened session has a baseline (no
    // separate openedAt) and is not immediately reapable as "idle since 0".
    this.touch(projectId);
    // Subscribe to status BEFORE connect so the first connecting->connected
    // transition is delivered (the prior wire-after-connect ordering dropped it,
    // leaving the UI stuck on 'disconnected'). Replace any prior subscription.
    this.unwireStatus(projectId);
    // Always wire the status funnel (even when no renderer onStatus is set yet),
    // because handleStatus also drives the session-owned watch lifecycle.
    const off = provider.onStatusChange((status) => this.handleStatus(projectId, status));
    this.statusOff.set(projectId, off);
    // Push the current status immediately so the renderer has a value even if no
    // further transition occurs before it subscribes, and so a provider that is
    // already connected (local short-circuit) starts its watch.
    this.handleStatus(projectId, provider.status());
    try {
      await provider.connect();
    } catch (err) {
      // A failed connect must NOT leave a dead provider cached: otherwise the
      // next open()/activate() (e.g. the Reconnect button) returns the
      // never-connected instance via the `existing` short-circuit and silently
      // does nothing. Evict so a retry rebuilds and reconnects with the current
      // spec (and re-runs remote helper provisioning).
      this.notifyEviction(projectId);
      this.sessions.delete(projectId);
      this.unwireStatus(projectId);
      try {
        await provider.disconnect();
      } catch {
        /* best-effort cleanup of a partially-connected provider */
      }
      throw err;
    }
    // Every live session is fully live (no warm/hot distinction). The watch is
    // started by handleStatus when the provider reaches `connected`.
    return provider;
  }

  /**
   * Record `projectId` as the active project (the slice the panels render and
   * the default target for omitted-projectId reads). Backgrounded sessions stay
   * fully live — there is no suspend/resume.
   */
  async activate(projectId: string): Promise<WorkspaceProvider> {
    const provider = await this.open(projectId);
    this.activeId = projectId;
    this.deps.persistActive(projectId);
    return provider;
  }

  get(projectId: string): WorkspaceProvider | undefined {
    return this.sessions.get(projectId);
  }

  /**
   * Per-session connection status — the ConnectionMachine-backed truth via the
   * provider. The idle reaper reads this (never the renderer tmuxStore enum) so
   * connection state stays single-owner (CLAUDE.md). Undefined if no session.
   */
  statusOf(projectId: string): ConnectionStatus | undefined {
    return this.sessions.get(projectId)?.status();
  }

  /** Record activity for a session (focus, seed, or background %output). */
  touch(projectId: string): void {
    this.activityAt.set(projectId, this.now());
  }

  /** Last-activity timestamp (epoch ms) for a session, or undefined if none. */
  activityOf(projectId: string): number | undefined {
    return this.activityAt.get(projectId);
  }

  getActive(): WorkspaceProvider | undefined {
    return this.activeId ? this.sessions.get(this.activeId) : undefined;
  }

  activeProjectId(): string | null {
    return this.activeId;
  }

  listOpen(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Disconnect a project's provider but KEEP it selected (activeId unchanged).
   * The project remains in the session map in a disconnected state. This is
   * distinct from close(), which evicts the session and clears activeId.
   * Status events propagate via the provider's onStatusChange.
   */
  async disconnect(projectId: string): Promise<void> {
    const p = this.sessions.get(projectId);
    if (!p) return;
    await p.disconnect();
  }

  /**
   * Evict any cached provider for projectId and reconnect from scratch (re-runs
   * helper provisioning). Keeps activeId = projectId throughout. The provider
   * emits status events during the reconnect sequence (connecting -> connected).
   */
  async reconnect(projectId: string): Promise<WorkspaceProvider> {
    const existing = this.sessions.get(projectId);
    if (existing) {
      this.notifyEviction(projectId);
      this.sessions.delete(projectId);
      this.unwireStatus(projectId);
      try {
        await existing.disconnect();
      } catch {
        /* best-effort cleanup */
      }
    }
    // activate() calls open() which creates a fresh provider and connects it
    // (re-provisions remote helper) and records it as the active session.
    return this.activate(projectId);
  }

  /**
   * Disconnect and drop a single session (keeps others intact).
   *
   * `detail` lets a caller annotate the resulting `disconnected` status — the
   * idle reaper passes a distinct aged-out cue so the renderer can tell an
   * automatic age-out apart from a network drop. close() unwires the provider's
   * status forwarder before `disconnect()` (so the provider's own undetailed
   * `disconnected` transition never reaches the renderer); when a detail is
   * given we forward a final annotated `disconnected` status first.
   */
  async close(projectId: string, detail?: string): Promise<void> {
    const p = this.sessions.get(projectId);
    if (!p) return;
    if (detail && this.deps.onStatus) {
      this.deps.onStatus(projectId, { state: 'disconnected', detail, since: new Date().toISOString() });
    }
    this.notifyEviction(projectId);
    this.sessions.delete(projectId);
    this.activityAt.delete(projectId);
    this.unwireStatus(projectId);
    if (this.activeId === projectId) {
      this.activeId = null;
      this.deps.persistActive(null);
    }
    await p.disconnect();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    this.activityAt.clear();
    // Union of both watch maps' keys: a project can in principle hold an
    // extra worktree-watch subscription with no primary watch sub (e.g. the
    // primary subscribeWatch failed best-effort while setActiveWorktree still
    // succeeded), so iterating watchSubs alone would leak that project's
    // worktree watch on shutdown — stopWatch tears down both per project.
    const watchProjectIds = new Set([...this.watchSubs.keys(), ...this.worktreeWatchSubs.keys()]);
    for (const id of watchProjectIds) await this.stopWatch(id);
    this.lastState.clear();
    this.worktreeWatchSeq.clear();
    for (const id of [...this.statusOff.keys()]) this.unwireStatus(id);
    this.activeId = null;
    await Promise.all(all.map((p) => p.disconnect()));
  }
}
