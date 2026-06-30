/**
 * The actual Shiki tokenization, factored out so it can run in EITHER a Web
 * Worker (the production path — keeps the main thread free, see tokenizeWorker)
 * OR inline on the calling thread (the fallback used under test, or if the worker
 * fails to start). Both paths call {@link tokenizeInline}, so their output is
 * identical by construction.
 *
 * Engine choice is unchanged from the original highlighter: the fine-grained
 * `shiki/core` bundle + the pure-JavaScript RegExp engine (no Oniguruma WASM, no
 * `wasm-unsafe-eval` CSP, nothing extra for electron-builder to package). Moving
 * it into a worker addresses the main-thread freeze WITHOUT reopening any of
 * those bundling/CSP/packaging trade-offs.
 *
 * Each module instance keeps its own memoized core + per-language grammar
 * promises — so the worker has one set and the main-thread fallback has another;
 * that is intentional and cheap (the core is created at most once per thread).
 */
import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ThemeId } from '@shared/settings';
import { grammarLoader, type LangId } from './languages';
import { shikiThemeFor } from './themeForApp';

export interface ThemedToken {
  content: string;
  color?: string;
}
export type TokenLine = ThemedToken[];

export interface TokenizeResult {
  /** One entry per source line; each is the line's colored tokens. */
  lines: TokenLine[];
  /** Theme default foreground / background (hex), for the container surface. */
  fg: string;
  bg: string;
}

let corePromise: Promise<HighlighterCore> | null = null;
const langPromises = new Map<LangId, Promise<void>>();

function getCore(): Promise<HighlighterCore> {
  if (!corePromise) {
    corePromise = createHighlighterCore({
      themes: [import('@shikijs/themes/solarized-dark'), import('@shikijs/themes/solarized-light')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  }
  return corePromise;
}

async function ensureLanguage(core: HighlighterCore, lang: LangId): Promise<void> {
  let p = langPromises.get(lang);
  if (!p) {
    p = core.loadLanguage(grammarLoader(lang)());
    langPromises.set(lang, p);
  }
  await p;
}

/**
 * Tokenize `code` for `lang` under the app `theme`. Resolves after the core and
 * the language grammar are ready. Throws only on genuinely unexpected engine
 * failures — callers fall back to plain text.
 */
export async function tokenizeInline(
  code: string,
  lang: LangId,
  theme: ThemeId,
): Promise<TokenizeResult> {
  const core = await getCore();
  await ensureLanguage(core, lang);
  const result = core.codeToTokens(code, { lang, theme: shikiThemeFor(theme) });
  return {
    lines: result.tokens.map((line) => line.map((t) => ({ content: t.content, color: t.color }))),
    fg: result.fg ?? '',
    bg: result.bg ?? '',
  };
}

/** Drop this thread's memoized core + grammars (test reset). */
export function resetTokenizeCore(): void {
  corePromise = null;
  langPromises.clear();
}
