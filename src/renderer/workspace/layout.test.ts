import { describe, expect, it } from 'vitest';
import { activeViewKey, LAYOUT_VERSION, layoutKey } from './layoutKeys';
import { ratioLabel, sideColumnWidth } from './presets';

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

describe('sideColumnWidth (1:center:1 split)', () => {
  it('defaults to 1:3:1 (each side = total/5)', () => {
    expect(sideColumnWidth(1000)).toBe(200); // center 600 => 1:3:1
  });

  it('honors other ratios', () => {
    expect(sideColumnWidth(1000, 2)).toBe(250); // /4 => center 500 => 1:2:1
    expect(sideColumnWidth(900, 1)).toBe(300); // /3 => center 300 => 1:1:1
  });

  it('never returns a non-positive width', () => {
    expect(sideColumnWidth(0)).toBeGreaterThan(0);
  });
});

describe('ratioLabel', () => {
  it('formats the column ratio', () => {
    expect(ratioLabel(3)).toBe('1:3:1');
    expect(ratioLabel(2)).toBe('1:2:1');
    expect(ratioLabel(1)).toBe('1:1:1');
  });
});
