import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CUE_MS, cueFileName, useOpenCueStore } from './openCueStore';

const cue = (name: string, projectId = 'p1') => ({
  projectId,
  name,
  path: `/repo/${name}`,
  reason: 'because',
});

beforeEach(() => {
  vi.useFakeTimers();
  useOpenCueStore.getState().clear();
});
afterEach(() => {
  useOpenCueStore.getState().clear();
  vi.useRealTimers();
});

describe('openCueStore', () => {
  it('holds one cue; a newer one replaces the older', () => {
    useOpenCueStore.getState().show(cue('a.md'));
    useOpenCueStore.getState().show(cue('b.md'));
    expect(useOpenCueStore.getState().cue).toMatchObject({ name: 'b.md', projectId: 'p1' });
  });

  it('dismisses itself after OPEN_CUE_MS, and not a moment before', () => {
    useOpenCueStore.getState().show(cue('a.md'));
    vi.advanceTimersByTime(OPEN_CUE_MS - 1);
    expect(useOpenCueStore.getState().cue).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useOpenCueStore.getState().cue).toBeNull();
  });

  it("an older cue's timer never dismisses a newer cue (the clock restarts on replace)", () => {
    useOpenCueStore.getState().show(cue('a.md'));
    vi.advanceTimersByTime(OPEN_CUE_MS - 1_000);
    useOpenCueStore.getState().show(cue('b.md'));
    vi.advanceTimersByTime(1_500); // past the first cue's deadline
    expect(useOpenCueStore.getState().cue).toMatchObject({ name: 'b.md' });
    vi.advanceTimersByTime(OPEN_CUE_MS);
    expect(useOpenCueStore.getState().cue).toBeNull();
  });

  it('clear() dismisses at once and leaves no timer behind to dismiss a later cue early', () => {
    useOpenCueStore.getState().show(cue('a.md'));
    vi.advanceTimersByTime(OPEN_CUE_MS - 1_000);
    useOpenCueStore.getState().clear();
    expect(useOpenCueStore.getState().cue).toBeNull();
    useOpenCueStore.getState().show(cue('b.md'));
    vi.advanceTimersByTime(2_000); // would pass the cleared cue's old deadline
    expect(useOpenCueStore.getState().cue).toMatchObject({ name: 'b.md' });
  });

  it('gives every cue its own id', () => {
    useOpenCueStore.getState().show(cue('a.md'));
    const first = useOpenCueStore.getState().cue!.id;
    useOpenCueStore.getState().show(cue('a.md'));
    expect(useOpenCueStore.getState().cue!.id).not.toBe(first);
  });
});

describe('cueFileName', () => {
  it.each([
    ['/repo/docs/plan.md', 'plan.md'],
    ['docs/plan.md', 'plan.md'],
    ['README.md', 'README.md'],
    ['/repo/docs/', 'docs'],
    ['/', '/'],
  ])('%s -> %s', (path, name) => {
    expect(cueFileName(path)).toBe(name);
  });
});
