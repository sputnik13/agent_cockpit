// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mock the WASM Graphviz so the test is deterministic and does not instantiate
// real WebAssembly: load() resolves to a stub whose dot() returns a tiny SVG.
vi.mock('@hpcc-js/wasm-graphviz', () => ({
  Graphviz: {
    load: () => Promise.resolve({ dot: (_src: string) => '<svg><text>node</text></svg>' }),
  },
}));

import { RenderedMarkdown } from './markdown';

afterEach(() => cleanup());

describe('RenderedMarkdown — graphviz', () => {
  it('routes a ```dot fence to a Graphviz frame and renders its SVG', async () => {
    const src = ['```dot', 'digraph { a -> b }', '```', ''].join('\n');
    const { container } = render(<RenderedMarkdown source={src} />);
    // The DiagramFrame chrome (label + Source toggle) renders before WASM resolves.
    await waitFor(() => expect(container.textContent).toContain('Graphviz'));
    // The fence must NOT fall through to a highlighted code block.
    expect(container.querySelector('pre code.language-dot')).toBeNull();
    // The mocked layout output lands as sanitized SVG.
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  });

  it('also accepts the ```graphviz fence alias', async () => {
    const src = ['```graphviz', 'graph { a -- b }', '```', ''].join('\n');
    const { container } = render(<RenderedMarkdown source={src} />);
    await waitFor(() => expect(container.textContent).toContain('Graphviz'));
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  });
});
