/**
 * Public entrypoint for the table view's data: opens a parsed table and hands
 * back a small async session. The table lives in a dedicated Web Worker
 * (tabularWorker.ts) so a large file never blocks the UI thread; if the worker
 * can't start (or under vitest, where there is no functional Worker) it falls
 * back to running the SAME {@link TabularEngine} inline — identical output.
 * Mirrors folding/foldClient.ts's worker/fallback shape. One worker per
 * session, terminated on {@link TabularSession.dispose}, so a table's memory
 * is released as soon as its view unmounts.
 */
import {
  TabularEngine,
  type Delimiter,
  type TabularInfo,
  type TabularQuery,
  type TabularRow,
} from './tabularCore';

export interface TabularSession {
  info: TabularInfo;
  /** Applies filter+sort; resolves to the visible row count. */
  query(q: TabularQuery): Promise<number>;
  /** Visible window `[start, end)` of the latest query. */
  rows(start: number, end: number): Promise<TabularRow[]>;
  /** Releases the table (terminates the worker). Idempotent. */
  dispose(): void;
}

const workerDisabled = import.meta.env?.MODE === 'test';

function inlineSession(text: string, delimiter: Delimiter): TabularSession {
  const engine = new TabularEngine(text, delimiter);
  return {
    info: engine.info(),
    query: (q) => Promise.resolve(engine.query(q)),
    rows: (start, end) => Promise.resolve(engine.rows(start, end)),
    dispose: () => {},
  };
}

async function workerSession(text: string, delimiter: Delimiter): Promise<TabularSession | null> {
  let worker: Worker;
  try {
    worker = new (await import('./tabularWorker?worker')).default();
  } catch {
    return null;
  }
  let seq = 0;
  let dead = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const fail = (message: string): void => {
    dead = true;
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>): void => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error != null) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
  };
  worker.onerror = (): void => fail('table worker crashed');
  const call = <T>(msg: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (dead) return reject(new Error('table worker unavailable'));
      const id = ++seq;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        worker.postMessage({ id, ...msg });
      } catch (err) {
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  try {
    const info = await call<TabularInfo>({ op: 'open', text, delimiter });
    return {
      info,
      query: (query) => call<number>({ op: 'query', query }),
      rows: (start, end) => call<TabularRow[]>({ op: 'rows', start, end }),
      dispose: () => {
        fail('disposed');
        worker.terminate();
      },
    };
  } catch {
    worker.terminate();
    return null;
  }
}

/** Parses `text` into a queryable table session (worker, else inline). */
export async function openTabular(text: string, delimiter: Delimiter): Promise<TabularSession> {
  if (!workerDisabled) {
    const s = await workerSession(text, delimiter);
    if (s) return s;
  }
  return inlineSession(text, delimiter);
}
