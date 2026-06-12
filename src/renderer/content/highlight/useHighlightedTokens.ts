import { useEffect, useState } from 'react';
import type { ThemeId } from '@shared/settings';
import { tokenizeLines, type TokenLine } from './highlighter';
import type { LangId } from './languages';

/**
 * Progressive-enhancement hook: returns `plain` synchronously so first paint is
 * the readable plain text, then resolves Shiki tokens asynchronously and flips
 * to `ready`. Re-runs when content, language, or theme changes. Any tokenize
 * failure stays `plain` (the caller renders unhighlighted text).
 */
export type HighlightState =
  | { state: 'plain' }
  | { state: 'ready'; lines: TokenLine[]; fg: string; bg: string };

export function useHighlightedTokens(
  content: string,
  lang: LangId | null,
  theme: ThemeId,
): HighlightState {
  const [result, setResult] = useState<HighlightState>({ state: 'plain' });

  useEffect(() => {
    if (lang === null) {
      setResult({ state: 'plain' });
      return;
    }
    let active = true;
    setResult({ state: 'plain' });
    void tokenizeLines(content, lang, theme)
      .then((r) => {
        if (active) setResult({ state: 'ready', lines: r.lines, fg: r.fg, bg: r.bg });
      })
      .catch(() => {
        if (active) setResult({ state: 'plain' });
      });
    return () => {
      active = false;
    };
  }, [content, lang, theme]);

  return result;
}
