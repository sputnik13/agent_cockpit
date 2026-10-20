import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, Spinner } from '../ui';
import { BinaryPlaceholder } from './BinaryPlaceholder';
import type { RawFileConfirmation } from './RawFile';
import { openTabular, type TabularSession } from './tabular/tabularClient';
import type { Delimiter, TabularInfo, TabularRow } from './tabular/tabularCore';

const ROW_H = 24;
const HEADER_H = 28;
const GUTTER_W = 56;
const COL_W = 160;
const OVERSCAN = 10;
const FILTER_DEBOUNCE_MS = 150;
/** Used until the scroll container reports a real height (and in jsdom). */
const FALLBACK_VIEWPORT_H = 400;

interface CsvViewProps {
  worktreePath: string;
  filePath: string;
  delimiter: Delimiter;
  /** Largest file (bytes) this view will load — the memory budget from
   *  tabular/tabularCap.ts, evaluated once per opened file by ContentViewer so
   *  it is stable for the file's lifetime. */
  maxBytes: number;
  gitRef?: string;
  /**
   * Same sole runtime-classification channel RawFile uses. Reports `text`,
   * `binary` and `missing` (so a binary `.csv` still reclassifies to the binary
   * placeholder). Deliberately does NOT report `too-large`: this view's cap is
   * a memory budget, not the file-read cap, and Diff/Raw can still show the
   * file — reporting it would make Diff claim the file is too large to diff.
   */
  onBinaryConfirmed?: (confirmation: RawFileConfirmation) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; session: TabularSession; info: TabularInfo }
  | { kind: 'over-budget'; sizeBytes: number }
  | { kind: 'binary'; sizeBytes: number }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/**
 * Read-only, sortable, filterable table for `.csv`/`.tsv` (the Rendered mode of
 * the `csv` content class). The first record is the header.
 *
 * Responsiveness/memory: the file is read once (like RawFile), handed to a
 * worker that owns the parsed table, and the view only ever fetches the rows
 * currently in the viewport — sort/filter run in the worker over a row-index
 * array. Files above `maxBytes` are not parsed at all; a notice points at Raw
 * and Diff. The table is released (worker terminated) on unmount.
 *
 * Not wrappable and not covered by find-in-file: rows are virtualized at a fixed
 * height (cells truncate; the full value is the cell's tooltip), and the filter
 * box is the in-table search.
 */
export function CsvView({
  worktreePath,
  filePath,
  delimiter,
  maxBytes,
  gitRef,
  onBinaryConfirmed,
}: CsvViewProps): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    let session: TabularSession | null = null;
    const opts: { ref?: string; worktreePath?: string; maxBytes?: number } = {
      worktreePath,
      maxBytes,
    };
    if (gitRef !== undefined) opts.ref = gitRef;
    void window.api.provider
      .readFile(filePath, opts)
      .then(async (r) => {
        if (!active) return;
        if (r.content !== null) {
          onBinaryConfirmed?.({ kind: 'text', sizeBytes: r.sizeBytes });
          const s = await openTabular(r.content, delimiter);
          if (!active) {
            s.dispose();
            return;
          }
          session = s;
          setState({ kind: 'ready', session: s, info: s.info });
        } else if (r.truncated) {
          setState({ kind: 'over-budget', sizeBytes: r.sizeBytes });
        } else if (r.isBinary) {
          onBinaryConfirmed?.({ kind: 'binary', sizeBytes: r.sizeBytes });
          setState({ kind: 'binary', sizeBytes: r.sizeBytes });
        } else {
          onBinaryConfirmed?.({ kind: 'missing' });
          setState({ kind: 'missing' });
        }
      })
      .catch((err: unknown) => {
        if (active)
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      active = false;
      session?.dispose();
    };
  }, [worktreePath, filePath, gitRef, delimiter, maxBytes, onBinaryConfirmed]);

  switch (state.kind) {
    case 'loading':
      return (
        <div
          style={{
            display: 'flex',
            height: '100%',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner />
        </div>
      );
    case 'over-budget':
      return (
        <EmptyState
          title="Too large for the table view"
          hint={`This file is ${fmtSize(state.sizeBytes)}; the table view loads up to ${fmtSize(maxBytes)} (based on available memory). Use Raw or Diff to view it.`}
        />
      );
    case 'binary':
      return <BinaryPlaceholder mode="rendered" reason="binary" size={state.sizeBytes} />;
    case 'missing':
      return <BinaryPlaceholder mode="rendered" reason="missing" />;
    case 'error':
      return <EmptyState title="Couldn't open this file as a table" hint={state.message} />;
    case 'ready':
      return <Table session={state.session} info={state.info} />;
  }
}

type SortState = { col: number; dir: 'asc' | 'desc' } | null;

function Table({ session, info }: { session: TabularSession; info: TabularInfo }): JSX.Element {
  const [sort, setSort] = useState<SortState>(null);
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [count, setCount] = useState(info.rowCount);
  // Bumped after every completed query so the row window re-fetches even when
  // `count` is unchanged (e.g. a re-sort).
  const [epoch, setEpoch] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT_H);
  const [page, setPage] = useState<{ start: number; rows: TabularRow[] }>({ start: 0, rows: [] });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setFilter(filterInput), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [filterInput]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) setViewportH(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Query: filter+sort in the worker. A stale reply (a newer query was issued
  // meanwhile) is dropped.
  useEffect(() => {
    let active = true;
    void session
      .query({ sortCol: sort?.col ?? -1, sortDir: sort?.dir ?? 'asc', filter })
      .then((n) => {
        if (!active) return;
        setCount(n);
        setEpoch((e) => e + 1);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        setScrollTop(0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session, sort, filter]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  useEffect(() => {
    let active = true;
    void session
      .rows(first, last)
      .then((rows) => {
        if (active) setPage({ start: first, rows });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session, first, last, epoch]);

  const onHeaderClick = useCallback((col: number) => {
    setSort((prev) => {
      if (prev?.col !== col) return { col, dir: 'asc' };
      return prev.dir === 'asc' ? { col, dir: 'desc' } : null;
    });
  }, []);

  const width = GUTTER_W + info.columns * COL_W;
  const filtered = filter.trim() !== '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-panel)',
          fontSize: 12,
        }}
      >
        <input
          type="search"
          aria-label="Filter rows"
          placeholder="Filter rows…"
          value={filterInput}
          onChange={(e) => setFilterInput(e.target.value)}
          style={{
            flex: '0 1 260px',
            fontSize: 12,
            padding: '2px 6px',
            border: '1px solid var(--border)',
            borderRadius: 4,
            background: 'var(--bg)',
            color: 'var(--fg)',
          }}
        />
        <span style={{ color: 'var(--fg-dim)' }} data-testid="csv-row-count">
          {filtered
            ? `${count.toLocaleString()} of ${info.rowCount.toLocaleString()} rows`
            : `${info.rowCount.toLocaleString()} rows`}
          {' · '}
          {info.columns.toLocaleString()} columns
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--mono-size)',
          background: 'var(--bg)',
          color: 'var(--fg)',
        }}
      >
        <div style={{ width, minWidth: '100%' }}>
          <div
            role="row"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              display: 'flex',
              height: HEADER_H,
              background: 'var(--bg-panel)',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={{ ...cellStyle(GUTTER_W), color: 'var(--fg-dim)', textAlign: 'right' }}>
              #
            </div>
            {info.header.map((name, c) => {
              const dir = sort?.col === c ? sort.dir : null;
              return (
                <button
                  key={c}
                  type="button"
                  role="columnheader"
                  aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                  title={name}
                  onClick={() => onHeaderClick(c)}
                  style={{
                    ...cellStyle(COL_W),
                    font: 'inherit',
                    fontWeight: 600,
                    textAlign: 'left',
                    cursor: 'pointer',
                    background: 'transparent',
                    color: 'inherit',
                    border: 0,
                  }}
                >
                  {name === '' ? `Column ${c + 1}` : name}
                  {dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}
                </button>
              );
            })}
          </div>
          {count === 0 ? (
            <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
              {filtered ? 'No rows match the filter.' : 'No data rows.'}
            </div>
          ) : (
            <div style={{ position: 'relative', height: count * ROW_H }}>
              <div style={{ position: 'absolute', top: page.start * ROW_H, left: 0, right: 0 }}>
                {page.rows.map((row) => (
                  <div key={row.n} role="row" style={{ display: 'flex', height: ROW_H }}>
                    <div
                      style={{ ...cellStyle(GUTTER_W), color: 'var(--fg-dim)', textAlign: 'right' }}
                    >
                      {row.n}
                    </div>
                    {row.cells.map((value, c) => (
                      <div key={c} role="cell" title={value} style={cellStyle(COL_W)}>
                        {value}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function cellStyle(width: number): React.CSSProperties {
  return {
    flex: `0 0 ${width}px`,
    width,
    boxSizing: 'border-box',
    padding: '0 8px',
    lineHeight: `${ROW_H}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'pre',
    borderRight: '1px solid var(--border)',
  };
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
