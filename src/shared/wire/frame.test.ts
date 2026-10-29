import { describe, expect, it } from 'vitest';
import { FRAME_HEADER_BYTES, FrameDecoder, FrameError, encodeFrame } from './frame';

const CAP = 1024;

function header(length: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  new DataView(out.buffer).setUint32(0, length, false);
  return out;
}

function rawFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  out.set(header(body.length), 0);
  out.set(body, FRAME_HEADER_BYTES);
  return out;
}

function frameError(fn: () => unknown): FrameError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FrameError);
    return err as FrameError;
  }
  throw new Error('expected a FrameError');
}

describe('encodeFrame', () => {
  it('writes a 4-byte big-endian body length followed by the UTF-8 JSON body', () => {
    const frame = encodeFrame({ a: 1 }, CAP);
    expect([...frame.subarray(0, 4)]).toEqual([0, 0, 0, 7]);
    expect(new TextDecoder().decode(frame.subarray(4))).toBe('{"a":1}');
  });

  it('counts bytes, not characters, in the length header', () => {
    const frame = encodeFrame({ p: '日本語' }, CAP);
    const body = new TextEncoder().encode('{"p":"日本語"}');
    expect(new DataView(frame.buffer).getUint32(0, false)).toBe(body.length);
    expect(body.length).toBeGreaterThan('{"p":"日本語"}'.length);
  });

  it('accepts a body exactly at the cap and rejects one byte over', () => {
    const atCap = 'a'.repeat(CAP - 2); // plus the two JSON quotes
    expect(encodeFrame(atCap, CAP).length).toBe(FRAME_HEADER_BYTES + CAP);
    const err = frameError(() => encodeFrame(atCap + 'a', CAP));
    expect(err.code).toBe('too-large');
    expect(err.message).toBe(`frame too large: ${CAP + 1} bytes`);
  });

  it('rejects a payload with no JSON form', () => {
    expect(frameError(() => encodeFrame(undefined, CAP)).code).toBe('malformed');
  });
});

describe('FrameDecoder', () => {
  it('round-trips a payload', () => {
    const payload = { v: 1, id: 7, op: 'open', args: { path: '/x/日本語 y.md' } };
    expect(new FrameDecoder(CAP).push(encodeFrame(payload, CAP))).toEqual([payload]);
  });

  it('reassembles a frame fed one byte at a time and reports nothing until the last byte', () => {
    const frame = encodeFrame({ id: 1, text: 'x'.repeat(300) }, CAP);
    const decoder = new FrameDecoder(CAP);
    let decoded: unknown[] = [];
    for (let i = 0; i < frame.length; i += 1) {
      const out = decoder.push(frame.subarray(i, i + 1));
      if (i < frame.length - 1) expect(out).toHaveLength(0);
      else decoded = out;
    }
    expect(decoded).toEqual([{ id: 1, text: 'x'.repeat(300) }]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('decodes several frames delivered in one chunk, in order', () => {
    const a = encodeFrame({ n: 1 }, CAP);
    const b = encodeFrame({ n: 2 }, CAP);
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0);
    both.set(b, a.length);
    expect(new FrameDecoder(CAP).push(both)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('reads chunks that are offset views into a larger buffer (Node Buffer pool)', () => {
    const frame = encodeFrame({ ok: true }, CAP);
    const pooled = Buffer.concat([Buffer.from([9, 9, 9]), Buffer.from(frame), Buffer.from([8])]);
    expect(new FrameDecoder(CAP).push(pooled.subarray(3, 3 + frame.length))).toEqual([
      { ok: true },
    ]);
  });

  it('accepts a body exactly at the cap', () => {
    const atCap = 'a'.repeat(CAP - 2);
    expect(new FrameDecoder(CAP).push(encodeFrame(atCap, CAP))).toEqual([atCap]);
  });

  it('rejects an oversize header as soon as the header is readable, before any body', () => {
    const err = frameError(() => new FrameDecoder(CAP).push(header(CAP + 1)));
    expect(err.code).toBe('too-large');
    expect(err.message).toBe(`frame too large: ${CAP + 1} bytes`);
    expect(frameError(() => new FrameDecoder(CAP).push(header(0xffffffff))).code).toBe('too-large');
  });

  it('rejects an oversize header that arrives split across chunks', () => {
    const decoder = new FrameDecoder(CAP);
    const h = header(CAP + 1);
    expect(decoder.push(h.subarray(0, 2))).toEqual([]);
    expect(frameError(() => decoder.push(h.subarray(2))).code).toBe('too-large');
  });

  it('keeps a truncated frame pending and counts its bytes', () => {
    const decoder = new FrameDecoder(CAP);
    expect(decoder.push(new Uint8Array([0, 0]))).toEqual([]);
    expect(decoder.pendingBytes).toBe(2);
    const frame = encodeFrame({ a: 'b' }, CAP);
    const half = new FrameDecoder(CAP);
    expect(half.push(frame.subarray(0, frame.length - 1))).toEqual([]);
    expect(half.pendingBytes).toBe(frame.length - 1);
  });

  it('keeps trailing bytes of a following frame pending', () => {
    const frame = encodeFrame({ a: 1 }, CAP);
    const withTail = new Uint8Array(frame.length + 3);
    withTail.set(frame, 0);
    withTail.set([0, 0, 9], frame.length);
    const decoder = new FrameDecoder(CAP);
    expect(decoder.push(withTail)).toEqual([{ a: 1 }]);
    expect(decoder.pendingBytes).toBe(3);
  });

  it('ignores an empty chunk', () => {
    const decoder = new FrameDecoder(CAP);
    expect(decoder.push(new Uint8Array(0))).toEqual([]);
    expect(decoder.pendingBytes).toBe(0);
  });

  it('rejects a body that is not JSON, an empty body, and a byte order mark', () => {
    const enc = new TextEncoder();
    expect(frameError(() => new FrameDecoder(CAP).push(rawFrame(enc.encode('{oops')))).code).toBe(
      'malformed',
    );
    expect(frameError(() => new FrameDecoder(CAP).push(rawFrame(new Uint8Array(0)))).code).toBe(
      'malformed',
    );
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('{}')]);
    expect(frameError(() => new FrameDecoder(CAP).push(rawFrame(bom))).code).toBe('malformed');
  });

  it('decodes any chunking of a frame stream to the same payloads (seeded fuzz)', () => {
    // mulberry32: a tiny deterministic PRNG, so a failure reproduces.
    let state = 0x9e3779b9;
    const random = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let round = 0; round < 200; round += 1) {
      const payloads = Array.from({ length: 1 + Math.floor(random() * 4) }, (_, i) =>
        random() < 0.2
          ? i
          : { i, text: 'é日'.repeat(Math.floor(random() * 120)), nested: { n: random() } },
      );
      const frames = payloads.map((p) => encodeFrame(p, 1 << 20));
      const stream = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
      let at = 0;
      for (const f of frames) {
        stream.set(f, at);
        at += f.length;
      }
      const decoder = new FrameDecoder(1 << 20);
      const decoded: unknown[] = [];
      for (let i = 0; i < stream.length; ) {
        // Mix 1-byte, small and large chunks, so headers and bodies split everywhere.
        const size = random() < 0.4 ? 1 : 1 + Math.floor(random() * 90);
        decoded.push(...decoder.push(stream.subarray(i, i + size)));
        i += size;
      }
      expect(decoded).toEqual(payloads);
      expect(decoder.pendingBytes).toBe(0);
    }
  });

  it('is poisoned after an error: later pushes rethrow it', () => {
    const decoder = new FrameDecoder(CAP);
    const first = frameError(() => decoder.push(header(CAP + 1)));
    expect(frameError(() => decoder.push(encodeFrame({ fine: true }, CAP)))).toBe(first);
  });
});
