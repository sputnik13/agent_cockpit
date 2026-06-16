import { useCallback } from 'react';
import DOMPurify from 'dompurify';
import { useSettingsStore } from '../settings';
import { DiagramFrame } from './DiagramFrame';

interface MermaidFrameProps {
  source: string;
}

// Lazy-load the bundled mermaid (a large dep) only when a diagram is shown.
// Loading from a CDN is impossible under the app CSP (script-src 'self'); the
// bundled copy is same-origin and works offline.
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

let idSeq = 0;

/**
 * Renders a mermaid diagram from untrusted Markdown. mermaid runs with
 * securityLevel 'strict' and SVG-only labels; its SVG output is sanitized with
 * DOMPurify before insertion. The zoom/pan/Source chrome lives in
 * {@link DiagramFrame}, shared with the graphviz renderer.
 */
export function MermaidFrame({ source }: MermaidFrameProps): JSX.Element {
  const theme = useSettingsStore((s) => s.settings.theme);
  const render = useCallback(async (): Promise<string> => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'solarized-light' ? 'default' : 'dark',
      // Native SVG <text> labels (not HTML <foreignObject>), which the
      // DOMPurify SVG profile preserves — otherwise shapes have no text.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
    });
    const renderId = `mmd-${++idSeq}`;
    try {
      const { svg } = await mermaid.render(renderId, source);
      return DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style'],
      });
    } finally {
      // mermaid appends a temporary measuring element (`#d<id>`) to
      // document.body to render into; on a PARSE error it injects its
      // "Syntax error in text" diagram there and throws BEFORE removing it,
      // leaking an orphan below the app root that makes the whole frame
      // scrollable. Always remove it (success or failure).
      document.getElementById(`d${renderId}`)?.remove();
      document.getElementById(renderId)?.remove();
    }
  }, [source, theme]);

  return (
    <DiagramFrame label="Mermaid" source={source} render={render} renderKey={`${source}\n${theme}`} />
  );
}
