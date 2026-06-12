import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { ThemeId } from '@shared/settings';
import { grammarLoader, type LangId } from './languages';
import { shikiThemeFor } from './themeForApp';

/**
 * Singleton Shiki highlighter for the read-only Content panel.
 *
 * Design notes:
 * - Fine-grained core bundle (`shiki/core`) + the pure-JavaScript RegExp engine
 *   (no Oniguruma WASM, no web workers) — a clean electron-vite renderer fit.
 * - Both Solarized themes are loaded once up front so theme switches are instant.
 * - Grammars are lazy-loaded per language on first use and memoized.
 * - Output is a token model (not HTML); callers build React elements from it,
 *   so there is no `dangerouslySetInnerHTML` of engine output.
 */

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

/**
 * Tokenize `code` for `lang` under the app `theme`. Resolves after the core and
 * the language grammar are ready. Throws only on genuinely unexpected engine
 * failures — callers fall back to plain text.
 */
export async function tokenizeLines(
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

/** Test-only reset of the memoized core/grammars. */
export function __resetHighlighterForTest(): void {
  corePromise = null;
  langPromises.clear();
}
