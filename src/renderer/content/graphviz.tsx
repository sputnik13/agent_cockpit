import { useCallback } from 'react';
import DOMPurify from 'dompurify';
import { Graphviz } from '@hpcc-js/wasm-graphviz';
import { DiagramFrame } from './DiagramFrame';

interface GraphvizFrameProps {
  source: string;
}

// Lazy-load the bundled Graphviz WASM only when a diagram is shown. The wasm is
// inlined (base64) in the package, so it loads same-origin with no extra asset
// fetch — works offline and under the strict production CSP, which permits
// `'wasm-unsafe-eval'` (see electron/main/security.ts).
let graphvizPromise: Promise<Graphviz> | null = null;
function loadGraphviz(): Promise<Graphviz> {
  if (!graphvizPromise) graphvizPromise = Graphviz.load();
  return graphvizPromise;
}

/**
 * Renders a Graphviz DOT diagram from untrusted Markdown (```dot / ```graphviz
 * fences). DOT is laid out to SVG by the WASM Graphviz, then DOMPurify-sanitized
 * before insertion. Mirrors {@link MermaidFrame}; the zoom/pan/Source chrome is
 * shared via {@link DiagramFrame}.
 */
export function GraphvizFrame({ source }: GraphvizFrameProps): JSX.Element {
  const render = useCallback(async (): Promise<string> => {
    const graphviz = await loadGraphviz();
    // `dot()` uses the "dot" layout engine and emits SVG. Invalid DOT throws,
    // which DiagramFrame surfaces as an error.
    const svg = graphviz.dot(source);
    return DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      ADD_TAGS: ['style'],
    });
  }, [source]);

  return <DiagramFrame label="Graphviz" source={source} render={render} renderKey={source} />;
}
