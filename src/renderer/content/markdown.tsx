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

export interface RenderedBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'code' | 'mermaid' | 'graphviz' | 'list' | 'table' | 'other';
  startLine: number;
  endLine: number;
  source?: string;
  language?: string;
}

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

    if (node.type === 'code' && ((node as Code).lang === 'dot' || (node as Code).lang === 'graphviz')) {
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
        if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
          node.properties = {
            ...(node.properties ?? {}),
            target: '_blank',
            rel: 'noopener noreferrer',
            'data-external': 'true',
          };
        } else if (href === '' || href.startsWith('#') || lower.startsWith('javascript:')) {
          // Empty, in-page fragment, or javascript: → inert (no navigation).
          node.properties = { ...(node.properties ?? {}), 'data-inert': 'true' };
          if (lower.startsWith('javascript:')) delete (node.properties as Record<string, unknown>).href;
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
    default:
      return 'other';
  }
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
        const startLine = Number(el.getAttribute('data-start-line') ?? 0);
        const endLine = Number(el.getAttribute('data-end-line') ?? 0);
        const mermaidId = el.getAttribute('data-mermaid-id');
        const mermaidEntry = mermaidId ? doc!.mermaidById.get(mermaidId) : null;
        const graphvizId = el.getAttribute('data-graphviz-id');
        const graphvizEntry = graphvizId ? doc!.graphvizById.get(graphvizId) : null;
        const tag = el.tagName.toLowerCase();
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
        const wrapStyle: React.CSSProperties = {
          margin: compact ? '4px 0' : '8px 0',
          padding: changed ? 8 : 0,
          borderLeft: changed ? '2px solid var(--accent)' : '2px solid transparent',
          background: changed ? 'rgba(91, 141, 239, 0.06)' : 'transparent',
          cursor: changed && hasClickHandler ? 'pointer' : 'default',
          position: 'relative',
        };

        const content = mermaidEntry ? (
          <MermaidFrame source={mermaidEntry.source} />
        ) : graphvizEntry ? (
          <GraphvizFrame source={graphvizEntry.source} />
        ) : (
          <div dangerouslySetInnerHTML={{ __html: el.outerHTML }} />
        );

        return (
          <BlockView
            key={id}
            startLine={startLine}
            endLine={endLine}
            changed={changed}
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
    const el = (e.target as HTMLElement).closest('[data-start-line]') as HTMLElement | null;
    if (!el || !wrapRef.current?.contains(el)) return;
    const line = Number(el.getAttribute('data-start-line'));
    if (!line) return;
    const top = el.offsetTop;
    setHover((h) => (h && h.line === line && h.top === top ? h : { line, top }));
  };

  return (
    <div
      ref={wrapRef}
      style={wrapStyle}
      onClick={onBlockClick}
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
