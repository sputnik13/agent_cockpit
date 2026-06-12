import { describe, it, expect } from 'vitest';
import { encodeWheelTick, encodeWheel } from './wheelEncode';

const bytes = (s: string): number[] => Array.from(new TextEncoder().encode(s));

describe('encodeWheelTick', () => {
  it('emits SGR press sequences with unbounded ASCII coordinates', () => {
    expect(Array.from(encodeWheelTick({ sgr: true, up: true, col: 10, row: 5 }))).toEqual(
      bytes('\x1b[<64;10;5M'),
    );
    expect(Array.from(encodeWheelTick({ sgr: true, up: false, col: 300, row: 12 }))).toEqual(
      bytes('\x1b[<65;300;12M'),
    );
  });

  it('emits X10/standard 6-byte sequences with the +32 offset', () => {
    // ESC [ M, button+32 (64+32=96 up / 65+32=97 down), col+32, row+32
    expect(Array.from(encodeWheelTick({ sgr: false, up: true, col: 10, row: 5 }))).toEqual([
      0x1b, 0x5b, 0x4d, 96, 10 + 32, 5 + 32,
    ]);
    expect(Array.from(encodeWheelTick({ sgr: false, up: false, col: 1, row: 1 }))).toEqual([
      0x1b, 0x5b, 0x4d, 97, 33, 33,
    ]);
  });

  it('clamps X10 coordinates to 223 (the protocol max)', () => {
    const out = Array.from(encodeWheelTick({ sgr: false, up: true, col: 999, row: 999 }));
    expect(out).toEqual([0x1b, 0x5b, 0x4d, 96, 223 + 32, 223 + 32]);
    expect(out[4]).toBe(255); // stays a single byte
    expect(out[5]).toBe(255);
  });
});

describe('encodeWheel', () => {
  it('repeats a tick N times', () => {
    const one = encodeWheelTick({ sgr: true, up: true, col: 2, row: 3 });
    const three = encodeWheel({ sgr: true, up: true, col: 2, row: 3 }, 3);
    expect(three.length).toBe(one.length * 3);
    expect(Array.from(three.subarray(0, one.length))).toEqual(Array.from(one));
  });

  it('treats ticks < 1 as a single tick', () => {
    const one = encodeWheelTick({ sgr: false, up: false, col: 4, row: 4 });
    expect(Array.from(encodeWheel({ sgr: false, up: false, col: 4, row: 4 }, 0))).toEqual(
      Array.from(one),
    );
  });
});
