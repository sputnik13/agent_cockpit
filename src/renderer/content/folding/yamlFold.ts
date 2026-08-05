import { Scalar, isMap, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';
import type { AnchorLink, FoldDocument, FoldModel, FoldRegion } from './foldModel';

/** YAML anchor/alias names exclude whitespace and the flow indicator chars
 *  (`,[]{}`) per the YAML spec; used to bound-check a candidate `&name`
 *  match so e.g. searching for `&x` cannot match inside `&xy`. */
const ANCHOR_NAME_CHAR = /[^\s,[\]{}]/;

/**
 * Parses YAML text into a {@link FoldModel} using `yaml`'s Document layer
 * (`parseAllDocuments`) and its nodes' `range` tuples — never `.toJS()` or
 * any other value-resolving API — so every fold region and anchor/alias
 * link is a literal slice of `text`. See the module doc comment on
 * `foldModel.ts` and parent issue local_repo_explorer-jp2f decisions #3/#5.
 *
 * Renders ALL documents in a multi-document (`---`-separated) stream
 * (parent issue's second comment, resolved product decision): one {@link
 * FoldDocument} per stream document, each with its own depth-0 origin and
 * its own anchor scope, since YAML anchor scope resets per document (the
 * same `&name` in two different documents produces two independent {@link
 * AnchorLink} entries, never merged).
 *
 * Total: malformed input never throws. `parseAllDocuments` reports
 * document-level parse errors on `doc.errors` rather than throwing for
 * ordinary malformed YAML; this function additionally guards the parse
 * call and each document's walk against an unexpected thrown error,
 * surfacing it as an `errors` entry instead of propagating.
 */
export function yamlFoldModel(text: string): FoldModel {
  const documents: FoldDocument[] = [];
  const regions: FoldRegion[] = [];
  const anchors: AnchorLink[] = [];
  const errors: { offset: number; message: string }[] = [];

  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, { keepSourceTokens: false });
  } catch (e) {
    errors.push({ offset: 0, message: describeError(e) });
    return { format: 'yaml', documents, regions, anchors, errors };
  }

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    try {
      const docRange = doc.range;
      if (docRange) documents.push({ start: docRange[0], end: docRange[2], index: i });
      for (const err of doc.errors) errors.push({ offset: err.pos[0], message: err.message });

      const docStart = docRange ? docRange[0] : 0;
      // Anchor definitions/aliases are collected per-document (scope reset).
      const defs = new Map<string, { start: number; end: number }>();
      const aliasesByName = new Map<string, { start: number; end: number }[]>();

      visit(doc, {
        // `Value` covers YAMLMap | YAMLSeq | Scalar in one handler - defining
        // `Map`/`Seq`/`Scalar` individually here too would silently steal
        // dispatch away from `Value` for those kinds ("only the most
        // specific defined one will be used"), so region-building AND
        // anchor-definition detection both live here, discriminated by the
        // isMap/isSeq/isScalar type guards. `node.anchor` is checked
        // directly (rather than via the package's internal `hasAnchor`
        // helper, which is not re-exported from its top-level entry point):
        // `Value`'s own type is already `Scalar | YAMLMap | YAMLSeq`, and
        // `.anchor` is declared on both Scalar and Collection (YAMLMap/
        // YAMLSeq's shared base), so it's always valid here regardless of
        // which of the three kinds `node` is.
        Value(_key, node, path) {
          if (isMap(node) || isSeq(node)) {
            addContainerRegion(node, isMap(node) ? 'map' : 'seq', containerDepth(path), text, regions);
          } else if (
            isScalar(node) &&
            (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED)
          ) {
            addBlockScalarRegion(node, containerDepth(path), text, regions);
          }
          if (node.anchor) {
            const range = node.range;
            if (range) {
              defs.set(node.anchor, findAnchorDefinitionRange(text, node.anchor, range[0], docStart));
            }
          }
        },
        Alias(_key, node) {
          const range = node.range;
          if (!range) return;
          const aliasRange = { start: range[0], end: range[1] };
          const list = aliasesByName.get(node.source);
          if (list) list.push(aliasRange);
          else aliasesByName.set(node.source, [aliasRange]);
        },
      });

      for (const [name, definition] of defs) {
        anchors.push({ name, definition, aliases: aliasesByName.get(name) ?? [] });
      }
    } catch (e) {
      errors.push({ offset: doc.range ? doc.range[0] : 0, message: describeError(e) });
    }
  }

  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  return { format: 'yaml', documents, regions, anchors, errors };
}

/** Container-nesting depth: one per YAMLMap/YAMLSeq ancestor in `path`
 *  (`Document` and the intermediate `Pair` wrapper are not nesting levels
 *  of their own — mirrors jsonFold.ts's treatment of the `'property'`
 *  wrapper). */
function containerDepth(path: readonly unknown[]): number {
  let depth = 0;
  for (const p of path) {
    if (isMap(p) || isSeq(p)) depth++;
  }
  return depth;
}

function addContainerRegion(
  node: YAMLMap<unknown, unknown> | YAMLSeq<unknown>,
  kind: 'map' | 'seq',
  depth: number,
  text: string,
  regions: FoldRegion[],
): void {
  const range = node.range;
  if (!range) return;
  const start = range[0];
  const end = range[1];
  if (!text.slice(start, end).includes('\n')) return; // single-line: not foldable

  // A flow collection's own marker is `{`/`[`; a block sequence's is its
  // first item's `-` (both single characters, so start+1 skips past it). A
  // block MAP has no marker of its own at `start` — see the FoldRegion doc
  // comment on foldModel.ts.
  const headerEnd = node.flow ? start + 1 : kind === 'seq' ? start + 1 : start;
  regions.push({ start, end, headerEnd, kind, itemCount: node.items.length, depth });
}

function addBlockScalarRegion(
  node: Scalar,
  depth: number,
  text: string,
  regions: FoldRegion[],
): void {
  const range = node.range;
  if (!range) return;
  const start = range[0];
  const end = range[1];
  // Unlike an anchor, a block scalar's own range starts AT its `|`/`>`
  // indicator, so `start` already covers the header line's first character.
  if (!text.slice(start, end).includes('\n')) return; // single-line: not foldable
  const firstNewline = text.indexOf('\n', start);
  // firstNewline is always found once the multi-line check above passes -
  // the fallback to `end` only guards a pathological/unparseable range.
  const headerEnd = firstNewline === -1 ? end : firstNewline + 1;
  regions.push({ start, end, headerEnd, kind: 'block-scalar', itemCount: 0, depth });
}

/**
 * Locates the `&name` anchor token for a node whose own `range` starts at
 * `nodeStart` (the Document layer's node range never includes a leading
 * anchor token, regardless of node kind — see the module doc comment on
 * foldModel.ts). Scans backward from `nodeStart`, tolerating whitespace and
 * `#` line comments in the gap, and never looks earlier than `boundStart`
 * (the enclosing document's own start). Deterministic: of every `&name`
 * occurrence at or before `nodeStart`, picks the rightmost one whose
 * trailing gap to `nodeStart` is pure trivia.
 *
 * Known limitation: does not tolerate an explicit YAML tag (e.g. `!!str`)
 * sharing the gap between the anchor and the node - that gap is no longer
 * pure trivia, so a tag+anchor combination falls back to the zero-width
 * range below rather than mis-locating the anchor. Untested/unrequired by
 * the issue's fixture list; the lower CST layer would be needed to handle
 * it precisely and is a deliberate fallback-only escalation per the
 * issue's guardrails.
 */
function findAnchorDefinitionRange(
  text: string,
  name: string,
  nodeStart: number,
  boundStart: number,
): { start: number; end: number } {
  const token = `&${name}`;
  let searchFrom = nodeStart;
  while (searchFrom >= boundStart) {
    const idx = text.lastIndexOf(token, searchFrom);
    if (idx < boundStart) break;
    const nameEnd = idx + token.length;
    const after = nameEnd < text.length ? text[nameEnd] : '';
    const boundaryOk = after === '' || !ANCHOR_NAME_CHAR.test(after);
    if (boundaryOk && nameEnd <= nodeStart && isTriviaGap(text, nameEnd, nodeStart)) {
      return { start: idx, end: nameEnd };
    }
    searchFrom = idx - 1;
  }
  // Should not happen for well-formed input (the node genuinely carries
  // this anchor per the library) - fall back to a zero-width range rather
  // than throwing or silently dropping the anchor from the model.
  return { start: nodeStart, end: nodeStart };
}

/** True if `text[start, end)` consists only of whitespace and `#`
 *  line-comments (comment-to-end-of-line, inclusive of the comment text but
 *  not requiring a trailing newline within the gap). */
function isTriviaGap(text: string, start: number, end: number): boolean {
  let i = start;
  while (i < end) {
    const ch = text[i];
    if (ch === '#') {
      while (i < end && text[i] !== '\n') i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
