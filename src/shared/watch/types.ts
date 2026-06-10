/**
 * Shared filesystem-watch types. Pure TS, no Node dependencies, so this module
 * loads in both the main process and the renderer.
 *
 * These types are the vocabulary of the layered watch subsystem
 * (policy → mechanism → ingest → dispatch). See `policy.ts` for the single
 * source of "what to watch" and `docs/proposals/_active_watch-dispatch-layering.md`
 * for the layering rationale.
 */

/**
 * The classes of filesystem change the UI reacts to. Every watched path is
 * classified into exactly one category (or dropped). Subscribers declare which
 * categories they care about; they do not re-inspect raw paths.
 *
 * - `working-tree`: an ordinary file change that affects the git changeset.
 * - `git-state`: a branch switch / commit / ref update (`.git/HEAD`, refs).
 * - `beads`: a committed-write to the beads store (`beads.db`/`issues.jsonl`).
 */
export type WatchCategory = 'working-tree' | 'git-state' | 'beads';

/**
 * Serializable projection of the watch policy for transports that cannot import
 * the TS policy module directly — specifically the Go remote helper, which
 * receives this over the `watch.subscribe` RPC. It is **derived** from the
 * single policy via `deriveWatchSpec()`; it is not a second definition and it
 * is not user-configurable.
 */
/** A watched path tagged with its category by the ingest layer. */
export interface ClassifiedPath {
  /** Repo-relative POSIX path. */
  rel: string;
  category: WatchCategory;
}

/**
 * The canonical, normalized, classified, debounced event emitted by the ingest
 * layer (Layer 3) and disseminated by the dispatch layer (Layer 4). Both
 * transports (local + remote) produce this identical shape, so subscribers
 * never see transport- or mechanism-specific detail.
 */
export interface CanonicalWatchEvent {
  /** Distinct categories present in this batch (deduped). */
  categories: WatchCategory[];
  /** Every classified path in this coalesced batch. */
  paths: ClassifiedPath[];
  /** ISO-8601 emission timestamp. */
  at: string;
}

export interface WatchSpec {
  /**
   * Directory names whose subtrees are never recursively walked. High-churn /
   * large trees that would exhaust inotify watches (EMFILE) on a recursive add.
   */
  neverRecurse: string[];
  /**
   * Directory names watched at directory granularity only — never per-file
   * walked. `.git` loses inodes on atomic ref renames; descending into `.beads`
   * pins a read FD on `beads.db` (local_repo_explorer-fg5z).
   */
  directoryGranularity: string[];
  /** Repo-relative signal paths/prefixes that constitute a `git-state` change. */
  gitStateSignals: string[];
  /** Repo-relative signal paths that constitute a `beads` change. */
  beadsSignals: string[];
  /** Authoritative debounce/coalesce window in milliseconds. */
  debounceMs: number;
}
