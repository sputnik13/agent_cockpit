import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { useActiveWorktree, useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { subscribeWatch } from '../watch/hub';
import { normalizeWatchPath } from '@shared/watch/policy';
import type { WorktreeRecord } from '@shared/ipc/channels';
import { Tooltip } from '../ui';
import { resolveLanguage } from './highlight/languages';
import { useHighlightedTokens } from './highlight/useHighlightedTokens';
import { CodeLineTokens, splitTokenLineAt } from './highlight/CodeTokens';
import type { TokenLine } from './highlight/highlighter';
import { lineNotesByLine, useNotesStore } from '../notes';
import { BinaryPlaceholder } from './BinaryPlaceholder';
import type { RawFileConfirmation } from './RawFile';
import { CodeRow } from './CodeRow';
import { useFoldModel } from './folding/useFoldModel';
import {
  lineStartOffsets,
  offsetToLine,
  type AnchorLink,
  type FoldDocument,
  type FoldFormat,
  type FoldRegion,
} from './folding/foldModel';
import {
  visibleFoldRows,
  groupRowsByDocument,
  lastTouchedLine,
  type DocumentRowGroup,
  type FoldedRow,
  type FoldRow,
} from './foldingRows';

/**
 * Real source-mapped structural folding renderer for the Content panel's
 * `rendered -> 'folding-view'` dispatch cell (modeSwitcher.tsx's
 * VIEW_DISPATCH, settled in local_repo_explorer-jp2f.2). Replaces the
 * previous pass-through-to-RawFile body — see git history for that interim
 * seam. JSON is the format proven first (local_repo_explorer-jp2f.5); this
 * leaf (.6) extends the SAME surface for YAML with two additive layers —
 * multi-document stacking and anchor/alias linkage badges — on top of the
 * unchanged .5 row markup, never forking a second render path.
 *
 * Load-bearing invariants (see the issue body for the full contract):
 *  - NEVER re-serialize. Every rendered character is a literal
 *    `content.slice(...)` of the file `readFile` returned — no
 *    pretty-printing, re-indenting, key reordering, or comment dropping.
 *  - Line numbers are ORIGINAL source line numbers, never renumbered.
 *    Tokens (from `useHighlightedTokens`, computed over the FULL original
 *    `content`) are indexed by that SAME original line number everywhere
 *    below (`tokenLines[row.line]`), never by a visible-row position —
 *    folding hides rows, it never mutates content, so the original indices
 *    stay valid regardless of what is currently collapsed.
 *  - Every failure degrades to the plain highlighted view, never blank: see
 *    `FoldingText`'s `notice`/`usableModel` derivation below.
 *  - The plain-line row shell (contentVisibility wrapper, flex row, gutter,
 *    code span, wrap-mode rules, note thread) is the shared `CodeRow`
 *    primitive (CodeRow.tsx, local_repo_explorer-ggog) — also consumed by
 *    `RawText` in RawFile.tsx. `renderRow` below composes it with this
 *    view's OWN fold-toggle cell and folded-row content (chip, prefix/
 *    suffix slicing) via `CodeRow`'s `beforeCode` prop and `children` —
 *    real behavioral divergence that stays local here, never absorbed into
 *    the shared primitive.
 *  - Multi-document grouping (`groupRowsByDocument`, foldingRows.ts) and
 *    anchor/alias badges (below) are BOTH purely additive chrome around the
 *    same unchanged rows: a single-document, anchor-free file (every JSON
 *    file, and most YAML files) renders through the exact same code path
 *    .5 shipped, with zero extra DOM. See `foldingRows.ts`'s `lastTouchedLine`
 *    for a real, pre-existing `visibleFoldRows` offset-resolution defect
 *    this leaf found and fixed — reachable only via YAML-shaped regions,
 *    never by .5's JSON-only coverage.
 */

interface FoldingViewProps {
  worktreePath: string;
  filePath: string;
  format: FoldFormat;
  /** Git ref to read the file at instead of the working tree. */
  gitRef?: string;
  /**
   * Read-cap override (bytes), forwarded verbatim as the read's
   * `FileReadOptions.maxBytes`. Only ever set by ContentViewer — see
   * RawFile.tsx's `maxBytes` doc comment for the full rationale (this view
   * mirrors it exactly: same setting, same cap, same reasoning). Also folded
   * into the module-level read cache's key below, so a cached outcome from
   * before a cap change is never served after the setting changes.
   */
  maxBytes?: number;
  /** Soft-wrap long lines. */
  wrap?: boolean;
  /**
   * Fires once per resolved read (fresh or served from the module-level
   * cache below) with the same {@link RawFileConfirmation} shape RawFile
   * uses — see RawFile.tsx's `onBinaryConfirmed` doc comment for the two
   * downstream consumers in ContentViewer.tsx. FoldingView owns the read
   * for this view (unlike the old pass-through body), so this is now the
   * earliest and only point the classification is known at runtime for a
   * json/yaml selection.
   */
  onBinaryConfirmed?: (confirmation: RawFileConfirmation) => void;
}

/** This view's classification of its own `readFile` result — structurally
 *  identical to RawFile's internal `state` (minus `'loading'`, tracked
 *  separately below) and to {@link RawFileConfirmation} (minus the
 *  discriminant naming); kept local so the module-level cache below can
 *  store it directly. */
type ReadOutcome =
  | { kind: 'text'; content: string; sizeBytes: number }
  | { kind: 'binary'; sizeBytes: number }
  | { kind: 'too-large'; sizeBytes: number }
  | { kind: 'missing' };

function toConfirmation(o: ReadOutcome): RawFileConfirmation {
  return o.kind === 'text'
    ? { kind: 'text', sizeBytes: o.sizeBytes }
    : o.kind === 'binary'
      ? { kind: 'binary', sizeBytes: o.sizeBytes }
      : o.kind === 'too-large'
        ? { kind: 'too-large', sizeBytes: o.sizeBytes }
        : { kind: 'missing' };
}

/**
 * Module-level cache of FoldingView's OWN read result, keyed by
 * `(worktreePath, filePath, gitRef)`. This is what makes a Rendered -> Raw ->
 * Rendered mode toggle NOT re-read the file: json/yaml's Rendered and Raw
 * are DIFFERENT VIEW_DISPATCH cells ('folding-view' vs 'raw-file' —
 * see modeSwitcher.tsx's doc comment on that table), so ContentViewer (out
 * of this leaf's touch set) mounts a genuinely FRESH FoldingView instance
 * every time `view` becomes 'folding-view' again — plain conditional-JSX
 * unmount/remount, not a persisted component the way RawFile serves BOTH
 * Rendered and Raw from one mounted instance via its `highlight` prop.
 * Without this cache, every toggle back to Rendered would re-issue
 * `readFile`. Bounded like folding/foldClient.ts's own model cache
 * (insertion-order eviction of the oldest entry) — small on purpose, this
 * only needs to survive a user's OWN back-and-forth toggling of the SAME
 * file's mode within one session, not to be a general file cache.
 *
 * An entry can also be evicted EARLY, before that bound, when a
 * filesystem-watch event reports that its own file changed on disk — see
 * `invalidateForWatchPaths`/`ensureWatchSubscription` below
 * (local_repo_explorer-cks4) — so an external edit is never served stale on
 * the next toggle back to Rendered.
 */
const MAX_READ_CACHE_ENTRIES = 8;

/**
 * The watch-matching target for a cache entry — a discriminated union so a
 * `'worktree'`-kind entry (a sibling/external linked worktree,
 * local_repo_explorer-g1je) is never confused with a `'root'`-kind one (the
 * primary worktree, or a worktree NESTED under the project root — both
 * observed via the SAME primary root-rooted watch and matched by a
 * project-root-relative path, exactly as before g1je):
 *
 * - `{ kind: 'root'; rel }` — matched ONLY by an UNTAGGED watch event (the
 *   primary watch's own events never carry a `worktreePath` tag) whose
 *   changed paths include `rel`, project-root-relative.
 * - `{ kind: 'worktree'; worktreePath; rel }` — matched ONLY by a
 *   `worktreePath`-TAGGED event (the active-external-worktree watch's own
 *   events, local_repo_explorer-g1je) whose tag equals `worktreePath` AND
 *   whose changed paths include `rel`, relative to THAT worktree. Before
 *   g1je there was no watch mechanism able to observe an external worktree
 *   at all, so this case degraded to an unmatchable `null`; a real,
 *   dedicated subscription can now exist for it (IFF it is the ACTIVE
 *   worktree — see `SessionManager.setActiveWorktree`), making it a real,
 *   matchable target instead.
 *
 * See `invalidateForWatchPaths` below for the matching logic itself.
 */
type WatchTarget = { kind: 'root'; rel: string } | { kind: 'worktree'; worktreePath: string; rel: string };

/**
 * A cache entry's stored value: the read outcome itself, plus the
 * `WatchTarget` used to match this entry against filesystem-watch events
 * (`invalidateForWatchPaths`/`toWatchTarget` below — local_repo_explorer-
 * w5x0, extended to a `'worktree'`-kind target by g1je). `watchTarget` is
 * precomputed exactly once, when the entry is WRITTEN (`rememberRead`),
 * because that is the only point with the right context to compute it
 * correctly: the ACTIVE project's own worktree list. FoldingView only ever
 * renders the active project's own selection (see `ContentPanelHost` in
 * workspace/panels.tsx), so at write time `useActiveWorktree()` is
 * guaranteed to be the SAME project the file being read belongs to.
 * `invalidateForWatchPaths` itself runs at module scope, invoked from the
 * shared watch hub for ANY project's event, with no way to look up "which
 * project does this entry belong to" after the fact (the cache carries no
 * project identity at all — see that function's own doc comment) — so
 * re-deriving `watchTarget` there, instead of reading it back off the entry,
 * is not an option.
 */
interface CacheEntry {
  outcome: ReadOutcome;
  watchTarget: WatchTarget;
}

const readCache = new Map<string, CacheEntry>();

// Disabled by default under test, mirroring folding/foldClient.ts's own
// `workerDisabled` test-mode default exactly, and for the same class of
// reason: suites OUTSIDE this leaf's touch set (content.test.tsx in
// particular) exercise many UNRELATED scenarios that reuse the SAME fake
// (worktreePath, filePath) fixture path across separate test cases, each
// mocking a DIFFERENT size/content and expecting an independent fresh read.
// A cross-mount cache keyed purely on those three values cannot distinguish
// "the same user toggling Rendered<->Raw" from "an unrelated test reusing a
// memorable fixture path" — so by default it behaves as a no-op (every
// mount reads fresh, exactly like RawFile), and a test that specifically
// wants to exercise the caching behavior opts in via
// `__setReadCacheEnabledForTest`.
let readCacheDisabled = import.meta.env?.MODE === 'test';

function readCacheKey(
  worktreePath: string,
  filePath: string,
  gitRef: string | undefined,
  maxBytes: number | undefined,
): string {
  // `maxBytes` is part of the key (not just a read param) so a cached
  // 'too-large' outcome from BEFORE a `structuredFoldMaxMb` increase is never
  // served after the setting grows the cap — a stale cache hit would show the
  // too-large placeholder for a file that would now actually degrade/fold
  // correctly. See the `maxBytes` prop's doc comment above.
  return `${worktreePath}\x1f${filePath}\x1f${gitRef ?? ''}\x1f${maxBytes ?? ''}`;
}

function cachedRead(key: string): ReadOutcome | undefined {
  return readCacheDisabled ? undefined : readCache.get(key)?.outcome;
}

function rememberRead(key: string, outcome: ReadOutcome, watchTarget: WatchTarget): void {
  if (readCacheDisabled) return;
  readCache.delete(key);
  readCache.set(key, { outcome, watchTarget });
  while (readCache.size > MAX_READ_CACHE_ENTRIES) {
    const oldest = readCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    readCache.delete(oldest);
  }
}

/**
 * The `WatchTarget` (see its own doc comment above) for a worktree-relative
 * `filePath` read, given the active project's worktree list.
 *
 * Reuses this repo's ONE existing worktree -> project-root relationship
 * instead of inventing a second one: `worktreeOptions.ts`'s own doc comment
 * records that `git worktree list --porcelain` emits the main worktree
 * first, so `worktrees[0]` IS the project root the primary local watch is
 * rooted at (`LocalWatchManager`'s `rootPath`) — the same invariant the
 * shared worktree dropdown already pins at the top of its list.
 *
 * - `worktreePath === ''` (no worktree override — the read already resolved
 *   against the project root; see `ContentSelection.worktreePath`'s doc
 *   comment) — `filePath` is already root-relative: `{kind:'root', rel:
 *   filePath}`.
 * - `worktrees` not yet loaded, or `worktreePath` IS the primary worktree
 *   (`worktrees[0].path`) — same `{kind:'root', rel: filePath}`. This is the
 *   exact case cks4 shipped (and the only one its tests exercise): an
 *   unresolvable or primary worktree preserves that behavior byte-for-byte
 *   rather than guessing.
 * - `worktreePath` is a DIFFERENT, KNOWN worktree NESTED under the project
 *   root (e.g. a linked worktree checked out inside the repo) — still
 *   `{kind:'root', ...}`, converted by stripping the root prefix and
 *   joining the offset with `filePath`: it is observed via the SAME primary
 *   root-rooted watch (local_repo_explorer-w5x0), so it matches an untagged
 *   event exactly like the primary worktree does.
 * - `worktreePath` is a KNOWN worktree that lives OUTSIDE the project root
 *   (the common shape for `git worktree add` — a sibling/external checkout)
 *   — `{kind:'worktree', worktreePath, rel: filePath}`: matched ONLY by a
 *   `worktreePath`-tagged event for this exact worktree (local_repo_
 *   explorer-g1je's active-external-worktree watch). Before g1je such a
 *   file could never be the subject of ANY watch event (the local watch was
 *   rootPath-scoped only — see CLAUDE.md "Filesystem watch: single-source
 *   what to watch"), so this case returned `null` (permanently unmatchable);
 *   a real, dedicated watch can now exist for it (IFF it is the ACTIVE
 *   worktree), so this is now a real, matchable target rather than a lossy
 *   fallback to the root-relative shape (which would risk a FALSE match
 *   against an unrelated root-level file sharing the same relative name).
 */
function toWatchTarget(
  worktreePath: string,
  filePath: string,
  worktrees: readonly WorktreeRecord[],
): WatchTarget {
  if (!worktreePath) return { kind: 'root', rel: filePath };
  const root = worktrees[0]?.path;
  if (!root || worktreePath === root) return { kind: 'root', rel: filePath };
  const prefix = `${root.replace(/\/+$/, '')}/`;
  return worktreePath.startsWith(prefix)
    ? { kind: 'root', rel: `${worktreePath.slice(prefix.length)}/${filePath}` }
    : { kind: 'worktree', worktreePath, rel: filePath };
}

/**
 * Evicts every cache entry whose own (precomputed, see `toWatchTarget`)
 * `watchTarget` matches a `working-tree` watch event's changed paths — so a
 * Rendered -> Raw -> Rendered toggle after an external edit re-reads instead
 * of serving the now-stale cached outcome (local_repo_explorer-cks4,
 * follow-up to jp2f.5's reviewer finding; extended to a LINKED worktree's
 * own files by local_repo_explorer-w5x0; extended to a SIBLING/EXTERNAL
 * worktree's own files by local_repo_explorer-g1je). Both sides of every
 * comparison are normalized through the SAME `normalizeWatchPath` the hub
 * itself uses to classify paths (@shared/watch/policy), so a shape mismatch
 * (leading `./`, backslashes on Windows, …) can never silently defeat the
 * match — see this repo's CLAUDE.md "Filesystem watch: single-source what to
 * watch".
 *
 * `eventWorktreePath` (the event's own `worktreePath` tag, from
 * `HubWatchEvent` — present only for a batch from the active-external-
 * worktree watch) decides WHICH kind of entry can match at all:
 * - `undefined` (an UNTAGGED event, from the PRIMARY root-rooted watch) —
 *   matches ONLY `kind: 'root'` entries, by `rel`. Exact behavior as before
 *   g1je, byte-for-byte, for the primary/nested-worktree cases w5x0 already
 *   fixed.
 * - set (a TAGGED event, from the active-external-worktree watch) — matches
 *   ONLY `kind: 'worktree'` entries whose OWN `worktreePath` field equals
 *   the tag (plain string equality — both sides originate from the same
 *   `worktreeStore` selection string, so no normalization is needed there)
 *   AND whose `rel` is in the tagged event's changed-paths set.
 * A `kind: 'root'` entry is never matched by a tagged event, and a
 * `kind: 'worktree'` entry is never matched by an untagged one or by a
 * tagged event for a DIFFERENT worktree — the two kinds' paths live in
 * disjoint namespaces (project-root-relative vs. that-worktree-relative), so
 * cross-matching them would be a false positive, not just a missed one.
 *
 * Per-entry eviction (not a blanket cache clear): this only ever drops
 * entries that actually match a changed path, so an UNRELATED cached file
 * that didn't change keeps its "no re-read on toggle" guarantee even while
 * some OTHER file in the project is being edited.
 *
 * Deliberately NOT scoped to `event.projectId`: the cache key carries no
 * project identity (adding one would widen the key shape, also out of
 * scope), and scoping the match to "whichever project is currently active"
 * would wrongly SKIP invalidating a file cached for a different, still-live,
 * backgrounded project — reintroducing exactly the class of
 * background-staleness bug this repo's connection-state model (CLAUDE.md
 * "Connection state has ONE authoritative owner") exists to prevent. The
 * only cost of not scoping is a vanishingly rare cross-project
 * false-positive eviction (two different open projects both touching an
 * identically-named relative path in the same debounce window) — safe by
 * construction, since a false eviction only costs one extra re-read, never a
 * stale one.
 */
function invalidateForWatchPaths(paths: readonly string[], eventWorktreePath?: string): void {
  if (readCache.size === 0 || paths.length === 0) return;
  const changed = new Set(paths.map(normalizeWatchPath));
  for (const [key, entry] of readCache) {
    const target = entry.watchTarget;
    const matches =
      eventWorktreePath === undefined
        ? target.kind === 'root' && changed.has(normalizeWatchPath(target.rel))
        : target.kind === 'worktree' &&
          target.worktreePath === eventWorktreePath &&
          changed.has(normalizeWatchPath(target.rel));
    if (matches) readCache.delete(key);
  }
}

let watchUnsubscribe: (() => void) | null = null;

/**
 * Subscribes to the shared renderer watch hub (src/renderer/watch/hub.ts —
 * this repo's single dispatch point for filesystem-watch events, per
 * CLAUDE.md "Filesystem watch: single-source what to watch") for
 * `working-tree` events, for as long as the read cache above is itself
 * enabled — there is nothing to invalidate while it's disabled (off by
 * default under test; see `readCacheDisabled` above). Idempotent: a second
 * call while already subscribed is a no-op.
 *
 * Deliberately MODULE-scoped, not tied to any single `FoldingView` mount's
 * effect lifecycle: the cache it protects is itself module-level and
 * outlives any one mount (a file cached while viewed, then navigated away
 * from, stays cached), so its invalidation trigger must too — otherwise a
 * per-mount subscription would miss an edit landing while nothing currently
 * displays that file, leaving it stale until evicted by the 8-entry cap
 * (see `invalidateForWatchPaths`'s doc comment for the same reasoning
 * applied to matching). In production this subscribes exactly once, at
 * first import, and is never torn down — the cache lives for the app's
 * lifetime, so this does too, mirroring the same app-lifetime scope
 * workspace/panelDataSync.ts's own hub subscription has (declared locally
 * here instead of from AppShell, since this is a private implementation
 * detail of this file's own cache, not a per-project panel slice).
 */
function ensureWatchSubscription(): void {
  if (readCacheDisabled || watchUnsubscribe !== null) return;
  watchUnsubscribe = subscribeWatch({
    interest: ['working-tree'],
    onEvent: (event) => invalidateForWatchPaths(event.paths, event.worktreePath),
  });
}

/** Test-only counterpart to `ensureWatchSubscription`: tears the
 *  subscription down (if any) so disabling the cache also releases its
 *  listener — no subscription survives into a later test with the cache
 *  back in its default (disabled) state. */
function teardownWatchSubscription(): void {
  watchUnsubscribe?.();
  watchUnsubscribe = null;
}

let worktreeUnsubscribe: (() => void) | null = null;
/** Per-project last-seen `activeWorktree`, used only to detect a transition
 *  AWAY from a worktree (see `handleWorktreeTransition` below). Reset on
 *  every `ensureWorktreeTransitionSubscription` (re-seeded from the store's
 *  current snapshot) so a stale prior value never leaks across an enable /
 *  disable cycle (mirrors the cache's own lifecycle discipline). */
let prevActiveWorktrees = new Map<string, string | null>();

/**
 * Evicts every cached `kind: 'worktree'` entry whose `worktreePath` is the
 * worktree a project's `activeWorktree` selection just moved AWAY FROM — the
 * "unwatched-interval staleness guard" (local_repo_explorer-g1je). The
 * active-external-worktree watch (`SessionManager.setActiveWorktree`) only
 * ever covers the CURRENTLY active worktree; once the selection moves away,
 * that worktree's watch is torn down, so an edit made during the resulting
 * unwatched interval would otherwise never arrive as a watch event. Without
 * this guard, reopening the SAME worktree later (re-establishing its watch)
 * would silently serve the stale pre-edit cache entry until the 8-entry cap
 * happened to evict it — this forces a real re-read instead.
 *
 * Scoped by worktree PATH alone, not by project — mirrors
 * `invalidateForWatchPaths`'s own "no project identity in the cache" design
 * (see its doc comment): two different projects sharing the identical
 * worktree absolute path is not a realistic shape, so this stays simple and
 * safe-by-construction rather than threading project identity through the
 * cache just for this one guard.
 */
function evictWorktree(worktreePath: string): void {
  if (readCache.size === 0) return;
  for (const [key, entry] of readCache) {
    if (entry.watchTarget.kind === 'worktree' && entry.watchTarget.worktreePath === worktreePath) {
      readCache.delete(key);
    }
  }
}

/** Diffs `byProject` against `prevActiveWorktrees` and evicts the worktree
 *  being left on every transition (see `evictWorktree`). Mirrors panelData
 *  Sync.ts's own `activeWorktree` transition-diffing shape. */
function handleWorktreeTransition(
  byProject: Readonly<Record<string, { activeWorktree: string | null }>>,
): void {
  const seen = new Set<string>();
  for (const [projectId, slice] of Object.entries(byProject)) {
    seen.add(projectId);
    const prev = prevActiveWorktrees.has(projectId) ? (prevActiveWorktrees.get(projectId) ?? null) : null;
    if (prev === slice.activeWorktree) continue;
    prevActiveWorktrees.set(projectId, slice.activeWorktree);
    if (prev !== null) evictWorktree(prev);
  }
  // Drop bookkeeping for projects whose worktree slice was evicted entirely.
  for (const projectId of [...prevActiveWorktrees.keys()]) {
    if (!seen.has(projectId)) prevActiveWorktrees.delete(projectId);
  }
}

/** Companion to `ensureWatchSubscription`: subscribes to `useWorktreeStore`
 *  for as long as the read cache is enabled, seeding `prevActiveWorktrees`
 *  from the store's CURRENT snapshot so only REAL subsequent transitions are
 *  evicted (never the pre-existing selection at subscribe time). */
function ensureWorktreeTransitionSubscription(): void {
  if (readCacheDisabled || worktreeUnsubscribe !== null) return;
  prevActiveWorktrees = new Map(
    Object.entries(useWorktreeStore.getState().byProject).map(([id, s]) => [id, s.activeWorktree]),
  );
  worktreeUnsubscribe = useWorktreeStore.subscribe((s) => handleWorktreeTransition(s.byProject));
}

/** Test-only counterpart to `ensureWorktreeTransitionSubscription`. */
function teardownWorktreeTransitionSubscription(): void {
  worktreeUnsubscribe?.();
  worktreeUnsubscribe = null;
  prevActiveWorktrees = new Map();
}

// Establish the real subscriptions as soon as this module loads. A no-op
// under test — `readCacheDisabled` starts `true` there (see above) — so
// this never touches the watch hub or worktree store for suites that never
// opt into the cache. In production this is the only time it needs to run.
ensureWatchSubscription();
ensureWorktreeTransitionSubscription();

/** Test-only reset of the read cache, mirroring
 *  folding/foldClient.ts's `__resetFoldClientForTest`. */
export function __resetFoldingReadCacheForTest(): void {
  readCache.clear();
}

/**
 * Test-only: force the cross-mount read cache on/off regardless of
 * `import.meta.env.MODE`, for a test that specifically wants to exercise
 * the "Rendered -> Raw -> Rendered does not re-read the file" behavior.
 * Mirrors folding/foldClient.ts's `__setWorkerFactoryForTest` escape hatch.
 * Always also clears the cache so a prior test's entries never leak into
 * the one that opts back in (or leak out to a later test that didn't).
 * Also establishes/tears down BOTH the watch-hub subscription (see
 * `ensureWatchSubscription`/`teardownWatchSubscription` above) and the
 * worktree-transition subscription (`ensureWorktreeTransitionSubscription`/
 * `teardownWorktreeTransitionSubscription`) in lockstep, so a test that
 * enables the cache can exercise either invalidation path, and no listener
 * leaks past a test that disables it again.
 */
export function __setReadCacheEnabledForTest(enabled: boolean): void {
  readCacheDisabled = !enabled;
  readCache.clear();
  if (enabled) {
    ensureWatchSubscription();
    ensureWorktreeTransitionSubscription();
  } else {
    teardownWatchSubscription();
    teardownWorktreeTransitionSubscription();
  }
}

export function FoldingView({
  worktreePath,
  filePath,
  format,
  gitRef,
  maxBytes,
  wrap = false,
  onBinaryConfirmed,
}: FoldingViewProps): JSX.Element {
  const cacheKey = readCacheKey(worktreePath, filePath, gitRef, maxBytes);
  // Seed synchronously from the cache so a Raw -> Rendered toggle repaints
  // immediately with no loading flash, not just "no re-read".
  const [state, setState] = useState<{ kind: 'loading' } | ReadOutcome>(
    () => cachedRead(cacheKey) ?? { kind: 'loading' },
  );

  // The ACTIVE project's own worktree list — FoldingView only ever renders
  // the active project's selection (see ContentPanelHost in
  // workspace/panels.tsx), so this is guaranteed to be the right list for
  // whatever file this instance is reading. Held in a ref (updated every
  // render, read only inside the effect below) rather than a read effect
  // dependency: `worktrees` is a fresh array reference on any worktree-store
  // update, and this file's OWN re-read must never be triggered by an
  // unrelated worktree-list refresh — only by `toWatchTarget`'s own
  // inputs changing (mirrors DiagramFrame.tsx's `renderRef` pattern).
  const { worktrees } = useActiveWorktree();
  const worktreesRef = useRef(worktrees);
  worktreesRef.current = worktrees;

  useEffect(() => {
    let active = true;
    const cached = cachedRead(cacheKey);
    if (cached) {
      // Re-applied even though the initializer above may already have set
      // this on first mount: `worktreePath` can change on an ALREADY
      // mounted instance (ContentViewer's remount key is `kind:path:baseline`
      // — it does not include worktreePath), and the lazy useState initializer
      // above only ever runs once, at mount.
      setState(cached);
      onBinaryConfirmed?.(toConfirmation(cached));
      return;
    }
    const opts: { ref?: string; worktreePath?: string; maxBytes?: number } = { worktreePath };
    if (gitRef !== undefined) opts.ref = gitRef;
    if (maxBytes !== undefined) opts.maxBytes = maxBytes;
    void window.api.provider.readFile(filePath, opts).then((r) => {
      if (!active) return;
      const outcome: ReadOutcome =
        r.content !== null
          ? { kind: 'text', content: r.content, sizeBytes: r.sizeBytes }
          : r.truncated
            ? { kind: 'too-large', sizeBytes: r.sizeBytes }
            : r.isBinary
              ? { kind: 'binary', sizeBytes: r.sizeBytes }
              : { kind: 'missing' };
      rememberRead(
        cacheKey,
        outcome,
        toWatchTarget(worktreePath, filePath, worktreesRef.current),
      );
      setState(outcome);
      onBinaryConfirmed?.(toConfirmation(outcome));
    });
    return () => {
      active = false;
    };
    // `wrap` is deliberately excluded — toggling Wrap must never re-fetch,
    // same discipline as RawFile's read effect. `maxBytes` IS included
    // (deliberately UNLIKE `wrap`) and also folded into `cacheKey` above — a
    // cap change (a live Preferences edit to `structuredFoldMaxMb`) can turn a
    // previously-refused read into a successful one, so both the cache lookup
    // and a fresh fetch must key on it, mirroring RawFile's identical
    // `maxBytes` deps-array reasoning.
  }, [worktreePath, filePath, gitRef, maxBytes, cacheKey, onBinaryConfirmed]);

  return (
    <div data-testid="folding-view" data-format={format} className="h-full">
      {state.kind === 'loading' && (
        <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>
      )}
      {state.kind === 'binary' && (
        <BinaryPlaceholder mode="rendered" reason="binary" size={state.sizeBytes} />
      )}
      {state.kind === 'too-large' && (
        <BinaryPlaceholder mode="rendered" reason="too-large" size={state.sizeBytes} />
      )}
      {state.kind === 'missing' && <BinaryPlaceholder mode="rendered" reason="missing" />}
      {state.kind === 'text' && (
        <FoldingText
          content={state.content}
          filePath={filePath}
          format={format}
          gitRef={gitRef}
          wrap={wrap}
        />
      )}
    </div>
  );
}

/** Stable empty-array/-map references so a null/error fold model never
 *  forces a dependent `useMemo` to recompute on every unrelated re-render (a
 *  fresh `[]`/`new Map()` literal would change identity each render). */
const NO_REGIONS: FoldRegion[] = [];
const NO_DOCUMENTS: FoldDocument[] = [];
const NO_ANCHORS: AnchorLink[] = [];
const NO_BADGES: LineBadge[] = [];
const NO_BADGES_BY_LINE: ReadonlyMap<number, LineBadge[]> = new Map();
const FOLD_TOGGLE_WIDTH = 20;

interface FoldingTextProps {
  content: string;
  filePath: string;
  format: FoldFormat;
  gitRef: string | undefined;
  wrap: boolean;
}

function FoldingText({ content, filePath, format, gitRef, wrap }: FoldingTextProps): JSX.Element {
  const theme = useSettingsStore((s) => s.settings.theme);
  const lang = resolveLanguage(filePath);
  // Unlike RawText, FoldingView is ALWAYS the Rendered presentation (see the
  // module doc comment) — there is no `highlight` switch to gate on.
  const hl = useHighlightedTokens(content, lang, theme);
  const foldModelState = useFoldModel(content, format);

  const notes = useNotesStore((s) => s.notes);
  const load = useNotesStore((s) => s.load);
  const addLineNote = useNotesStore((s) => s.addLineNote);
  const removeNote = useNotesStore((s) => s.remove);
  const activeId = useProjectsStore((s) => s.activeId);
  const [composing, setComposing] = useState<number | null>(null);

  useEffect(() => {
    void load();
  }, [activeId, load]);

  // Collapsed region START offsets. Default: every region expanded.
  // Explicitly reset on filePath/gitRef change (belt-and-braces alongside
  // ContentViewer's `key={kind:path:baseline}`, which already forces a
  // fresh FoldingView/FoldingText mount on either change — see
  // ContentViewer.tsx — so this holds even if a future caller ever reuses
  // one instance across files).
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  useEffect(() => {
    setCollapsed(new Set());
  }, [filePath, gitRef]);

  const toggleRegion = (start: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });
  };

  const textLines = useMemo(() => content.split('\n'), [content]);
  const notesByLine = useMemo(() => lineNotesByLine(notes, filePath), [notes, filePath]);
  const tokenLines = lang !== null && hl.state === 'ready' ? hl.lines : null;
  const starts = useMemo(() => lineStartOffsets(content), [content]);

  // Every failure degrades to the plain highlighted view, minus fold
  // controls: an `unavailable` model (compute failed / inputs not ready) or
  // a model carrying `errors` (malformed input recovered a PARTIAL region
  // list) both ignore `regions` entirely here, rather than rendering a
  // partial/misleading fold UI. Zero foldable regions and an empty file are
  // NOT notice-worthy — they fall out of this same path with `notice: null`
  // (an empty/valid `regions` array renders identically to "nothing to
  // fold", no special-casing needed).
  const modelReady = foldModelState.state === 'ready';
  const modelErrorCount = modelReady ? foldModelState.model.errors.length : 0;
  const usableModel = modelReady && modelErrorCount === 0 ? foldModelState.model : null;
  const regions = usableModel?.regions ?? NO_REGIONS;
  // Both `documents`/`groups` (decision #2) and `anchors`/`badgesByLine`
  // (decision #3) fall back to stable-empty per `usableModel` exactly like
  // `regions` above — an `unavailable`/`errors` model degrades to the plain
  // highlighted view with grouping AND badges simply absent, never
  // partially applied (the issue's Data States requirement).
  const documents = usableModel?.documents ?? NO_DOCUMENTS;
  const anchors = usableModel?.anchors ?? NO_ANCHORS;

  const rows = useMemo(
    () => visibleFoldRows(starts, regions, collapsed),
    [starts, regions, collapsed],
  );

  // Multi-document grouping (parent issue's second comment, decision #2) —
  // ONLY when there is genuinely more than one document. A single-document
  // file (every JSON file, and most YAML files) renders through the exact
  // same flat `rows.map(renderRow)` path .5 shipped below, with ZERO extra
  // wrapper elements: "A single-document YAML file must render exactly as
  // it does after .5 — no separator, no document label, no layout change"
  // (the issue's Guardrails). `groupRowsByDocument` buckets `rows` AS-IS —
  // grouping is a pure post-pass, never a second projection.
  const groups: DocumentRowGroup[] | null = useMemo(
    () => (documents.length > 1 ? groupRowsByDocument(rows, documents, starts) : null),
    [rows, documents, starts],
  );

  // Anchor/alias badges (parent issue's second comment, decision #3): one
  // flat, offset-sorted list, then bucketed by the badge's OWN original
  // line so a row's renderer can look up "my own badges" in O(1). A badge
  // is only ever rendered when its own line is actually looked up by a
  // VISIBLE row below (an ordinary 'line' row, or the still-visible
  // prefix/suffix of a 'folded' row via `FoldedRowContent`) — a badge whose
  // line is hidden inside a collapsed region is simply never looked up, so
  // it is absent while collapsed and reappears on expand with no
  // special-casing beyond that (the issue's Contract).
  const badgesByLine = useMemo(() => {
    if (anchors.length === 0) return NO_BADGES_BY_LINE;
    const flat: LineBadge[] = [];
    for (const anchor of anchors) {
      flat.push({
        offset: anchor.definition.end,
        kind: 'definition',
        name: anchor.name,
        aliasCount: anchor.aliases.length,
        definitionLine: 0,
      });
      const definitionLine = offsetToLine(starts, anchor.definition.start) + 1; // 1-based
      for (const alias of anchor.aliases) {
        flat.push({
          offset: alias.end,
          kind: 'alias',
          name: anchor.name,
          aliasCount: 0,
          definitionLine,
        });
      }
    }
    flat.sort((a, b) => a.offset - b.offset);
    const byLine = new Map<number, LineBadge[]>();
    for (const badge of flat) {
      const line = offsetToLine(starts, badge.offset);
      const arr = byLine.get(line);
      if (arr) arr.push(badge);
      else byLine.set(line, [badge]);
    }
    return byLine;
  }, [anchors, starts]);

  // Lines that start a VISIBLE, EXPANDED region — the chevron for these
  // renders on their ordinary 'line' row (a COLLAPSED region's chevron is
  // already carried on its own 'folded' row — see foldingRows.ts). Reuses
  // `rows`'s own "what actually rendered" answer rather than re-deriving
  // hidden-ancestor containment a second time.
  const expandableAt = useMemo(() => {
    const visibleLines = new Set<number>();
    for (const row of rows) if (row.kind === 'line') visibleLines.add(row.line);
    const m = new Map<number, FoldRegion>();
    for (const region of regions) {
      if (collapsed.has(region.start)) continue;
      // `lastTouchedLine`, not `offsetToLine` — see its doc comment in
      // foldingRows.ts. A block scalar's `headerEnd` lands exactly on the
      // NEXT line's start offset, which `offsetToLine` would misattribute
      // to that next line, attaching the chevron to the wrong row.
      const headerLine = lastTouchedLine(starts, region.headerEnd, region.start);
      if (visibleLines.has(headerLine) && !m.has(headerLine)) m.set(headerLine, region);
    }
    return m;
  }, [rows, regions, collapsed, starts]);

  const notice =
    foldModelState.state === 'unavailable'
      ? 'Folding is unavailable for this file. Showing plain text.'
      : modelReady && modelErrorCount > 0
        ? `Folding is unavailable: this file has ${modelErrorCount} syntax ${modelErrorCount === 1 ? 'error' : 'errors'}. Showing plain text.`
        : null;

  const containerStyle = {
    margin: 0,
    paddingTop: 8,
    paddingBottom: 8,
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--mono-size)',
    background: (tokenLines && hl.state === 'ready' && hl.bg) || 'var(--bg)',
    color: (tokenLines && hl.state === 'ready' && hl.fg) || 'var(--fg)',
    overflow: 'auto',
    flex: '1 1 auto',
    minHeight: 0,
  } as const;

  // Loading (read OR fold model pending) shows the same affordance RawFile
  // uses for its own 'loading' state. All hooks above have already run
  // unconditionally, so this early return is safe.
  if (foldModelState.state === 'loading') {
    return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>;
  }

  // Composes the shared CodeRow shell (row/gutter/note markup — see
  // CodeRow.tsx) with this view's OWN fold-toggle cell and folded-row
  // content, factored into a plain function (not a separate component — it
  // closes over this render's tokenLines/notesByLine/composing/wrap/
  // badgesByLine, same as the inline arrow function it replaces) so BOTH the
  // flat single-document path and the grouped multi-document path below
  // render identical rows through one definition — never two diverging
  // copies of this markup.
  function renderRow(row: FoldRow): JSX.Element {
    const lineNo = row.line + 1; // 1-based — matches LineNoteGutter/lineNotesByLine.
    const lineNotes = notesByLine.get(lineNo) ?? [];
    const open = composing === lineNo;
    const liveText = textLines[row.line] ?? '';
    const chevronRegion = row.kind === 'folded' ? row.region : (expandableAt.get(row.line) ?? null);
    const rowKey = row.kind === 'line' ? `l${row.line}` : `f${row.region.start}`;
    // Only an ordinary 'line' row looks up its own badges directly by
    // line — a 'folded' row's prefix/suffix badges are looked up (and
    // column-filtered) inside FoldedRowContent itself, since they can come
    // from TWO different lines (the header line's prefix, the closing
    // line's suffix — see FoldedRowContent's doc comment).
    const rowBadges = row.kind === 'line' ? (badgesByLine.get(row.line) ?? NO_BADGES) : NO_BADGES;

    return (
      <CodeRow
        key={rowKey}
        line={lineNo}
        wrap={wrap}
        notes={lineNotes}
        composing={open}
        liveText={liveText}
        onAddNote={setComposing}
        onSubmitNote={(body) => {
          void addLineNote(filePath, lineNo, liveText, body);
          setComposing(null);
        }}
        onCancelNote={() => setComposing(null)}
        onDeleteNote={(id) => void removeNote(id)}
        beforeCode={
          <FoldToggleCell
            region={chevronRegion}
            expanded={row.kind === 'line'}
            lineNo={lineNo}
            onToggle={toggleRegion}
          />
        }
      >
        {row.kind === 'line' ? (
          tokenLines?.[row.line] ? (
            spliceTokenBadges(tokenLines[row.line], starts[row.line] ?? 0, rowBadges)
          ) : (
            spliceTextBadges(liveText, starts[row.line] ?? 0, rowBadges)
          )
        ) : (
          <FoldedRowContent
            content={content}
            starts={starts}
            row={row}
            badgesByLine={badgesByLine}
            onExpand={toggleRegion}
          />
        )}
      </CodeRow>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {notice && (
        <div
          style={{
            flexShrink: 0,
            padding: '6px 12px',
            fontSize: 12,
            color: 'var(--color-warn)',
            borderBottom: '1px solid var(--border)',
            background: 'color-mix(in srgb, var(--color-warn) 12%, transparent)',
          }}
        >
          {notice}
        </div>
      )}
      <div style={containerStyle}>
        {groups
          ? groups.map((group, i) => {
              const label = `Document ${i + 1} of ${groups.length}`;
              return (
                <Fragment key={group.document.index}>
                  {i > 0 && <DocumentSeparator label={label} />}
                  <div role="region" aria-label={label} data-fold-document={group.document.index}>
                    {group.rows.map(renderRow)}
                  </div>
                </Fragment>
              );
            })
          : rows.map(renderRow)}
      </div>
    </div>
  );
}

/**
 * A purely decorative visual band between two consecutive document groups
 * (parent issue's second comment, decision #2: multi-document YAML renders
 * ALL documents, stacked, with a labelled separator between them). The
 * REAL accessible label lives on the sibling `role="region"` wrapper that
 * immediately follows it (both are given the IDENTICAL text, so a sighted
 * user reads it in the band and a screen-reader user reads the same text
 * as the region's name) — this element is `aria-hidden` so it is never
 * announced as a second, redundant label alongside the region's own.
 */
function DocumentSeparator({ label }: { label: string }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-fold-separator="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '10px 0',
        padding: '0 4px',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--fg-dim)',
        userSelect: 'none',
      }}
    >
      <span style={{ flexShrink: 0 }}>{label}</span>
      <span style={{ flex: '1 1 auto', height: 1, background: 'var(--border)' }} />
    </div>
  );
}

/** `region.kind` -> a short human noun for aria-labels ("Collapse array
 *  starting on line 12, 8 items"). `map`/`seq`/`block-scalar` are YAML-only
 *  kinds (never produced by jsonFold.ts) handled here for format-agnosticism
 *  per this leaf's scope — .6 may refine block-scalar's treatment. */
function regionNoun(kind: FoldRegion['kind']): string {
  switch (kind) {
    case 'object':
    case 'map':
      return 'object';
    case 'array':
    case 'seq':
      return 'array';
    case 'block-scalar':
      return 'block';
  }
}

/** `region.kind` -> the folded placeholder chip's glyph. */
function chipGlyph(kind: FoldRegion['kind']): string {
  switch (kind) {
    case 'object':
    case 'map':
      return '{…}';
    case 'array':
    case 'seq':
      return '[…]';
    case 'block-scalar':
      return '…';
  }
}

function formatItemCount(n: number): string {
  return n === 1 ? '1 item' : `${n} items`;
}

interface FoldToggleCellProps {
  /** The region whose header starts on this row, or `null` for a row that
   *  doesn't start a foldable region (renders an inert spacer instead). */
  region: FoldRegion | null;
  /** Whether toggling this region collapses it (true) or expands it
   *  (false) — i.e. its CURRENT state is the opposite of this action. */
  expanded: boolean;
  lineNo: number;
  onToggle: (regionStart: number) => void;
}

/**
 * Fixed-width toggle cell rendered for EVERY row so the code column stays
 * aligned (mirrors the gutter's own fixed width) — a chevron `<button>` on
 * rows that start a foldable region, an inert spacer otherwise. Never
 * hover-gated: the chevron is always visible and always in the Tab order
 * when present (per ui-standards/desktop-ui-standards — an essential
 * affordance must not require hovering to discover or activate).
 */
function FoldToggleCell({ region, expanded, lineNo, onToggle }: FoldToggleCellProps): JSX.Element {
  if (!region) {
    return <span aria-hidden="true" className="shrink-0" style={{ width: FOLD_TOGGLE_WIDTH }} />;
  }

  const verb = expanded ? 'Collapse' : 'Expand';
  const label = `${verb} ${regionNoun(region.kind)} starting on line ${lineNo}, ${formatItemCount(region.itemCount)}`;

  function activate(): void {
    onToggle(region!.start);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void {
    // Explicit Enter/Space handling (not just relying on native <button>
    // activation) so this is reliably testable and unambiguous: preventDefault
    // suppresses the browser's own follow-up synthesized click for a
    // keyboard activation, so `activate()` still runs exactly once.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  }

  return (
    <button
      type="button"
      onClick={activate}
      onKeyDown={onKeyDown}
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      className="shrink-0 select-none text-dim outline-none hover:text-fg hover:bg-elev focus-visible:bg-elev focus-visible:text-fg active:bg-panel-2"
      style={{ width: FOLD_TOGGLE_WIDTH, textAlign: 'center' }}
    >
      {expanded ? '▾' : '▸'}
    </button>
  );
}

/**
 * One anchor/alias linkage badge (local_repo_explorer-jp2f.6, parent
 * issue's second comment, decision #3), anchored immediately after its
 * `&name`/`*name` token at an absolute source `offset`. A DEFINITION badge
 * (one per `AnchorLink`, always — including an anchor with zero aliases:
 * yamlFold.ts reports those too, "definition-only") carries the total
 * alias count for its glyph/tooltip; an ALIAS badge (one per
 * `AnchorLink.aliases` entry) carries the anchor's OWN definition line
 * (precomputed here, NOT looked up live from the DOM) so its tooltip is
 * correct even when the definition's own row is currently folded away.
 */
interface LineBadge {
  offset: number;
  kind: 'definition' | 'alias';
  name: string;
  /** Definition badge: total alias count. Unused (0) for an alias badge. */
  aliasCount: number;
  /** Alias badge: the anchor's definition line, 1-based. Unused (0) for a
   *  definition badge. */
  definitionLine: number;
}

function pluralAliases(n: number): string {
  return n === 1 ? '1 alias' : `${n} aliases`;
}

/** The badge's tooltip text — the ONLY place singular/plural wording and
 *  the exact sentence shape are decided, so both call sites (the visible
 *  Tooltip content and the `aria-label` fallback) always agree. */
function badgeTooltip(badge: LineBadge): string {
  return badge.kind === 'definition'
    ? `Anchor &${badge.name} — referenced by ${pluralAliases(badge.aliasCount)}`
    : `Alias of &${badge.name}, defined on line ${badge.definitionLine}`;
}

/**
 * The badge's always-visible glyph — reuses the format's OWN `&`/`*` sigil
 * (matching the token this badge sits immediately after) paired with the
 * one number that matters (alias count for a definition, target line for
 * an alias). Per ui-standards ("never color alone for state — pair with
 * text, icon, shape, position, or wording") and this issue's Guardrails
 * ("the badge must also convey its meaning without relying on hover
 * alone"): the glyph differs by kind and carries real information visibly,
 * without requiring the Tooltip's hover/focus reveal.
 */
function badgeGlyph(badge: LineBadge): string {
  return badge.kind === 'definition' ? `&${badge.aliasCount}` : `*${badge.definitionLine}`;
}

const BADGE_CLASS =
  'mx-0.5 inline-flex items-center rounded border border-edge bg-panel-2 px-1 py-px ' +
  'text-[10px] font-medium leading-none text-dim outline-none hover:bg-elev hover:text-fg ' +
  'focus-visible:bg-elev focus-visible:text-fg';

/**
 * The badge itself: a small, always-visible, keyboard-focusable chip using
 * this repo's Radix-based `Tooltip` (src/renderer/ui) — NOT a `title`
 * attribute or a handrolled popover, per the issue's Guardrails. A plain
 * `<span tabIndex={0}>` (rather than the app's `Badge`/`FoldedRowContent`-
 * style `<button>`) is the trigger: Radix's `Tooltip.Trigger asChild` needs
 * its child to forward a ref for correct positioning (this repo's `Row`
 * component was specifically converted to `forwardRef` for exactly this —
 * see ui/Row.tsx's own doc comment — while `Badge`/`IconButton` are NOT
 * both suitable here: `Badge` doesn't forward a ref, and a `<button>` would
 * wrongly imply a click action — anchor/alias click-to-jump is explicitly
 * deferred by this leaf's Scope). A native `<span>` always forwards a ref,
 * side-stepping the issue entirely without touching `Badge`/`Tooltip`
 * (both outside this leaf's touch set). `tabIndex={0}` + `aria-label`
 * make it independently keyboard-reachable and named even before Radix's
 * own `aria-describedby` wiring applies (Radix shows the tooltip on focus
 * as well as hover, so Tab reaches every badge). `data-fold-badge` is a
 * pure test/DOM marker (never styled) so round-trip text comparisons can
 * reliably strip badge chrome back out — see foldingView.test.tsx's
 * `codeLines` helper.
 */
function AnchorAliasBadge({ badge }: { badge: LineBadge }): JSX.Element {
  const tooltip = badgeTooltip(badge);
  return (
    <Tooltip content={tooltip}>
      <span tabIndex={0} aria-label={tooltip} data-fold-badge={badge.kind} className={BADGE_CLASS}>
        {badgeGlyph(badge)}
      </span>
    </Tooltip>
  );
}

/**
 * Splices `badges` (each already known to fall within
 * `[textStart, textStart + text.length]`, ascending by `offset`) into plain
 * `text` at their column offsets, producing `[text][badge][text]...` —
 * never altering a character of `text`. `textStart` is the absolute source
 * offset of `text`'s own first character. Shared by the plain-text
 * (unhighlighted) row fallback and by a folded row's visible prefix/suffix
 * fragments, which are never tokenized through Shiki (see
 * `FoldedRowContent`'s doc comment) — so both badge-placement sites for a
 * folded row use this, never `spliceTokenBadges`.
 */
function spliceTextBadges(text: string, textStart: number, badges: LineBadge[]): ReactNode {
  if (badges.length === 0) return text;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  badges.forEach((badge, i) => {
    const col = badge.offset - textStart;
    if (col > cursor) nodes.push(<span key={`t${i}`}>{text.slice(cursor, col)}</span>);
    nodes.push(<AnchorAliasBadge key={`b${i}`} badge={badge} />);
    cursor = col;
  });
  if (cursor < text.length) nodes.push(<span key="tend">{text.slice(cursor)}</span>);
  return nodes;
}

/**
 * Same idea as {@link spliceTextBadges} but for a highlighted `TokenLine`,
 * using `splitTokenLineAt` (highlight/CodeTokens.tsx) so no token's text is
 * ever mutated — only split at each badge's column, left to right,
 * re-basing each subsequent column against the previous split's `after`
 * half (each split's `remaining` starts at a new absolute offset, tracked
 * via `consumedAbsolute`).
 */
function spliceTokenBadges(line: TokenLine, textStart: number, badges: LineBadge[]): ReactNode {
  if (badges.length === 0) return <CodeLineTokens line={line} />;
  const nodes: ReactNode[] = [];
  let remaining = line;
  let consumedAbsolute = textStart;
  badges.forEach((badge, i) => {
    const [before, after] = splitTokenLineAt(remaining, badge.offset - consumedAbsolute);
    nodes.push(<CodeLineTokens key={`t${i}`} line={before} />);
    nodes.push(<AnchorAliasBadge key={`b${i}`} badge={badge} />);
    remaining = after;
    consumedAbsolute = badge.offset;
  });
  nodes.push(<CodeLineTokens key="tend" line={remaining} />);
  return nodes;
}

/**
 * Renders a folded row's content: the literal source from the row's line
 * start through `headerEnd` (the prefix — e.g. the opening `{`), then the
 * placeholder chip, then the literal source from `suffixStart` to the
 * CLOSING line's end (the suffix — e.g. a trailing `,` after `}`). Per the
 * issue's Guardrails, prefix/suffix are NOT re-tokenized through Shiki here
 * (slicing a token line's sub-range is real, non-trivial new logic this leaf
 * does not need — full-line tokens are only ever indexed by whole original
 * line elsewhere in this file); they render as plain text, with the chip
 * itself visually distinct from code text.
 *
 * The chip's aria-label deliberately omits "starting on line N" (unlike
 * FoldToggleCell's chevron label): the chip IS the row at that line, so
 * restating its own position is redundant — and, more importantly, would
 * otherwise produce the IDENTICAL accessible name as the chevron on the
 * same row once collapsed (both describing the same "expand" action),
 * which is ambiguous for assistive tech and for `getByRole` alike.
 *
 * Anchor/alias badges landing in the PREFIX (`[headerLineStart,
 * prefixEnd)`, e.g. an anchor defined right on a `key: &name [` header
 * line) or the SUFFIX (`[suffixStart, suffixLineEnd)`, e.g. a trailing
 * alias reference after a closing delimiter) stay visible on this folded
 * row via `spliceTextBadges` — a badge whose offset falls strictly BETWEEN
 * `prefixEnd` and `suffixStart` (the actually-hidden middle span) is never
 * looked up at all here, so it is simply absent while collapsed, per the
 * issue's Contract — no special-casing needed beyond the `<=`/`>=` filters
 * below.
 */
function FoldedRowContent({
  content,
  starts,
  row,
  badgesByLine,
  onExpand,
}: {
  content: string;
  // Plain (not `readonly`) to match foldModel.ts's `offsetToLine` signature.
  starts: number[];
  row: FoldedRow;
  badgesByLine: ReadonlyMap<number, LineBadge[]>;
  onExpand: (start: number) => void;
}): JSX.Element {
  const headerLineStart = starts[row.line] ?? 0;
  const prefix = content.slice(headerLineStart, row.prefixEnd);
  // `lastTouchedLine`, not `offsetToLine`, on purpose: `row.suffixStart`
  // (===`region.end`) routinely lands EXACTLY on the NEXT line's own start
  // offset for a YAML region (see lastTouchedLine's doc comment in
  // foldingRows.ts) — `offsetToLine` would then resolve to that next line,
  // making `suffixLineEnd` come from the WRONG line and `suffix` bleed in
  // that line's own text (e.g. a following YAML document's `---` marker).
  // `lastTouchedLine` resolves to the line the region's content actually
  // still touches; when suffixStart lands exactly on a boundary this makes
  // `suffixLineEnd < row.suffixStart`, and `.slice()` of an inverted range
  // is always `''` — correctly "no trailing suffix on this line".
  const suffixLine = lastTouchedLine(starts, row.suffixStart, headerLineStart);
  const suffixLineEnd =
    suffixLine + 1 < starts.length ? starts[suffixLine + 1] - 1 : content.length;
  const suffix = content.slice(row.suffixStart, suffixLineEnd);
  const count = formatItemCount(row.region.itemCount);
  const label = `Expand ${regionNoun(row.region.kind)}, ${count}`;

  const prefixBadges = (badgesByLine.get(row.line) ?? NO_BADGES).filter(
    (b) => b.offset <= row.prefixEnd,
  );
  const suffixBadges = (badgesByLine.get(suffixLine) ?? NO_BADGES).filter(
    (b) => b.offset >= row.suffixStart,
  );

  return (
    <>
      {spliceTextBadges(prefix, headerLineStart, prefixBadges)}
      <button
        type="button"
        onClick={() => onExpand(row.region.start)}
        aria-label={label}
        title="Click to expand"
        className="mx-1 rounded border border-edge bg-panel-2 px-1.5 text-[11px] text-dim hover:text-fg hover:bg-elev focus-visible:bg-elev focus-visible:text-fg"
      >
        {chipGlyph(row.region.kind)} {count}
      </button>
      {spliceTextBadges(suffix, row.suffixStart, suffixBadges)}
    </>
  );
}
