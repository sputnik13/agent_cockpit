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

/** Minimal UTF-8 encoder (TextEncoder is available in node + jsdom + browser). */
function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
