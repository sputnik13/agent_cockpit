import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoteRecord } from '@shared/ipc/channels';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import DOMPurify from 'dompurify';
import { visit } from 'unist-util-visit';
import type { Root as HastRoot, Element as HastElement } from 'hast';
// Solarized base16 hljs theme — token colors (yellow/orange/red/magenta/violet/
// blue/cyan/green) are theme-invariant and work in both Solarized light/dark.
// Base bg/fg is overridden in styles.css to track --color-panel/--color-fg.
import 'highlight.js/styles/base16/solarized-dark.css';
import type { Root, RootContent, Code } from 'mdast';
import { MermaidFrame } from './mermaid';
import { GraphvizFrame } from './graphviz';
import { openLinkTarget, type LinkContext } from '../links/openLinkTarget';
import { useProjectsStore } from '../providerClient';
import { LineNoteThread, lineNotesByLine, useNotesStore } from '../notes';
import {
  blockquoteChildKeyOf,
  classifyItems,
  classifyUnits,
  codeKeyOf,
  extractBlockquoteChildren,
  extractCodeUnits,
  extractListItems,
  extractProseUnits,
  extractTableRows,
  pairListItems,
  pairUnits,
  proseKeyOf,
  resolveGhostAnchors,
  resolveGhostAnchorsForUnits,
  tableRowKeyOf,
  type GhostAnchor,
  type MdTableRow,
  type UnitGhostAnchor,
} from './markdownItemDiff';
import { computeWordDiff, type WordDiffSegment } from './wordDiff';

export interface RenderedBlock {
  id: string;
  kind:
    | 'heading'
    | 'paragraph'
    | 'code'
    | 'mermaid'
    | 'graphviz'
    | 'list'
    | 'table'
    | 'blockquote'
    | 'other';
  startLine: number;
  endLine: number;
  source?: string;
  language?: string;
}

/** Per-unit diff info consumed by `decorateListItems` (list items, keyed by
 *  each `<li>`'s own line) and `decorateProseBlock` (paragraphs/headings,
 *  keyed by the block's own line) — see
 *  docs/design/ui-rendered-markdown-diff.md, Decision items 2-4 and
 *  "Decision — Extension: Non-List Block Types". An 'edited' entry always
 *  carries the matched OLD unit's flattened text — `classifyItems`/
 *  `classifyUnits` only ever return 'edited' when the corresponding pairing
 *  call found a match, so this is never undefined in practice; the type
 *  still requires it explicitly so a future caller can't construct an
 *  edited entry with nothing to diff against.
 *
 *  `oldSourceText`/`newSourceText` (leaf .4) are the unit's VERBATIM raw
 *  source-line slices — see `verbatimSourceSlice`'s doc comment for why
 *  these must NOT be derived from `oldText`/the new unit's own flattened
 *  text. Always populated alongside `oldText` (computed from the exact same
 *  matched old/new pair); only actually rendered when the intraline splice
 *  (`spliceIntralineInto`) reports `clean: false`. */
type ItemDiffInfo =
  | { classification: 'added' }
  | { classification: 'edited'; oldText: string; oldSourceText: string; newSourceText: string };

/** Per-row diff info consumed by `decorateTableRows` (keyed by each `<tr>`'s
 *  own line) — the table sibling of `ItemDiffInfo`
 *  (docs/design/ui-rendered-markdown-diff.md, "Decision — Extension:
 *  Non-List Block Types", "Tables"). Unlike a list item's single flattened
 *  `oldText`, an edited row's change can live in ANY of its cells, so this
 *  carries BOTH sides' full per-column cell arrays (`oldCells`/`newCells`,
 *  from `MdTableRow.cells`) rather than one pre-flattened string —
 *  `decorateTableRows` pairs them positionally by column index itself.
 *  `oldSourceText`/`newSourceText` are still the row's single verbatim
 *  raw-source line (see `verbatimSourceSlice`) — a table row is exactly one
 *  source line, so the existing one-row Before/After marker shape already
 *  fits without change. */
type TableRowDiffInfo =
  | { classification: 'added' }
  | {
      classification: 'edited';
      oldCells: string[];
      newCells: string[];
      oldSourceText: string;
      newSourceText: string;
    };

interface RenderMarkdownProps {
  source: string;
  changedLineSet?: Set<number>;
  onBlockClick?: (block: RenderedBlock) => void;
  /** Tighter padding/margins/font for embedding in a panel (e.g. TaskDetail). */
  compact?: boolean;
  /** When set, local-path links are routed through the shared link router
   *  (Explorer/content panel) instead of being inert. */
  linkContext?: LinkContext;
  /** Repo-relative path of the rendered file. When provided, blocks become note
   *  anchors (add via a hover affordance; existing line notes render inline).
   *  Omitted for non-file uses (e.g. TaskDetail), which keep no notes UI. */
  filePath?: string;
  /** The file's pre-change source (git baseline), when available. Enables
   *  per-`<li>` change classification for `list` top-level nodes, and
   *  intraline word-diff for top-level `paragraph`/`heading` nodes (see
   *  markdownItemDiff.ts) instead of the whole-block treatment. `null`/absent
   *  (untracked/external file, or a still-loading diff bundle) falls back to
   *  today's exact whole-block behavior for those nodes too — see
   *  docs/design/ui-rendered-markdown-diff.md, "State Ownership". */
  oldSource?: string | null;
}

const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
    ADD_ATTR: [
      'data-start-line',
      'data-end-line',
      'data-mermaid-id',
      'data-graphviz-id',
      'data-external',
      'data-inert',
      'data-localpath',
      'data-image-blocked',
      'target',
    ],
  });

interface MermaidEntry {
  source: string;
  startLine: number;
  endLine: number;
}

interface PreparedDoc {
  html: string;
  mermaidById: Map<string, MermaidEntry>;
  graphvizById: Map<string, MermaidEntry>;
}

// Single whole-document pass: parse once with GFM, replace top-level mermaid
// code blocks with sentinel placeholders, annotate every top-level node with
// data-start-line/data-end-line via mdast `data.hProperties` (consumed by
// remark-rehype), then stringify + sanitize the full document once. Reference
// definitions, footnote definitions, and reference images resolve because the
// pass sees the whole document; per-block re-parsing would break them.
/** Block-level mdast node types that should carry a source-line anchor so the
 *  rendered view can attach a note to a SPECIFIC line (e.g. one list item or
 *  table row), not just the enclosing top-level block. */
const ANCHOR_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'tableRow',
  'blockquote',
  'code',
  'thematicBreak',
]);

async function renderDoc(source: string): Promise<PreparedDoc> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;

  // Annotate every block-level node (including nested list items / table rows)
  // with its source line range via hProperties, so the rendered DOM exposes
  // `data-start-line` on sub-block elements for line-precise note anchoring.
  visit(tree, (node) => {
    if (!ANCHOR_NODE_TYPES.has(node.type)) return;
    const sl = node.position?.start.line;
    const el = node.position?.end.line;
    if (!sl || !el) return;
    const withData = node as { data?: { hProperties?: Record<string, unknown> } };
    const data = (withData.data ??= {});
    const hProps = (data.hProperties ??= {});
    hProps['data-start-line'] = sl;
    hProps['data-end-line'] = el;
  });

  const mermaidById = new Map<string, MermaidEntry>();
  let mid = 0;
  const graphvizById = new Map<string, MermaidEntry>();
  let gid = 0;

  const children: RootContent[] = tree.children.map((node) => {
    const startLine = node.position?.start.line ?? 0;
    const endLine = node.position?.end.line ?? 0;

    if (node.type === 'code' && (node as Code).lang === 'mermaid') {
      const id = `m${mid++}`;
      mermaidById.set(id, { source: (node as Code).value, startLine, endLine });
      return {
        type: 'paragraph',
        children: [],
        position: node.position,
        data: {
          hName: 'div',
          hProperties: {
            'data-mermaid-id': id,
            'data-start-line': startLine,
            'data-end-line': endLine,
          },
        },
      } as RootContent;
    }

    if (
      node.type === 'code' &&
      ((node as Code).lang === 'dot' || (node as Code).lang === 'graphviz')
    ) {
      const id = `g${gid++}`;
      graphvizById.set(id, { source: (node as Code).value, startLine, endLine });
      return {
        type: 'paragraph',
        children: [],
        position: node.position,
        data: {
          hName: 'div',
          hProperties: {
            'data-graphviz-id': id,
            'data-start-line': startLine,
            'data-end-line': endLine,
          },
        },
      } as RootContent;
    }

    if (startLine && endLine) {
      const withData = node as RootContent & {
        data?: { hProperties?: Record<string, unknown> };
      };
      const data = (withData.data ??= {});
      const hProps = (data.hProperties ??= {});
      hProps['data-start-line'] = startLine;
      hProps['data-end-line'] = endLine;
    }
    return node;
  });
  tree.children = children;

  const processor = unified()
    .use(remarkRehype)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeSafeLinksImages)
    .use(rehypeStringify);
  const hast = await processor.run(tree);
  const html = processor.stringify(hast) as string;
  return { html: sanitize(html), mermaidById, graphvizById };
}

// rehype transform: harden anchors + images.
//  - Absolute http(s)/mailto anchors get target=_blank, rel=noopener noreferrer,
//    and a data-external flag the renderer click handler reads.
//  - Anchors whose href is relative or a fragment get data-inert so the
//    renderer suppresses default navigation (Electron blocks it anyway via
//    will-navigate, but the click would otherwise feel broken).
//  - Images with non-http(s)/data: src are dropped to a plain alt text span so
//    sanitizer can't fight a `javascript:` slip-through later.
function rehypeSafeLinksImages() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node: HastElement) => {
      if (node.tagName === 'a') {
        const href = String((node.properties?.href as string | undefined) ?? '');
        const lower = href.toLowerCase();
        if (
          lower.startsWith('http://') ||
          lower.startsWith('https://') ||
          lower.startsWith('mailto:')
        ) {
          node.properties = {
            ...(node.properties ?? {}),
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-external': 'true',
          };
        } else if (href === '' || href.startsWith('#') || lower.startsWith('javascript:')) {
          // Empty, in-page fragment, or javascript: → inert (no navigation).
          node.properties = { ...(node.properties ?? {}), 'data-inert': 'true' };
          if (lower.startsWith('javascript:'))
            delete (node.properties as Record<string, unknown>).href;
        } else {
          // A local path (relative, absolute, or file://) → routed by the link
          // router (existence-validated) when a linkContext is supplied.
          node.properties = { ...(node.properties ?? {}), 'data-localpath': 'true' };
        }
      } else if (node.tagName === 'img') {
        const src = String((node.properties?.src as string | undefined) ?? '');
        const lower = src.toLowerCase();
        const safe =
          lower.startsWith('http://') ||
          lower.startsWith('https://') ||
          lower.startsWith('data:image/');
        if (!safe) {
          // Convert to alt text so we don't trigger broken-image chrome.
          const alt = String((node.properties?.alt as string | undefined) ?? '');
          node.tagName = 'span';
          node.properties = { 'data-image-blocked': 'true' };
          node.children = alt ? [{ type: 'text', value: alt }] : [];
        }
      }
    });
  };
}

function kindFromTag(tag: string): RenderedBlock['kind'] {
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'p':
      return 'paragraph';
    case 'pre':
      return 'code';
    case 'ul':
    case 'ol':
      return 'list';
    case 'table':
      return 'table';
    case 'blockquote':
      return 'blockquote';
    default:
      return 'other';
  }
}

/**
 * A code block's own source-line anchors (`data-start-line`/`data-end-line`,
 * set by `renderDoc`'s `visit()` pass off the mdast `code` node's position)
 * land on the rendered `<code>` CHILD element, NEVER on the wrapping `<pre>`
 * itself — verified empirically against the real rendered DOM (not assumed):
 * mdast-util-to-hast's default `code` handler applies the mdast node's own
 * hProperties to the `<code>` element it generates, treating `<pre>` as pure
 * wrapping formality. This holds regardless of whether a language/hljs
 * classes are present (plain-text and highlighted blocks alike).
 *
 * EVERY lookup that needs to key code-block behavior off a start/end line
 * MUST go through this helper (and its `codeBlockEndLine` sibling below) —
 * this covers BOTH the decoration lookup (`decoratedBlockHtml`) and the
 * GENERAL per-block `startLine`/`endLine` computed in the render loop (the
 * one that drives `changed`/`blockChanged`/the click cursor/note-anchoring
 * for every block kind) — rather than reading
 * `pre.getAttribute('data-start-line')`/`data-end-line` directly, which
 * always yields 0 and would silently disable the affected feature for every
 * code block (0 makes `canAnchor`/`rangeOverlaps` fail closed with no error,
 * no console noise — indistinguishable from "nothing changed"/"notes not
 * supported here"). The general lookup didn't go through this helper until
 * local_repo_explorer-rendered-md-nonlist-diff-ek7c.5 — found during .2's own
 * review (see this issue's comment log) as a genuinely pre-existing gap, out
 * of .2's scope to fix since it affected every code block's
 * click/note-anchoring, not just decoration.
 */
function codeBlockStartLine(pre: HTMLElement): number {
  return Number(pre.querySelector(':scope > code')?.getAttribute('data-start-line') ?? 0);
}

/** Sibling of `codeBlockStartLine` — same `:scope > code` indirection, reading
 *  `data-end-line` instead. See `codeBlockStartLine`'s doc comment for why
 *  both anchors must always be read through these helpers for a `<pre>`. */
function codeBlockEndLine(pre: HTMLElement): number {
  return Number(pre.querySelector(':scope > code')?.getAttribute('data-end-line') ?? 0);
}

export function RenderedMarkdown(props: RenderMarkdownProps): JSX.Element {
  const [doc, setDoc] = useState<PreparedDoc | null>(null);

  // Line notes (only when a filePath is supplied — i.e. the Content panel, not
  // TaskDetail/compact uses). A note anchors to a block's source start line;
  // existing notes whose line falls within a block render inline beneath it.
  const notesEnabled = props.filePath != null;
  const allNotes = useNotesStore((s) => s.notes);
  const loadNotes = useNotesStore((s) => s.load);
  const addLineNote = useNotesStore((s) => s.addLineNote);
  const removeNote = useNotesStore((s) => s.remove);
  const activeId = useProjectsStore((s) => s.activeId);
  const [composing, setComposing] = useState<number | null>(null);
  useEffect(() => {
    if (notesEnabled) void loadNotes();
  }, [notesEnabled, activeId, loadNotes]);
  const sourceLines = useMemo(() => props.source.split('\n'), [props.source]);
  const notesByLine = useMemo(
    () => lineNotesByLine(props.filePath ? allNotes : [], props.filePath ?? ''),
    [allNotes, props.filePath],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await renderDoc(props.source);
      if (!cancelled) setDoc(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [props.source]);

  const topLevel = useMemo<HTMLElement[]>(() => {
    if (!doc) return [];
    const tpl = document.createElement('template');
    tpl.innerHTML = doc.html;
    return Array.from(tpl.content.children) as HTMLElement[];
  }, [doc]);

  // Per-item classification for `list` nodes (see markdownItemDiff.ts and
  // docs/design/ui-rendered-markdown-diff.md). Degrades to `null` — meaning
  // every list block below falls back to the legacy whole-block treatment —
  // whenever there is no old side or no changedLineSet to classify against.
  // Keyed only by non-'unchanged' items (by their startLine, the same value
  // renderDoc puts in data-start-line) since that's all any consumer needs.
  // An 'edited' entry carries the matched OLD item's flattened text (from
  // leaf .1's own pairing — `pairListItems` is already exported, so this
  // reuses it rather than re-deriving a match elsewhere) for the intraline
  // word-diff below; `classifyItems` itself only returns the verdict, not
  // the match, so both are called here off the same newItems/oldItems.
  const itemClassification = useMemo<Map<number, ItemDiffInfo> | null>(() => {
    const oldSource = props.oldSource;
    if (oldSource == null || !props.changedLineSet) return null;
    const newItems = extractListItems(props.source);
    if (newItems.length === 0) return null;
    const oldItems = extractListItems(oldSource);
    const classes = classifyItems({ newItems, oldItems, changedLineSet: props.changedLineSet });
    const { matches } = pairListItems(oldItems, newItems);
    const byStartLine = new Map<number, ItemDiffInfo>();
    newItems.forEach((item, i) => {
      if (classes[i] === 'unchanged') return;
      const oldItem = matches[i];
      if (classes[i] === 'edited' && oldItem) {
        byStartLine.set(item.startLine, {
          classification: 'edited',
          oldText: oldItem.text,
          oldSourceText: verbatimSourceSlice(oldSource, oldItem.startLine, oldItem.endLine),
          newSourceText: verbatimSourceSlice(props.source, item.startLine, item.endLine),
        });
      } else {
        byStartLine.set(item.startLine, { classification: 'added' });
      }
    });
    return byStartLine;
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Per-unit classification for top-level `paragraph`/`heading` blocks (see
  // markdownItemDiff.ts's extractProseUnits/proseKeyOf and
  // docs/design/ui-rendered-markdown-diff.md, "Decision — Extension:
  // Non-List Block Types"). Mirrors `itemClassification` above, but a
  // paragraph/heading is already a correctly-scoped single unit (no
  // per-item layer needed — mdast gives each its own top-level node, no
  // sibling to misattribute to), so this only ever needs the intraline
  // word-diff (or its fallback) — never a ghost row (no ghost mechanism for
  // prose; a removed paragraph/heading renders nothing, as today). Keyed by
  // startLine only — a paragraph/heading has no nested-unit case, so unlike
  // `itemClassification` there is exactly one entry per changed block, never
  // more. Same degradation gate as `itemClassification`: `null` (every
  // paragraph/heading falls back to the legacy whole-block treatment) when
  // there is no usable old side or no changedLineSet to classify against.
  //
  // Deliberate refinement, NOT present on the (frozen, byte-identical-output)
  // list path: an `edited`-classified unit whose VERBATIM raw source is
  // byte-identical old vs. new (`changedLineSet` flagged the line, but
  // nothing about the block's own text actually differs — e.g. a git-diff
  // context line, or another block's edit incidentally pulling this one's
  // line into the same hunk) contributes NO entry at all, rather than a
  // fallback marker whose Before/After rows would show two identical rows.
  // This is intentionally narrower than "flattened text unchanged" (which
  // the intraline mapper already treats as a FALLBACK, not a skip — see
  // `computeWordDiff`'s "no word-level change detected" — because a
  // formatting-only edit like `*em*` -> `**em**` DOES have differing raw
  // text and must still surface the marker, exactly like the list-item
  // precedent): only an EXACT raw-text match short-circuits here, so a
  // formatting-only prose edit still reaches the normal fallback path below.
  const proseClassification = useMemo<Map<number, ItemDiffInfo> | null>(() => {
    const oldSource = props.oldSource;
    if (oldSource == null || !props.changedLineSet) return null;
    const newUnits = extractProseUnits(props.source);
    if (newUnits.length === 0) return null;
    const oldUnits = extractProseUnits(oldSource);
    const classes = classifyUnits({
      newUnits,
      oldUnits,
      changedLineSet: props.changedLineSet,
      keyOf: proseKeyOf,
    });
    const { matches } = pairUnits(oldUnits, newUnits, proseKeyOf);
    const byStartLine = new Map<number, ItemDiffInfo>();
    newUnits.forEach((unit, i) => {
      if (classes[i] === 'unchanged') return;
      const oldUnit = matches[i];
      if (classes[i] === 'edited' && oldUnit) {
        const oldSourceText = verbatimSourceSlice(oldSource, oldUnit.startLine, oldUnit.endLine);
        const newSourceText = verbatimSourceSlice(props.source, unit.startLine, unit.endLine);
        if (oldSourceText === newSourceText) return; // see doc comment above
        byStartLine.set(unit.startLine, {
          classification: 'edited',
          oldText: oldUnit.text,
          oldSourceText,
          newSourceText,
        });
      } else {
        byStartLine.set(unit.startLine, { classification: 'added' });
      }
    });
    return byStartLine;
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Per-unit classification for top-level fenced code blocks (see
  // markdownItemDiff.ts's extractCodeUnits/codeKeyOf and
  // docs/design/ui-rendered-markdown-diff.md, "Fenced code blocks"). A
  // BYTE-FOR-BYTE mirror of `proseClassification` above — same degradation
  // gate, same matches/keyOf shape, same verbatim-source-identical-old-vs-new
  // skip (see that memo's own doc comment for why) — a code block is, like a
  // paragraph/heading, already correctly scoped as ONE unit (mdast gives it
  // its own top-level node), so it needs the identical treatment; only the
  // extractor/keyOf pair differs (`extractCodeUnits`/`codeKeyOf` instead of
  // `extractProseUnits`/`proseKeyOf`). `unit.startLine`/`endLine` here are
  // FENCE-TO-FENCE (mdast `code` position), which is also what the rendered
  // `<code>` element's own data-start-line/data-end-line carry — see
  // `codeBlockStartLine`'s doc comment for why the DOM lookup can't just read
  // `data-start-line` off the top-level `<pre>` itself.
  const codeClassification = useMemo<Map<number, ItemDiffInfo> | null>(() => {
    const oldSource = props.oldSource;
    if (oldSource == null || !props.changedLineSet) return null;
    const newUnits = extractCodeUnits(props.source);
    if (newUnits.length === 0) return null;
    const oldUnits = extractCodeUnits(oldSource);
    const classes = classifyUnits({
      newUnits,
      oldUnits,
      changedLineSet: props.changedLineSet,
      keyOf: codeKeyOf,
    });
    const { matches } = pairUnits(oldUnits, newUnits, codeKeyOf);
    const byStartLine = new Map<number, ItemDiffInfo>();
    newUnits.forEach((unit, i) => {
      if (classes[i] === 'unchanged') return;
      const oldUnit = matches[i];
      if (classes[i] === 'edited' && oldUnit) {
        const oldSourceText = verbatimSourceSlice(oldSource, oldUnit.startLine, oldUnit.endLine);
        const newSourceText = verbatimSourceSlice(props.source, unit.startLine, unit.endLine);
        if (oldSourceText === newSourceText) return; // see proseClassification's doc comment
        byStartLine.set(unit.startLine, {
          classification: 'edited',
          oldText: oldUnit.text,
          oldSourceText,
          newSourceText,
        });
      } else {
        byStartLine.set(unit.startLine, { classification: 'added' });
      }
    });
    return byStartLine;
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Per-row classification for table rows (leaf .3, markdownItemDiff.ts's
  // extractTableRows/tableRowKeyOf and docs/design/ui-rendered-markdown-diff.md,
  // "Decision — Extension: Non-List Block Types", "Tables"). Structurally a
  // BYTE-FOR-BYTE mirror of `itemClassification` above (same degradation
  // gate, same classifyUnits/pairUnits/matches shape, same
  // "unmatched -> added, matched -> edited" logic) — only the extractor/keyOf
  // pair differs (`extractTableRows`/`tableRowKeyOf` instead of
  // `extractListItems`/`listKeyOf`), and each entry carries per-CELL arrays
  // (`oldCells`/`newCells`) rather than one flattened `oldText`, since an
  // edited row's decoration is per-cell, not whole-row (see
  // `decorateTableRows`).
  //
  // DELIBERATE DECISION (this leaf's call, per its Contract — see also the
  // dedicated header-row tests in markdown.test.tsx), REVISED per REJECT
  // correction: a HEADER row (`row.isHeader`) is extracted, classified, AND
  // DECORATED exactly like any body row. It still MUST flow through
  // `classifyUnits`/`pairUnits` in the SAME `newRows`/`oldRows` arrays as
  // the body rows, because `tableRowKeyOf`'s `:h`/`:b` bucket-key suffix is
  // what keeps a header from ever pairing against a body row — that
  // invariant is untouched, so an edit confined to the header still can
  // NEVER cause a body row's own classification to change (the binding
  // requirement in this leaf's Contract) regardless of the decision below.
  //
  // ORIGINAL decision shipped here left a header's classification result
  // OUT of `byStartLine` (undecorated: no rail, no mini-tag, no intraline
  // diff), reasoning that the prescribed rail CSS targets `td:first-child`
  // only and a header already has its own distinct look. REJECTED on
  // review: a header+body edit in the SAME table then decorated the body
  // row — which suppresses `blockChanged`/the table's whole-block wash via
  // `decoratedBlockHtml` having an entry at all — while the header's own
  // real content change got NO visual indication anywhere: worse than the
  // pre-leaf behavior (which at least washed the whole table for ANY
  // change) and a failure mode unique to tables (a changed sub-unit fully
  // undecorated while the block simultaneously loses its own fallback).
  //
  // FIX: decorate headers too. `decorateTableRows` already operates
  // generically on `tr.children[i]` regardless of tag, so a `<th>` is
  // exactly as splice-eligible a content root as a `<td>` — the only other
  // change needed was adding `th:first-child` rail CSS alongside the
  // existing `td:first-child` rules (styles.css). A header can classify
  // 'edited' (its own text changed) or, in the edge case of a wholly-new
  // table with no old counterpart at all, 'added' — never 'removed'/
  // ghosted, since a header always pairs 1:1 within its own singleton `:h`
  // bucket whenever its table persists on both sides (a persisting table
  // always has exactly one old and one new header, so `alignBucket`'s
  // single-item substitution always matches them — see
  // `resolveGhostAnchorsForUnits`'s "bucket with no surviving sibling"
  // rule: only a WHOLLY deleted table's bucket has zero survivors, and a
  // wholly deleted table contributes no ghosts for ANY of its rows, header
  // included), so no ghost-header handling is needed anywhere.
  const tableClassification = useMemo<Map<number, TableRowDiffInfo> | null>(() => {
    const oldSource = props.oldSource;
    if (oldSource == null || !props.changedLineSet) return null;
    const newRows = extractTableRows(props.source);
    if (newRows.length === 0) return null;
    const oldRows = extractTableRows(oldSource);
    const keyOf = tableRowKeyOf(oldRows, newRows);
    const classes = classifyUnits({
      newUnits: newRows,
      oldUnits: oldRows,
      changedLineSet: props.changedLineSet,
      keyOf,
    });
    const { matches } = pairUnits(oldRows, newRows, keyOf);
    const byStartLine = new Map<number, TableRowDiffInfo>();
    newRows.forEach((row, i) => {
      if (classes[i] === 'unchanged') return;
      const oldRow = matches[i];
      if (classes[i] === 'edited' && oldRow) {
        const oldSourceText = verbatimSourceSlice(oldSource, oldRow.startLine, oldRow.endLine);
        const newSourceText = verbatimSourceSlice(props.source, row.startLine, row.endLine);
        if (oldSourceText === newSourceText) return; // see proseClassification's doc comment
        byStartLine.set(row.startLine, {
          classification: 'edited',
          oldCells: oldRow.cells,
          newCells: row.cells,
          oldSourceText,
          newSourceText,
        });
      } else {
        byStartLine.set(row.startLine, { classification: 'added' });
      }
    });
    return byStartLine;
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Ghost-row anchors for removed table rows (leaf .3, the table analogue of
  // `ghostAnchors` below — mirrors its own doc comment exactly). Computed
  // independently of `tableClassification` for the same reason: a pure
  // deletion with nothing else changed in that specific table must still
  // produce ghosts even when `tableClassification` ends up empty for that
  // table. `keyOf` is passed as BOTH `pairUnits`'s `keyOf` AND
  // `resolveGhostAnchorsForUnits`'s `bucketOf` — the SAME closure instance —
  // so pairing and ghost-anchor bucketing can never disagree (see
  // `tableRowKeyOf`'s doc comment for why a table's bucketing, unlike a
  // list's, is not safe to re-derive from a raw field access: the `:h`/`:b`
  // split is required to keep a wholly-deleted table BODY, with its header
  // surviving, from producing spurious ghosts anchored after the header).
  const tableGhostAnchors = useMemo<UnitGhostAnchor<MdTableRow>[]>(() => {
    if (props.oldSource == null || !props.changedLineSet) return [];
    const newRows = extractTableRows(props.source);
    if (newRows.length === 0) return [];
    const oldRows = extractTableRows(props.oldSource);
    const keyOf = tableRowKeyOf(oldRows, newRows);
    const pairing = pairUnits(oldRows, newRows, keyOf);
    return resolveGhostAnchorsForUnits(oldRows, newRows, pairing, keyOf);
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Ghost-row anchors for removed list items (leaf .3,
  // docs/design/ui-rendered-markdown-diff.md, Decision item 5). Computed
  // independently of `itemClassification` — a pure deletion with nothing
  // else changed in that specific list must still produce ghosts even when
  // itemClassification ends up empty for that block — but gated by the SAME
  // oldSource/changedLineSet availability ("leaf .1's degradation path").
  // `pairListItems` is called again here rather than threaded out of
  // itemClassification's own internal call, so this memo stays a fully
  // independent, directly-inspectable derivation of (source, oldSource);
  // cheap given list sizes are small (see markdownItemDiff.ts's LCS note).
  const ghostAnchors = useMemo<GhostAnchor[]>(() => {
    if (props.oldSource == null || !props.changedLineSet) return [];
    const newItems = extractListItems(props.source);
    if (newItems.length === 0) return [];
    const oldItems = extractListItems(props.oldSource);
    const pairing = pairListItems(oldItems, newItems);
    return resolveGhostAnchors(oldItems, newItems, pairing);
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Per-child classification for a blockquote's DIRECT children (leaf .4,
  // markdownItemDiff.ts's extractBlockquoteChildren/blockquoteChildKeyOf and
  // docs/design/ui-rendered-markdown-diff.md, "Decision — Extension:
  // Non-List Block Types", "Blockquotes"). Structurally a BYTE-FOR-BYTE
  // mirror of `proseClassification`/`codeClassification` above (same
  // degradation gate, same classifyUnits/pairUnits/matches shape, same
  // "unmatched -> added, matched -> edited" logic, same verbatim-source-
  // identical-old-vs-new skip — see that memo's own doc comment for why) —
  // reusing `ItemDiffInfo` (not a new type) since a blockquote child, like a
  // paragraph/heading, has ONE flattened text to diff, unlike a table row's
  // per-cell shape. Only the extractor/keyOf pair differs
  // (`extractBlockquoteChildren`/`blockquoteChildKeyOf` instead of
  // `extractProseUnits`/`proseKeyOf`).
  //
  // No ghost-anchor counterpart (unlike `ghostAnchors`/`tableGhostAnchors`
  // above): a removed blockquote child is PERMANENTLY out of scope (this
  // leaf's Contract — the design record's Alternatives explicitly DEFERS,
  // not rejects, a "ghost paragraph" pending a future pass that scopes its
  // anchoring question on its own). A removed child therefore simply
  // contributes no output, exactly like a removed top-level paragraph/
  // heading (leaf .1) — `extractBlockquoteChildren`'s own unmatched-old
  // units are never even looked up here.
  //
  // BOUNDARY (Guardrail: compose with existing nesting, do not extend it —
  // see `extractBlockquoteChildren`'s own doc comment for the full
  // rationale): a blockquote's direct child that is a nested LIST or a
  // nested BLOCKQUOTE (or any other non-paragraph/heading block type) is
  // never extracted at all, so it can never appear here and is never
  // decorated by `decorateBlockquoteChildren` — the shipped per-`<li>`
  // decoration already only iterates TOP-LEVEL blocks, so a list nested
  // inside a blockquote gets no per-item decoration today, and this leaf
  // does not change that; a nested blockquote's own children are likewise
  // never classified by this leaf. KNOWN, ACCEPTED tradeoff this boundary
  // implies (not a defect to "fix" here — no new mechanism per the
  // Guardrails): if a blockquote's nested-list child and a SIBLING
  // paragraph child are BOTH edited in the same change, the paragraph gets
  // decorated (suppressing the blockquote's own legacy whole-block wash,
  // since `blockquoteClassification` is non-empty for that blockquote) but
  // the nested list's own edit gets no indication anywhere — the same
  // "compose, don't extend" boundary applied consistently, not a
  // per-sibling regression introduced by this leaf (the nested list was
  // NEVER decorated, before or after; only the co-occurring whole-block
  // wash's fate changes, and only when a DIFFERENT sibling is decorated).
  const blockquoteClassification = useMemo<Map<number, ItemDiffInfo> | null>(() => {
    const oldSource = props.oldSource;
    if (oldSource == null || !props.changedLineSet) return null;
    const newChildren = extractBlockquoteChildren(props.source);
    if (newChildren.length === 0) return null;
    const oldChildren = extractBlockquoteChildren(oldSource);
    const keyOf = blockquoteChildKeyOf(oldChildren, newChildren);
    const classes = classifyUnits({
      newUnits: newChildren,
      oldUnits: oldChildren,
      changedLineSet: props.changedLineSet,
      keyOf,
    });
    const { matches } = pairUnits(oldChildren, newChildren, keyOf);
    const byStartLine = new Map<number, ItemDiffInfo>();
    newChildren.forEach((child, i) => {
      if (classes[i] === 'unchanged') return;
      const oldChild = matches[i];
      if (classes[i] === 'edited' && oldChild) {
        const oldSourceText = verbatimSourceSlice(oldSource, oldChild.startLine, oldChild.endLine);
        const newSourceText = verbatimSourceSlice(props.source, child.startLine, child.endLine);
        if (oldSourceText === newSourceText) return; // see proseClassification's doc comment
        byStartLine.set(child.startLine, {
          classification: 'edited',
          oldText: oldChild.text,
          oldSourceText,
          newSourceText,
        });
      } else {
        byStartLine.set(child.startLine, { classification: 'added' });
      }
    });
    return byStartLine;
  }, [props.source, props.oldSource, props.changedLineSet]);

  // Decorated HTML, keyed by the block's own data-start-line, for EVERY
  // block kind that gets per-unit/intraline decoration: `list` blocks with
  // at least one classified item OR at least one ghost-row anchor (leaf .3
  // — a pure deletion with nothing else changed in a list has no classified
  // item at all, so ghosts need their own independent gate here), top-level
  // `paragraph`/`heading` blocks with a `proseClassification` entry, and
  // (leaf .2) top-level `code` blocks with a `codeClassification` entry — for
  // `code` specifically the key is the block's `<code>` CHILD's
  // data-start-line, not the `<pre>` element's own (which never carries one —
  // see `codeBlockStartLine`'s doc comment); every other kind keys off its
  // own element directly. (leaf .3) `table` blocks with at least one
  // classified row OR at least one table ghost anchor — the table analogue
  // of the `list` gate above. (leaf .4) `blockquote` blocks with at least
  // one classified DIRECT child (`blockquoteClassification`) — no ghost
  // gate here, since a removed blockquote child is permanently out of
  // scope (see `blockquoteClassification`'s own doc comment). A PURE
  // derivation: each entry is built by cloning the pristine `topLevel`
  // element (never mutating it — topLevel is memoized and reused across
  // renders, e.g. on a notes-store update, so an in-place mutation would
  // compound decorations every render) and decorating/ghost-inserting into
  // the clone. A block that overlaps changedLineSet but has no decoration
  // of its own (a list/table with no classified item/row/ghost in its
  // range; a paragraph/heading/code/blockquote block absent from its own
  // classification map) is intentionally absent here — the render loop's
  // zero-decoration safety net then keeps that block on the legacy
  // whole-block treatment.
  //
  // The `list` branch below is BYTE-IDENTICAL to leaf .1's original
  // `decoratedListHtml` logic (same conditions, same computation, same
  // order) — only lifted into one arm of a kind switch so `paragraph`/
  // `heading`/`code` can share the same map/loop/clone machinery. Do not
  // "clean up" this branch independently of verifying the list-path output
  // stays byte-identical (see markdownItemDiff.test.ts/markdown.test.tsx's
  // unmodified list-diff assertions, plus this leaf's evidence).
  const decoratedBlockHtml = useMemo<Map<number, string>>(() => {
    const result = new Map<number, string>();
    const hasListWork =
      (itemClassification && itemClassification.size > 0) || ghostAnchors.length > 0;
    const hasProseWork = proseClassification && proseClassification.size > 0;
    const hasCodeWork = codeClassification && codeClassification.size > 0;
    const hasTableWork =
      (tableClassification && tableClassification.size > 0) || tableGhostAnchors.length > 0;
    const hasBlockquoteWork = blockquoteClassification && blockquoteClassification.size > 0;
    if (!hasListWork && !hasProseWork && !hasCodeWork && !hasTableWork && !hasBlockquoteWork) {
      return result;
    }
    for (const el of topLevel) {
      const kind = kindFromTag(el.tagName.toLowerCase());
      if (kind === 'list') {
        const startLine = Number(el.getAttribute('data-start-line') ?? 0);
        const endLine = Number(el.getAttribute('data-end-line') ?? 0);
        if (!startLine) continue;
        let decorated = false;
        if (itemClassification) {
          for (const line of itemClassification.keys()) {
            if (line < startLine || line > endLine) continue;
            decorated = true;
            break;
          }
        }
        const blockGhosts = ghostAnchors.filter(
          (g) => g.hostItemStartLine >= startLine && g.hostItemStartLine <= endLine,
        );
        if (!decorated && blockGhosts.length === 0) continue;
        const clone = el.cloneNode(true) as HTMLElement;
        if (itemClassification) decorateListItems(clone, itemClassification);
        if (blockGhosts.length > 0) insertGhostRows(clone, blockGhosts);
        result.set(startLine, clone.outerHTML);
      } else if (kind === 'paragraph' || kind === 'heading') {
        const startLine = Number(el.getAttribute('data-start-line') ?? 0);
        const entry = startLine ? proseClassification?.get(startLine) : undefined;
        if (!entry) continue;
        const clone = el.cloneNode(true) as HTMLElement;
        // decorateProseBlock returns the final HTML string itself (not just
        // a mutated clone to read .outerHTML off) — see its own doc comment
        // for why the `<p>` fallback case needs to build a sibling wrapper.
        result.set(startLine, decorateProseBlock(clone, entry));
      } else if (kind === 'code') {
        // CRITICAL: a code block's own data-start-line lives on its <code>
        // CHILD, not this top-level <pre> — see `codeBlockStartLine`'s doc
        // comment. Reading `el.getAttribute('data-start-line')` here (as the
        // list/paragraph/heading branches above correctly do for THEIR own
        // tags) would always read 0 and this branch would never find a
        // `codeClassification` entry, silently disabling the whole feature.
        const startLine = codeBlockStartLine(el);
        const entry = startLine ? codeClassification?.get(startLine) : undefined;
        if (!entry) continue;
        const clone = el.cloneNode(true) as HTMLElement;
        // decorateCodeBlock returns the final HTML string itself, exactly
        // like decorateProseBlock's `<p>` case and for the SAME reason:
        // `<pre>`'s content model is phrasing content only, so the fallback
        // marker must live in a sibling wrapper, not inside `<pre>` — see
        // decorateCodeBlock's own doc comment.
        result.set(startLine, decorateCodeBlock(clone, entry));
      } else if (kind === 'table') {
        // A table's own data-start-line works directly off `el` (like list/
        // paragraph/heading, unlike code) — renderDoc's ANCHOR_NODE_TYPES
        // annotation for the top-level `table` node lands right on it, no
        // child-element indirection needed.
        const startLine = Number(el.getAttribute('data-start-line') ?? 0);
        const endLine = Number(el.getAttribute('data-end-line') ?? 0);
        if (!startLine) continue;
        let decorated = false;
        if (tableClassification) {
          for (const line of tableClassification.keys()) {
            if (line < startLine || line > endLine) continue;
            decorated = true;
            break;
          }
        }
        const blockGhosts = tableGhostAnchors.filter(
          (g) => g.hostStartLine >= startLine && g.hostStartLine <= endLine,
        );
        if (!decorated && blockGhosts.length === 0) continue;
        const clone = el.cloneNode(true) as HTMLElement;
        if (tableClassification) decorateTableRows(clone, tableClassification);
        if (blockGhosts.length > 0) insertGhostTableRows(clone, blockGhosts);
        result.set(startLine, clone.outerHTML);
      } else if (kind === 'blockquote') {
        // A blockquote's own data-start-line works directly off `el` (like
        // list/paragraph/heading/table, unlike code) — renderDoc's
        // ANCHOR_NODE_TYPES annotation for 'blockquote' lands right on it.
        const startLine = Number(el.getAttribute('data-start-line') ?? 0);
        const endLine = Number(el.getAttribute('data-end-line') ?? 0);
        if (!startLine) continue;
        let decorated = false;
        if (blockquoteClassification) {
          for (const line of blockquoteClassification.keys()) {
            if (line < startLine || line > endLine) continue;
            decorated = true;
            break;
          }
        }
        // No ghost gate here (unlike list/table): a removed blockquote
        // child is permanently out of scope, so `decorated` (at least one
        // classified DIRECT child) is the only trigger.
        if (!decorated) continue;
        const clone = el.cloneNode(true) as HTMLElement;
        if (blockquoteClassification) decorateBlockquoteChildren(clone, blockquoteClassification);
        result.set(startLine, clone.outerHTML);
      }
    }
    return result;
  }, [
    topLevel,
    itemClassification,
    ghostAnchors,
    proseClassification,
    codeClassification,
    tableClassification,
    tableGhostAnchors,
    blockquoteClassification,
  ]);

  // Route anchor clicks: external links via window.open (Electron main routes
  // window.open through shell.openExternal — see electron/main/window.ts);
  // inert/relative links are suppressed so the renderer doesn't attempt
  // in-window navigation (which Electron blocks via will-navigate anyway).
  const linkContext = props.linkContext;
  const handleRootClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      if (anchor.hasAttribute('data-inert')) {
        e.preventDefault();
        return;
      }
      if (anchor.hasAttribute('data-external')) {
        e.preventDefault();
        const href = anchor.getAttribute('href');
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      if (anchor.hasAttribute('data-localpath')) {
        e.preventDefault();
        const href = anchor.getAttribute('href');
        if (href && linkContext) void openLinkTarget(href, linkContext);
      }
    },
    [linkContext],
  );

  const compact = props.compact ?? false;
  return (
    <div
      className="agent-cockpit-markdown"
      onClick={handleRootClick}
      style={{
        padding: compact ? '4px 8px' : 16,
        fontFamily: 'system-ui, sans-serif',
        lineHeight: compact ? 1.5 : 1.55,
        ...(compact ? { fontSize: 13 } : {}),
      }}
    >
      {topLevel.map((el, i) => {
        const tag = el.tagName.toLowerCase();
        // A code block's own start/end-line anchors live on its `<code>`
        // CHILD, never on this top-level `<pre>` itself — see
        // `codeBlockStartLine`'s doc comment. Reading
        // `el.getAttribute('data-start-line'/'data-end-line')` here for `pre`
        // (as every other tag correctly does) always yields 0, which is why
        // `changed`/`blockChanged`/the click cursor/note-anchoring never
        // triggered for ANY code block until this fix — independent of, and
        // pre-dating, leaf .2's own decoration-lookup fix.
        const startLine =
          tag === 'pre' ? codeBlockStartLine(el) : Number(el.getAttribute('data-start-line') ?? 0);
        const endLine =
          tag === 'pre' ? codeBlockEndLine(el) : Number(el.getAttribute('data-end-line') ?? 0);
        const mermaidId = el.getAttribute('data-mermaid-id');
        const mermaidEntry = mermaidId ? doc!.mermaidById.get(mermaidId) : null;
        const graphvizId = el.getAttribute('data-graphviz-id');
        const graphvizEntry = graphvizId ? doc!.graphvizById.get(graphvizId) : null;
        const kind: RenderedBlock['kind'] = mermaidEntry
          ? 'mermaid'
          : graphvizEntry
            ? 'graphviz'
            : kindFromTag(tag);
        const id = `b${i}`;
        const block: RenderedBlock = {
          id,
          kind,
          startLine,
          endLine,
          ...(mermaidEntry
            ? { source: mermaidEntry.source, language: 'mermaid' }
            : graphvizEntry
              ? { source: graphvizEntry.source, language: 'graphviz' }
              : {}),
        };
        const changed = Boolean(
          props.changedLineSet &&
          startLine > 0 &&
          rangeOverlaps(props.changedLineSet, startLine, endLine),
        );
        const hasClickHandler = Boolean(props.onBlockClick);
        // Per-unit decoration takes over the VISUAL treatment for a `list`,
        // `paragraph`, `heading`, `table`, or `code` block once it has a
        // `decoratedBlockHtml` entry (list: at least one item classified as
        // added/edited, or a ghost anchor; paragraph/heading:
        // a `proseClassification` entry; table: a `tableClassification` entry
        // or a table ghost anchor; code: a `codeClassification` entry — see
        // `decoratedBlockHtml`'s own doc comment for the zero-decoration
        // safety net). `blockChanged` (not `changed`) drives the rail/wash/
        // tag below; `changed` itself is untouched and keeps driving the
        // click cursor, so onBlockClick's affordance for these blocks is
        // unaffected by this leaf.
        //
        // `code` re-derives its key via `codeBlockStartLine(el)` here rather
        // than reusing the `startLine` variable above, even though the two
        // are now guaranteed to agree (both indirect through the same
        // `:scope > code` helper as of local_repo_explorer-rendered-md-nonlist-diff-ek7c.5
        // — previously `startLine` read `data-start-line` off `el` itself,
        // always absent/0 for a top-level `<pre>`, which is what made this
        // separate lookup necessary in the first place). Left as its own
        // explicit call for minimal diff and because it keeps this line
        // correct independently of the general computation above ever
        // changing again. `table`/`blockquote` need no such indirection —
        // their own `data-start-line` lands directly on the top-level
        // `<table>`/`<blockquote>` element, same as list/paragraph/heading.
        const decoratedHtml =
          kind === 'list' ||
          kind === 'paragraph' ||
          kind === 'heading' ||
          kind === 'table' ||
          kind === 'blockquote'
            ? decoratedBlockHtml.get(startLine)
            : kind === 'code'
              ? decoratedBlockHtml.get(codeBlockStartLine(el))
              : undefined;
        const blockChanged = changed && decoratedHtml === undefined;
        const wrapStyle: React.CSSProperties = {
          margin: compact ? '4px 0' : '8px 0',
          padding: blockChanged ? 8 : 0,
          borderLeft: blockChanged ? '2px solid var(--accent)' : '2px solid transparent',
          background: blockChanged ? 'rgba(91, 141, 239, 0.06)' : 'transparent',
          cursor: changed && hasClickHandler ? 'pointer' : 'default',
          position: 'relative',
        };

        const content = mermaidEntry ? (
          <MermaidFrame source={mermaidEntry.source} />
        ) : graphvizEntry ? (
          <GraphvizFrame source={graphvizEntry.source} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: decoratedHtml ?? el.outerHTML }} />
        );

        return (
          <BlockView
            key={id}
            startLine={startLine}
            endLine={endLine}
            changed={blockChanged}
            wrapStyle={wrapStyle}
            onBlockClick={() => props.onBlockClick?.(block)}
            content={content}
            notesEnabled={notesEnabled}
            filePath={props.filePath}
            notesByLine={notesByLine}
            sourceLines={sourceLines}
            composing={composing}
            setComposing={setComposing}
            onAdd={(line, anchorText, body) => {
              if (props.filePath) void addLineNote(props.filePath, line, anchorText, body);
            }}
            onDelete={(noteId) => void removeNote(noteId)}
          />
        );
      })}
    </div>
  );
}

interface BlockViewProps {
  startLine: number;
  endLine: number;
  changed: boolean;
  wrapStyle: React.CSSProperties;
  onBlockClick: () => void;
  content: JSX.Element;
  notesEnabled: boolean;
  filePath?: string;
  notesByLine: Map<number, NoteRecord[]>;
  sourceLines: string[];
  composing: number | null;
  setComposing: (line: number | null) => void;
  onAdd: (line: number, anchorText: string, body: string) => void;
  onDelete: (noteId: number) => void;
}

/**
 * A single rendered top-level block. When notes are enabled it tracks the
 * hovered line-bearing descendant (`data-start-line`, set on sub-block nodes by
 * renderDoc) and shows a "+" aligned to it, so a note can be anchored to a
 * SPECIFIC source line — e.g. one list item — not just the block start. Existing
 * notes whose line falls within the block render as inline threads at the block
 * end, each labeled with its line + source snippet so the association is clear.
 */
function BlockView({
  startLine,
  endLine,
  changed,
  wrapStyle,
  onBlockClick,
  content,
  notesEnabled,
  notesByLine,
  sourceLines,
  composing,
  setComposing,
  onAdd,
  onDelete,
}: BlockViewProps): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ line: number; top: number } | null>(null);

  const canAnchor = notesEnabled && startLine > 0;
  const threadLines = canAnchor
    ? Array.from(
        new Set([
          ...[...notesByLine.keys()].filter((l) => l >= startLine && l <= endLine),
          ...(composing != null && composing >= startLine && composing <= endLine
            ? [composing]
            : []),
        ]),
      ).sort((a, b) => a - b)
    : [];

  const onMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!canAnchor) return;
    const target = e.target as HTMLElement;
    // A ghost row has no line in the CURRENT file (markdownItemDiff.ts's
    // resolveGhostAnchors / this file's buildGhostListItem) and must never
    // become a note-anchor target. It carries no data-start-line of its
    // own, but without this check `.closest('[data-start-line]')` below
    // would still walk UP past it to an ENCLOSING real item/list and anchor
    // there instead — so the bail must happen before that walk, not rely on
    // the ghost merely lacking the attribute itself.
    if (target.closest(`.${GHOST_ITEM_CLASS}`)) return;
    const el = target.closest('[data-start-line]') as HTMLElement | null;
    if (!el || !wrapRef.current?.contains(el)) return;
    const line = Number(el.getAttribute('data-start-line'));
    if (!line) return;
    const top = el.offsetTop;
    setHover((h) => (h && h.line === line && h.top === top ? h : { line, top }));
  };

  // The fallback detail marker (docs/design/ui-rendered-markdown-diff.md,
  // Decision item 4) is native <details>/<summary> HTML, serialized to a
  // string and re-parsed via dangerouslySetInnerHTML (see
  // `appendDetailMarker`'s doc comment) — it carries no listener of its own
  // to call stopPropagation from, so the click-isolation guard lives here
  // instead: a click landing anywhere inside the marker (its icon button OR
  // its revealed before/after body) must toggle the native disclosure and
  // nothing else, never `onBlockClick`.
  const handleWrapperClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if ((e.target as HTMLElement).closest?.('.ac-detail')) return;
    onBlockClick();
  };

  return (
    <div
      ref={wrapRef}
      style={wrapStyle}
      onClick={handleWrapperClick}
      onMouseMove={canAnchor ? onMove : undefined}
      onMouseLeave={() => hover && setHover(null)}
    >
      {canAnchor && hover && (
        <button
          type="button"
          title={`Add a note on line ${hover.line}`}
          onClick={(e) => {
            e.stopPropagation();
            setComposing(hover.line);
          }}
          className="absolute z-10 flex h-5 w-5 items-center justify-center rounded border border-edge bg-panel text-accent"
          style={{ left: 0, top: hover.top, transform: 'translateX(-115%)' }}
        >
          +
        </button>
      )}
      {changed ? <ChangedTag /> : null}
      {content}
      {threadLines.length > 0 && (
        <div onClick={(e) => e.stopPropagation()}>
          {threadLines.map((line) => (
            <div key={line}>
              <div className="px-3 pt-1 font-mono text-[10px] text-dim">
                {`L${line}: ${(sourceLines[line - 1] ?? '').trim().slice(0, 80)}`}
              </div>
              <LineNoteThread
                notes={notesByLine.get(line) ?? []}
                liveText={sourceLines[line - 1] ?? null}
                composing={composing === line}
                onSubmit={(body) => {
                  onAdd(line, sourceLines[line - 1] ?? '', body);
                  setComposing(null);
                }}
                onCancel={() => setComposing(null)}
                onDelete={onDelete}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChangedTag(): JSX.Element {
  return (
    <span
      style={{
        position: 'absolute',
        top: 2,
        right: 6,
        fontSize: 10,
        color: 'var(--accent)',
        background: 'var(--bg-panel)',
        padding: '1px 4px',
        borderRadius: 3,
        border: '1px solid var(--border)',
      }}
    >
      changed
    </span>
  );
}

function rangeOverlaps(changedLines: Set<number>, start: number, end: number): boolean {
  for (let i = start; i <= end; i++) {
    if (changedLines.has(i)) return true;
  }
  return false;
}

/**
 * Decorates every classified `<li data-start-line>` inside `root` in place.
 * `root` MUST be a detached clone (never the pristine `topLevel` element —
 * see `decoratedListHtml`'s doc comment), so mutating it here is safe: the
 * clone is discarded after its `outerHTML` is read, and a fresh clone off
 * the untouched original is made on every recomputation. Matches nested
 * `<li>`s too (querySelectorAll walks the whole subtree), which is what
 * lets nested items decorate independently of their ancestors.
 *
 * An 'edited' item tries the intraline word-diff first (Decision item 3):
 * when `applyIntralineSpans` reports `clean: true`, the item keeps the
 * amber rail but gets NO mini-tag — the del/add spans already show old and
 * new simultaneously. Any `clean: false` (complex markup, over the size
 * bound, a degenerate no-visible-change diff, or a still-unsupported
 * multi-paragraph loose-list shape — see `applyIntralineSpans`) falls back
 * to leaf .1's exact whole-item treatment (rail + mini-tag, `li` left
 * untouched) AND stamps `data-diff-fallback-reason` on the `<li>`, AND (leaf
 * .4) attaches the always-visible `<details>` detail marker plus the hover
 * quick preview — the ONLY item state that carries either (Decision item 4).
 * Absent on every other item state (added, clean-edited, unchanged) — the
 * `data-diff-fallback-reason` attribute's mere presence doubles as the
 * boolean "not clean" signal.
 */
function decorateListItems(root: HTMLElement, info: Map<number, ItemDiffInfo>): void {
  const items = root.querySelectorAll<HTMLLIElement>('li[data-start-line]');
  items.forEach((li) => {
    const line = Number(li.getAttribute('data-start-line'));
    const entry = info.get(line);
    if (!entry) return;
    if (entry.classification === 'added') {
      li.classList.add('ac-item-added');
      appendMiniTag(li, 'added');
      return;
    }
    li.classList.add('ac-item-edited');
    const result = applyIntralineSpans(li, entry.oldText);
    if (!result.clean) {
      const reason = result.reason ?? 'complex markup';
      li.setAttribute('data-diff-fallback-reason', reason);
      appendMiniTag(li, 'edited');
      appendDetailMarker(li, entry.oldSourceText, entry.newSourceText, reason);
    }
  });
}

/**
 * Decorates a classified top-level `<p>`/`<h1>`-`<h6>` clone — the prose
 * sibling of `decorateListItems` (docs/design/ui-rendered-markdown-diff.md,
 * "Decision — Extension: Non-List Block Types"). `clone` MUST be a detached
 * clone, same requirement as `decorateListItems` (see `decoratedBlockHtml`'s
 * doc comment).
 *
 * Unlike a list item, a paragraph/heading IS its own content root (no
 * nested-list skip case, no loose-item `<p>` to descend into — see
 * `spliceIntralineInto`'s doc comment), so this calls it directly rather
 * than going through `applyIntralineSpans`'s `<li>`-specific pre-steps.
 *
 * State mapping deliberately DIFFERS from `decorateListItems` for the
 * `added` case: a list item gets a mini-tag pill for `added`
 * (`appendMiniTag(li, 'added')` above), but the design-language record is
 * explicit that the prose rail is used "WITHOUT the mini-tag pill" — this
 * leaf's Contract confirms that reading applies to `added` too (no old
 * counterpart to explain via a marker, and the green rail alone already
 * conveys "new"), so `added` here is rail-only, no tag, no marker. The
 * `edited` case matches list exactly: clean intraline diff -> rail only (no
 * tag, no marker, del/add spans already show both old and new); not clean
 * -> rail + `changed` mini-tag + the same `<details>` fallback marker (and
 * its hover tip) a fallback list item gets.
 *
 * Returns the final HTML STRING to use for this block, rather than mutating
 * `clone` alone and letting the caller read `clone.outerHTML` (as the list
 * path does) — because of a real, empirically-confirmed HTML-parsing trap
 * specific to `<p>`: `<details>` and `<div>` (the fallback marker and its
 * `.ac-hover-tip`) are FLOW-content elements, and the WHATWG parser's
 * "close a p element" step forcibly closes an open `<p>` the instant it
 * sees either start tag while inside one — relocating them to become
 * SIBLINGS of the `<p>` (with a spurious empty trailing `<p></p>`) the
 * moment the serialized clone is reparsed via `dangerouslySetInnerHTML`.
 * Verified directly: `<li>`/`<h1>`-`<h6>` do NOT trigger this (their
 * content model already permits flow content — a `<details>` appended to
 * either survives serialize+reparse as a real child), so this is a
 * `<p>`-only concern; the mini-tag `<span>` is phrasing content and is
 * unaffected everywhere. When the fallback path is reached on a `<p>`, the
 * marker/tip are therefore built as SIBLINGS of the (still-intact) `<p>`
 * inside a detached wrapper `<div>`, and the WRAPPER's `innerHTML` is
 * returned instead — `dangerouslySetInnerHTML` accepts multiple top-level
 * sibling nodes fine; it is not constrained to one root element the way
 * `Element.outerHTML` is. This does not affect the marker's click-isolation
 * guard (`BlockView`'s `.closest('.ac-detail')` walks up from whatever the
 * user actually clicked, regardless of the marker's position relative to
 * the paragraph) or the hover tip's correctness (still a real, if now
 * sibling-anchored, `:hover`-revealed element — see the `.ac-prose-changed`
 * CSS rule's own note).
 */
function decorateProseBlock(clone: HTMLElement, entry: ItemDiffInfo): string {
  if (entry.classification === 'added') {
    clone.classList.add('ac-prose-added');
    return clone.outerHTML;
  }
  clone.classList.add('ac-prose-changed');
  const result = spliceIntralineInto(clone, entry.oldText);
  if (result.clean) return clone.outerHTML;

  const reason = result.reason ?? 'complex markup';
  clone.setAttribute('data-diff-fallback-reason', reason);
  appendMiniTag(clone, 'edited'); // <span> is phrasing content — always safe as a direct child.

  if (clone.tagName !== 'P') {
    // <h1>-<h6>: flow content (details/div) nests safely — the same simple
    // path <li> already uses.
    appendDetailMarker(clone, entry.oldSourceText, entry.newSourceText, reason);
    return clone.outerHTML;
  }
  const wrapper = document.createElement('div');
  wrapper.appendChild(clone);
  appendDetailMarker(wrapper, entry.oldSourceText, entry.newSourceText, reason);
  return wrapper.innerHTML;
}

/**
 * Decorates a classified top-level `<pre>` clone (a fenced code block) — the
 * code sibling of `decorateProseBlock` (docs/design/ui-rendered-markdown-diff.md,
 * "Fenced code blocks"; docs/design/ui-design-language.md, "Prose rail",
 * which explicitly lists a fenced code block alongside `<p>`/`<h1>`-`<h6>`).
 * `pre` MUST be a detached clone, same requirement as
 * `decorateProseBlock`/`decorateListItems` (see `decoratedBlockHtml`'s doc
 * comment).
 *
 * State mapping matches the prose rail exactly: `added` -> green rail only,
 * no mini-tag (no old counterpart to explain via a marker); `edited` + clean
 * intraline splice -> amber rail only, no tag, no marker (the del/add spans
 * already show both old and new, spliced INSIDE `<code>` by `spliceCodeInto`
 * while preserving every rehype-highlight span around them); `edited` + NOT
 * clean -> amber rail + `changed` mini-tag + the same `<details>` fallback
 * marker every other fallback state gets.
 *
 * UNLIKE `decorateProseBlock`, the wrapper-for-the-marker branch below is NOT
 * conditional on tag name: `<pre>`, like `<p>`, has a content model of
 * PHRASING CONTENT ONLY (unlike `<h1>`-`<h6>`, which permit flow content) —
 * `<details>`/`<div>` cannot survive nested inside it through the
 * serialize+reparse round-trip `dangerouslySetInnerHTML` performs (the exact
 * HTML-parsing trap `decorateProseBlock`'s own doc comment documents for
 * `<p>`). So a fallback code block ALWAYS needs the sibling-wrapper
 * structure — there is no "flow content nests safely" branch analogous to
 * the heading case. The mini-tag ALSO moves outside `<pre>` here (unlike the
 * `<p>` case, which keeps its mini-tag INSIDE the paragraph, since `<span>`
 * is phrasing content and safe there too): appending it inside `<pre>`'s
 * `white-space: pre` content would render the pill as literal trailing "code
 * text" glued onto the last line with no way to add a newline before it
 * without corrupting the block's own byte-exact content — so both the
 * mini-tag and the detail marker live on the wrapper, as later siblings of
 * the (untouched-by-them) `<pre>`.
 *
 * `wrapper` itself carries NO class and is never returned as an element —
 * only its `.innerHTML` is (see the `return` below), exactly like
 * `decorateProseBlock`'s `<p>` case: the throwaway wrapper is discarded the
 * instant `dangerouslySetInnerHTML` re-parses the string, so its own
 * attributes never reach the live DOM (empirically confirmed: an earlier
 * version of this function set a class on `wrapper` intending to scope
 * styles.css's hover-tip/marker-body rules under it, and that class never
 * once appeared in rendered output). CSS that needs to distinguish "this
 * marker/tip belongs to a code fallback" therefore scopes off
 * `pre.ac-code-changed` itself via the general-sibling combinator (styles.css)
 * — `pre.ac-code-changed` DOES survive (it's set directly on `pre`, which
 * IS part of `wrapper.innerHTML`) and is never a sibling of any OTHER
 * block's own marker, so it uniquely and correctly scopes the code case
 * without needing an intermediate wrapper class at all.
 */
function decorateCodeBlock(pre: HTMLElement, entry: ItemDiffInfo): string {
  if (entry.classification === 'added') {
    pre.classList.add('ac-code-added');
    return pre.outerHTML;
  }
  pre.classList.add('ac-code-changed');
  const codeEl = pre.querySelector<HTMLElement>(':scope > code');
  // Defensive: mdast-util-to-hast's default `code` handler always produces
  // <pre><code>, so an element classified `kindFromTag === 'code'` should
  // always have this child — but never assume DOM shape blindly (mirrors
  // `buildCodeSlots`'s own defensive `unexpected` flag one level down). A
  // missing <code> is treated exactly like any other unsplice-able
  // structure: fail closed to the fallback marker, never throw.
  const result: IntralineResult = codeEl
    ? spliceCodeInto(codeEl, entry.oldText)
    : { clean: false, reason: 'complex markup' };
  if (result.clean) return pre.outerHTML;

  const reason = result.reason ?? 'complex markup';
  pre.setAttribute('data-diff-fallback-reason', reason);

  const wrapper = document.createElement('div');
  wrapper.appendChild(pre);
  appendMiniTag(wrapper, 'edited');
  appendDetailMarker(wrapper, entry.oldSourceText, entry.newSourceText, reason);
  return wrapper.innerHTML;
}

/**
 * Decorates every classified `<tr data-start-line>` inside `root` in place —
 * the table sibling of `decorateListItems` (docs/design/ui-rendered-markdown-diff.md,
 * "Decision — Extension: Non-List Block Types", "Tables"). `root` MUST be a
 * detached clone, same requirement as every other decorate* function (see
 * `decoratedBlockHtml`'s doc comment).
 *
 * `info` MAY carry an entry for a HEADER row too, decorated through this
 * SAME loop with zero special-casing (REJECT-corrected decision — see
 * `tableClassification`'s own doc comment for the full rationale and why an
 * undecorated header was wrong): `querySelectorAll('tr[data-start-line]')`
 * matches the header `<tr>` identically to a body row (renderDoc annotates
 * both the same way), and every operation below — `tr.children[i]`,
 * `spliceIntralineInto`, `appendMiniTag`, `appendDetailMarker` — reads/writes
 * generically off whatever element is actually there, so a `<th>` flows
 * through exactly like a `<td>` with no branch needed to tell them apart.
 *
 * CRITICAL (foster-parenting trap — see this leaf's Contract): every
 * decoration appended below goes INTO a `<td>`/`<th>` cell
 * (`appendMiniTag`/`appendDetailMarker`'s target), never directly onto the
 * `<tr>` itself. A node appended straight to a `<tr>` (anything other than
 * `<td>`/`<th>`) survives the CURRENT in-memory DOM but is silently
 * relocated OUTSIDE the table the moment this clone's `.outerHTML` is
 * serialized and re-parsed via `dangerouslySetInnerHTML` — verified directly
 * against both jsdom and Chromium, not assumed.
 *
 * Unlike a list item's SINGLE flattened text content, an edited row's change
 * can live in ANY of its cells — so instead of one whole-row intraline
 * splice, this pairs cells positionally BY COLUMN INDEX
 * (`entry.oldCells[i]`/`entry.newCells[i]` against the rendered i-th
 * `<td>`/`<th>`) and diffs each independently via the SAME
 * `spliceIntralineInto` the prose path uses directly on `<p>`/`<h1>`-`<h6>`
 * — a table cell is likewise already its own splice-eligible content root
 * (no loose-item `<p>`-descent, no nested-list skip case), so no `<li>`-style
 * pre-step is needed here either.
 *
 * A cell whose MDAST-DERIVED text (`oldCells[i]`/`newCells[i]`, from
 * `MdTableRow.cells`) is IDENTICAL old vs. new is skipped entirely — not
 * even handed to `spliceIntralineInto` — comparing the mdast text rather
 * than `cellEl.textContent` is required here: an image's `alt` text
 * contributes to `collectOwnText`'s flattened text but NOT to
 * `cellEl.textContent` (an `<img>` contributes nothing to textContent), so
 * comparing DOM text could report "no difference" for a cell whose actual
 * (alt-text) content changed, silently skipping a real edit. Skipping ALSO
 * avoids a false fallback: calling `spliceIntralineInto` on a genuinely
 * unchanged cell would itself report `clean:false` (`computeWordDiff`'s own
 * "no word-level change detected" gate), which would incorrectly mark an
 * untouched cell's row as needing the fallback marker.
 *
 * Fallback surfacing (Contract: "decide and document how the row surfaces
 * such a fallback"): if ANY cell's splice comes back unclean, the row-level
 * `data-diff-fallback-reason` + mini-tag + detail marker are attached ONCE,
 * into the FIRST cell only — not per-cell — because a table row is exactly
 * one source line, so the marker's existing one-Before/one-After shape
 * already matches it exactly (the whole `| a | b | c |` line, precisely like
 * `verbatimSourceSlice` already produces for `oldSourceText`/`newSourceText`
 * elsewhere). Cleanly-spliced SIBLING cells keep their own del/add spans
 * regardless of another cell's fallback — each cell's splice attempt is
 * fully independent; only the ROW-level marker decision aggregates across
 * cells (fail-closed per cell, per this leaf's Guardrails).
 *
 * REJECT correction — zero-visible-decoration row: the per-cell skip above
 * ("identical mdast text — not even attempted") is correct in isolation
 * (attempting a genuinely unchanged cell would itself report `clean:false`
 * and wrongly trigger the fallback), but it means a row where EVERY cell's
 * mdast-derived text is identical old-vs-new — a formatting-only edit like
 * `**x**` -> `__x__`, or a whitespace-only source change (raw text differs,
 * which is why `tableClassification` still produced an 'edited' entry, but
 * every cell's flattened text is unchanged) — never attempts ANY cell, so
 * neither the clean-splice path nor the unclean-fallback path ever runs.
 * The row still got the amber `ac-item-edited` rail (classified 'edited')
 * but with ZERO indication of what changed — no mini-tag, no marker, and
 * (since a decorated clone WAS produced) no whole-block wash either. Fixed
 * by tracking whether ANY cell produced real, visible decoration (a clean
 * splice that actually spliced in `.ac-del-span`/`.ac-add-span`s — not
 * merely "was attempted"): when the row is 'edited' but no cell ever did,
 * the SAME row-level marker mechanism as the unclean case fires, using the
 * reason `'no word-level change detected'` — the exact string
 * `spliceIntralineInto`'s own degenerate-diff gate would have produced had
 * these cells not been skipped, and the same string the list/prose paths
 * already surface for this identical shape. A row with at least one cleanly
 * spliced cell (visible decoration) needs no row-level marker regardless of
 * any OTHER cell being skipped as unchanged — "the row already shows
 * something" — so this only fires when NEITHER path produced anything.
 */
function decorateTableRows(root: HTMLElement, info: Map<number, TableRowDiffInfo>): void {
  const rows = root.querySelectorAll<HTMLTableRowElement>('tr[data-start-line]');
  rows.forEach((tr) => {
    const line = Number(tr.getAttribute('data-start-line'));
    const entry = info.get(line);
    if (!entry) return;
    const firstCell = tr.children[0] as HTMLElement | undefined;
    if (!firstCell) return; // defensive: a row with zero cells should not occur
    if (entry.classification === 'added') {
      tr.classList.add('ac-item-added');
      appendMiniTag(firstCell, 'added');
      return;
    }
    tr.classList.add('ac-item-edited');
    let anyUnclean = false;
    let anyVisible = false;
    let firstReason: string | undefined;
    for (let i = 0; i < tr.children.length; i++) {
      const cellEl = tr.children[i] as HTMLElement;
      const oldText = entry.oldCells[i] ?? '';
      const newText = entry.newCells[i] ?? '';
      if (oldText === newText) continue; // mdast-text identical — untouched, not even attempted
      const result = spliceIntralineInto(cellEl, oldText);
      if (result.clean) {
        anyVisible = true;
      } else {
        anyUnclean = true;
        firstReason = firstReason ?? result.reason;
      }
    }
    const attachRowFallback = (reason: string): void => {
      tr.setAttribute('data-diff-fallback-reason', reason);
      appendMiniTag(firstCell, 'edited');
      appendDetailMarker(firstCell, entry.oldSourceText, entry.newSourceText, reason);
    };
    if (anyUnclean) {
      attachRowFallback(firstReason ?? 'complex markup');
    } else if (!anyVisible) {
      // See this function's own doc comment ("zero-visible-decoration row"):
      // every cell was skipped as mdast-text-identical, so nothing else will
      // ever indicate what changed on this genuinely 'edited' row.
      attachRowFallback('no word-level change detected');
    }
  });
}

/** CSS class marking a decorated `<p>` blockquote child whose fallback
 *  marker/tip were inserted as its own trailing siblings WITHIN the
 *  blockquote (see `decorateBlockquoteChildren`) when that `<p>` was the
 *  blockquote's actual last child BEFORE that insertion — compensates for
 *  `blockquote > :last-child` (styles.css) then targeting the newly-last
 *  marker/tip instead of this `<p>`, which would otherwise leave the `<p>`'s
 *  own `margin: 0.6em 0` bottom margin active, producing stray vertical
 *  space before the blockquote's own bottom padding/border (Guardrail: the
 *  first/last-child margin resets must still apply to a decorated child —
 *  see this leaf's Contract). Scoped to exactly this one narrow case: a
 *  CLEANLY spliced or `added` child never moves position (no siblings
 *  inserted, so the existing `:last-child` reset keeps working unmodified),
 *  and a decorated HEADING's marker/tip land INSIDE it (flow content nests
 *  safely there, unlike `<p>` — see `decorateBlockquoteChildren`'s own doc
 *  comment), so neither case ever needs this class. The FIRST-child reset
 *  needs no analogous fix: nothing is ever inserted BEFORE a decorated
 *  child, so it stays literally first regardless of classification. */
const BLOCKQUOTE_TAIL_FALLBACK_CLASS = 'ac-blockquote-tail-fallback';

/**
 * Decorates every classified DIRECT child of `root` (a blockquote clone) —
 * the blockquote sibling of `decorateListItems`/`decorateTableRows`
 * (docs/design/ui-rendered-markdown-diff.md, "Decision — Extension:
 * Non-List Block Types", "Blockquotes"; docs/design/ui-design-language.md,
 * "Prose rail" — blockquote children explicitly reuse the item-level states
 * VERBATIM, not the prose rail, since they ARE contained children of a
 * multi-child container, structurally closer to a list item than to a
 * standalone paragraph). `root` MUST be a detached clone, same requirement
 * as every other decorate* function (see `decoratedBlockHtml`'s doc
 * comment).
 *
 * Iterates `root.children` DIRECTLY (never `querySelectorAll`, and
 * deliberately NOT scanning descendants), so a nested list's or nested
 * blockquote's own descendant content is never reached by this loop at
 * all — composing with what already exists rather than extending it, per
 * this leaf's Guardrails. This is belt-and-braces alongside
 * `extractBlockquoteChildren`'s own type filter (paragraph/heading only):
 * `info` never actually carries an entry for anything else, but scoping the
 * DOM walk to direct children too means that stays true even if a future
 * change to `info`'s construction were to slip up — a nested list's or
 * blockquote's own contents are simply never visited here, full stop.
 *
 * `entry.classification === 'added'` and a CLEANLY-spliced `'edited'` both
 * decorate `child` in place with NO change to its position among its
 * siblings — exactly like `decorateListItems`. Only the NOT-clean `'edited'`
 * path on a `<p>` child needs special handling: `<p>`'s content model is
 * phrasing content only (the same HTML-parsing trap `decorateProseBlock`'s
 * own doc comment documents for a top-level `<p>` — `<details>`/`<div>`
 * cannot survive nested inside one through a serialize+reparse round-trip),
 * so the marker/tip must land as `child`'s own LATER SIBLINGS instead —
 * safe here because `<blockquote>`, like `<li>`/`<h1>`-`<h6>`, accepts flow
 * content directly. This reuses `appendDetailMarker` COMPLETELY UNCHANGED
 * (no new insertion-strategy parameter, no risk to its existing `<li>`/
 * heading/table-cell callers) via a THROWAWAY wrapper: `child` is moved
 * into a fresh `<div>` at its own original position, `appendDetailMarker`
 * runs against the wrapper (landing marker+tip as `child`'s siblings INSIDE
 * the wrapper, exactly as it already does for any element with no nested
 * list), and the wrapper is then unwrapped
 * (`replaceWith(...wrapper.childNodes)`) so `child`+marker+tip end up as
 * `root`'s own direct children at the wrapper's position — no wrapper
 * `<div>` ever persists in the final DOM. A `<h1>`-`<h6>` child needs none
 * of this: `appendDetailMarker` is called on it DIRECTLY (matching
 * `decorateProseBlock`'s own heading branch), so the marker/tip land INSIDE
 * the heading and it never moves relative to its siblings.
 *
 * `BLOCKQUOTE_TAIL_FALLBACK_CLASS` is applied to `child` (a `<p>` only)
 * when — and only when — it was `root`'s actual last child BEFORE the
 * wrapper dance above: inserting its marker/tip as later siblings means
 * `root`'s new last child becomes the tip, not `child`, so the existing
 * `blockquote > :last-child` reset (styles.css) would silently stop
 * targeting the paragraph that actually needs it. See the constant's own
 * doc comment and styles.css's matching rule for the full guardrail this
 * closes.
 *
 * No `'removed'` case: a removed blockquote child is never represented in
 * `info` at all (this leaf's permanent, explicit exclusion — see
 * `blockquoteClassification`'s doc comment) — so unlike
 * `decorateListItems`/`decorateTableRows`, this function has no
 * ghost-insertion counterpart and needs none.
 */
function decorateBlockquoteChildren(root: HTMLElement, info: Map<number, ItemDiffInfo>): void {
  const children = Array.from(root.children) as HTMLElement[];
  for (const child of children) {
    const line = Number(child.getAttribute('data-start-line') ?? 0);
    const entry = line ? info.get(line) : undefined;
    if (!entry) continue;
    if (entry.classification === 'added') {
      child.classList.add('ac-item-added');
      appendMiniTag(child, 'added');
      continue;
    }
    child.classList.add('ac-item-edited');
    const result = spliceIntralineInto(child, entry.oldText);
    if (result.clean) continue;

    const reason = result.reason ?? 'complex markup';
    child.setAttribute('data-diff-fallback-reason', reason);
    appendMiniTag(child, 'edited');
    if (child.tagName !== 'P') {
      // <h1>-<h6>: flow content nests safely — same as decorateListItems's
      // <li> path and decorateProseBlock's own heading branch.
      appendDetailMarker(child, entry.oldSourceText, entry.newSourceText, reason);
      continue;
    }
    // <p>: see this function's own doc comment for the full rationale —
    // details/div can't nest inside <p>, so splice them in as the <p>'s
    // own LATER SIBLINGS within the blockquote itself via a throwaway
    // wrapper that is unwrapped immediately after appendDetailMarker runs,
    // never left in the final DOM.
    const wasLastChild = root.lastElementChild === child;
    const wrapper = document.createElement('div');
    child.replaceWith(wrapper);
    wrapper.appendChild(child);
    appendDetailMarker(wrapper, entry.oldSourceText, entry.newSourceText, reason);
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
    if (wasLastChild) child.classList.add(BLOCKQUOTE_TAIL_FALLBACK_CLASS);
  }
}

const MINI_TAG_ROLE_CLASS: Record<'added' | 'edited' | 'removed', string> = {
  added: 'ac-mini-tag-added',
  edited: 'ac-mini-tag-changed',
  removed: 'ac-mini-tag-removed',
};
const MINI_TAG_ROLE_LABEL: Record<'added' | 'edited' | 'removed', string> = {
  added: 'new',
  edited: 'changed',
  removed: 'removed',
};

/**
 * Inserts `node` right after the unit's own text, i.e. before any DIRECT
 * nested `<ul>/<ol>` (a deeper-nested list several levels down belongs to a
 * descendant `<li>`, not this one, so only the direct child matters).
 * Appending unconditionally would land a decoration AFTER a direct nested
 * sublist instead of inline after the item's own text, visually
 * misattributing it to the sublist's last item.
 *
 * The single shared insertion point for every per-unit decoration appended
 * to `el` — `appendMiniTag`'s pill and `appendDetailMarker`'s `<details>`
 * marker and hover tip — so the two can never drift out of sync on where
 * "after the unit's own text" actually is the way they previously did
 * (local_repo_explorer-rendered-md-per-item-diff-bibv.4 REJECT correction:
 * `appendDetailMarker` used to `li.appendChild` unconditionally, landing the
 * marker/tip after a direct nested sublist instead of inline after the
 * item's own text).
 *
 * Widened from `HTMLLIElement` to `HTMLElement` (type-only; body unchanged)
 * so the same insertion seam also serves the prose path
 * (`decorateProseBlock`, `<p>`/`<h1>`-`<h6>`). The `:scope > ul, :scope >
 * ol` lookup is a structural no-op there: mdast's content model forbids a
 * list child of a paragraph/heading, and the browser HTML parser cannot
 * produce one either, so `el.appendChild` is always what actually runs for
 * a prose element.
 */
function appendAfterItemText(el: HTMLElement, node: Node): void {
  const nestedList = el.querySelector<HTMLElement>(':scope > ul, :scope > ol');
  if (nestedList) el.insertBefore(node, nestedList);
  else el.appendChild(node);
}

/** Appends the mini-tag pill right after the unit's own text (see
 *  `appendAfterItemText`) — irrelevant for a ghost row, which never has a
 *  nested list of its own. Widened to `HTMLElement` (type-only; body
 *  unchanged) — see `appendAfterItemText`'s doc comment. */
function appendMiniTag(el: HTMLElement, role: 'added' | 'edited' | 'removed'): void {
  const tag = document.createElement('span');
  tag.className = `ac-mini-tag ${MINI_TAG_ROLE_CLASS[role]}`;
  tag.textContent = MINI_TAG_ROLE_LABEL[role];
  appendAfterItemText(el, tag);
}

/** Verbatim raw source-line slice for a unit's own content (a list item OR,
 *  since this leaf, a top-level paragraph/heading) — the ACTUAL characters
 *  of `source` between `startLine` and `endLine` (1-based, inclusive;
 *  matches `MdListItem.startLine`/`endLine`, which already excludes a
 *  nested descendant list — see its doc comment in markdownItemDiff.ts —
 *  and equally matches `MdProseUnit.startLine`/`endLine`, which needs no
 *  such exclusion since a paragraph/heading cannot contain a nested block),
 *  joined by '\n'. Used ONLY by the fallback detail marker's before/after
 *  body (`appendDetailMarker`, Decision item 4).
 *
 *  Deliberately NOT `MdListItem.text`/`MdProseUnit.text` (the
 *  markup-flattened, whitespace-normalized text `extractListItems`/
 *  `extractProseUnits` produce for pairing/word-diffing):
 *  docs/design/ui-rendered-markdown-diff.md is explicit that the marker must
 *  show the item's real source, not that flattened pairing text — a
 *  formatting-only edit (`*em*` -> `**em**`) or a GFM task-list checkbox
 *  toggle (`- [ ]` -> `- [x]`, which remark-gfm consumes into a `checked`
 *  boolean, never into the item's own text) flattens to IDENTICAL text on
 *  both sides, so a marker built from `.text` would show two indistinguishable
 *  rows — defeating the reason the marker exists (leaf .4 only ever attaches
 *  it when the intraline splice found no visible word-level change to
 *  splice, so this degenerate case is precisely the common path here, not an
 *  edge case). Reading raw source instead shows the actual difference. */
function verbatimSourceSlice(source: string, startLine: number, endLine: number): string {
  if (startLine <= 0 || endLine < startLine) return '';
  const lines = source.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

/** One "Before"/"After" labeled row inside the detail marker's body (see
 *  `appendDetailMarker`). `text` is inserted via `textContent` ONLY — never
 *  innerHTML, matching every other untrusted-text insertion in this file. */
function buildKvRow(label: string, valueClass: string, text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'ac-kv';
  const k = document.createElement('span');
  k.className = 'ac-k';
  k.textContent = label;
  const v = document.createElement('span');
  v.className = valueClass;
  v.textContent = text;
  row.appendChild(k);
  row.appendChild(v);
  return row;
}

/**
 * Appends the fallback detail marker (docs/design/ui-rendered-markdown-diff.md,
 * Decision item 4; docs/design/ui-design-language.md, "Always-visible detail
 * marker") — the ONLY item state that carries it (see `decorateListItems`'s
 * doc comment: reached only on `clean: false`). Native `<details>`/
 * `<summary>`, deliberately unmanaged by React (design record, "State
 * Ownership": ephemeral DOM state, resets on remount) — chosen specifically
 * so keyboard (Tab + Enter/Space) and screen-reader access come for free
 * instead of a hand-rolled popover.
 *
 * Inserted via the SAME `appendAfterItemText` helper `appendMiniTag` uses —
 * right after the item's own text, before any direct nested `<ul>/<ol>` —
 * rather than unconditionally at the end of `li` (REJECT correction: an
 * earlier version of this function `li.appendChild`ed unconditionally,
 * which landed the marker/tip AFTER a direct nested sublist instead of
 * inline after the item's own text, visually misattributing the change to
 * the sublist's last item).
 *
 * `oldSourceText`/`newSourceText` (see `verbatimSourceSlice`) are raw,
 * unsanitized markdown source — never `entry.oldText`'s markup-flattened
 * pairing text. Inserted via `createTextNode` ONLY (`buildKvRow`), exactly
 * like `buildGhostListItem`'s old-text handling: this text has never passed
 * through `sanitize()` as markup, so splicing it in as innerHTML would be an
 * XSS vector regardless of what it contains.
 *
 * `el` cannot own a listener of its own here to stop the marker's click from
 * bubbling: this whole subtree is serialized to a string
 * (`decoratedBlockHtml`'s `clone.outerHTML`) and re-parsed by the browser via
 * `dangerouslySetInnerHTML`, which drops any `addEventListener` attached at
 * this stage. The required click-isolation (the marker's own click/keyboard
 * activation must never reach `BlockView`'s `onBlockClick`, nor
 * `RenderedMarkdown`'s anchor-routing root click handler — which is already
 * a no-op here since nothing inside the marker is an `<a>`) is therefore
 * implemented as a target check in `BlockView`'s wrapper `onClick`
 * (`.closest('.ac-detail')`), not here.
 *
 * Also appends the mouse-hover quick preview (`.ac-hover-tip` — the
 * Diagram's "mouse-hover quick preview" convenience): pure CSS `:hover`
 * reveal (`li.ac-item-edited:hover > .ac-hover-tip` for a list item,
 * `.ac-prose-changed:hover > .ac-hover-tip` for a paragraph/heading —
 * styles.css — a CHILD combinator so the reveal stays scoped to the tip's
 * own unit rather than leaking across a nested-list ancestor/descendant
 * boundary), no listener of its own, so it can never intercept pointer
 * events or need JS-managed hover state. It shows the SAME `reason` text
 * the marker body's own "why" row carries below — never a mouse-only fact —
 * so every keyboard/screen-reader user reaches the identical information
 * through the marker alone; the tip is purely additive, never the only path
 * to it.
 *
 * Widened from `HTMLLIElement` to `HTMLElement` (type-only; body unchanged)
 * — see `appendAfterItemText`'s doc comment. Called for both a fallback
 * list item (`decorateListItems`) and a fallback paragraph/heading
 * (`decorateProseBlock`); the design record is explicit both get the same
 * marker — same trigger, same before/after body, same hover tip.
 */
function appendDetailMarker(
  el: HTMLElement,
  oldSourceText: string,
  newSourceText: string,
  reason: string,
): void {
  const details = document.createElement('details');
  details.className = 'ac-detail';

  const summary = document.createElement('summary');
  summary.title = 'Show full before/after';
  summary.setAttribute('aria-label', 'Show full before/after');
  summary.textContent = 'ⓘ'; // circled "i" — matches design/mockups/rendered-markdown-diff.html
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'ac-detail-body';
  const why = document.createElement('div');
  why.className = 'ac-detail-reason';
  why.textContent = reason; // TEXT ONLY — same reason the hover tip shows below.
  body.appendChild(why);
  body.appendChild(buildKvRow('Before', 'ac-before', oldSourceText));
  body.appendChild(buildKvRow('After', 'ac-after', newSourceText));
  details.appendChild(body);

  appendAfterItemText(el, details);

  const tip = document.createElement('div');
  tip.className = 'ac-hover-tip';
  tip.textContent = reason;
  // Decorative convenience only — the identical text is already reachable
  // (and, for AT users, reachable in the right place) via the marker's own
  // "why" row above, so hide this floating duplicate from the accessibility
  // tree rather than let it be announced out of context.
  tip.setAttribute('aria-hidden', 'true');
  appendAfterItemText(el, tip);
}

/** CSS class marking a synthesized ghost row (see `buildGhostListItem`) —
 *  shared between the class assignment here and `BlockView`'s hover-
 *  affordance guard above, so the two can never drift out of sync. */
const GHOST_ITEM_CLASS = 'ac-item-removed';

/**
 * Synthesizes one removed-item ghost `<li>`: the OLD item's flattened text
 * (docs/design/ui-rendered-markdown-diff.md, "Removed item") as a TEXT NODE
 * ONLY — never innerHTML, never re-parsed through the markdown/sanitizer
 * pipeline. The old source has never passed through `sanitize()` as markup,
 * so splicing it in as HTML would be an XSS vector; a plain Text node makes
 * that structurally impossible regardless of content (literal `<`/`>`
 * characters render as inert text, never as an element). Carries no
 * `data-start-line`/`data-end-line` — it has no line in the CURRENT file —
 * and no nested list, so `appendMiniTag`'s nested-list insertion branch is
 * never taken here.
 */
function buildGhostListItem(text: string): HTMLLIElement {
  const li = document.createElement('li');
  li.className = GHOST_ITEM_CLASS;
  li.appendChild(document.createTextNode(text));
  appendMiniTag(li, 'removed');
  return li;
}

/**
 * Inserts every ghost anchor targeting THIS clone's subtree (`root`) at its
 * resolved position (see `resolveGhostAnchors`, markdownItemDiff.ts).
 * `ghosts` is in old-document order, which lets consecutive deletions
 * anchored to the SAME point chain correctly: `lastInsertedByAnchor` tracks,
 * per anchor key, the most recently inserted ghost so the NEXT one sharing
 * that key is placed immediately after IT (not re-inserted at the original
 * anchor, which would reverse their order) — preserving old-tree relative
 * order for runs of adjacent deletions.
 *
 * `root` MUST already be a detached clone (see `decoratedListHtml`'s doc
 * comment) — these are real DOM insertions, not innerHTML splicing.
 */
function insertGhostRows(root: HTMLElement, ghosts: GhostAnchor[]): void {
  const lastInsertedByAnchor = new Map<string, HTMLElement>();
  const touchedLists = new Set<HTMLOListElement>();
  for (const ghost of ghosts) {
    const hostLi = root.querySelector<HTMLLIElement>(
      `li[data-start-line="${ghost.hostItemStartLine}"]`,
    );
    if (!hostLi || !hostLi.parentElement) continue; // defensive: host item not present in this clone
    const list = hostLi.parentElement;
    const key =
      ghost.insertAfterStartLine != null
        ? `after:${ghost.insertAfterStartLine}`
        : `start:${ghost.hostItemStartLine}`;
    const ghostLi = buildGhostListItem(ghost.text);
    const prevGhost = lastInsertedByAnchor.get(key);
    if (prevGhost) {
      prevGhost.after(ghostLi);
    } else if (ghost.insertAfterStartLine != null) {
      const afterLi = root.querySelector<HTMLLIElement>(
        `li[data-start-line="${ghost.insertAfterStartLine}"]`,
      );
      (afterLi ?? hostLi).after(ghostLi);
    } else {
      list.insertBefore(ghostLi, list.firstChild);
    }
    lastInsertedByAnchor.set(key, ghostLi);
    if (list.tagName === 'OL') touchedLists.add(list as HTMLOListElement);
  }
  for (const list of touchedLists) renumberOrderedList(list);
}

/**
 * Ordered-list ordinal preservation (docs/design/ui-rendered-markdown-diff.md,
 * "Ordered lists" behavior): inserting ANY `<li>` into an `<ol>` increments
 * the browser's built-in counter for every following sibling regardless of
 * `list-style` (which only hides a marker glyph — it never stops the
 * counter), so every REAL item gets an explicit `value` pinning it to the
 * ordinal it would show with NO ghosts present, overriding whatever the
 * natural auto-increment would otherwise compute. Ghost items are left
 * without a `value` (their marker is suppressed via CSS for an ordered
 * list, so their own phantom ordinal is never painted) and are skipped when
 * counting. Recomputes the WHOLE list from scratch — idempotent, safe to
 * call once per touched list regardless of how many ghosts it received.
 */
function renumberOrderedList(list: HTMLOListElement): void {
  const startAttr = list.getAttribute('start');
  const parsedStart = startAttr ? Number.parseInt(startAttr, 10) : NaN;
  let n = Number.isFinite(parsedStart) ? parsedStart : 1;
  for (const child of Array.from(list.children)) {
    if (child.tagName !== 'LI' || child.classList.contains(GHOST_ITEM_CLASS)) continue;
    (child as HTMLLIElement).value = n;
    n += 1;
  }
}

/**
 * Synthesizes one removed-row ghost `<tr>` — the table sibling of
 * `buildGhostListItem`. Reuses `GHOST_ITEM_CLASS` DIRECTLY (the single
 * shared ghost definition — `BlockView.onMove`'s existing
 * `.closest('.' + GHOST_ITEM_CLASS)` guard then covers a ghost `<tr>` with
 * ZERO code change, exactly per this leaf's Guardrails).
 *
 * Emits exactly `columnCount` `<td>`s — never more, never fewer — so the
 * ghost can never widen the table or leave it ragged: a shorter old row
 * pads with empty cells, a longer one truncates (matching how the renderer
 * already truncates/pads real rows on both sides for a well-formed GFM
 * table). Every cell's content is a plain TEXT NODE ONLY
 * (`document.createTextNode`) — the old row's cell text has never passed
 * through `sanitize()` as markup, so splicing it in as HTML would be an XSS
 * vector, exactly like `buildGhostListItem`'s own rule: a literal `<`/`>`
 * in the old source must render as inert text, never as an element. Carries
 * no `data-start-line` (it has no line in the CURRENT file, and per this
 * leaf's Guardrails must never become a note-anchor target) and no detail
 * marker (the ghost's visible text already IS the full "before" state —
 * same rule as a removed list item).
 */
function buildGhostTableRow(cells: string[], columnCount: number): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.className = GHOST_ITEM_CLASS;
  for (let i = 0; i < columnCount; i++) {
    const td = document.createElement('td');
    td.appendChild(document.createTextNode(cells[i] ?? ''));
    tr.appendChild(td);
  }
  // Defensive, matching decorateTableRows's identical `if (!firstCell)
  // return` guard for the same shape: unreachable today (a real GFM table
  // row always has >= 1 column, so `columnCount` is always >= 1 here), but
  // fails closed instead of throwing if that ever stops holding.
  const firstCell = tr.children[0] as HTMLElement | undefined;
  if (firstCell) appendMiniTag(firstCell, 'removed');
  return tr;
}

/**
 * Inserts every ghost-row anchor targeting THIS clone's subtree (`root`) at
 * its resolved position — the table sibling of `insertGhostRows`. Same
 * anchor-CHAINING shape (`lastInsertedByAnchor`, preserving consecutive
 * deletions' old-tree relative order) as `insertGhostRows`, but DUPLICATED
 * rather than shared with it — an explicitly acceptable fallback per this
 * leaf's Contract — because the two differ in: the host-element selector
 * (`tr[data-start-line]` vs `li[data-start-line]`), the ghost-builder
 * signature (`buildGhostTableRow(cells, columnCount)` vs
 * `buildGhostListItem(text)`), and the post-loop per-container hook (a
 * zebra restripe below vs `renumberOrderedList`) — sharing the loop itself
 * would need a callback-parametrized indirection for comparatively little
 * duplication saved, at real risk to `insertGhostRows`'s own shipped,
 * heavily-tested behavior (see markdown.test.tsx's ghost-row-for-lists
 * suite). The anchor RESOLUTION algorithm itself (deciding WHERE each ghost
 * belongs) is NOT duplicated — both this function and `insertGhostRows`
 * consume anchors already resolved by the one shared
 * `resolveGhostAnchorsForUnits` core (markdownItemDiff.ts).
 *
 * `anchors` is in old-document order (guaranteed by
 * `resolveGhostAnchorsForUnits`), which is what lets consecutive deletions
 * anchored to the SAME point chain correctly via `lastInsertedByAnchor`.
 *
 * `columnCount` is read PER-GHOST from its own resolved `hostTr.children.length`
 * — the anchor's host row, already present in this clone — rather than a
 * single table-wide constant computed up front: simpler (no separate
 * header lookup needed) and self-consistent with "matching how the
 * renderer already truncates/pads on both sides" (every row of a
 * well-formed GFM table already has the same rendered cell count as the
 * header).
 *
 * No-preceding-survivor case inserts at `tbody.firstChild` (never the
 * `<table>`/`<thead>`) — the host row resolved by
 * `resolveGhostAnchorsForUnits` is always a BODY row: the header always
 * pairs within its own `:h` bucket (see `tableRowKeyOf`'s doc comment), so
 * it can never itself be an unmatched-old "host" for anchoring — meaning
 * `hostTr.parentElement` is always the `<tbody>`.
 *
 * `root` MUST already be a detached clone (see `decoratedBlockHtml`'s doc
 * comment) — these are real DOM insertions, not innerHTML splicing.
 */
function insertGhostTableRows(root: HTMLElement, anchors: UnitGhostAnchor<MdTableRow>[]): void {
  const lastInsertedByAnchor = new Map<string, HTMLElement>();
  const touchedTables = new Set<HTMLTableElement>();
  for (const anchor of anchors) {
    const hostTr = root.querySelector<HTMLTableRowElement>(
      `tr[data-start-line="${anchor.hostStartLine}"]`,
    );
    if (!hostTr || !hostTr.parentElement) continue; // defensive: host row not present in this clone
    const tbody = hostTr.parentElement;
    const columnCount = hostTr.children.length;
    const key =
      anchor.insertAfterStartLine != null
        ? `after:${anchor.insertAfterStartLine}`
        : `start:${anchor.hostStartLine}`;
    const ghostTr = buildGhostTableRow(anchor.unit.cells, columnCount);
    const prevGhost = lastInsertedByAnchor.get(key);
    if (prevGhost) {
      prevGhost.after(ghostTr);
    } else if (anchor.insertAfterStartLine != null) {
      const afterTr = root.querySelector<HTMLTableRowElement>(
        `tr[data-start-line="${anchor.insertAfterStartLine}"]`,
      );
      (afterTr ?? hostTr).after(ghostTr);
    } else {
      tbody.insertBefore(ghostTr, tbody.firstChild);
    }
    lastInsertedByAnchor.set(key, ghostTr);
    const table = tbody.closest('table');
    if (table) touchedTables.add(table);
  }
  for (const table of touchedTables) restripeTable(table);
}

/** CSS class marking a table that received at least one ghost row and
 *  therefore needs explicit zebra-stripe classes instead of relying on
 *  `:nth-child(even)` alone (see styles.css's `.ac-table-restriped` rule
 *  pair for the full rationale): inserting a ghost `<tr>` shifts every
 *  FOLLOWING real row's `nth-child` parity, flipping stripes that have
 *  nothing to do with the actual edit — the table analogue of
 *  `renumberOrderedList`'s ordinal-preservation problem, but purely
 *  presentational (a class, never a displayed number). */
const TABLE_RESTRIPED_CLASS = 'ac-table-restriped';
/** CSS class marking a NON-GHOST row that should render the striped
 *  ("even") background under `.ac-table-restriped` — assigned purely by
 *  counting real (non-ghost) rows in DOM order, so it never exposes any
 *  actual row index/ordinal to the user (Guardrail: no row-ordinal
 *  mechanism) — a presentation-only boolean, fully recomputed from scratch
 *  on every `restripeTable` call. */
const TABLE_ROW_EVEN_CLASS = 'ac-row-even';

/**
 * Re-stripes `table`'s body rows after `insertGhostTableRows` inserted ≥1
 * ghost into it, so the VISUAL stripe pattern for every REAL (non-ghost) row
 * is identical to what it would be with NO ghost present — the direct table
 * analogue of `renumberOrderedList`'s ordinal-preservation guarantee, but
 * purely presentational (a class, never a displayed number): counts only
 * non-ghost `<tr>`s in DOM order and assigns `TABLE_ROW_EVEN_CLASS` to every
 * 2nd one (1-based: the 2nd, 4th, 6th... real row), matching
 * `tbody tr:nth-child(even)`'s own effective pattern on a ghost-free table.
 * Ghost rows are skipped by BOTH the counting and the class assignment —
 * they never receive a stripe class themselves (styles.css's own
 * `tr.ac-item-removed` treatment already gives them their own distinct
 * dashed/struck-through look, independent of zebra striping). Only ever
 * called (from `insertGhostTableRows`) on a table that received ≥1 ghost —
 * a table with no ghosts is never restriped and keeps relying on the plain
 * `:nth-child(even)` CSS rule unchanged.
 */
function restripeTable(table: HTMLTableElement): void {
  table.classList.add(TABLE_RESTRIPED_CLASS);
  const rows = table.querySelectorAll<HTMLTableRowElement>('tbody > tr');
  let realIndex = 0;
  rows.forEach((tr) => {
    if (tr.classList.contains(GHOST_ITEM_CLASS)) return;
    realIndex += 1;
    tr.classList.toggle(TABLE_ROW_EVEN_CLASS, realIndex % 2 === 0);
  });
}

// --- Intraline word-diff splicing (docs/design/ui-rendered-markdown-diff.md,
// Decision item 3) --------------------------------------------------------

interface IntralineResult {
  clean: boolean;
  reason?: string;
}

/** One direct child of an item element, classified for diff-splicing
 *  purposes. `text`: a real Text node, splice-eligible (its parent IS the
 *  item itself). `opaque`: an inline element (a/strong/em/code/img-as-span/
 *  etc.) — its OWN flattened text counts toward the item's diffable text
 *  (so word alignment stays correct across it) but it can never receive a
 *  spliced span. `skip`: a nested `<ul>/<ol>` (or any other node type) —
 *  contributes NO text and is never touched, matching `MdListItem`'s own
 *  exclusion of nested-list content from an item's text.
 *
 * `leadingFringe`/`trailingFringe` (text slots only): whitespace trimmed
 * off the RAW node data because the previous/next sibling is a nested
 * list — rehype-stringify pretty-prints a newline around block-level
 * content, which is pure HTML-serialization noise, never real prose (and
 * has no counterpart at all in `MdListItem.text`, which excludes nested
 * lists outright). Excluded from `start`/`end` (never a diff target, never
 * counted in the flattened text used for tokenizing/matching) but always
 * re-emitted verbatim — see `rebuildTextSlot`. '' when not applicable. */
interface Slot {
  kind: 'text' | 'opaque' | 'skip';
  node: ChildNode;
  start: number;
  end: number;
  leadingFringe: string;
  trailingFringe: string;
}

function isListElement(node: ChildNode): boolean {
  return (
    node.nodeType === Node.ELEMENT_NODE &&
    ((node as Element).tagName === 'UL' || (node as Element).tagName === 'OL')
  );
}

/** The element whose DIRECT children hold an item's own splice-eligible
 *  content. For a normal (tight) list item this is `li` itself. For a LOOSE
 *  list item — `<li><p>text</p></li>` (CommonMark wraps a loose item's own
 *  inline content in a single child `<p>`), optionally with a nested
 *  `<ul>/<ol>` as a SIBLING of that `<p>` — `li`'s own direct children never
 *  hold the item's text at all, so `buildSlots(li)` would only ever see one
 *  opaque, never-splice-eligible `<p>` slot. Detected structurally: exactly
 *  one ELEMENT child once any nested `<ul>/<ol>` is set aside, and that
 *  child is a `<p>`. A multi-paragraph item (`<li><p/><p/></li>`) or any
 *  other shape returns `li` unchanged — still not clean, but via
 *  `verifyCleanSplice`'s own accurate reason (`fallbackReasonFor`), not
 *  because this function mis-detects the shape. */
function spliceContentRoot(li: HTMLLIElement): HTMLElement {
  const ownElements = Array.from(li.children).filter((el) => !isListElement(el));
  if (ownElements.length === 1 && ownElements[0].tagName === 'P') {
    return ownElements[0] as HTMLElement;
  }
  return li;
}

/** True when `li` is a loose-list item shape `spliceContentRoot` does NOT
 *  reduce to a single content root — e.g. `<li><p/><p/></li>` (a
 *  multi-paragraph item) — i.e. `li` itself has more than one of its own
 *  (non-nested-list) elements and at least one is a `<p>`. Checked BEFORE
 *  attempting the diff at all: with `contentRoot` staying `li`, EVERY such
 *  paragraph is an opaque, never-splice-eligible slot (see `Slot`'s `kind`
 *  doc), so ANY edit in this shape fails `verifyCleanSplice` unconditionally
 *  — but a segment that happens to straddle two opaque `<p>` slots (e.g. an
 *  added word immediately before the paragraph break) maps to NO single
 *  slot at all, so `verifyCleanSplice` can't blame a specific `<p>` and
 *  falls back to the generic boundary message, which is misleading for this
 *  shape. Deciding it structurally, up front, sidesteps that entirely. */
function hasUnsupportedParagraphWrapping(li: HTMLLIElement): boolean {
  const ownElements = Array.from(li.children).filter((el) => !isListElement(el));
  return ownElements.length !== 1 && ownElements.some((el) => el.tagName === 'P');
}

/** Flattens `root`'s DIRECT children into slots + the concatenated text
 *  those slots represent. This flattened text is byte-exact by
 *  construction (it's read straight off the live, already-sanitized DOM),
 *  which is what lets `applyIntralineSpans` map diff-segment offsets back
 *  onto real node positions without any whitespace-normalization drift —
 *  modulo the nested-list pretty-print fringe stripped per `Slot`'s doc. */
function buildSlots(root: HTMLElement): { slots: Slot[]; text: string } {
  const slots: Slot[] = [];
  let text = '';
  const children = Array.from(root.childNodes);
  children.forEach((child, i) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const raw = (child as Text).data;
      let core = raw;
      let leadingFringe = '';
      let trailingFringe = '';
      if (i > 0 && isListElement(children[i - 1])) {
        const m = /^\s+/.exec(core);
        if (m) {
          leadingFringe = m[0];
          core = core.slice(m[0].length);
        }
      }
      if (i < children.length - 1 && isListElement(children[i + 1])) {
        const m = /\s+$/.exec(core);
        if (m) {
          trailingFringe = m[0];
          core = core.slice(0, core.length - m[0].length);
        }
      }
      slots.push({
        kind: 'text',
        node: child,
        start: text.length,
        end: text.length + core.length,
        leadingFringe,
        trailingFringe,
      });
      text += core;
    } else if (child.nodeType === Node.ELEMENT_NODE && !isListElement(child)) {
      const data = (child as Element).textContent ?? '';
      slots.push({
        kind: 'opaque',
        node: child,
        start: text.length,
        end: text.length + data.length,
        leadingFringe: '',
        trailingFringe: '',
      });
      text += data;
    } else {
      // Nested <ul>/<ol>, or any other node type — never measured/diffed,
      // preserved verbatim at its current position (see `skip` doc above).
      slots.push({
        kind: 'skip',
        node: child,
        start: text.length,
        end: text.length,
        leadingFringe: '',
        trailingFringe: '',
      });
    }
  });
  return { slots, text };
}

/** The slot that strictly CONTAINS `point` (i.e. splitting it), if any —
 *  used for a `del` segment's insertion point. A point that instead sits
 *  exactly at a slot boundary (between two slots, or at the very start/end)
 *  returns `undefined`: inserting a new sibling there is always safe
 *  regardless of what's adjacent, so it imposes no cleanliness constraint. */
function enclosingSlot(slots: Slot[], point: number): Slot | undefined {
  return slots.find((s) => point > s.start && point < s.end);
}

/** The single slot that FULLY covers `[start, end)`, if any — used for an
 *  `add` segment's range. Returns `undefined` both when the range straddles
 *  more than one slot (crosses an element boundary) and when it falls
 *  inside a zero-width `skip` slot (impossible for a non-empty range). */
function coveringSlot(slots: Slot[], start: number, end: number): Slot | undefined {
  return slots.find((s) => start >= s.start && end <= s.end);
}

const FALLBACK_REASON_BOUNDARY = 'edit crosses a formatting or link boundary';
const FALLBACK_REASON_MULTI_PARAGRAPH = 'item spans multiple paragraphs';
const FALLBACK_REASON_RECONSTRUCTION = 'edit mapping does not match the rendered text';

/** Accurate, user-showable reason for a slot that blocked a splice (leaf .4
 *  surfaces this verbatim in its hover quick preview, so it must actually be
 *  true). Callers only reach this for a slot that already failed the
 *  `kind === 'text'` check (or found no single covering slot at all), so a
 *  defined `slot` here is always 'opaque' or 'skip' — both back a real
 *  Element, so `.tagName` is always safe to read. A `<p>` slot specifically
 *  means the item has MORE THAN ONE paragraph (`spliceContentRoot` already
 *  descends into a single `<p>`, so a second one is never reached there and
 *  surfaces here as an ordinary opaque slot instead) — no formatting or
 *  link is actually involved, so it gets its own message rather than the
 *  inline-markup one. */
function fallbackReasonFor(slot: Slot | undefined): string {
  if (slot && (slot.node as Element).tagName === 'P') return FALLBACK_REASON_MULTI_PARAGRAPH;
  return FALLBACK_REASON_BOUNDARY;
}

/** Verifies every non-equal segment maps to a splice-eligible position
 *  BEFORE any DOM mutation is attempted (see the module-level guardrail:
 *  never leave a partial splice behind). Returns a short, user-showable
 *  reason on failure, or `null` when the whole diff is safe to apply. */
function verifyCleanSplice(slots: Slot[], segments: WordDiffSegment[]): string | null {
  let cursor = 0;
  for (const seg of segments) {
    if (seg.kind === 'equal') {
      cursor += seg.text.length;
      continue;
    }
    if (seg.kind === 'add') {
      const slot = coveringSlot(slots, cursor, cursor + seg.text.length);
      if (!slot || slot.kind !== 'text') return fallbackReasonFor(slot);
      cursor += seg.text.length;
      continue;
    }
    // del: zero-width at `cursor`. Strictly inside a non-'text' slot means
    // splitting a link/bold/em/code/image's own text — not clean. Strictly
    // inside a 'text' slot, or at any boundary, is safe.
    const inside = enclosingSlot(slots, cursor);
    if (inside && inside.kind !== 'text') return fallbackReasonFor(inside);
  }
  return null;
}

interface LocalOp {
  start: number;
  end: number;
  kind: 'add' | 'del';
  text: string;
}

function makeDiffSpan(kind: 'add' | 'del', value: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = kind === 'del' ? 'ac-del-span' : 'ac-add-span';
  // textContent, never innerHTML: `value` may come from old-source text
  // (see applyIntralineSpans) that has never been through the sanitizer as
  // markup — safe as literal text, unsafe if ever re-parsed as HTML.
  span.textContent = value;
  return span;
}

/** Rebuilds ONE 'text' slot's content as an alternating sequence of plain
 *  text nodes (untouched runs) and diff spans, per its local ops (already
 *  verified splice-eligible by `verifyCleanSplice`), bracketed by the
 *  slot's fringe (see `Slot`'s doc) re-attached verbatim on either side. */
function rebuildTextSlot(slot: Slot, text: string, ops: LocalOp[]): ChildNode[] {
  const out: ChildNode[] = [];
  if (slot.leadingFringe) out.push(document.createTextNode(slot.leadingFringe));
  const sorted = [...ops].sort((a, b) => a.start - b.start);
  let cursor = slot.start;
  for (const op of sorted) {
    // A `del` is zero-width (op.start === op.end) and may share its start
    // with an immediately-following `add` at the same point — advance the
    // cursor to op.start UNCONDITIONALLY (not just for 'add') so a second
    // op at the same position never re-emits the same gap text twice.
    if (op.start > cursor) out.push(document.createTextNode(text.slice(cursor, op.start)));
    cursor = Math.max(cursor, op.start);
    out.push(makeDiffSpan(op.kind, op.text));
    if (op.kind === 'add') cursor = op.end;
  }
  if (cursor < slot.end) out.push(document.createTextNode(text.slice(cursor, slot.end)));
  if (slot.trailingFringe) out.push(document.createTextNode(slot.trailingFringe));
  return out;
}

/** Builds the item's full replacement child list. Only reached after
 *  `verifyCleanSplice` confirms every non-equal segment has a valid,
 *  unambiguous placement, so every `add`/`del` here is guaranteed to land
 *  somewhere — nothing is silently dropped. `opaque`/`skip` slots are
 *  guaranteed (by the same verification) to have no overlapping non-equal
 *  segment, so they're always re-emitted as their ORIGINAL node, untouched. */
function buildSplicedChildren(
  slots: Slot[],
  text: string,
  segments: WordDiffSegment[],
): ChildNode[] {
  const localOps = new Map<Slot, LocalOp[]>();
  const boundaryDels: Array<{ at: number; text: string }> = [];

  let cursor = 0;
  for (const seg of segments) {
    if (seg.kind === 'equal') {
      cursor += seg.text.length;
      continue;
    }
    if (seg.kind === 'add') {
      const slot = coveringSlot(slots, cursor, cursor + seg.text.length)!;
      const list = localOps.get(slot) ?? [];
      list.push({ start: cursor, end: cursor + seg.text.length, kind: 'add', text: seg.text });
      localOps.set(slot, list);
      cursor += seg.text.length;
      continue;
    }
    const inside = enclosingSlot(slots, cursor);
    if (inside && inside.kind === 'text') {
      const list = localOps.get(inside) ?? [];
      list.push({ start: cursor, end: cursor, kind: 'del', text: seg.text });
      localOps.set(inside, list);
    } else {
      boundaryDels.push({ at: cursor, text: seg.text });
    }
  }

  const placed = new Set<number>();
  const output: ChildNode[] = [];
  for (const slot of slots) {
    boundaryDels.forEach((bd, idx) => {
      if (!placed.has(idx) && bd.at === slot.start) {
        output.push(makeDiffSpan('del', bd.text));
        placed.add(idx);
      }
    });
    const ops = localOps.get(slot);
    if (slot.kind === 'text' && ops) {
      output.push(...rebuildTextSlot(slot, text, ops));
    } else {
      output.push(slot.node);
    }
  }
  boundaryDels.forEach((bd, idx) => {
    if (!placed.has(idx)) output.push(makeDiffSpan('del', bd.text));
  });
  return output;
}

/** Collapses every whitespace run in `raw` to a single space and trims the
 *  ends — the SAME rule `normalizeText` (markdownItemDiff.ts) applies to the
 *  OLD side's flattened text — so `applyIntralineSpans` can diff two
 *  strings in the SAME whitespace regime instead of comparing raw DOM text
 *  (`buildSlots`) directly against already-normalized text. Un-reconciled,
 *  that mismatch is what produced local_repo_explorer-rendered-md-per-item-diff-bibv.2's
 *  REJECT: a GFM checkbox's genuine leading space, a multi-space run, or a
 *  soft/hard line-break character all differ from their normalized old-side
 *  rendering in ways that carry no actual content change, yet diffed as
 *  phantom del/add segments.
 *
 *  `toRaw[i]` maps canonical offset `i` (a boundary BEFORE the i-th
 *  canonical character, `0..canonical.length` inclusive) back to the `raw`
 *  offset it corresponds to, so a diff segment boundary computed over
 *  `canonical` can be translated back into `buildSlots`' raw offset space
 *  before splicing (`remapSegmentsToRaw`) — `canonical` itself is only ever
 *  used to determine WHERE segments fall, never spliced in verbatim. */
function canonicalizeForDiff(raw: string): { canonical: string; toRaw: number[] } {
  const isWs = (ch: string): boolean => /\s/.test(ch);
  let start = 0;
  while (start < raw.length && isWs(raw[start])) start++;
  let end = raw.length;
  while (end > start && isWs(raw[end - 1])) end--;

  let canonical = '';
  const toRaw: number[] = [start];
  let cursor = start;
  while (cursor < end) {
    if (isWs(raw[cursor])) {
      let runEnd = cursor + 1;
      while (runEnd < end && isWs(raw[runEnd])) runEnd++;
      canonical += ' ';
      cursor = runEnd;
    } else {
      canonical += raw[cursor];
      cursor += 1;
    }
    toRaw.push(cursor);
  }
  return { canonical, toRaw };
}

/** Re-expresses each `equal`/`add` segment's text as the literal RAW
 *  substring it corresponds to (via `toRaw` from `canonicalizeForDiff`), so
 *  summing non-'del' segment lengths in order walks `buildSlots`' raw
 *  offset space instead of the canonicalized space the diff actually ran
 *  over — required by `verifyCleanSplice`/`buildSplicedChildren`, which
 *  anchor entirely on that raw coordinate space, cursor starting at 0. An
 *  `add` span therefore displays the item's real, un-normalized text (e.g. a
 *  genuinely-odd internal multi-space run inside newly-added words), never
 *  the collapsed canonical form. `del` segments are old-side-only content
 *  with no counterpart in the new/raw text at all (`wordDiff`'s own
 *  contract: `del` text always comes from the OLD tokens) — already
 *  zero-width in canonical space, so they pass through unchanged.
 *
 *  CRITICAL: also bookends the trimmed prefix/suffix (`raw.slice(0,
 *  toRaw[0])` / `raw.slice(toRaw[toRaw.length - 1])`) as literal 'equal'
 *  segments, ordered strictly first/last (never interleaved ahead of a
 *  leading `del` or behind a trailing one, so a boundary `del` still anchors
 *  at `toRaw[0]`/the pre-suffix offset, not at raw offset 0/`raw.length`).
 *  This is what makes `segments.filter(s => s.kind !== 'del').map(s =>
 *  s.text).join('') === raw` hold EXACTLY. `canonicalizeForDiff` trims
 *  leading/trailing whitespace before diffing, so without these two extra
 *  segments nothing in the output covers that trimmed span at all, and the
 *  downstream cursor (which starts at 0 and assumes the join reproduces
 *  `raw` from offset 0) silently drifts by the trimmed-prefix length for
 *  every position after it — dropping/duplicating characters at every
 *  splice point. This was local_repo_explorer-rendered-md-per-item-diff-bibv.2's
 *  2nd-pass REJECT root cause (reproduced on any item with leading
 *  whitespace, e.g. a GFM task-list item's checkbox gap, or an item whose
 *  first slot contributes no text, e.g. a leading image). `applyIntralineSpans`
 *  also re-verifies this exact invariant at runtime via `reconstructsRawText`
 *  as a defense-in-depth backstop, independent of this function staying
 *  correct. */
function remapSegmentsToRaw(
  segments: WordDiffSegment[],
  raw: string,
  toRaw: number[],
): WordDiffSegment[] {
  const out: WordDiffSegment[] = [];
  const prefixLen = toRaw[0];
  if (prefixLen > 0) out.push({ kind: 'equal', text: raw.slice(0, prefixLen) });
  let canonCursor = 0;
  for (const seg of segments) {
    if (seg.kind === 'del') {
      out.push(seg);
      continue;
    }
    const rawStart = toRaw[canonCursor];
    canonCursor += seg.text.length;
    const rawEnd = toRaw[canonCursor];
    out.push({ kind: seg.kind, text: raw.slice(rawStart, rawEnd) });
  }
  const suffixStart = toRaw[toRaw.length - 1];
  if (suffixStart < raw.length) out.push({ kind: 'equal', text: raw.slice(suffixStart) });
  return out;
}

/** Defense-in-depth structural backstop (see `applyIntralineSpans` and
 *  local_repo_explorer-rendered-md-per-item-diff-bibv.2's 2nd-pass REJECT):
 *  verifies that concatenating every non-'del' segment's text reproduces
 *  `rawNewText` EXACTLY, BEFORE any DOM mutation is even considered.
 *  `verifyCleanSplice`/`buildSplicedChildren` both compute splice positions
 *  by cumulatively summing non-'del' segment lengths from cursor 0 —
 *  silently assuming this join equals `rawNewText`. `remapSegmentsToRaw` is
 *  responsible for keeping that true, but this check stays as an always-on,
 *  independent guard against the whole bug CLASS: any future change that
 *  breaks the raw-offset-space agreement fails CLOSED (falls back to the
 *  whole-item treatment) instead of silently corrupting the splice. */
function reconstructsRawText(segments: WordDiffSegment[], rawNewText: string): boolean {
  const joined = segments
    .filter((s) => s.kind !== 'del')
    .map((s) => s.text)
    .join('');
  return joined === rawNewText;
}

const WHITESPACE_ONLY_RE = /^\s+$/;

/** Suppresses an `add`/`del` segment that is PURELY whitespace — a
 *  belt-and-braces backstop alongside `canonicalizeForDiff`/
 *  `remapSegmentsToRaw` (docs/design/ui-rendered-markdown-diff.md's
 *  "Fallback detection" is explicit that a diff boundary must never produce
 *  a visible artifact from a non-content difference). A whitespace-only
 *  `add` keeps its (real, raw) text but downgrades to `equal`: the text is
 *  genuine DOM content and must stay in the output, just without the
 *  visible add-span "chip" around invisible whitespace. A whitespace-only
 *  `del` is dropped entirely — it has no counterpart in the new/raw text to
 *  anchor a visible strikethrough around. */
function suppressWhitespaceOnlySegments(segments: WordDiffSegment[]): WordDiffSegment[] {
  const out: WordDiffSegment[] = [];
  for (const seg of segments) {
    if (seg.kind === 'equal' || !WHITESPACE_ONLY_RE.test(seg.text)) {
      out.push(seg);
      continue;
    }
    if (seg.kind === 'add') out.push({ kind: 'equal', text: seg.text });
  }
  return out;
}

/**
 * Attempts to splice word-level `.ac-del-span`/`.ac-add-span`s into an
 * edited list item's own text (never into a nested `<ul>/<ol>` — that's an
 * independently classified item, see `Slot`'s `skip` case; and never into a
 * SECOND paragraph of a loose item — see `spliceContentRoot`). `li` MUST
 * already be part of a detached clone (see `decoratedBlockHtml`'s doc
 * comment).
 *
 * The `<li>`-specific pre-steps live HERE, not in `spliceIntralineInto`:
 * `hasUnsupportedParagraphWrapping` (bail before even attempting a diff for
 * a multi-paragraph loose item) and `spliceContentRoot` (descend into a
 * loose item's single wrapping `<p>`, when present, since a LIST ITEM is
 * not itself the splice-eligible content root the way a paragraph/heading
 * element already is). Once the real content root is resolved, everything
 * else is identical between the list and prose paths, so it is delegated to
 * the shared `spliceIntralineInto`.
 */
function applyIntralineSpans(li: HTMLLIElement, oldText: string): IntralineResult {
  if (hasUnsupportedParagraphWrapping(li)) {
    return { clean: false, reason: FALLBACK_REASON_MULTI_PARAGRAPH };
  }
  const contentRoot = spliceContentRoot(li);
  return spliceIntralineInto(contentRoot, oldText);
}

/**
 * Generic intraline-splice core (docs/design/ui-rendered-markdown-diff.md,
 * Decision item 3; "Decision — Extension: Non-List Block Types"): attempts
 * to splice word-level `.ac-del-span`/`.ac-add-span`s directly into
 * `contentRoot`'s own text. `contentRoot` MUST already be part of a
 * detached clone (see `decoratedBlockHtml`'s doc comment) — this mutates it
 * directly, but only via `replaceChildren` after `verifyCleanSplice`
 * confirms the ENTIRE diff is safe — so on any `clean: false` result
 * `contentRoot` is left byte-identical to its undecorated form, never
 * partially spliced.
 *
 * Callers are responsible for resolving `contentRoot` to the actual
 * splice-eligible element BEFORE calling this: `applyIntralineSpans`
 * descends a loose list item's wrapping `<p>` (`spliceContentRoot`) and
 * bails early on an unsupported multi-paragraph shape
 * (`hasUnsupportedParagraphWrapping`); `decorateProseBlock` passes its
 * `<p>`/`<h1>`-`<h6>` element directly, since that element already IS its
 * own content root (no nested-list skip case, no loose-item `<p>` to
 * descend into — a paragraph/heading can never contain a nested
 * `<ul>/<ol>` or a second paragraph per CommonMark's content model, so
 * neither pre-step is reachable for it).
 *
 * `oldText` (markdownItemDiff.ts's `normalizeText` — collapsed/trimmed) and
 * the unit's own rendered DOM text (`buildSlots` — read raw off the
 * sanitized DOM) are flattened by two DIFFERENT rules, so they are
 * reconciled into the SAME whitespace regime (`canonicalizeForDiff`) before
 * ever being compared; segment boundaries are translated back to
 * `buildSlots`' raw offsets (`remapSegmentsToRaw`) before splicing, and any
 * residual whitespace-only segment is suppressed
 * (`suppressWhitespaceOnlySegments`) rather than ever rendered as a span.
 */
function spliceIntralineInto(contentRoot: HTMLElement, oldText: string): IntralineResult {
  const { slots, text: rawNewText } = buildSlots(contentRoot);
  const { canonical, toRaw } = canonicalizeForDiff(rawNewText);

  const diff = computeWordDiff(oldText, canonical);
  if (!diff.clean) return { clean: false, reason: diff.reason };

  const segments = suppressWhitespaceOnlySegments(
    remapSegmentsToRaw(diff.segments, rawNewText, toRaw),
  );
  // Mandatory structural backstop, BEFORE any DOM mutation is even
  // considered — see `reconstructsRawText`'s doc comment. Independent of
  // whatever produced `segments`; fails closed on any disagreement.
  if (!reconstructsRawText(segments, rawNewText)) {
    return { clean: false, reason: FALLBACK_REASON_RECONSTRUCTION };
  }
  if (!segments.some((s) => s.kind !== 'equal')) {
    return { clean: false, reason: 'no word-level change detected' };
  }

  const reason = verifyCleanSplice(slots, segments);
  if (reason) return { clean: false, reason };

  contentRoot.replaceChildren(...buildSplicedChildren(slots, rawNewText, segments));
  return { clean: true };
}

// --- Fenced code-block intraline word-diff splicing (docs/design/
// ui-rendered-markdown-diff.md, "Fenced code blocks"; leaf .2) ------------
//
// Extends the splice engine above to a code block's `<code>` element, whose
// splice-eligible text lives at ARBITRARY DEPTH inside rehype-highlight's
// `<span class="hljs-*">` wrappers, not as direct children the way a
// paragraph/heading's/list-item's phrasing content does. `buildSlots`
// classifies every element CHILD as one opaque, never-splice-eligible slot
// — reused unmodified against a code block, that would report `clean: false`
// for nearly every real change on a highlighted block (most of the text is
// inside hljs spans), degrading straight back to the whole-block wash this
// leaf exists to remove. `buildCodeSlots` below is the extension: it walks
// the WHOLE subtree, treating every hljs `<span>` as a transparent
// container, so the resulting slots are exactly the code's real text nodes
// regardless of nesting depth.

/** Code-accurate fallback reason strings. The markdown-specific
 *  `FALLBACK_REASON_BOUNDARY`/`FALLBACK_REASON_MULTI_PARAGRAPH` (above) name
 *  link/inline-formatting/multi-paragraph causes that cannot occur inside a
 *  code block — surfacing either of them here would be actively misleading,
 *  so this path never reuses them. */
const CODE_REASON_BOUNDARY = 'edit crosses a syntax-highlighting boundary';
const CODE_REASON_TOO_LARGE = 'code block is too large for a word-level diff';

/** Translates `computeWordDiff`'s (wordDiff.ts) size-gate reason string to
 *  the code-accurate wording above, via an exact-string-match remap AT THIS
 *  CALL SITE — `wordDiff.ts` itself stays kind-agnostic and unedited, per
 *  this leaf's Contract. `computeWordDiff`'s only OTHER failure reason,
 *  `'no word-level change detected'`, already reads correctly for code (no
 *  markdown-specific vocabulary in it), so it passes through verbatim,
 *  unmatched by this remap. */
function translateCodeDiffReason(reason: string): string {
  return reason === 'item is too large for a word-level diff' ? CODE_REASON_TOO_LARGE : reason;
}

/**
 * DFS-flattened text-node slots over the WHOLE `<code>` subtree (arbitrary
 * depth) — the code-block counterpart of `buildSlots`, which only looks at
 * `contentRoot`'s DIRECT children (correct for a list item/paragraph/
 * heading's phrasing content, wrong for a highlighted code block — see this
 * section's header comment). Every hljs `<span>` is treated as a
 * TRANSPARENT container: recursed into, contributing no slot of its own —
 * it is never split, cloned, or itself made splice-eligible, so a diff span
 * landing inside one becomes a CHILD of that span (confirmed against real
 * rendered output: `<span class="hljs-property"><span
 * class="ac-add-span">cost</span></span>`), leaving every OTHER hljs class
 * on surrounding text completely untouched.
 *
 * `unexpected` is a defensive fail-closed flag: hljs's real output is always
 * plain text or nested `<span>`s (never `<a>`/`<em>`/a comment node/etc.
 * inside a highlighted code block), so this should never trigger in
 * practice — but `spliceCodeInto` must never assume that and splice anyway
 * if some future hljs/rehype version (or an as-yet-unseen language grammar)
 * emits something else; an unrecognized node type means "cannot safely
 * reason about this subtree," not "ignore it and continue."
 *
 * Slots carry no fringe (`leadingFringe`/`trailingFringe` always `''`,
 * unlike `buildSlots`' nested-list pretty-print trimming — `Slot`'s shape is
 * reused as-is rather than narrowed, since every other consumer
 * (`coveringSlot`/`enclosingSlot`/`verifyCleanSplice`/`rebuildTextSlot`)
 * already handles an always-empty fringe as a no-op): `<code>`'s content is
 * verbatim/whitespace-significant by construction (`white-space: pre`) and
 * rehype-stringify never injects pretty-printing whitespace around inline
 * `<span>`s the way it does around a `<li>`'s block-level children, so there
 * is no HTML-serialization artifact to strip here.
 */
function buildCodeSlots(codeEl: HTMLElement): {
  slots: Slot[];
  text: string;
  unexpected: boolean;
} {
  const slots: Slot[] = [];
  let text = '';
  let unexpected = false;
  const walk = (node: Element): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const data = (child as Text).data;
        slots.push({
          kind: 'text',
          node: child,
          start: text.length,
          end: text.length + data.length,
          leadingFringe: '',
          trailingFringe: '',
        });
        text += data;
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'SPAN') {
        walk(child as Element); // hljs container — transparent, no slot of its own.
      } else {
        // A different element tag, a comment node, ... — fail closed rather
        // than guess how to treat it.
        unexpected = true;
      }
    }
  };
  walk(codeEl);
  return { slots, text, unexpected };
}

/**
 * Attempts to splice word-level `.ac-del-span`/`.ac-add-span`s directly into
 * a fenced code block's `<code>` element, preserving every rehype-highlight
 * `<span class="hljs-*">` around them — the code sibling of
 * `spliceIntralineInto`. `codeEl` MUST already be part of a detached clone
 * (see `decoratedBlockHtml`'s doc comment) — this mutates it directly, in
 * place, per text node, but only AFTER `verifyCleanSplice` confirms the
 * ENTIRE diff is safe, so on any `clean: false` result `codeEl` is left
 * byte-identical to its undecorated form, never partially spliced.
 *
 * Reuses the SAME text-diff pipeline as `spliceIntralineInto`, in the exact
 * same order (`canonicalizeForDiff` -> `computeWordDiff` ->
 * `remapSegmentsToRaw` -> `suppressWhitespaceOnlySegments` ->
 * `reconstructsRawText` backstop -> degenerate check) and the SAME
 * `verifyCleanSplice` UNCHANGED — only `buildCodeSlots` (DFS over the whole
 * subtree instead of direct children) and the final DOM-mutation step
 * differ, because a code block's slots live at arbitrary depth inside hljs
 * spans rather than as `contentRoot`'s own direct children.
 *
 * `MAX_WORD_DIFF_TOKENS` (wordDiff.ts, currently 600) is intentionally left
 * SHARED with prose rather than given a code-specific bound: 600 tokens is
 * already generous headroom for a single fenced block (one large enough to
 * exceed it already reads poorly rendered inline in a diff view regardless
 * of this feature), and the same bounded-diff guarantee (wordDiff.ts's own
 * doc comment: no unbounded O(n*m) LCS) applies unchanged without
 * introducing a second bound to reason about.
 *
 * Placement of a non-splice-eligible (boundary) deletion deliberately uses
 * the SIMPLER of two viable rules, confirmed empirically to both produce a
 * clean, byte-exact splice: `parentNode.insertBefore` on the immediate
 * parent of the next slot's own text node — no ancestor-hop search for an
 * insertion point outside the innermost enclosing hljs span. The two rules
 * differ only in whether the del span lands INSIDE or as a sibling BEFORE
 * that innermost span; the simpler (inside) placement was chosen because
 * `.ac-del-span` sets its own `color`/`background`/`text-decoration`
 * directly (styles.css), so it reads identically regardless of which hljs
 * class happens to be its immediate parent — there is nothing it would need
 * to inherit from that wrapper that the ancestor-hop would have preserved.
 */
function spliceCodeInto(codeEl: HTMLElement, oldText: string): IntralineResult {
  const { slots, text: rawNewText, unexpected } = buildCodeSlots(codeEl);
  if (unexpected) return { clean: false, reason: 'complex markup' };

  const { canonical, toRaw } = canonicalizeForDiff(rawNewText);
  const diff = computeWordDiff(oldText, canonical);
  if (!diff.clean) return { clean: false, reason: translateCodeDiffReason(diff.reason) };

  const segments = suppressWhitespaceOnlySegments(
    remapSegmentsToRaw(diff.segments, rawNewText, toRaw),
  );
  // Mandatory structural backstop, BEFORE any DOM mutation — see
  // `reconstructsRawText`'s doc comment; this is what makes the byte-exact
  // reconstruction guarantee (every newline/indentation included) hold.
  if (!reconstructsRawText(segments, rawNewText)) {
    return { clean: false, reason: FALLBACK_REASON_RECONSTRUCTION };
  }
  if (!segments.some((s) => s.kind !== 'equal')) {
    return { clean: false, reason: 'no word-level change detected' };
  }

  // verifyCleanSplice is reused UNCHANGED: every code slot is 'text' (any
  // other shape already bailed via `unexpected` above), so ANY non-null
  // return here is necessarily a boundary case — this substitution is
  // therefore unconditional, not a guess at which of its possible reasons
  // applies (see this leaf's Contract).
  if (verifyCleanSplice(slots, segments)) return { clean: false, reason: CODE_REASON_BOUNDARY };

  // Assign ops per slot — the SAME first-loop logic as
  // `buildSplicedChildren`: adds -> the slot fully covering the add's
  // range; dels strictly inside a text slot -> that slot; a del landing
  // exactly on a slot boundary (not strictly inside any slot) ->
  // boundaryDels, placed separately below.
  const localOps = new Map<Slot, LocalOp[]>();
  const boundaryDels: Array<{ at: number; text: string }> = [];
  let cursor = 0;
  for (const seg of segments) {
    if (seg.kind === 'equal') {
      cursor += seg.text.length;
      continue;
    }
    if (seg.kind === 'add') {
      const slot = coveringSlot(slots, cursor, cursor + seg.text.length)!;
      const list = localOps.get(slot) ?? [];
      list.push({ start: cursor, end: cursor + seg.text.length, kind: 'add', text: seg.text });
      localOps.set(slot, list);
      cursor += seg.text.length;
      continue;
    }
    const inside = enclosingSlot(slots, cursor);
    if (inside && inside.kind === 'text') {
      const list = localOps.get(inside) ?? [];
      list.push({ start: cursor, end: cursor, kind: 'del', text: seg.text });
      localOps.set(inside, list);
    } else {
      boundaryDels.push({ at: cursor, text: seg.text });
    }
  }

  // Boundary dels: inserted immediately before the DOM node of the first
  // slot starting at that offset (inside that node's own parent — see this
  // function's doc comment on the placement choice), or appended at the
  // very end of `codeEl` when nothing follows.
  for (const bd of boundaryDels) {
    const next = slots.find((s) => s.start === bd.at);
    const span = makeDiffSpan('del', bd.text);
    if (next?.node.parentNode) next.node.parentNode.insertBefore(span, next.node);
    else codeEl.appendChild(span);
  }
  // In-place per-text-node splice — NEVER split or rebuild an hljs span:
  // only the text node itself is replaced, so a diff span landing inside a
  // highlighted token becomes a CHILD of that token's span, and every
  // surrounding text node (and its wrapping span, if any) is left
  // completely untouched.
  for (const [slot, ops] of localOps) {
    slot.node.replaceWith(...rebuildTextSlot(slot, rawNewText, ops));
  }
  return { clean: true };
}
