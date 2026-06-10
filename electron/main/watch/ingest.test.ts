import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWatchIngest } from './ingest';
import type { CanonicalWatchEvent } from '@shared/watch/types';

const FIXED_AT = '2026-06-02T00:00:00.000Z';

describe('createWatchIngest', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (debounceMs = 200): { events: CanonicalWatchEvent[]; ingest: ReturnType<typeof createWatchIngest> } => {
    const events: CanonicalWatchEvent[] = [];
    const ingest = createWatchIngest((e) => events.push(e), { debounceMs, clock: () => FIXED_AT });
    return { events, ingest };
  };

  it('classifies and emits a single coalesced batch after the debounce window', () => {
    const { events, ingest } = make(200);
    ingest.feed(['src/a.ts', '.git/HEAD', '.beads/issues.jsonl']);
    expect(events).toHaveLength(0); // not yet flushed
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
    expect(events[0].categories.sort()).toEqual(['beads', 'git-state', 'working-tree']);
    expect(events[0].paths).toEqual(
      expect.arrayContaining([
        { rel: 'src/a.ts', category: 'working-tree' },
        { rel: '.git/HEAD', category: 'git-state' },
        { rel: '.beads/issues.jsonl', category: 'beads' },
      ]),
    );
    expect(events[0].at).toBe(FIXED_AT);
  });

  it('coalesces multiple feeds within one fixed window into one event', () => {
    const { events, ingest } = make(200);
    ingest.feed(['src/a.ts']);
    vi.advanceTimersByTime(100);
    ingest.feed(['src/b.ts']); // joins the same window (no reset)
    vi.advanceTimersByTime(100); // window elapses 200ms from the first feed
    expect(events).toHaveLength(1);
    expect(events[0].paths.map((p) => p.rel).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('dedupes repeated paths within a batch', () => {
    const { events, ingest } = make(200);
    ingest.feed(['src/a.ts', 'src/a.ts']);
    vi.advanceTimersByTime(200);
    expect(events[0].paths).toEqual([{ rel: 'src/a.ts', category: 'working-tree' }]);
  });

  it('drops unclassifiable paths and does not arm a timer for an all-dropped feed', () => {
    const { events, ingest } = make(200);
    ingest.feed(['.beads/beads.db-wal', '.git/index', 'node_modules/x/y.js']);
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });

  it('normalizes paths via the shared policy normalizer', () => {
    const { events, ingest } = make(200);
    ingest.feed(['./src/a.ts', '/.git/HEAD']);
    vi.advanceTimersByTime(200);
    expect(events[0].paths.map((p) => p.rel).sort()).toEqual(['.git/HEAD', 'src/a.ts']);
  });

  it('flush() emits the pending batch immediately', () => {
    const { events, ingest } = make(200);
    ingest.feed(['src/a.ts']);
    ingest.flush();
    expect(events).toHaveLength(1);
    // No duplicate emit when the (cancelled) timer would have fired.
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(1);
  });

  it('dispose() cancels a pending batch without emitting', () => {
    const { events, ingest } = make(200);
    ingest.feed(['src/a.ts']);
    ingest.dispose();
    vi.advanceTimersByTime(200);
    expect(events).toHaveLength(0);
  });
});
