/**
 * Byte codecs for the tmux control protocol.
 *
 * `%output` payloads are octal-escaped by tmux: bytes outside a safe printable
 * range are emitted as `\ooo` (three octal digits), and a literal backslash as
 * `\\`. `decodeOutput` reverses that into the original bytes. `toHex` encodes
 * arbitrary input bytes as the hex-pair string `send-keys -H` expects.
 *
 * Pure functions: no I/O, no Node Buffer dependency (so renderer + node both
 * use the same code path).
 */

const BACKSLASH = 0x5c; // '\'

/** True when `c` is an ASCII octal digit (`0`-`7`). */
function isOctalDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x37;
}

/**
 * Decode a tmux `%output` octal-escaped payload into raw bytes.
 *
 * Recognized escapes:
 * - `\\` -> a single backslash byte.
 * - `\ooo` -> the byte whose value is the (1-3 digit) octal number `ooo`.
 *
 * tmux always emits exactly three octal digits, but we accept 1-3 for
 * robustness. A trailing lone backslash (truncated input) is preserved as a
 * literal backslash byte rather than dropped.
 */
export function decodeOutput(payload: string): Uint8Array {
  const out: number[] = [];
  // Operate on char codes; the payload is ASCII (tmux escapes anything else).
  for (let i = 0; i < payload.length; i += 1) {
    const c = payload.charCodeAt(i);
    if (c !== BACKSLASH) {
      out.push(c & 0xff);
      continue;
    }
    // We are at a backslash.
    const next = i + 1 < payload.length ? payload.charCodeAt(i + 1) : -1;
    if (next === BACKSLASH) {
      out.push(BACKSLASH);
      i += 1;
      continue;
    }
    if (next >= 0 && isOctalDigit(next)) {
      let value = 0;
      let digits = 0;
      let j = i + 1;
      while (j < payload.length && digits < 3 && isOctalDigit(payload.charCodeAt(j))) {
        value = value * 8 + (payload.charCodeAt(j) - 0x30);
        j += 1;
        digits += 1;
      }
      out.push(value & 0xff);
      i = j - 1;
      continue;
    }
    // Lone/unknown escape: keep the backslash literally.
    out.push(BACKSLASH);
  }
  return Uint8Array.from(out);
}

/**
 * Encode bytes (or a UTF-8 string) as a lowercase hex-pair string for
 * `send-keys -t %<pane> -H <pair> <pair> …`. tmux's `-H` flag takes
 * SPACE-SEPARATED two-digit hex bytes (verified against tmux 3.x), so the pairs
 * are joined with spaces. Using hex sidesteps all shell quoting/escaping
 * concerns for control keys, paste, and multibyte input.
 */
export function toHex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  const pairs: string[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    pairs.push(bytes[i]!.toString(16).padStart(2, '0'));
  }
  return pairs.join(' ');
}

/**
 * Decode a space-separated lowercase hex-pair string (as produced by
 * {@link toHex}) back into raw bytes. Whitespace-tolerant; empty → empty.
 * Inverse of {@link toHex} for the `send-keys -H` wire form.
 */
export function fromHex(hex: string): Uint8Array {
  const trimmed = hex.trim();
  if (trimmed === '') return new Uint8Array(0);
  const parts = trimmed.split(/\s+/);
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i += 1) out[i] = Number.parseInt(parts[i]!, 16) & 0xff;
  return out;
}

/** Minimal UTF-8 encoder (TextEncoder is available in node + jsdom + browser). */
function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Max payload bytes per `send-keys -H` chunk.
 *
 * tmux/PTY drop an over-long control-mode command line (a single huge
 * `send-keys`), so a large paste must be split across several `send-keys` calls
 * — otherwise the whole paste silently vanishes. iTerm2's tmux integration
 * splits long `send-keys` into sub-1024-byte *command* lines for the same
 * reason. The hex encoding is ~3 chars/byte (two hex digits + a space) and the
 * `send-keys -t %NN -H ` prefix adds ~20 chars, so 256 payload bytes keeps the
 * command line under ~800 chars — comfortably below the limit. Keystrokes and
 * other small input fit in a single chunk (no behavior change); only large
 * pastes fan out.
 */
export const MAX_SEND_KEYS_CHUNK_BYTES = 256;

/** True for a UTF-8 continuation byte (`10xxxxxx`, i.e. 0x80-0xBF). */
function isUtf8Continuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/**
 * Split input into `<= max`-byte chunks for separate `send-keys -H` calls,
 * never ending a chunk in the middle of a multi-byte UTF-8 codepoint.
 *
 * A boundary mid-codepoint is harmless at the byte level (the pane reassembles
 * the bytes in order), but iTerm2 hit a real "paste nothing" bug from boundary
 * splits, so we keep every chunk a valid standalone UTF-8 sequence. The
 * back-up is bounded by the max UTF-8 length (4 bytes), so it is cheap.
 *
 * Returns `[]` for empty input and a single chunk for input that already fits.
 */
export function chunkBytesForSendKeys(
  input: string | Uint8Array,
  max: number = MAX_SEND_KEYS_CHUNK_BYTES,
): Uint8Array[] {
  const bytes = typeof input === 'string' ? utf8Encode(input) : input;
  if (bytes.length === 0) return [];
  if (bytes.length <= max) return [bytes];
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + max, bytes.length);
    // Back the boundary up off any UTF-8 continuation byte so a codepoint is
    // never split across chunks. Guard `end > start + 1` so we always advance.
    while (end < bytes.length && end > start + 1 && isUtf8Continuation(bytes[end]!)) {
      end -= 1;
    }
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}
