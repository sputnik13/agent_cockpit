import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractScreenTitle, resetScreenTitleState as reset } from './extractScreenTitle';

const bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const text = (b: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < b.length; i += 1) out += String.fromCharCode(b[i]!);
  return out;
};

afterEach(() => reset());

describe('extractScreenTitle', () => {
  it('drops the title sequence and surfaces the title', () => {
    const onTitle = vi.fn();
    const out = extractScreenTitle('proj-a', '%1', bytes('hello\x1bkvim\x1b\\world'), onTitle);
    expect(text(out)).toBe('helloworld');
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('vim');
  });

  it('preserves unrelated escape sequences', () => {
    const onTitle = vi.fn();
    const out = extractScreenTitle('proj-a', '%1', bytes('a\x1b[31mred\x1b[0m'), onTitle);
    expect(text(out)).toBe('a\x1b[31mred\x1b[0m');
    expect(onTitle).not.toHaveBeenCalled();
  });

  it('handles a sequence split across chunks', () => {
    const onTitle = vi.fn();
    let acc = '';
    acc += text(extractScreenTitle('proj-a', '%1', bytes('pre\x1bkv'), onTitle));
    acc += text(extractScreenTitle('proj-a', '%1', bytes('im'), onTitle));
    acc += text(extractScreenTitle('proj-a', '%1', bytes('\x1b\\post'), onTitle));
    expect(acc).toBe('prepost');
    expect(onTitle).toHaveBeenCalledTimes(1);
    expect(onTitle).toHaveBeenCalledWith('vim');
  });

  it('keeps per-pane state isolated (same project, different panes)', () => {
    const a = vi.fn();
    const b = vi.fn();
    extractScreenTitle('proj-a', '%1', bytes('\x1bkaaa'), a); // %1 enters skip
    extractScreenTitle('proj-a', '%2', bytes('plain'), b); // %2 stays normal
    expect(b).not.toHaveBeenCalled();
    const out1 = extractScreenTitle('proj-a', '%1', bytes('\x1b\\done'), a);
    expect(text(out1)).toBe('done');
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('aaa');
  });

  it('keeps per-pane state isolated across projects (same paneId, different projectId)', () => {
    // This is the 48wb fix: pane %0 in proj-a must not inherit state from proj-b.
    const titleA = vi.fn();
    const titleB = vi.fn();
    // proj-a's %0 enters title-skip state mid-sequence.
    extractScreenTitle('proj-a', '%0', bytes('\x1bkvim'), titleA);
    // proj-b's %0 must start in a clean 'normal' state (no cross-project leakage).
    const outB = extractScreenTitle('proj-b', '%0', bytes('normal text'), titleB);
    expect(text(outB)).toBe('normal text'); // must not consume bytes as title
    expect(titleB).not.toHaveBeenCalled();
  });

  it('resetScreenTitleState(projectId, paneId) clears only that pane', () => {
    const onTitle = vi.fn();
    // Start a title sequence in proj-a/%0
    extractScreenTitle('proj-a', '%0', bytes('\x1bk'), onTitle);
    reset('proj-a', '%0');
    // After reset, a fresh input to proj-a/%0 must start clean (normal state).
    const out = extractScreenTitle('proj-a', '%0', bytes('plain'), onTitle);
    expect(text(out)).toBe('plain');
  });

  it('resetScreenTitleState(projectId) clears all panes for that project', () => {
    const onTitle = vi.fn();
    extractScreenTitle('proj-a', '%0', bytes('\x1bk'), onTitle);
    extractScreenTitle('proj-a', '%1', bytes('\x1bk'), onTitle);
    extractScreenTitle('proj-b', '%0', bytes('\x1bk'), onTitle);
    reset('proj-a');
    // proj-a panes must now start clean.
    expect(text(extractScreenTitle('proj-a', '%0', bytes('x'), onTitle))).toBe('x');
    expect(text(extractScreenTitle('proj-a', '%1', bytes('x'), onTitle))).toBe('x');
    // proj-b/%0 still mid-skip (was not reset).
    expect(text(extractScreenTitle('proj-b', '%0', bytes('y'), onTitle))).toBe('');
  });

  it('recovers from a non-screen escape after the introducer (ESC X with X != k)', () => {
    const onTitle = vi.fn();
    // ESC O — not a SCREEN title; should pass through as ESC O so xterm
    // processes the SS3 sequence normally.
    const out = extractScreenTitle('proj-a', '%1', bytes('a\x1bOPb'), onTitle);
    expect(text(out)).toBe('a\x1bOPb');
    expect(onTitle).not.toHaveBeenCalled();
  });
});
