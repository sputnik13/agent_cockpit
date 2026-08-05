import { useEffect, useState } from 'react';
import { computeFoldModel } from './foldClient';
import type { FoldFormat, FoldModel } from './foldModel';

/**
 * Progressive-enhancement hook: starts `loading`, then resolves the fold
 * model asynchronously via {@link computeFoldModel} and flips to `ready`.
 * Mirrors highlight/useHighlightedTokens.ts's shape. Re-runs when `text` or
 * `format` changes; a superseded in-flight result is discarded (guarded by
 * `active`) so a fast input change never clobbers state with a stale model.
 * Either input being `null` short-circuits to `unavailable` with NO compute
 * call — the caller then renders its plain/highlighted fallback rather than
 * a broken pane — and a compute that throws resolves to `unavailable` too.
 */
export type FoldModelState =
  | { state: 'loading' }
  | { state: 'ready'; model: FoldModel }
  | { state: 'unavailable' };

export function useFoldModel(text: string | null, format: FoldFormat | null): FoldModelState {
  const [result, setResult] = useState<FoldModelState>({ state: 'loading' });

  useEffect(() => {
    if (text === null || format === null) {
      setResult({ state: 'unavailable' });
      return;
    }
    let active = true;
    setResult({ state: 'loading' });
    void computeFoldModel(text, format)
      .then((model) => {
        if (active) setResult({ state: 'ready', model });
      })
      .catch(() => {
        if (active) setResult({ state: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [text, format]);

  return result;
}
