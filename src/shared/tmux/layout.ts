/**
 * Parser for the tmux window-layout string carried by `%layout-change` and
 * `list-windows -F '#{window_layout}'`.
 *
 * Grammar (tmux `layout_dump`/`layout_parse`):
 *   layout  := checksum "," cell
 *   cell    := WxH "," x "," y [ paneId | "{" cells "}" | "[" cells "]" ]
 *   cells   := cell ("," cell)*
 * where `{...}` is a left/right (horizontal) split and `[...]` is a top/bottom
 * (vertical) split. A bare numeric suffix is a leaf pane id (tmux emits the
 * pane *index* here, not the `%`-sigil id; callers correlate via geometry or
 * `list-panes`). The leading 4-hex `checksum` is preserved but not verified.
 *
 * Pure and fixture-tested. Throws `TmuxLayoutParseError` on malformed input so
 * callers can surface a typed boundary error instead of a silent bad tree.
 */
import type { LayoutDir, LayoutNode, WindowLayout } from './types';

export class TmuxLayoutParseError extends Error {
  constructor(message: string, readonly layout: string) {
    super(`tmux layout parse error: ${message} (in "${layout}")`);
    this.name = 'TmuxLayoutParseError';
  }
}

interface Cursor {
  s: string;
  i: number;
}

function fail(cur: Cursor, msg: string): never {
  throw new TmuxLayoutParseError(`${msg} at offset ${cur.i}`, cur.s);
}

function peek(cur: Cursor): string {
  return cur.i < cur.s.length ? cur.s[cur.i]! : '';
}

function expect(cur: Cursor, ch: string): void {
  if (peek(cur) !== ch) fail(cur, `expected "${ch}"`);
  cur.i += 1;
}

/** Read a run of decimal digits as a non-negative integer. */
function readUint(cur: Cursor): number {
  const start = cur.i;
  while (cur.i < cur.s.length && cur.s[cur.i]! >= '0' && cur.s[cur.i]! <= '9') cur.i += 1;
  if (cur.i === start) fail(cur, 'expected a number');
  return Number(cur.s.slice(start, cur.i));
}

/** Parse one `WxH,x,y[...]` cell into a layout node. */
function parseCell(cur: Cursor): LayoutNode {
  const w = readUint(cur);
  expect(cur, 'x');
  const h = readUint(cur);
  expect(cur, ',');
  const x = readUint(cur);
  expect(cur, ',');
  const y = readUint(cur);

  const c = peek(cur);
  if (c === '{' || c === '[') {
    const dir: LayoutDir = c === '{' ? 'lr' : 'tb';
    const open = c;
    const close = c === '{' ? '}' : ']';
    expect(cur, open);
    const children: LayoutNode[] = [parseCell(cur)];
    while (peek(cur) === ',') {
      cur.i += 1;
      children.push(parseCell(cur));
    }
    expect(cur, close);
    return { type: 'split', dir, w, h, x, y, children };
  }

  // Leaf: an optional `,paneId` suffix. The layout string encodes the bare pane
  // number, but tmux's actual pane id (used by `%output` and as a command target)
  // carries a `%` sigil — normalize to that so output routing and commands agree.
  if (c === ',') {
    cur.i += 1;
    const paneIndex = readUint(cur);
    return { type: 'leaf', paneId: `%${paneIndex}`, w, h, x, y };
  }
  // No pane suffix (rare/degenerate) — synthesize an empty leaf id.
  return { type: 'leaf', paneId: '', w, h, x, y };
}

/**
 * Parse a full tmux window-layout string (with its leading checksum) into a
 * {@link WindowLayout}. Throws on malformed input.
 */
export function parseLayout(layout: string): WindowLayout {
  const cur: Cursor = { s: layout, i: 0 };
  const checksumStart = cur.i;
  // checksum: hex digits up to the first comma.
  while (cur.i < layout.length && layout[cur.i] !== ',') cur.i += 1;
  const checksum = layout.slice(checksumStart, cur.i);
  if (checksum.length === 0) fail(cur, 'missing checksum');
  expect(cur, ',');
  const root = parseCell(cur);
  if (cur.i !== layout.length) fail(cur, 'trailing characters after layout');
  return { checksum, root };
}

/** Parse a layout string, returning null instead of throwing on bad input. */
export function tryParseLayout(layout: string): WindowLayout | null {
  try {
    return parseLayout(layout);
  } catch {
    return null;
  }
}
