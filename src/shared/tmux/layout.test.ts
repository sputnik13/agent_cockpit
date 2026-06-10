import { describe, expect, it } from 'vitest';
import { TmuxLayoutParseError, parseLayout, tryParseLayout } from './layout';
import type { LayoutLeaf, LayoutSplit } from './types';

describe('parseLayout (tmux window-layout string)', () => {
  it('parses a single full-window pane', () => {
    // 80x24 window, one pane (index 0).
    const wl = parseLayout('a1b2,80x24,0,0,0');
    expect(wl.checksum).toBe('a1b2');
    expect(wl.root.type).toBe('leaf');
    const leaf = wl.root as LayoutLeaf;
    expect(leaf).toMatchObject({ paneId: '%0', w: 80, h: 24, x: 0, y: 0 });
  });

  it('parses a horizontal (left/right) split with {}', () => {
    // Two side-by-side panes splitting an 80x24 window at column 40.
    const wl = parseLayout('cccc,80x24,0,0{40x24,0,0,1,39x24,41,0,2}');
    const root = wl.root as LayoutSplit;
    expect(root.type).toBe('split');
    expect(root.dir).toBe('lr');
    expect(root.children).toHaveLength(2);
    expect((root.children[0] as LayoutLeaf).paneId).toBe('%1');
    expect((root.children[0] as LayoutLeaf).w).toBe(40);
    expect((root.children[1] as LayoutLeaf).paneId).toBe('%2');
    expect((root.children[1] as LayoutLeaf).x).toBe(41);
  });

  it('parses a vertical (top/bottom) split with []', () => {
    const wl = parseLayout('dddd,80x24,0,0[80x12,0,0,3,80x11,0,13,4]');
    const root = wl.root as LayoutSplit;
    expect(root.dir).toBe('tb');
    expect(root.children).toHaveLength(2);
    expect((root.children[0] as LayoutLeaf).h).toBe(12);
    expect((root.children[1] as LayoutLeaf).y).toBe(13);
  });

  it('parses a nested split (lr containing a tb on the right)', () => {
    // Left pane full height; right column split top/bottom.
    const layout = 'eeee,80x24,0,0{40x24,0,0,5,39x24,41,0[39x12,41,0,6,39x11,41,13,7]}';
    const wl = parseLayout(layout);
    const root = wl.root as LayoutSplit;
    expect(root.dir).toBe('lr');
    expect(root.children).toHaveLength(2);
    const left = root.children[0] as LayoutLeaf;
    expect(left.type).toBe('leaf');
    expect(left.paneId).toBe('%5');
    const right = root.children[1] as LayoutSplit;
    expect(right.type).toBe('split');
    expect(right.dir).toBe('tb');
    expect(right.children.map((c) => (c as LayoutLeaf).paneId)).toEqual(['%6', '%7']);
  });

  it('parses a three-way horizontal split', () => {
    const wl = parseLayout('ffff,90x24,0,0{30x24,0,0,1,29x24,31,0,2,29x24,61,0,3}');
    const root = wl.root as LayoutSplit;
    expect(root.children).toHaveLength(3);
    expect(root.children.map((c) => (c as LayoutLeaf).paneId)).toEqual(['%1', '%2', '%3']);
  });

  it('preserves the full geometry of every leaf', () => {
    const wl = parseLayout('1111,100x40,0,0{50x40,0,0,8,49x40,51,0,9}');
    const root = wl.root as LayoutSplit;
    expect(root).toMatchObject({ w: 100, h: 40, x: 0, y: 0 });
    expect(root.children[0]).toMatchObject({ w: 50, h: 40, x: 0, y: 0, paneId: '%8' });
    expect(root.children[1]).toMatchObject({ w: 49, h: 40, x: 51, y: 0, paneId: '%9' });
  });

  it('throws a typed error on a missing checksum', () => {
    expect(() => parseLayout(',80x24,0,0,0')).toThrow(TmuxLayoutParseError);
  });

  it('throws a typed error on malformed geometry', () => {
    expect(() => parseLayout('aaaa,80,0,0,0')).toThrow(TmuxLayoutParseError);
  });

  it('throws on trailing characters after a complete layout', () => {
    expect(() => parseLayout('aaaa,80x24,0,0,0xyz')).toThrow(TmuxLayoutParseError);
  });

  it('tryParseLayout returns null instead of throwing', () => {
    expect(tryParseLayout('garbage')).toBeNull();
    expect(tryParseLayout('aaaa,80x24,0,0,0')).not.toBeNull();
  });
});
