/**
 * Pure CSV/TSV engine behind the Content panel's table view: RFC-4180 parsing
 * plus sort/filter over a row-INDEX array. Runs in tabularWorker.ts off the
 * renderer's main thread (inline under test / if the worker can't start) — see
 * tabularClient.ts. No DOM, no React, no I/O.
 *
 * Memory discipline (the reason this is index-based): the parsed rows are held
 * exactly once. Sorting and filtering never copy rows or cells — they only
 * build a `Uint32Array` of body-row indices (4 bytes/row), and the view asks
 * for the visible window via {@link TabularEngine.rows}. The total size of what
 * may be parsed at all is bounded upstream by tabularCap.ts.
 */

export type Delimiter = ',' | '\t';

export interface TabularInfo {
  /** First record (treated as the header), padded to `columns`. */
  header: string[];
  /** Number of body records (excludes the header). */
  rowCount: number;
  /** Widest record's field count. */
  columns: number;
}

export interface TabularQuery {
  /** Column to sort by; `-1` = source order. */
  sortCol: number;
  sortDir: 'asc' | 'desc';
  /** Case-insensitive substring matched against every cell; empty = no filter. */
  filter: string;
}

/** One visible row: its 1-based body-row number in the source, and its cells
 *  padded to the column count. */
export interface TabularRow {
  n: number;
  cells: string[];
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Parses delimited text into records. Handles quoted fields with embedded
 * delimiters/newlines/doubled quotes, CRLF/LF/CR line endings, a leading BOM,
 * and ragged rows. Blank lines are skipped. Lenient by design: an unterminated
 * quote consumes the rest of the input; text after a closing quote is kept.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  const D = delimiter.charCodeAt(0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < n) {
    const row: string[] = [];
    for (;;) {
      let field: string;
      if (text.charCodeAt(i) === QUOTE) {
        let j = i + 1;
        let segStart = j;
        let out = '';
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) {
            out += text.slice(segStart);
            j = n;
            break;
          }
          if (text.charCodeAt(q + 1) === QUOTE) {
            out += text.slice(segStart, q + 1);
            j = q + 2;
            segStart = j;
            continue;
          }
          out += text.slice(segStart, q);
          j = q + 1;
          break;
        }
        let k = j;
        while (k < n) {
          const c = text.charCodeAt(k);
          if (c === D || c === LF || c === CR) break;
          k++;
        }
        field = k > j ? out + text.slice(j, k) : out;
        i = k;
      } else {
        let k = i;
        while (k < n) {
          const c = text.charCodeAt(k);
          if (c === D || c === LF || c === CR) break;
          k++;
        }
        field = text.slice(i, k);
        i = k;
      }
      row.push(field);
      if (i >= n) break;
      const c = text.charCodeAt(i);
      if (c === D) {
        i++;
        if (i >= n) {
          row.push('');
          break;
        }
        continue;
      }
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      break;
    }
    if (row.length === 1 && row[0] === '') continue; // blank line
    rows.push(row);
  }
  return rows;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class TabularEngine {
  private readonly records: string[][];
  private readonly columns: number;
  /** Visible body-row indices in display order; `null` = every row, source order. */
  private order: Uint32Array | null = null;
  private readonly numericCache = new Map<number, Float64Array | null>();

  constructor(text: string, delimiter: Delimiter) {
    this.records = parseDelimited(text, delimiter);
    let columns = 0;
    for (const r of this.records) if (r.length > columns) columns = r.length;
    this.columns = columns;
  }

  info(): TabularInfo {
    const header = this.records[0] ?? [];
    const padded = header.slice();
    while (padded.length < this.columns) padded.push('');
    return {
      header: padded,
      rowCount: Math.max(0, this.records.length - 1),
      columns: this.columns,
    };
  }

  private cell(body: number, col: number): string {
    return this.records[body + 1]?.[col] ?? '';
  }

  /**
   * Numeric keys for a column when EVERY non-empty cell is a finite number
   * (so `10` sorts after `9`); `null` when any cell isn't, in which case the
   * column sorts as natural-order text. Empty cells key to NaN. Cached.
   */
  private numericKeys(col: number): Float64Array | null {
    if (this.numericCache.has(col)) return this.numericCache.get(col) ?? null;
    const total = this.records.length - 1;
    const keys = new Float64Array(total);
    let numeric = true;
    for (let r = 0; r < total; r++) {
      const raw = this.cell(r, col).trim();
      if (raw === '') {
        keys[r] = NaN;
        continue;
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) {
        numeric = false;
        break;
      }
      keys[r] = v;
    }
    const result = numeric ? keys : null;
    this.numericCache.set(col, result);
    return result;
  }

  /** Applies filter then sort; returns the number of visible rows. */
  query(q: TabularQuery): number {
    const total = Math.max(0, this.records.length - 1);
    const needle = q.filter.trim().toLowerCase();
    const sorting = q.sortCol >= 0 && q.sortCol < this.columns;

    if (needle === '' && !sorting) {
      this.order = null;
      return total;
    }

    let ids: Uint32Array;
    if (needle === '') {
      ids = new Uint32Array(total);
      for (let r = 0; r < total; r++) ids[r] = r;
    } else {
      const hits = new Uint32Array(total);
      let count = 0;
      for (let r = 0; r < total; r++) {
        const rec = this.records[r + 1];
        if (rec === undefined) continue;
        for (let c = 0; c < rec.length; c++) {
          if (rec[c]!.toLowerCase().includes(needle)) {
            hits[count++] = r;
            break;
          }
        }
      }
      ids = hits.slice(0, count);
    }

    if (sorting) {
      const dir = q.sortDir === 'desc' ? -1 : 1;
      const col = q.sortCol;
      const keys = this.numericKeys(col);
      // Empty cells sort last in BOTH directions (a blank is "no value", not
      // the smallest value). TypedArray#sort is stable, so ties keep source order.
      if (keys) {
        ids.sort((a, b) => {
          const ka = keys[a]!;
          const kb = keys[b]!;
          const ea = Number.isNaN(ka);
          const eb = Number.isNaN(kb);
          if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
          return (ka - kb) * dir;
        });
      } else {
        ids.sort((a, b) => {
          const sa = this.cell(a, col);
          const sb = this.cell(b, col);
          if (sa === '' || sb === '') return sa === sb ? 0 : sa === '' ? 1 : -1;
          return collator.compare(sa, sb) * dir;
        });
      }
    }
    this.order = ids;
    return ids.length;
  }

  /** The visible window `[start, end)` of the current query, clamped. */
  rows(start: number, end: number): TabularRow[] {
    const visible = this.order ? this.order.length : Math.max(0, this.records.length - 1);
    const lo = Math.max(0, start);
    const hi = Math.min(visible, end);
    const out: TabularRow[] = [];
    for (let v = lo; v < hi; v++) {
      const body = this.order ? this.order[v]! : v;
      const rec = this.records[body + 1] ?? [];
      const cells = rec.slice();
      while (cells.length < this.columns) cells.push('');
      out.push({ n: body + 1, cells });
    }
    return out;
  }
}
