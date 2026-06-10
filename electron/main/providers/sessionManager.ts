/**
 * SessionManager — owns one live WorkspaceProvider per project plus which
 * project is active. Every live session is fully live (background-live): there
 * is no warm/hot distinction and no `suspend()`/`resume()`. `activate()` only
 * records which project the panels render; backgrounded sessions keep receiving
 * watch events and serving reads. A session ends only by explicit `close()` or
 * idle age-out (separate proposal).
 *
 * Session-owned watch lifecycle: each session owns exactly one watch
 * subscription, started when it reaches `connected` and stopped when it ends.
 * Teardown fires on BOTH the provider's status->disconnected/failed transition
 * AND on eviction, because a plain `disconnect()` keeps the session in the map
 * and does NOT fire `onEviction` (the CLAUDE.md symmetric-teardown trap).
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
   * watch.subscribe from its activeId effect).
   */
  onWatch?: (projectId: string, event: WatchEvent) => void;
  /**
   * Clock for the per-session activity tracker (injected for testable idle
   * aging-out). Defaults to `Date.now`.
   */
  now?: () => number;
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
  setWatchListener(onWatch: (projectId: string, event: WatchEvent) => void): void {
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

  /** Stop the session's live watch if present. */
  private async stopWatch(projectId: string): Promise<void> {
    const entry = this.watchSubs.get(projectId);
    if (!entry) return;
    this.watchSubs.delete(projectId);
    try {
      await entry.sub.unsubscribe();
    } catch {
      /* best-effort teardown */
    }
  }

  /** Number of live watch subscriptions (NFR1 test seam: assert exactly N). */
  watchSubCount(): number {
    return this.watchSubs.size;
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
    for (const id of [...this.watchSubs.keys()]) await this.stopWatch(id);
    this.lastState.clear();
    for (const id of [...this.statusOff.keys()]) this.unwireStatus(id);
    this.activeId = null;
    await Promise.all(all.map((p) => p.disconnect()));
  }
}
