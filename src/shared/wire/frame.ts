/**
 * Length-prefixed JSON framing shared by every cockpit wire protocol: the
 * helper RPC stream (`electron/main/providers/remote/rpcClient.ts`, 16 MiB cap)
 * and the terminal callback socket (`src/shared/callback/protocol.ts`, 64 KiB
 * cap). The cap is a parameter, not a constant, because the two protocols
 * deliberately differ.
 *
 * Wire layout: a 4-byte big-endian uint32 body length, then that many bytes of
 * UTF-8 JSON. `remote-helper/protocol.go` implements the same layout; the
 * callback fixtures under `src/shared/callback/fixtures` pin the cases a Go
 * mirror must agree on.
 *
 * Pure functions over `Uint8Array`: no Node `Buffer` dependency (like
 * `src/shared/tmux/codec.ts`), because `src/shared` is type-checked by the
 * renderer project too. Node `Buffer` values are `Uint8Array`s, so Node callers
 * pass and receive them unchanged.
 */

export const FRAME_HEADER_BYTES = 4;

export type FrameErrorCode = 'too-large' | 'malformed';

/** Raised by {@link encodeFrame} / {@link FrameDecoder} for a frame the wire layout rejects. */
export class FrameError extends Error {
  readonly code: FrameErrorCode;
  constructor(code: FrameErrorCode, message: string) {
    super(message);
    this.name = 'FrameError';
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
// `ignoreBOM: true` keeps a leading U+FEFF in the decoded text, as
// `Buffer#toString('utf8')` always did, so JSON.parse rejects it exactly as the
// decoder this module was extracted from did.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Encode a JSON-serializable payload as one length-prefixed frame. */
export function encodeFrame(payload: unknown, maxFrameBytes: number): Uint8Array {
  const json = JSON.stringify(payload);
  if (json === undefined) throw new FrameError('malformed', 'payload is not JSON-serializable');
  const body = textEncoder.encode(json);
  if (body.length > maxFrameBytes) {
    throw new FrameError('too-large', `frame too large: ${body.length} bytes`);
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, false);
  frame.set(body, FRAME_HEADER_BYTES);
  return frame;
}

/** The body length declared by the first four buffered bytes (which may span chunks). */
function declaredLength(chunks: readonly Uint8Array[]): number {
  let length = 0;
  let read = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length && read < FRAME_HEADER_BYTES; i += 1, read += 1) {
      length = length * 256 + chunk[i]!; // not <<, which would wrap above 2^31
    }
    if (read === FRAME_HEADER_BYTES) break;
  }
  return length;
}

/**
 * Incremental frame decoder. Feed it arbitrary chunks; it yields complete
 * payloads as they become available, buffering partial frames across chunks.
 *
 * An oversize length header is rejected as soon as the 4 header bytes are
 * readable, before any body is buffered, so a hostile peer cannot make the
 * decoder allocate against a bogus length. After a {@link FrameError} the
 * decoder is poisoned: every later `push` rethrows it, and the caller is
 * expected to drop the stream.
 */
export class FrameDecoder {
  // Pending chunks held WITHOUT concatenation. A frame is copied into one
  // contiguous buffer exactly once, when it is complete (and not at all when it
  // arrived in a single chunk), so a large frame that trickles in as many small
  // packets costs O(bytes), not O(bytes x chunks).
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** Header + body bytes of the frame being assembled; null until its header is readable. */
  private frameBytes: number | null = null;
  private failure: FrameError | null = null;

  constructor(private readonly maxFrameBytes: number) {}

  /** Bytes received that do not (yet) form a complete frame. Non-zero when the
   *  stream ends means the peer's final frame was truncated. */
  get pendingBytes(): number {
    return this.buffered;
  }

  /** Append a chunk and return any complete payloads decoded from the buffer. */
  push(chunk: Uint8Array): unknown[] {
    if (this.failure) throw this.failure;
    if (chunk.length === 0) return [];
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const out: unknown[] = [];
    for (;;) {
      if (this.frameBytes === null) {
        if (this.buffered < FRAME_HEADER_BYTES) break;
        const length = declaredLength(this.chunks);
        if (length > this.maxFrameBytes) {
          throw this.fail(new FrameError('too-large', `frame too large: ${length} bytes`));
        }
        this.frameBytes = FRAME_HEADER_BYTES + length;
      }
      if (this.buffered < this.frameBytes) break;
      const frame = this.take(this.frameBytes);
      this.frameBytes = null;
      try {
        out.push(JSON.parse(textDecoder.decode(frame.subarray(FRAME_HEADER_BYTES))));
      } catch (err) {
        throw this.fail(
          new FrameError('malformed', err instanceof Error ? err.message : String(err)),
        );
      }
    }
    return out;
  }

  /** Remove and return the first `n` buffered bytes as one contiguous view. */
  private take(n: number): Uint8Array {
    this.buffered -= n;
    const first = this.chunks[0]!;
    if (first.length >= n) {
      const rest = first.subarray(n);
      if (rest.length > 0) this.chunks[0] = rest;
      else this.chunks.shift();
      return first.subarray(0, n);
    }
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.chunks[0]!;
      const need = n - offset;
      if (chunk.length <= need) {
        out.set(chunk, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        out.set(chunk.subarray(0, need), offset);
        this.chunks[0] = chunk.subarray(need);
        offset = n;
      }
    }
    return out;
  }

  private fail(error: FrameError): FrameError {
    this.failure = error;
    return error;
  }
}
