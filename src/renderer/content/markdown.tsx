import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { openLinkTarget, type LinkContext } from '../links/openLinkTarget';

export interface RenderedBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'code' | 'mermaid' | 'list' | 'table' | 'other';
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
}

const sanitize = (html: string): string =>
  DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style'],
    ADD_ATTR: [
      'data-start-line',
      'data-end-line',
      'data-mermaid-id',
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
}

// Single whole-document pass: parse once with GFM, replace top-level mermaid
// code blocks with sentinel placeholders, annotate every top-level node with
// data-start-line/data-end-line via mdast `data.hProperties` (consumed by
// remark-rehype), then stringify + sanitize the full document once. Reference
// definitions, footnote definitions, and reference images resolve because the
// pass sees the whole document; per-block re-parsing would break them.
async function renderDoc(source: string): Promise<PreparedDoc> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as Root;
  const mermaidById = new Map<string, MermaidEntry>();
  let mid = 0;

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
  return { html: sanitize(html), mermaidById };
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
        const tag = el.tagName.toLowerCase();
        const kind: RenderedBlock['kind'] = mermaidEntry ? 'mermaid' : kindFromTag(tag);
        const id = `b${i}`;
        const block: RenderedBlock = {
          id,
          kind,
          startLine,
          endLine,
          ...(mermaidEntry ? { source: mermaidEntry.source, language: 'mermaid' } : {}),
        };
        const changed =
          props.changedLineSet &&
          startLine > 0 &&
          rangeOverlaps(props.changedLineSet, startLine, endLine);
        const hasClickHandler = Boolean(props.onBlockClick);
        const onClick = () => props.onBlockClick?.(block);
        const wrapStyle: React.CSSProperties = {
          margin: compact ? '4px 0' : '8px 0',
          padding: changed ? 8 : 0,
          borderLeft: changed ? '2px solid var(--accent)' : '2px solid transparent',
          background: changed ? 'rgba(91, 141, 239, 0.06)' : 'transparent',
          cursor: changed && hasClickHandler ? 'pointer' : 'default',
          position: 'relative',
        };
        if (mermaidEntry) {
          return (
            <div key={id} style={wrapStyle} onClick={onClick}>
              {changed && <ChangedTag />}
              <MermaidFrame source={mermaidEntry.source} />
            </div>
          );
        }
        return (
          <div key={id} style={wrapStyle} onClick={onClick}>
            {changed ? <ChangedTag /> : null}
            <div dangerouslySetInnerHTML={{ __html: el.outerHTML }} />
          </div>
        );
      })}
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
