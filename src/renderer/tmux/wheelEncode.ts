/**
 * Encode a terminal mouse-wheel event as the raw input bytes an application
 * expects, in the protocol it negotiated.
 *
 * In `-CC` control mode tmux never puts the renderer (the control client) into
 * mouse mode, so we synthesize the wheel ourselves and inject it into the pane.
 * Apps negotiate one of two encodings, and an app in one mode cannot parse the
 * other — so emitting the wrong one is silently dropped (the original bug:
 * vim negotiates the legacy X10/standard protocol, `#{mouse_sgr_flag}=0`, but
 * only SGR was emitted, so its wheel never scrolled):
 *
 * - **SGR (1006)**: `CSI < Cb ; Cx ; Cy M` — ASCII decimal, unbounded coordinates.
 * - **X10 / standard (1000)**: `CSI M` then three single bytes `Cb+32, Cx+32,
 *   Cy+32`. Coordinates are limited to 223 (255 − 32) and are clamped. These are
 *   raw bytes (often ≥ 0x80), so callers MUST send the returned `Uint8Array`
 *   verbatim — never via a UTF-8 string path.
 *
 * Wheel buttons are press-only: button 64 (up) / 65 (down).
 */

const ESC = 0x1b;
const enc = new TextEncoder();

export interface WheelEncodeOpts {
  /** App negotiated SGR (1006) mouse; otherwise legacy X10/standard (1000). */
  sgr: boolean;
  /** Wheel direction (true = up / away from user). */
  up: boolean;
  /** 1-based terminal column under the pointer. */
  col: number;
  /** 1-based terminal row under the pointer. */
  row: number;
}

/** One wheel "tick" as raw terminal-input bytes for the negotiated protocol. */
export function encodeWheelTick({ sgr, up, col, row }: WheelEncodeOpts): Uint8Array {
  const button = up ? 64 : 65;
  if (sgr) {
    return enc.encode(`\x1b[<${button};${col};${row}M`);
  }
  const cx = Math.min(Math.max(Math.trunc(col), 1), 223) + 32;
  const cy = Math.min(Math.max(Math.trunc(row), 1), 223) + 32;
  return Uint8Array.from([ESC, 0x5b, 0x4d, button + 32, cx, cy]);
}

/** `ticks` wheel ticks (>=1) concatenated into one byte sequence. */
export function encodeWheel(opts: WheelEncodeOpts, ticks: number): Uint8Array {
  const one = encodeWheelTick(opts);
  const n = Math.max(1, Math.trunc(ticks));
  if (n === 1) return one;
  const out = new Uint8Array(one.length * n);
  for (let i = 0; i < n; i += 1) out.set(one, i * one.length);
  return out;
}
