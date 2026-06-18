import { describe, it, expect } from 'vitest';
import { isOutdated } from './anchor';

describe('isOutdated', () => {
  it('is false when there is no anchor snapshot', () => {
    expect(isOutdated(null, 'anything')).toBe(false);
    expect(isOutdated(undefined, 'anything')).toBe(false);
  });

  it('is false when the live line matches (ignoring surrounding whitespace)', () => {
    expect(isOutdated('const x = 1;', 'const x = 1;')).toBe(false);
    expect(isOutdated('  const x = 1;', 'const x = 1;  ')).toBe(false);
  });

  it('is true when the live line text changed', () => {
    expect(isOutdated('const x = 1;', 'const x = 2;')).toBe(true);
  });

  it('is true when the anchored line no longer exists', () => {
    expect(isOutdated('const x = 1;', null)).toBe(true);
    expect(isOutdated('const x = 1;', undefined)).toBe(true);
  });
});
