/**
 * Web Worker owning ONE parsed table (see tabularClient.ts, which creates a
 * worker per opened file and terminates it on dispose). Keeping the parsed
 * rows here means the main thread never holds them and never blocks on
 * parse/sort/filter of a large file; it only receives the visible window.
 * ES-module worker (vite `worker.format: 'es'`), mirroring foldWorker.ts.
 *
 * Protocol: `{ id, op: 'open', text, delimiter }` | `{ id, op: 'query', query }`
 * | `{ id, op: 'rows', start, end }`; reply `{ id, result }` or `{ id, error }`.
 */
import { TabularEngine, type Delimiter, type TabularQuery } from './tabularCore';

type Request =
  | { id: number; op: 'open'; text: string; delimiter: Delimiter }
  | { id: number; op: 'query'; query: TabularQuery }
  | { id: number; op: 'rows'; start: number; end: number };

let engine: TabularEngine | null = null;

self.onmessage = (e: MessageEvent<Request>): void => {
  const req = e.data;
  try {
    let result: unknown;
    if (req.op === 'open') {
      engine = new TabularEngine(req.text, req.delimiter);
      result = engine.info();
    } else if (engine === null) {
      throw new Error('table not opened');
    } else if (req.op === 'query') {
      result = engine.query(req.query);
    } else {
      result = engine.rows(req.start, req.end);
    }
    (self as unknown as Worker).postMessage({ id: req.id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
