/**
 * The actual fold-model computation, factored out so it can run in EITHER a
 * Web Worker (the production path — keeps the main thread free while a large
 * JSON/YAML file is parsed, see foldWorker.ts) OR inline on the calling
 * thread (the fallback used under test, or if the worker fails to start).
 * Both paths call {@link computeFoldModelSync}, so their output is identical
 * by construction. Mirrors highlight/tokenizeCore.ts's role in the sibling
 * tokenize pipeline.
 *
 * Unlike tokenizeCore.ts's Shiki setup, there is no async engine/grammar
 * warm-up here: .1's extractors (`jsonFoldModel`/`yamlFoldModel`) are already
 * pure and synchronous, so this module is a plain, synchronous dispatcher.
 */
import type { FoldFormat, FoldModel } from './foldModel';
import { jsonFoldModel } from './jsonFold';
import { yamlFoldModel } from './yamlFold';

/**
 * Computes the fold model for `text` given its `format`, dispatching to .1's
 * `jsonFoldModel`/`yamlFoldModel`. This is the ONE function both
 * {@link foldWorker} and the inline main-thread fallback in
 * {@link foldClient} call, so there is no second code path to keep in sync.
 */
export function computeFoldModelSync(text: string, format: FoldFormat): FoldModel {
  return format === 'json' ? jsonFoldModel(text) : yamlFoldModel(text);
}
