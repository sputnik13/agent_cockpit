import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Blockquote, Code, Heading, List, ListItem, Root, Table } from 'mdast';

/**
 * Change classification for the rendered-markdown diff view (see
 * docs/design/ui-rendered-markdown-diff.md, "Decision" and "Decision —
 * Extension: Non-List Block Types"). This module is pure — no DOM, no
 * React — so it is usable both from RenderedMarkdown (markdown.tsx) and
 * standalone in tests.
 *
 * Two layers:
 * - A generic pairing/classification core (`pairUnits`, `classifyUnits`,
 *   `alignBucket`, `longestCommonSubsequence`) that operates over any unit
 *   shape with at least `{ text: string }` (classification additionally
 *   needs `{ startLine, endLine }`), parametrized by a caller-supplied
 *   `keyOf` bucketing accessor. LCS anchors exact-equal `text` within each
 *   `keyOf` bucket; the gaps between anchors are resolved by positional
 *   substitution — this is what lets an EDITED unit (text does NOT
 *   exact-match its old counterpart) be distinguished from a delete+insert
 *   pair.
 * - Kind-specific extraction + bucketing, which stays separate BY DESIGN —
 *   different block kinds need different bucket keys (see `listKeyOf`'s and
 *   `proseKeyOf`'s doc comments): `extractListItems`/`pairListItems`/
 *   `classifyItems` for `list` nodes (thin wrappers over the generic core,
 *   kept at their original exported signatures so the shipped list-diff
 *   output is unaffected); `extractProseUnits`/`proseKeyOf` for top-level
 *   paragraphs and headings, which are already correctly-scoped single
 *   units, so the caller (markdown.tsx) calls `pairUnits`/`classifyUnits`
 *   directly rather than through a dedicated wrapper; `extractTableRows`/
 *   `tableRowKeyOf` for table rows (`<tr>`), which — like a list item —
 *   need per-row classification within a multi-child container, so the
 *   caller uses them exactly like `pairListItems`/`classifyItems`, just
 *   without a dedicated wrapper (see `tableRowKeyOf`'s own doc comment for
 *   why its bucket key needs a header/body suffix `listKeyOf` has no
 *   analogue of); `extractBlockquoteChildren`/`blockquoteChildKeyOf` for a
 *   blockquote's direct children (typically paragraphs), which — like a
 *   list item or table row — need per-child classification within a
 *   multi-child container, so the caller (markdown.tsx) uses them exactly
 *   like `pairListItems`/`classifyItems` too, just without a dedicated
 *   wrapper (mirroring the table-row precedent, minus its header/body
 *   suffix — a blockquote's direct children are homogeneous).
 */

/** A single markdown list item's classification-relevant data, extracted
 *  independently from one parsed source (old or new). Nested list items
 *  (inside a parent item's own sub-list) are extracted as their own
 *  entries — see `depth` — and are never folded into their parent's data,
 *  so a nested edit cannot make its ancestor item look changed. */
export interface MdListItem {
  /** 1-based source line where the item starts. Matches the `data-start-line`
   *  attribute `renderDoc` annotates on the rendered `<li>` (markdown.tsx) —
   *  used as the join key to decorate the right DOM element. */
  startLine: number;
  /**
   * 1-based source line where the item's OWN content ends — i.e. EXCLUDING
   * any nested descendant list. A parent item's `endLine` therefore never
   * extends into a nested child's lines, so a change confined to a nested
   * item never makes the parent's own `[startLine, endLine]` overlap
   * `changedLineSet` (nested items classify independently). This
   * intentionally differs from the rendered `<li>`'s `data-end-line` (and
   * from the item's raw mdast `position.end`), which DO span nested
   * content — that attribute is a different concern and is untouched by
   * this module.
   */
  endLine: number;
  /** Start line of the item's immediately-enclosing `list` node. Items that
   *  share a `listStartLine` (within the SAME extraction/source) belong to
   *  the same list; `pairListItems` uses this to anchor pairing within a
   *  list instead of across unrelated lists. */
  listStartLine: number;
  /** Nesting depth: 0 for a top-level list's items, 1 for items in a list
   *  nested one level inside a parent item, etc. */
  depth: number;
  /** The item's own plain-text content, EXCLUDING any nested descendant
   *  list subtree, whitespace-normalized (runs collapsed, trimmed). Used
   *  for equality/pairing, and — for a REMOVED item specifically — as a
   *  ghost row's displayed content (see `resolveGhostAnchors` below and
   *  markdown.tsx's `buildGhostListItem`): always inserted as a plain DOM
   *  text node, never parsed/rendered as markup, so formatting from the old
   *  source (including literal `<`/`>` characters from inline HTML) reaches
   *  the DOM only as inert text. */
  text: string;
}

/** `unchanged`: no source line of the item is in `changedLineSet`.
 *  `added`: changed, with no corresponding item in the old tree.
 *  `edited`: changed, with a corresponding item in the old tree (this
 *  leaf's whole-item highlight is the common base treatment for both the
 *  clean-intraline-diff and fallback cases a later leaf distinguishes). */
export type ItemClassification = 'unchanged' | 'added' | 'edited';

/** Same remark-parse + remark-gfm configuration `renderDoc` (markdown.tsx)
 *  uses for the rendered HTML, so line numbers agree exactly with the
 *  rendered DOM's `data-start-line`/`data-end-line` attributes. */
function parseTree(source: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
}

/** Extracts every list item (top-level lists and their nested sub-lists) in
 *  document order. Pure; does no DOM/React work. */
export function extractListItems(source: string): MdListItem[] {
  const tree = parseTree(source);
  const items: MdListItem[] = [];
  for (const node of tree.children) {
    if (node.type === 'list') collectListItems(node, 0, items);
  }
  return items;
}

function collectListItems(list: List, depth: number, out: MdListItem[]): void {
  const listStartLine = list.position?.start.line ?? 0;
  for (const item of list.children) {
    const startLine = item.position?.start.line ?? 0;
    const textParts: string[] = [];
    for (const child of item.children) collectOwnText(child, textParts);
    out.push({
      startLine,
      endLine: ownContentEndLine(item, startLine),
      listStartLine,
      depth,
      text: normalizeText(textParts.join(' ')),
    });
    for (const child of item.children) {
      if (child.type === 'list') collectListItems(child, depth + 1, out);
    }
  }
}

/** The item's own end line, excluding any nested list child — see
 *  `MdListItem.endLine`'s doc comment for why this matters. */
function ownContentEndLine(item: ListItem, fallback: number): number {
  let end = 0;
  for (const child of item.children) {
    if (child.type === 'list') continue;
    const childEnd = child.position?.end.line;
    if (childEnd && childEnd > end) end = childEnd;
  }
  return end || fallback;
}

/** Recursively collects text content from a node, skipping any nested
 *  `list` subtree. Loose enough to walk any mdast node shape without
 *  depending on the full block/phrasing-content type union — every mdast
 *  node has a `type`, text-bearing leaves expose either `value`
 *  (text/inlineCode/html) or `alt` (image), and container nodes expose
 *  `children`. */
function collectOwnText(node: unknown, parts: string[]): void {
  if (!node || typeof node !== 'object') return;
  const n = node as { type?: unknown; value?: unknown; alt?: unknown; children?: unknown };
  if (n.type === 'list') return;
  if (typeof n.value === 'string') parts.push(n.value);
  if (typeof n.alt === 'string') parts.push(n.alt);
  if (Array.isArray(n.children)) {
    for (const child of n.children) collectOwnText(child, parts);
  }
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A single top-level paragraph or heading's change-classification-relevant
 *  data, extracted independently from one parsed source (old or new) — the
 *  prose sibling of `MdListItem`. Unlike a list item, a paragraph/heading is
 *  already correctly scoped as ONE unit by mdast (no sibling to
 *  misattribute to, and no nested-block content possible inside either
 *  node type per CommonMark's content model), so there is no `depth`/
 *  `listStartLine` analogue here — see `proseKeyOf` for how these bucket
 *  for pairing instead. */
export interface MdProseUnit {
  /** 1-based source line where the block starts. Matches the
   *  `data-start-line` attribute `renderDoc` annotates on the rendered
   *  `<p>`/`<h1>`-`<h6>` (markdown.tsx). */
  startLine: number;
  /** 1-based source line where the block ends. A paragraph/heading's mdast
   *  `position.end` is already its OWN end (it cannot contain a nested
   *  block), so — unlike `MdListItem.endLine` — this needs no separate
   *  "exclude nested content" computation. */
  endLine: number;
  /** 'p' for a paragraph; 'h1'..'h6' for a heading, keyed by its own depth.
   *  Doubles as the pairing bucket key — see `proseKeyOf`. */
  kind: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  /** The block's own plain-text content, whitespace-normalized (runs
   *  collapsed, trimmed) — same rule as `MdListItem.text`, via the same
   *  `collectOwnText`/`normalizeText` helpers. Used for equality/pairing and
   *  the intraline word-diff old-side input; never rendered directly (the
   *  fallback detail marker uses the verbatim raw source slice instead, the
   *  same rule `MdListItem.text` already follows for list items). */
  text: string;
}

/** Extracts every top-level paragraph and heading, in document order. Pure;
 *  does no DOM/React work. Extraction stays kind-specific by design (a
 *  paragraph and a heading need different `kind` derivation), mirroring
 *  `extractListItems` for lists — a future block kind (table row,
 *  blockquote child) is expected to add its own sibling extractor rather
 *  than generalize this one further. */
export function extractProseUnits(source: string): MdProseUnit[] {
  const tree = parseTree(source);
  const units: MdProseUnit[] = [];
  for (const node of tree.children) {
    if (node.type !== 'paragraph' && node.type !== 'heading') continue;
    const startLine = node.position?.start.line ?? 0;
    const endLine = node.position?.end.line ?? startLine;
    const kind: MdProseUnit['kind'] =
      node.type === 'heading' ? (`h${(node as Heading).depth}` as MdProseUnit['kind']) : 'p';
    const textParts: string[] = [];
    for (const child of node.children) collectOwnText(child, textParts);
    units.push({ startLine, endLine, kind, text: normalizeText(textParts.join(' ')) });
  }
  return units;
}

/**
 * Bucket key for prose pairing: the unit's own `kind` ('p' or 'h1'..'h6'),
 * joined by VALUE across the old/new sides — unlike list pairing's per-side
 * first-appearance ORDINAL remap (`listKeyOf`), a paragraph/heading's kind
 * is an intrinsically stable key across two independent parses (the Nth
 * paragraph in the old document and the Nth paragraph in the new document
 * are not otherwise related, but "a paragraph" and "a paragraph" are always
 * comparable — there is exactly one document-wide bucket per kind), so no
 * remap is needed here. This is also what keeps a heading from ever pairing
 * with a paragraph even when their text happens to coincide.
 *
 * Tradeoff, accepted as a lossy-but-safe degradation: bucketing per literal
 * heading LEVEL means a level promote/demote (e.g. `##` -> `###`) buckets
 * the survivor into a DIFFERENT kind (`h2` vs `h3`), so it never pairs with
 * its own prior self — the old heading is left unmatched (contributes
 * nothing; there is no ghost mechanism for prose) and the new one
 * classifies as `added` rather than `edited`. This is safe (it still
 * renders correctly, just without an intraline diff for that one edit) and
 * was chosen over a depth-insensitive "any heading" bucket, which would risk
 * pairing two semantically unrelated headings that happen to share body
 * text across a level change.
 */
export function proseKeyOf(unit: MdProseUnit): string {
  return unit.kind;
}

/** A single top-level fenced (or indented) code block's change-classification
 *  data — the code sibling of `MdProseUnit` (docs/design/ui-rendered-markdown-diff.md,
 *  "Decision — Extension: Non-List Block Types", "Fenced code blocks"). Like a
 *  paragraph/heading, mdast gives a code block its own top-level node with no
 *  nested-block content possible (a `code` node's `value` is a single opaque
 *  string, not `children`), so this needs no `depth`/`listStartLine` analogue
 *  either — see `codeKeyOf` for the (deliberately trivial) pairing bucket. */
export interface MdCodeUnit {
  /** 1-based source line where the block starts — for a FENCED code block
   *  this is the OPENING fence line (` ```lang `), not the first content
   *  line: mdast's `code` node position spans fence-to-fence inclusive, and
   *  `renderDoc` (markdown.tsx) propagates that same position verbatim onto
   *  the rendered `<code>` element's `data-start-line` (NOT the wrapping
   *  `<pre>` — see markdown.tsx's `codeBlockStartLine` doc comment), so this
   *  value is what the rendered DOM lookup must match. */
  startLine: number;
  /** 1-based source line where the block ends — the CLOSING fence line,
   *  matching `data-end-line` on the same `<code>` element. */
  endLine: number;
  /** The block's own source text (the fence content, i.e. `Code.value` —
   *  never the fence markers themselves), whitespace-normalized (runs
   *  collapsed, trimmed) via the same `normalizeText` every other unit kind
   *  uses. Used for equality/pairing and as the intraline word-diff old-side
   *  input; never rendered directly (the fallback detail marker uses the
   *  verbatim FENCE-TO-FENCE raw source slice instead, exactly like
   *  `MdProseUnit.text`/`MdListItem.text`). */
  text: string;
}

/** Languages whose fenced blocks are rewritten to placeholder divs
 *  (MermaidFrame/GraphvizFrame) BEFORE rehype ever runs — see renderDoc's
 *  mermaid/graphviz replacement in markdown.tsx. Those blocks never reach a
 *  rendered `<pre><code>` at all, so they can never be diff-decorated by this
 *  leaf's DOM-splicing path regardless of extraction; excluded here too, at
 *  the source level, as defense-in-depth (a future caller reading
 *  `extractCodeUnits` directly, without going through markdown.tsx's own
 *  render-branch gate, must not be handed a unit for a block it must never
 *  decorate). */
const NON_DIFFABLE_CODE_LANGS = new Set(['mermaid', 'dot', 'graphviz']);

/** Extracts every top-level fenced code block, in document order, EXCLUDING
 *  mermaid/dot/graphviz (see `NON_DIFFABLE_CODE_LANGS`). Pure; does no DOM/
 *  React work. Extraction stays kind-specific by design, mirroring
 *  `extractProseUnits`/`extractListItems` — a future block kind is expected
 *  to add its own sibling extractor rather than generalize this one further. */
export function extractCodeUnits(source: string): MdCodeUnit[] {
  const tree = parseTree(source);
  const units: MdCodeUnit[] = [];
  for (const node of tree.children) {
    if (node.type !== 'code') continue;
    const code = node as Code;
    if (code.lang && NON_DIFFABLE_CODE_LANGS.has(code.lang)) continue;
    const startLine = code.position?.start.line ?? 0;
    const endLine = code.position?.end.line ?? startLine;
    units.push({ startLine, endLine, text: normalizeText(code.value) });
  }
  return units;
}

/**
 * Bucket key for code-block pairing: a SINGLE constant bucket ('code') for
 * every code block in the document, deliberately ignoring `lang` — unlike
 * `proseKeyOf`'s per-kind buckets ('p' vs 'h1'..'h6' never pair with each
 * other). A code block's fence language is not a reliable identity signal
 * the way a paragraph-vs-heading tag distinction is: a block can legitimately
 * be RETAGGED (e.g. ` ```js ` -> ` ```javascript `, or a language label
 * corrected/added/removed) with its body otherwise unchanged or lightly
 * edited, and that is still recognizably "the same block, edited" to a
 * reader. Putting `lang` in the bucket key would instead classify a
 * same-body retag as an unrelated delete+insert pair (`added`, no diff
 * against its actual prior self) purely because the two sides landed in
 * different buckets — strictly worse than the single-bucket choice, which
 * still pairs it (via LCS-anchor or positional-substitution, same as any
 * other edit) and shows an accurate `edited` result, at worst falling back to
 * the whole-block marker if the retag alone doesn't yield a clean word-level
 * mapping. There is exactly one bucket per document, so every code block
 * pairs positionally against the others in document order (LCS-anchored on
 * exact text match first, same as every other `pairUnits` caller). */
export function codeKeyOf(_unit: MdCodeUnit): string {
  return 'code';
}

/** A single markdown table row's change-classification data — the table
 *  sibling of `MdListItem` (docs/design/ui-rendered-markdown-diff.md,
 *  "Decision — Extension: Non-List Block Types", "Tables"). Both the header
 *  row (`<thead><tr><th>`) and every body row (`<tbody><tr><td>`) are
 *  `tableRow` mdast nodes — there is no separate node type for a header row,
 *  `isHeader` (the table's FIRST row) is how this module tells them apart,
 *  matching remark-gfm's own table model. */
export interface MdTableRow {
  /** 1-based source line where the row starts — matches the rendered
   *  `<tr>`'s `data-start-line` (renderDoc's ANCHOR_NODE_TYPES already
   *  includes 'tableRow', so no new annotation is needed). A GFM table row
   *  is always exactly one source line (a `|`-delimited row cannot itself
   *  span multiple lines — unlike a loose list item), so this always equals
   *  `endLine`. */
  startLine: number;
  /** 1-based source line where the row ends — always equal to `startLine`
   *  (see above); kept as its own field purely so `MdTableRow` satisfies the
   *  `{ startLine, endLine, text }` shape `classifyUnits` requires,
   *  mirroring `MdProseUnit`/`MdCodeUnit`. */
  endLine: number;
  /** Start line of the row's enclosing `table` node — the table analogue of
   *  `MdListItem.listStartLine`, used to bucket rows per-table so pairing
   *  never crosses two unrelated tables (see `tableRowKeyOf`). */
  tableStartLine: number;
  /** True for a table's first row (the header, rendered `<thead><tr><th>`);
   *  false for every body row (`<tbody><tr><td>`). */
  isHeader: boolean;
  /** Each cell's own plain-text content, in column order — the same
   *  `collectOwnText`+`normalizeText` flattening every other unit kind
   *  uses. Raw mdast cell count (symmetric on both the old and new side for
   *  a well-formed GFM table, since mdast-util-gfm-table normalizes every
   *  row to the header's own column count during parsing); NOT re-padded or
   *  truncated here — that is a rendering concern (see markdown.tsx's
   *  `buildGhostTableRow`, which pads/truncates against the RENDERED row's
   *  own cell count at insertion time). */
  cells: string[];
  /** The row's identity text for pairing/equality — every cell's own text
   *  joined by a NUL character (`'\u0000'`), deliberately NOT a space:
   *  unlike `MdListItem.text` (which has no cell concept at all), joining
   *  table cells with a plain space could make two DIFFERENT rows compare
   *  equal purely because content shifted across a cell boundary — e.g. old
   *  `["a", "b c"]` and new `["a b", "c"]` both flatten to `"a b c"` with a
   *  space join, though they are genuinely different rows, producing a
   *  false LCS anchor. `normalizeText` already collapses/trims whitespace
   *  and can never itself introduce a NUL, so no real cell content can ever
   *  contain one — joining on it makes the cell boundary itself part of the
   *  row's identity, ruling out this cross-boundary false-equality class
   *  entirely. */
  text: string;
}

/** Extracts every table row — the header row (`isHeader: true`) and every
 *  body row (`isHeader: false`), across every top-level `table` node — in
 *  document order. Pure; does no DOM/React work. Extraction stays
 *  kind-specific by design, mirroring `extractListItems`/`extractProseUnits`/
 *  `extractCodeUnits`. */
export function extractTableRows(source: string): MdTableRow[] {
  const tree = parseTree(source);
  const rows: MdTableRow[] = [];
  for (const node of tree.children) {
    if (node.type !== 'table') continue;
    const table = node as Table;
    const tableStartLine = table.position?.start.line ?? 0;
    table.children.forEach((row, i) => {
      const startLine = row.position?.start.line ?? 0;
      const endLine = row.position?.end.line ?? startLine;
      const cells = row.children.map((cell) => {
        const textParts: string[] = [];
        for (const child of cell.children) collectOwnText(child, textParts);
        return normalizeText(textParts.join(' '));
      });
      rows.push({
        startLine,
        endLine,
        tableStartLine,
        isHeader: i === 0,
        cells,
        text: cells.join('\u0000'),
      });
    });
  }
  return rows;
}

/** A single blockquote's direct child's change-classification data — the
 *  blockquote sibling of `MdProseUnit` (docs/design/ui-rendered-markdown-diff.md,
 *  "Decision — Extension: Non-List Block Types", "Blockquotes"). Unlike a
 *  top-level paragraph/heading, a blockquote child is only ONE of
 *  potentially several siblings inside a shared multi-child container —
 *  structurally closer to `MdListItem`/`MdTableRow` than to `MdProseUnit` —
 *  so pairing needs a per-blockquote bucket key (see
 *  `blockquoteChildKeyOf`), the same reason `MdListItem.listStartLine`/
 *  `MdTableRow.tableStartLine` exist. */
export interface MdBlockquoteChild {
  /** 1-based source line where the child starts. Matches the
   *  `data-start-line` attribute `renderDoc` annotates on the rendered
   *  child element (`<p>`/`<h1>`-`<h6>` — see `extractBlockquoteChildren`'s
   *  doc comment for why only these two node types are ever extracted). */
  startLine: number;
  /** 1-based source line where the child ends. A paragraph/heading cannot
   *  itself contain a nested block (the same CommonMark content-model
   *  guarantee `MdProseUnit.endLine` relies on), so — unlike
   *  `MdListItem.endLine` — this needs no separate "exclude nested content"
   *  computation. */
  endLine: number;
  /** Start line of the child's immediately-enclosing `blockquote` node —
   *  the blockquote analogue of `MdListItem.listStartLine`/
   *  `MdTableRow.tableStartLine`, used to bucket children per-blockquote so
   *  pairing never crosses two unrelated blockquotes (see
   *  `blockquoteChildKeyOf`). */
  blockquoteStartLine: number;
  /** The child's own plain-text content, whitespace-normalized — the same
   *  `collectOwnText` + `normalizeText` rule every other unit kind uses.
   *  Used for equality/pairing and the intraline word-diff old-side input;
   *  never rendered directly (the fallback detail marker uses the verbatim
   *  raw source slice instead, same rule as every other unit kind). */
  text: string;
}

/**
 * Extracts every DIRECT child of every top-level `blockquote` node that is
 * itself a `paragraph` or `heading`, in document order. Pure; does no DOM/
 * React work. Mirrors `extractProseUnits`'s own top-level `paragraph`/
 * `heading` filter exactly, just scoped one level down (`blockquote.children`
 * instead of `tree.children`) — `text` is computed by calling
 * `collectOwnText` directly on the child node itself, which is equivalent
 * to (and simpler than) `extractProseUnits`'s "iterate `node.children` and
 * collect each" loop: `collectOwnText` on a paragraph/heading node
 * immediately recurses into its own `children`, having no `value`/`alt` of
 * its own to contribute first.
 *
 * DELIBERATELY excludes every other direct-child node type — most notably a
 * nested `list` and a nested `blockquote` (docs/design/ui-rendered-markdown-diff.md's
 * explicit composition boundary: "a blockquote may also directly contain a
 * nested list or another blockquote, each of which keeps ITS OWN existing
 * per-item/whole-block treatment recursively — this record does not add a
 * new mechanism for that nesting"), but also any OTHER block type a
 * blockquote can legally contain (a fenced code block, a GFM table, a
 * thematic break, a raw HTML block) — none of these are discussed by the
 * design record, and none are safe to hand to `spliceIntralineInto`
 * (markdown.tsx): that splice engine treats an element CHILD as one opaque,
 * never-splice-eligible slot (see markdown.tsx's `Slot` doc comment), so
 * splicing into e.g. a nested `<ul>` or `<table>` was never the intent here.
 *
 * Excluding these node types at EXTRACTION time (not merely at decoration
 * time) is required, not just tidy: `collectOwnText` special-cases only
 * `list` (returns '' immediately — see its own doc comment), so a nested
 * TABLE or CODE child, if extracted, would produce a genuine, non-empty
 * flattened text and could classify 'edited' with no decoration ever
 * applied to it (markdown.tsx's `decorateBlockquoteChildren` only ever
 * touches a `<p>`/`<h1>`-`<h6>` element) — silently suppressing the
 * blockquote's own legacy whole-block fallback wash (the zero-decoration
 * safety net) while showing NOTHING in its place, exactly the "technically
 * classified but the user can't tell what changed" bug class leaf .3 was
 * REJECTED for. A nested LIST child specifically would be even more subtly
 * wrong: `collectOwnText` returns '' for a `list` node regardless of
 * content, so an old-side and new-side nested list would always compare
 * text-equal (both '') and pair via LCS — meaning ANY edit confined to the
 * list's own items would still classify the (never-decorated) list child as
 * 'edited' purely because its line range overlaps `changedLineSet`, with the
 * exact same silent-suppression consequence. Excluding these types from
 * extraction entirely — so no unit, hence no classification entry, is ever
 * produced for them — is what lets the zero-decoration safety net correctly
 * fall back to the blockquote's whole-block wash instead.
 */
export function extractBlockquoteChildren(source: string): MdBlockquoteChild[] {
  const tree = parseTree(source);
  const children: MdBlockquoteChild[] = [];
  for (const node of tree.children) {
    if (node.type !== 'blockquote') continue;
    const blockquoteStartLine = node.position?.start.line ?? 0;
    for (const child of (node as Blockquote).children) {
      if (child.type !== 'paragraph' && child.type !== 'heading') continue;
      const startLine = child.position?.start.line ?? 0;
      const endLine = child.position?.end.line ?? startLine;
      const textParts: string[] = [];
      collectOwnText(child, textParts);
      children.push({
        startLine,
        endLine,
        blockquoteStartLine,
        text: normalizeText(textParts.join(' ')),
      });
    }
  }
  return children;
}

export interface PairUnitsResult<T> {
  /** Parallel to the `newUnits` array passed in: each new unit's matched
   *  old unit, or `null` when it has no corresponding unit in the old tree. */
  matches: Array<T | null>;
  /** Old units with no corresponding new unit (removed). */
  unmatchedOld: Set<T>;
}

/** List-item specialization of `PairUnitsResult` — kept as its own exported
 *  name (rather than inlining `PairUnitsResult<MdListItem>` at every call
 *  site) since every existing consumer (`resolveGhostAnchors`, markdown.tsx)
 *  already imports it by this name. Not rendered by this leaf — the
 *  unmatched-old set is consumed by the ghost-row leaf (.3). */
export type PairListItemsResult = PairUnitsResult<MdListItem>;

/**
 * Deterministic sequence alignment between an old and new unit list:
 * longest-common-subsequence on exact-equal `text`, computed independently
 * per `keyOf` bucket (so units never pair across unrelated buckets — e.g.
 * two different lists, or a paragraph vs. a heading), with the gaps between
 * LCS anchors resolved by positional substitution — i.e. when both sides
 * have leftover units in the same gap, they pair up as "edited" (this is
 * what lets `classifyUnits` distinguish an edited unit from a delete+insert
 * pair, since an edited unit's text — by definition — does NOT exact-match
 * its old counterpart, so LCS alone never anchors it). Leftover units
 * beyond the shorter side's length within a gap stay unmatched (excess old =
 * deletions, excess new = insertions).
 *
 * `keyOf` decides what "the same bucket" means and is entirely the caller's
 * responsibility to get right — see `listKeyOf` (per-side first-appearance
 * ordinal remap) and `proseKeyOf` (bucket by kind, joined by value) for the
 * two shapes this repo needs today, and their doc comments for why a naive
 * "same accessor, same shape" choice can silently break pairing.
 */
export function pairUnits<T extends { text: string }>(
  oldUnits: T[],
  newUnits: T[],
  keyOf: (unit: T) => number | string,
): PairUnitsResult<T> {
  const oldBuckets = bucketByKey(oldUnits, keyOf);
  const newBuckets = bucketByKey(newUnits, keyOf);
  const newIndex = new Map<T, number>(newUnits.map((unit, i) => [unit, i]));
  const matches = new Array<T | null>(newUnits.length).fill(null);
  const unmatchedOld = new Set<T>(oldUnits);

  const keys = new Set<number | string>([...oldBuckets.keys(), ...newBuckets.keys()]);
  for (const key of keys) {
    const oldBucket = oldBuckets.get(key) ?? [];
    const newBucket = newBuckets.get(key) ?? [];
    alignBucket(oldBucket, newBucket, (oldUnit, newUnit) => {
      const idx = newIndex.get(newUnit);
      if (idx !== undefined) matches[idx] = oldUnit;
      unmatchedOld.delete(oldUnit);
    });
  }
  return { matches, unmatchedOld };
}

/** Groups `units` by `keyOf(unit)`, preserving each bucket's relative
 *  (pre-order) item ordering — required by `alignBucket`'s own LCS, which
 *  assumes each bucket array is already in document order. */
function bucketByKey<T>(
  units: T[],
  keyOf: (unit: T) => number | string,
): Map<number | string, T[]> {
  const buckets = new Map<number | string, T[]>();
  for (const unit of units) {
    const key = keyOf(unit);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(unit);
    else buckets.set(key, [unit]);
  }
  return buckets;
}

/** Thin wrapper over `pairUnits`, kept at its original exported signature —
 *  every existing caller (markdown.tsx, this file's own tests) constructs no
 *  `keyOf` of its own. Delegates entirely to `listKeyOf` for bucketing; see
 *  its doc comment for why list pairing cannot use `pairUnits` with a naive
 *  `(item) => item.listStartLine` key. */
export function pairListItems(oldItems: MdListItem[], newItems: MdListItem[]): PairListItemsResult {
  return pairUnits(oldItems, newItems, listKeyOf(oldItems, newItems));
}

/**
 * Assigns each distinct `groupOf(item)` value (within ONE side's own
 * extraction) an ordinal in first-appearance (i.e. document pre-order)
 * order — NOT the raw group value itself, which is meaningless across two
 * independent parses (old/new source have unrelated line-number spaces).
 * `items` MUST already be in document pre-order (as every `extract*`
 * function in this module produces), so insertion order into this map IS
 * pre-order. Generalizes what was originally a list-only helper
 * (`(item) => item.listStartLine`) so `tableRowKeyOf` (below) can reuse the
 * exact same "Nth container encountered in THIS side's own traversal"
 * pattern for tables — see `listKeyOf` for how the OLD-side and NEW-side
 * maps this produces are combined into a single cross-referenced `keyOf`.
 */
function ordinalsByFirstAppearance<T>(
  items: T[],
  groupOf: (item: T) => number | string,
): Map<number | string, number> {
  const ordinalByGroup = new Map<number | string, number>();
  for (const item of items) {
    const group = groupOf(item);
    if (!ordinalByGroup.has(group)) {
      ordinalByGroup.set(group, ordinalByGroup.size);
    }
  }
  return ordinalByGroup;
}

/**
 * Bucket-key accessor for list pairing: two lists (one from each side) are
 * treated as "the same list" when they share the same ordinal, i.e. the Nth
 * list encountered in EACH document's own pre-order traversal (top-level
 * lists and nested sub-lists alike, in the order `extractListItems` visits
 * them) — this is a heuristic, not a semantic identity: it holds for the
 * common case (edits within existing lists, unrelated content elsewhere)
 * and degrades gracefully — a plausible but not-guaranteed-correct pairing —
 * if lists themselves are inserted/removed/reordered relative to each
 * other; there is no stronger signal available without a real tree-diff,
 * which is out of scope here.
 *
 * CRITICAL: this can NOT be a naive `(item) => item.listStartLine` key
 * plugged straight into `pairUnits` — `listStartLine` is a raw source-line
 * number, and the old and new sides' line-number spaces are UNRELATED
 * (independent parses). The ordinal remap above must run separately per
 * side; this function builds BOTH sides' ordinal maps up front and merges
 * them into a single per-item lookup (keyed by object identity, which is
 * safe since `oldItems`/`newItems` are always disjoint object instances —
 * one extraction per side), so the returned closure is a pure `(item) =>
 * key` function as `pairUnits`/`classifyUnits` require, while still
 * resolving each item against the correct side's own ordinal space.
 */
function listKeyOf(oldItems: MdListItem[], newItems: MdListItem[]): (item: MdListItem) => number {
  const oldOrdinals = ordinalsByFirstAppearance(oldItems, (item) => item.listStartLine);
  const newOrdinals = ordinalsByFirstAppearance(newItems, (item) => item.listStartLine);
  const ordinalByItem = new Map<MdListItem, number>();
  for (const item of oldItems) ordinalByItem.set(item, oldOrdinals.get(item.listStartLine)!);
  for (const item of newItems) ordinalByItem.set(item, newOrdinals.get(item.listStartLine)!);
  return (item) => ordinalByItem.get(item)!;
}

/**
 * Bucket-key accessor for table-row pairing — the table analogue of
 * `listKeyOf`, reusing the exact same per-side first-appearance ordinal
 * remap (`ordinalsByFirstAppearance`), keyed by each row's `tableStartLine`:
 * "the Nth table encountered in EACH document's own pre-order traversal" is
 * the same heuristic identity `listKeyOf` uses for lists — see its own doc
 * comment for the full rationale and degradation characteristics (it
 * applies unchanged here: a plausible-but-not-guaranteed pairing that
 * degrades gracefully when tables themselves are inserted/removed/
 * reordered).
 *
 * The bucket key is `` `${tableOrdinal}:${isHeader ? 'h' : 'b'}` `` — the
 * `:h`/`:b` suffix is REQUIRED, not cosmetic. Without it, a table's header
 * row and its body rows would share one bucket (same `tableStartLine`) and
 * could pair against EACH OTHER whenever their cell text happens to align
 * positionally. Worse, it would corrupt ghost-row anchoring for the
 * documented "table analogue of the wholly-deleted-list rule" (a table
 * whose body rows are ALL deleted but whose header survives must contribute
 * NO ghosts): with header and body merged into one bucket, the surviving
 * header would be picked up as a false "first survivor" for the deleted
 * body rows, synthesizing ghosts anchored right after the header instead of
 * correctly producing none. A header and a body row are never semantically
 * the same kind of thing — a header can't become "edited" into a body row —
 * so the suffix guarantees they can never share a bucket, mirroring how
 * `proseKeyOf` keeps a `'p'` bucket from ever pairing with an `'h1'` one.
 */
export function tableRowKeyOf(
  oldRows: MdTableRow[],
  newRows: MdTableRow[],
): (row: MdTableRow) => string {
  const oldOrdinals = ordinalsByFirstAppearance(oldRows, (row) => row.tableStartLine);
  const newOrdinals = ordinalsByFirstAppearance(newRows, (row) => row.tableStartLine);
  const bucketKey = (row: MdTableRow, ordinals: Map<number | string, number>): string =>
    `${ordinals.get(row.tableStartLine)}:${row.isHeader ? 'h' : 'b'}`;
  const keyByRow = new Map<MdTableRow, string>();
  for (const row of oldRows) keyByRow.set(row, bucketKey(row, oldOrdinals));
  for (const row of newRows) keyByRow.set(row, bucketKey(row, newOrdinals));
  return (row) => keyByRow.get(row)!;
}

/**
 * Bucket-key accessor for blockquote-child pairing — the blockquote
 * analogue of `listKeyOf`/`tableRowKeyOf`, reusing the exact same per-side
 * first-appearance ordinal remap (`ordinalsByFirstAppearance`), keyed by
 * each child's `blockquoteStartLine`: "the Nth blockquote encountered in
 * EACH document's own pre-order traversal" is the same heuristic identity
 * `listKeyOf`/`tableRowKeyOf` use for lists/tables — see `listKeyOf`'s own
 * doc comment for the full rationale and degradation characteristics (it
 * applies unchanged here: a plausible-but-not-guaranteed pairing that
 * degrades gracefully when blockquotes themselves are inserted/removed/
 * reordered relative to each other). Unlike `tableRowKeyOf`, no header/body
 * suffix is needed — a blockquote's direct children are homogeneous (no
 * analogue of a table's distinct header row), so the bare per-blockquote
 * ordinal is the complete key, mirroring `listKeyOf` exactly.
 */
export function blockquoteChildKeyOf(
  oldChildren: MdBlockquoteChild[],
  newChildren: MdBlockquoteChild[],
): (child: MdBlockquoteChild) => number {
  const oldOrdinals = ordinalsByFirstAppearance(oldChildren, (child) => child.blockquoteStartLine);
  const newOrdinals = ordinalsByFirstAppearance(newChildren, (child) => child.blockquoteStartLine);
  const ordinalByChild = new Map<MdBlockquoteChild, number>();
  for (const child of oldChildren) {
    ordinalByChild.set(child, oldOrdinals.get(child.blockquoteStartLine)!);
  }
  for (const child of newChildren) {
    ordinalByChild.set(child, newOrdinals.get(child.blockquoteStartLine)!);
  }
  return (child) => ordinalByChild.get(child)!;
}

/** Aligns one (old, new) bucket pair and reports every matched pair — both
 *  exact (LCS anchor, unchanged text) and substituted (same-gap positional
 *  edit) — via `onMatch`. Unmatched items are simply never reported; the
 *  caller derives "unmatched" as "never reported" (old) or "left `null`"
 *  (new). Generic over any unit shape with `.text` — same body as before
 *  the generalization, it never reads any other field. */
function alignBucket<T extends { text: string }>(
  oldBucket: T[],
  newBucket: T[],
  onMatch: (oldItem: T, newItem: T) => void,
): void {
  const anchors = longestCommonSubsequence(oldBucket, newBucket);
  let oldCursor = 0;
  let newCursor = 0;
  const substituteGap = (oldEnd: number, newEnd: number): void => {
    const gapLen = Math.min(oldEnd - oldCursor, newEnd - newCursor);
    for (let k = 0; k < gapLen; k++) {
      onMatch(oldBucket[oldCursor + k], newBucket[newCursor + k]);
    }
  };
  for (const [oi, ni] of anchors) {
    substituteGap(oi, ni);
    onMatch(oldBucket[oi], newBucket[ni]);
    oldCursor = oi + 1;
    newCursor = ni + 1;
  }
  substituteGap(oldBucket.length, newBucket.length);
}

/** Standard O(n*m) LCS via DP table + backtrack, matching on exact `text`
 *  equality. Returns matched index pairs `[oldIndex, newIndex]`, strictly
 *  increasing on both sides. List/prose unit counts in a markdown document
 *  are small (tens to low hundreds), so the quadratic table is not a
 *  practical concern; this repo has no diff library and must not gain one
 *  for this. Generic over any unit shape with `.text` — same body as before
 *  the generalization, it never reads any other field. */
function longestCommonSubsequence<T extends { text: string }>(
  a: T[],
  b: T[],
): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].text === b[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/**
 * Per-new-unit classification, combining `pairUnits`'s alignment with the
 * caller's line-based `changedLineSet`. Callers with no usable old side
 * (untracked/external file, or a still-loading diff bundle) should not call
 * this at all — see RenderedMarkdown's graceful-degradation gate — but an
 * absent `changedLineSet` degrades safely here too: every unit comes back
 * `unchanged`. Generic over any unit shape with `{ startLine, endLine,
 * text }`; see `pairUnits`'s doc comment for `keyOf`'s contract.
 */
export function classifyUnits<
  T extends { startLine: number; endLine: number; text: string },
>(args: {
  newUnits: T[];
  oldUnits: T[];
  changedLineSet: Set<number> | undefined;
  keyOf: (unit: T) => number | string;
}): ItemClassification[] {
  const { newUnits, oldUnits, changedLineSet, keyOf } = args;
  const { matches } = pairUnits(oldUnits, newUnits, keyOf);
  return newUnits.map((unit, i) => {
    if (!changedLineSet || !itemOverlaps(changedLineSet, unit.startLine, unit.endLine)) {
      return 'unchanged';
    }
    return matches[i] ? 'edited' : 'added';
  });
}

/** Thin wrapper over `classifyUnits`, kept at its original exported
 *  signature — every existing caller (markdown.tsx, this file's own tests)
 *  passes no `keyOf` of its own. Delegates to `listKeyOf`, exactly like
 *  `pairListItems`. */
export function classifyItems(args: {
  newItems: MdListItem[];
  oldItems: MdListItem[];
  changedLineSet: Set<number> | undefined;
}): ItemClassification[] {
  const { newItems, oldItems, changedLineSet } = args;
  return classifyUnits({
    newUnits: newItems,
    oldUnits: oldItems,
    changedLineSet,
    keyOf: listKeyOf(oldItems, newItems),
  });
}

function itemOverlaps(changedLines: Set<number>, start: number, end: number): boolean {
  if (start <= 0) return false;
  for (let line = start; line <= end; line++) {
    if (changedLines.has(line)) return true;
  }
  return false;
}

/**
 * Ghost-row anchor resolution (docs/design/ui-rendered-markdown-diff.md,
 * Decision item 5, "Ghost row positioning", and "Decision — Extension:
 * Non-List Block Types", "Tables"). Pure — no DOM; the caller (markdown.tsx)
 * turns each anchor into a synthesized element and inserts it into the
 * rendered NEW tree. Reuses the caller's own alignment (`pairing`) rather
 * than recomputing it — this module's LCS/bucket logic is the single source
 * of "which old unit matches which new unit," and ghost placement must stay
 * consistent with it.
 *
 * Generic over any unit shape with `{ text, startLine }` — the shared core
 * both `resolveGhostAnchors` (lists, below) and the table-row ghost path
 * (markdown.tsx) build on, so there is exactly ONE anchor-resolution
 * algorithm regardless of container kind. `bucketOf` decides what "the same
 * container" means, exactly like `pairUnits`'s own `keyOf` — the CALLER is
 * responsible for passing a `bucketOf` that partitions `oldUnits` the same
 * way `pairing` itself was computed, or pairing and anchoring can disagree
 * (see `tableRowKeyOf`'s doc comment for why the table caller passes THAT
 * SAME closure here rather than a raw field access).
 *
 * Precondition: `pairing` MUST be `pairUnits(oldUnits, newUnits, keyOf)`
 * called with these EXACT SAME `oldUnits`/`newUnits` array instances (object
 * identity, not just equal content) — matching is looked up by object
 * reference, mirroring `pairUnits`'s own `unmatchedOld`/`matches` contract.
 *
 * Resolves, for every unmatched OLD unit (`pairing.unmatchedOld`), where its
 * ghost belongs in the NEW tree: walk backward through its OLD-tree
 * siblings (units sharing the same `bucketOf` value, in document order) to
 * the nearest one that survived (has a match in `pairing.matches`), and
 * anchor immediately after THAT sibling's matched new unit. When no
 * surviving sibling precedes it, every ghost at the head of that run anchors
 * to the container's start boundary instead, using the bucket's first
 * surviving unit (any surviving sibling identifies the same corresponding
 * new container) purely to locate the container — never as an insertion
 * point. A bucket with NO surviving sibling at all (the entire old
 * container was deleted) contributes NO anchors — there is no corresponding
 * new container to host a ghost, so it degrades silently rather than
 * synthesizing one (per the design's explicit "render nothing" rule for a
 * wholly-deleted list, and its table analogue for a wholly-deleted table).
 *
 * Anchors are returned in old-document order, which is what lets the caller
 * (`markdown.tsx`'s `insertGhostRows`/`insertGhostTableRows`) preserve
 * consecutive deletions' original relative order by chaining each insertion
 * off the previous one when two ghosts share the same anchor point.
 */
export interface UnitGhostAnchor<T> {
  /** The removed old unit itself — the caller reads whatever fields it
   *  needs to render the ghost (e.g. `MdListItem.text` for a list item,
   *  `MdTableRow.cells` for a table row) rather than this module
   *  pre-flattening a rendering-specific shape. */
  unit: T;
  /** A NEW-tree unit's `startLine`, used only to locate the DOM container
   *  the ghost belongs in (any surviving sibling from the same old
   *  container). Relevant only for the start-of-container case;
   *  `insertAfterStartLine` takes precedence as the actual insertion point
   *  when set. */
  hostStartLine: number;
  /** When set, the ghost is inserted immediately after the NEW element with
   *  this `startLine` — the last surviving OLD sibling that precedes the
   *  deleted unit, per the design's context-anchoring rule. `null` means no
   *  surviving sibling precedes it in the old container, so it anchors to
   *  the container's start boundary instead (inserted as its first child). */
  insertAfterStartLine: number | null;
}

export function resolveGhostAnchorsForUnits<T extends { text: string; startLine: number }>(
  oldUnits: T[],
  newUnits: T[],
  pairing: PairUnitsResult<T>,
  bucketOf: (unit: T) => number | string,
): UnitGhostAnchor<T>[] {
  const { matches, unmatchedOld } = pairing;
  if (unmatchedOld.size === 0) return [];

  const survivorNewStartLine = new Map<T, number>();
  newUnits.forEach((newUnit, i) => {
    const oldUnit = matches[i];
    if (oldUnit) survivorNewStartLine.set(oldUnit, newUnit.startLine);
  });

  const buckets = new Map<number | string, T[]>();
  for (const unit of oldUnits) {
    const key = bucketOf(unit);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(unit);
    else buckets.set(key, [unit]);
  }

  const anchors: UnitGhostAnchor<T>[] = [];
  for (const bucket of buckets.values()) {
    const firstSurvivorStartLine = bucket
      .map((unit) => survivorNewStartLine.get(unit))
      .find((line): line is number => line !== undefined);
    if (firstSurvivorStartLine === undefined) continue; // whole container deleted

    let precedingSurvivorStartLine: number | null = null;
    for (const unit of bucket) {
      const ownStartLine = survivorNewStartLine.get(unit);
      if (ownStartLine !== undefined) {
        precedingSurvivorStartLine = ownStartLine;
        continue;
      }
      // Not in survivorNewStartLine === in pairing.unmatchedOld (both are
      // derived from the same `matches` array) — every unit reaching here
      // is a genuine deletion.
      anchors.push({
        unit,
        hostStartLine: firstSurvivorStartLine,
        insertAfterStartLine: precedingSurvivorStartLine,
      });
    }
  }
  return anchors;
}

/** List-item specialization of `UnitGhostAnchor`/`resolveGhostAnchorsForUnits`
 *  — kept at its ORIGINAL exported shape and signature (every existing
 *  caller: markdown.tsx, this file's own tests) since this predates the
 *  generalization above. A thin wrapper: `bucketOf` is a raw
 *  `(item) => item.listStartLine` field access (NOT `listKeyOf`'s
 *  cross-referenced ordinal — old-side-only bucketing never needs the
 *  ordinal remap; see `listKeyOf`'s own doc comment for why that remap
 *  exists at all), mapping the generic `{ unit, hostStartLine }` result back
 *  onto `GhostAnchor`'s `{ text, hostItemStartLine }` field names. Output is
 *  byte-identical to the original hand-written implementation. */
export interface GhostAnchor {
  /** The removed old item's own flattened text (see `MdListItem.text`) —
   *  rendered as the ghost's content, always as a plain text node. */
  text: string;
  /** A NEW-tree item's `startLine`, used only to locate the DOM list the
   *  ghost belongs in (any surviving sibling from the same old list — see
   *  `resolveGhostAnchors`). Relevant only for the start-of-list case;
   *  `insertAfterStartLine` takes precedence as the actual insertion point
   *  when set. */
  hostItemStartLine: number;
  /** When set, the ghost is inserted immediately after the NEW `<li>` with
   *  this `startLine` — the last surviving OLD sibling that precedes the
   *  deleted item, per the design's context-anchoring rule. `null` means no
   *  surviving sibling precedes it in the old list, so it anchors to the
   *  list's start boundary instead (inserted as the list's first child). */
  insertAfterStartLine: number | null;
}

export function resolveGhostAnchors(
  oldItems: MdListItem[],
  newItems: MdListItem[],
  pairing: PairListItemsResult,
): GhostAnchor[] {
  const anchors = resolveGhostAnchorsForUnits(
    oldItems,
    newItems,
    pairing,
    (item) => item.listStartLine,
  );
  return anchors.map((a) => ({
    text: a.unit.text,
    hostItemStartLine: a.hostStartLine,
    insertAfterStartLine: a.insertAfterStartLine,
  }));
}
