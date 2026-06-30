/**
 * Web Worker that runs Shiki tokenization off the renderer's main thread, so a
 * large file (or two sides of a big diff) no longer freezes the UI while the
 * pure-JS regex engine scans it. Built as an ES-module worker (vite
 * `worker.format: 'es'`) because {@link tokenizeInline} lazy-imports grammars.
 *
 * Protocol: the client posts `{ id, code, lang, theme }`; the worker replies with
 * `{ id, result }` on success or `{ id, error }` on failure. The client
 * (highlighter.ts) correlates by id and caches the result.
 */
import { tokenizeInline } from './tokenizeCore';
import type { LangId } from './languages';
import type { ThemeId } from '@shared/settings';

interface TokenizeRequest {
  id: number;
  code: string;
  lang: LangId;
  theme: ThemeId;
}

self.onmessage = (e: MessageEvent<TokenizeRequest>): void => {
  const { id, code, lang, theme } = e.data;
  tokenizeInline(code, lang, theme).then(
    (result) => {
      (self as unknown as Worker).postMessage({ id, result });
    },
    (err: unknown) => {
      (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    },
  );
};
