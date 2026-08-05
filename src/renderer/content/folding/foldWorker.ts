/**
 * Web Worker that runs fold-model computation off the renderer's main
 * thread, so a large JSON/YAML file no longer freezes the UI while
 * jsonc-parser/yaml walks it. Built as an ES-module worker (vite
 * `worker.format: 'es'`), mirroring highlight/tokenizeWorker.ts.
 *
 * Protocol: the client posts `{ id, text, format }`; the worker replies with
 * `{ id, model }` on success or `{ id, error }` on failure. The client
 * (foldClient.ts) correlates by id and caches the result. `computeFoldModelSync`
 * itself does not throw for malformed input — parse errors land in the
 * model's own `errors` array (see foldModel.ts) — so the try/catch below is a
 * backstop for a genuinely unexpected failure, ensuring the worker always
 * replies rather than going silent.
 */
import { computeFoldModelSync } from './foldCore';
import type { FoldFormat } from './foldModel';

interface FoldRequest {
  id: number;
  text: string;
  format: FoldFormat;
}

self.onmessage = (e: MessageEvent<FoldRequest>): void => {
  const { id, text, format } = e.data;
  try {
    const model = computeFoldModelSync(text, format);
    (self as unknown as Worker).postMessage({ id, model });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
