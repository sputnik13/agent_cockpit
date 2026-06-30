/**
 * Public highlight entrypoint for the read-only Content panel: a content-
 * addressed token cache in front of a Web-Worker tokenizer (with an inline
 * fallback). Callers keep importing `tokenizeLines` / the token types from here.
 *
 * - The actual Shiki work lives in {@link tokenizeCore} and runs in
 *   {@link tokenizeWorker} so the main thread never blocks on it. If the worker
 *   can't start (or under test), it transparently falls back to inline tokenize —
 *   identical output, since both call `tokenizeInline`.
 * - Tokenizing is pure in (code, lang, theme), so a re-opened file, a diff↔raw
 *   toggle, or an unchanged-theme re-render hits the cache instead of paying the
 *   tokenize again. Bounded by entry count (oldest evicted).
 */
import type { ThemeId } from '@shared/settings';
import type { LangId } from './languages';
import { tokenizeInline, resetTokenizeCore, type TokenizeResult } from './tokenizeCore';

export type { ThemedToken, TokenLine, TokenizeResult } from './tokenizeCore';

const MAX_TOKEN_CACHE_ENTRIES = 32;
const tokenCache = new Map<string, TokenizeResult>();

// Worker lifecycle. `workerDisabled` latches true under test (no functional
// Worker in the vitest environment) or if the worker ever fails to start/run, so
// we permanently fall back to inline tokenize rather than hang.
let worker: Worker | null = null;
let workerDisabled = import.meta.env?.MODE === 'test';
let seq = 0;
const pending = new Map<number, (r: TokenizeResult | null) => void>();

async function ensureWorker(): Promise<Worker | null> {
  if (workerDisabled) return null;
  if (worker) return worker;
  try {
    // Dynamic import so the `?worker` virtual module is never evaluated under
    // test (where vite's worker transform isn't wired up).
    const { default: TokenizeWorker } = await import('./tokenizeWorker?worker');
    const w = new TokenizeWorker();
    w.onmessage = (e: MessageEvent<{ id: number; result?: TokenizeResult; error?: string }>): void => {
      const resolve = pending.get(e.data.id);
      if (!resolve) return;
      pending.delete(e.data.id);
      resolve(e.data.error != null ? null : (e.data.result ?? null));
    };
    w.onerror = (): void => {
      // Worker crashed: disable it, and unblock anything waiting (null → inline).
      workerDisabled = true;
      worker = null;
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
    };
    worker = w;
    return w;
  } catch {
    workerDisabled = true;
    return null;
  }
}

/** Tokenize via the worker; resolves null on any worker-side failure so the
 *  caller can fall back to inline. */
function tokenizeViaWorker(w: Worker, code: string, lang: LangId, theme: ThemeId): Promise<TokenizeResult | null> {
  return new Promise<TokenizeResult | null>((resolve) => {
    const id = (seq += 1);
    pending.set(id, resolve);
    try {
      w.postMessage({ id, code, lang, theme });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Tokenize `code` for `lang` under `theme`. Served from the content-addressed
 * cache when possible; otherwise tokenized in the worker (falling back to inline
 * if the worker is unavailable or errors). Throws only if even the inline path
 * fails — callers render plain text on rejection.
 */
export async function tokenizeLines(
  code: string,
  lang: LangId,
  theme: ThemeId,
): Promise<TokenizeResult> {
  const cacheKey = `${theme}\x1f${lang}\x1f${code.length}\x1f${code}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const w = await ensureWorker();
  const fromWorker = w ? await tokenizeViaWorker(w, code, lang, theme) : null;
  const out = fromWorker ?? (await tokenizeInline(code, lang, theme));

  // Re-insert at the end for insertion-order eviction of the oldest entry.
  tokenCache.delete(cacheKey);
  tokenCache.set(cacheKey, out);
  while (tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tokenCache.delete(oldest);
  }
  return out;
}

/** Test-only reset of the memoized core/grammars + token cache. */
export function __resetHighlighterForTest(): void {
  resetTokenizeCore();
  tokenCache.clear();
}
