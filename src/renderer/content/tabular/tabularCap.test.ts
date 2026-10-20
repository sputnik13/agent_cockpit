import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  TABULAR_CEILING_BYTES,
  TABULAR_FALLBACK_BYTES,
  TABULAR_FLOOR_BYTES,
  readHeapStats,
  tabularMaxBytes,
} from './tabularCap';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

describe('tabularMaxBytes (memory-derived cap)', () => {
  it('uses the conservative fallback when heap stats are unavailable', () => {
    expect(tabularMaxBytes(null)).toBe(TABULAR_FALLBACK_BYTES);
  });

  it('is bounded by the hard ceiling when memory is plentiful', () => {
    expect(tabularMaxBytes({ limit: 4 * GiB, used: 100 * MiB })).toBe(TABULAR_CEILING_BYTES);
  });

  it('shrinks as free heap shrinks, proportionally (25% / 8x expansion)', () => {
    // 512 MiB headroom * 0.25 / 8 = 16 MiB
    expect(tabularMaxBytes({ limit: 1 * GiB, used: 512 * MiB })).toBe(16 * MiB);
    // 128 MiB headroom -> 4 MiB
    expect(tabularMaxBytes({ limit: 1 * GiB, used: 896 * MiB })).toBe(4 * MiB);
  });

  it('never drops below the floor, even with no headroom or used > limit', () => {
    expect(tabularMaxBytes({ limit: 1 * GiB, used: 1 * GiB })).toBe(TABULAR_FLOOR_BYTES);
    expect(tabularMaxBytes({ limit: 1 * GiB, used: 2 * GiB })).toBe(TABULAR_FLOOR_BYTES);
  });
});

describe('readHeapStats', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads Chromium performance.memory', () => {
    vi.stubGlobal('performance', { memory: { jsHeapSizeLimit: 100, usedJSHeapSize: 40 } });
    expect(readHeapStats()).toEqual({ limit: 100, used: 40 });
  });

  it('returns null when the API is absent or malformed', () => {
    vi.stubGlobal('performance', {});
    expect(readHeapStats()).toBeNull();
    vi.stubGlobal('performance', { memory: { jsHeapSizeLimit: 'x' } });
    expect(readHeapStats()).toBeNull();
  });
});
