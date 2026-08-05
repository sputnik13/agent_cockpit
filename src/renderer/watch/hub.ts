/**
 * Layer 4 (renderer) — the central watch dispatch hub.
 *
 * One subscription to the provider watch stream (`agentCockpit.events.onWatch`)
 * is fanned out to panel subscribers by *category interest*. Panels no longer
 * inspect raw paths or re-implement filtering: they declare which
 * `WatchCategory`s they care about and receive only matching events.
 *
 * Classification uses the shared policy (`classifyWatchPath`) — the same single
 * source the mechanisms and ingest use — so categories are defined exactly once.
 * Paths arriving here are repo-relative POSIX for both transports (the local and
 * remote mechanisms normalize before emit), so classification is uniform.
 */
import { agentCockpit } from '@renderer/providerClient';
import { classifyWatchPath } from '@shared/watch/policy';
import type { WatchCategory } from '@shared/watch/types';

export interface HubWatchEvent {
  /** The project the event originated from (every live session emits its own
   *  watch events; the tag was always on the wire, now carried through). */
  projectId: string;
  /**
   * The worktree `paths` are relative to, when this batch came from the
   * EXTRA active-external-worktree watch (local_repo_explorer-g1je) rather
   * than the project's primary root-rooted watch. Absent for the primary
   * watch's events, whose `paths` stay project-root-relative exactly as
   * before this field existed. Passed through unchanged — the hub's own
   * category classification is unaffected by it.
   */
  worktreePath?: string;
  /** Distinct categories present in this event. */
  categories: WatchCategory[];
  /** Repo-relative (or, when `worktreePath` is set, worktree-relative) POSIX
   *  paths that classified into a category. */
  paths: string[];
  at: string;
}

export interface WatchSubscriber {
  /** Categories this subscriber wants. It is invoked when the event intersects. */
  interest: WatchCategory[];
  onEvent: (event: HubWatchEvent) => void;
}

interface Listener {
  interest: ReadonlySet<WatchCategory>;
  onEvent: (event: HubWatchEvent) => void;
}

const listeners = new Set<Listener>();
let detach: (() => void) | null = null;

function handleRaw(e: {
  projectId?: string;
  worktreePath?: string;
  event?: { paths?: string[]; at?: string };
}): void {
  const rawPaths = e.event?.paths ?? [];
  const paths: string[] = [];
  const categories = new Set<WatchCategory>();
  for (const p of rawPaths) {
    const category = classifyWatchPath(p);
    if (category === null) continue;
    paths.push(p);
    categories.add(category);
  }
  if (categories.size === 0) return;
  const event: HubWatchEvent = {
    projectId: e.projectId ?? '',
    worktreePath: e.worktreePath,
    categories: [...categories],
    paths,
    at: e.event?.at ?? '',
  };
  for (const listener of listeners) {
    for (const category of categories) {
      if (listener.interest.has(category)) {
        listener.onEvent(event);
        break;
      }
    }
  }
}

/**
 * Register a category-scoped watch subscriber. Attaches the single provider
 * watch listener on first subscriber and detaches it on the last unsubscribe.
 * Returns an unsubscribe function.
 */
export function subscribeWatch(sub: WatchSubscriber): () => void {
  const listener: Listener = { interest: new Set(sub.interest), onEvent: sub.onEvent };
  listeners.add(listener);
  if (detach === null) {
    detach = agentCockpit.events.onWatch(handleRaw);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach !== null) {
      detach();
      detach = null;
    }
  };
}
