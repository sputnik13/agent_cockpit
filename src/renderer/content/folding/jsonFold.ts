import { parseTree, printParseErrorCode } from 'jsonc-parser';
import type { Node as JsoncNode, ParseError } from 'jsonc-parser';
import type { FoldModel, FoldRegion } from './foldModel';

/**
 * Parses JSON(C) text into a {@link FoldModel} using jsonc-parser's
 * `parseTree` — a structure-only DOM whose container nodes carry `offset`/
 * `length`/`children` and NEVER a materialized `value` — so every fold
 * region is a literal slice of `text`, never a re-serialized value. See the
 * module doc comment on `foldModel.ts` and parent issue
 * local_repo_explorer-jp2f decision #3.
 *
 * Comments and trailing commas are both tolerated (JSONC, matching what VS
 * Code accepts): `disallowComments` defaults to `false` already, and
 * `allowTrailingComma: true` is passed explicitly below. `allowEmptyContent:
 * true` treats a genuinely empty file as a benign zero-region model rather
 * than an `errors`-populated one — that distinction is deliberate, "empty
 * file" and "invalid JSON" are separate cases in the issue's Validation
 * list.
 *
 * Total: malformed input never throws. `parseTree` is itself fault-tolerant
 * (it recovers a partial — possibly childless — tree and reports
 * `errors`), and this function additionally guards the parse and walk
 * against an unexpected thrown error, surfacing it as an `errors` entry
 * instead of propagating.
 */
export function jsonFoldModel(text: string): FoldModel {
  const regions: FoldRegion[] = [];
  const errors: { offset: number; message: string }[] = [];
  const documents = [{ start: 0, end: text.length, index: 0 }];

  try {
    const parseErrors: ParseError[] = [];
    const root = parseTree(text, parseErrors, {
      allowTrailingComma: true,
      allowEmptyContent: true,
    });
    for (const err of parseErrors) {
      errors.push({ offset: err.offset, message: printParseErrorCode(err.error) });
    }
    if (root) walk(root, 0, text, regions);
  } catch (e) {
    errors.push({ offset: 0, message: describeError(e) });
  }

  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  return { format: 'json', documents, regions, anchors: [], errors };
}

/**
 * Walks container nodes only (`'object' | 'array'`), emitting one region
 * per container whose span covers more than one line — a single-line
 * container is not foldable (folding it gains nothing and adds visual
 * noise). `depth` increments only when descending from one container into
 * a nested one; the `'property'` wrapper node in between (an object
 * child's key/value pair) is plumbing, not a nesting level of its own.
 */
function walk(node: JsoncNode, depth: number, text: string, regions: FoldRegion[]): void {
  if (node.type !== 'object' && node.type !== 'array') return;

  const start = node.offset;
  const end = node.offset + node.length;
  if (text.slice(start, end).includes('\n')) {
    regions.push({
      start,
      end,
      headerEnd: start + 1, // just past the opening `{` or `[` (always one character)
      kind: node.type,
      itemCount: node.children?.length ?? 0,
      depth,
    });
  }

  for (const child of node.children ?? []) {
    // An object's children are 'property' nodes ([keyNode, valueNode]); an
    // array's children ARE the elements directly.
    const next = node.type === 'object' ? child.children?.[1] : child;
    if (next) walk(next, depth + 1, text, regions);
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
