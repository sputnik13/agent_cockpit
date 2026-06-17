import { describe, expect, it } from 'vitest';
import { activeViewKey, LAYOUT_VERSION, layoutKey } from './layoutKeys';
import { ratioLabel, sideColumnWidths } from './presets';

describe('layout keys', () => {
  it('keys layout per project and per view', () => {
    expect(layoutKey('p1', 'edit')).toBe(`agent-cockpit:layout:v${LAYOUT_VERSION}:p1:edit`);
    expect(layoutKey('p1', 'review')).toBe(`agent-cockpit:layout:v${LAYOUT_VERSION}:p1:review`);
    // Edit and Review never collide for the same project.
    expect(layoutKey('p1', 'edit')).not.toBe(layoutKey('p1', 'review'));
  });

  it('keys the active view per project', () => {
    expect(activeViewKey('p1')).toBe('agent-cockpit:view:p1');
  });
});

describe('sideColumnWidths (left:center:right split)', () => {
  it('defaults to 1:3:1 (each side = total/5, equal)', () => {
    expect(sideColumnWidths(1000)).toEqual({ left: 200, right: 200 }); // center 600
  });

  it('honors symmetric ratios', () => {
    expect(sideColumnWidths(1000, [1, 2, 1])).toEqual({ left: 250, right: 250 }); // center 500
    expect(sideColumnWidths(900, [1, 1, 1])).toEqual({ left: 300, right: 300 }); // center 300
  });

  it('supports the asymmetric 2:3:1 (left twice the right)', () => {
    // parts = 6: left 2/6, right 1/6, center auto-takes 3/6.
    expect(sideColumnWidths(1200, [2, 3, 1])).toEqual({ left: 400, right: 200 });
  });

  it('never returns a non-positive width', () => {
    const w = sideColumnWidths(0);
    expect(w.left).toBeGreaterThan(0);
    expect(w.right).toBeGreaterThan(0);
  });
});

describe('ratioLabel', () => {
  it('formats the column ratio', () => {
    expect(ratioLabel([1, 3, 1])).toBe('1:3:1');
    expect(ratioLabel([1, 2, 1])).toBe('1:2:1');
    expect(ratioLabel([1, 1, 1])).toBe('1:1:1');
    expect(ratioLabel([2, 3, 1])).toBe('2:3:1');
  });
});
