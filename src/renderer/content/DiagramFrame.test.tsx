// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { DiagramFrame } from './DiagramFrame';

const HEIGHT_KEY = 'ac:diagramHeight';

/** Controls what every element reports as its own natural height for the
 *  duration of a test — jsdom never lays anything out for real, so the
 *  auto-size effect (which reads `contentRef.current.getBoundingClientRect()
 *  .height`) needs a stand-in. Other DiagramFrame call sites also read
 *  `getBoundingClientRect` (e.g. the wheel-zoom handler), but none of those
 *  paths run in these tests. */
let stubHeight = 0;

beforeEach(() => {
  // This runner's jsdom lacks a working localStorage; provide a fresh
  // in-memory one (same pattern as beads.test.tsx) so the persisted-override
  // read/write path behaves like the real app.
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  });
  stubHeight = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        height: stubHeight,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function frame(label = 'Mermaid', renderKey = 'k') {
  const doRender = async () => '<svg><text>node</text></svg>';
  return render(<DiagramFrame label={label} source="a --> b" render={doRender} renderKey={renderKey} />);
}

/** The viewport div is the one with the inline `height` style (its sibling,
 *  the content div, has no inline height — it sizes to its own content). */
function viewportHeight(container: HTMLElement): number {
  const el = container.querySelector('div[style*="height"]') as HTMLElement;
  return Number(el.style.height.replace('px', ''));
}

describe('DiagramFrame — content-based auto-sizing', () => {
  it('auto-sizes the viewport to the diagram’s own natural rendered height when no override is stored', async () => {
    stubHeight = 220;
    const { container } = frame();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    await waitFor(() => expect(viewportHeight(container)).toBe(220));
  });

  it('caps auto-sizing at AUTO_MAX_HEIGHT for a diagram taller than the cap', async () => {
    stubHeight = 5000;
    const { container } = frame();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    await waitFor(() => expect(viewportHeight(container)).toBe(600));
  });

  it('floors auto-sizing at MIN_HEIGHT for a tiny diagram', async () => {
    stubHeight = 40;
    const { container } = frame();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    await waitFor(() => expect(viewportHeight(container)).toBe(160));
  });

  it('does NOT persist anything to localStorage merely from auto-sizing', async () => {
    stubHeight = 220;
    const { container } = frame();
    await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
    await waitFor(() => expect(viewportHeight(container)).toBe(220));
    expect(localStorage.getItem(HEIGHT_KEY)).toBeNull();
  });

  it('a manual resize establishes a persisted override that a freshly-mounted diagram picks up instead of auto-sizing', async () => {
    stubHeight = 220;
    const first = frame('Mermaid', 'k1');
    await waitFor(() => expect(first.container.querySelector('svg')).not.toBeNull());
    await waitFor(() => expect(viewportHeight(first.container)).toBe(220));

    const handle = first.container.querySelector('[title="Drag to resize"]') as HTMLElement;
    fireEvent.pointerDown(handle, { clientY: 0 });
    fireEvent.pointerMove(handle, { clientY: 150 }); // drag down 150px -> 220 + 150 = 370
    fireEvent.pointerUp(handle);
    expect(viewportHeight(first.container)).toBe(370);
    expect(localStorage.getItem(HEIGHT_KEY)).toBe('370');

    // A second, independent diagram instance — even though ITS own natural
    // content height differs (40px) — starts from the persisted override,
    // not from auto-sizing to its own (much smaller) content.
    stubHeight = 40;
    const second = frame('Graphviz', 'k2');
    await waitFor(() => expect(second.container.querySelector('svg')).not.toBeNull());
    expect(viewportHeight(second.container)).toBe(370);
  });

  it('re-measures and re-auto-sizes when the diagram content changes (renderKey changes), while no override is set', async () => {
    stubHeight = 200;
    const { container, rerender } = frame('Mermaid', 'k1');
    await waitFor(() => expect(viewportHeight(container)).toBe(200));

    stubHeight = 300;
    const doRender = async () => '<svg><text>bigger</text></svg>';
    rerender(<DiagramFrame label="Mermaid" source="a --> b --> c" render={doRender} renderKey="k2" />);
    await waitFor(() => expect(viewportHeight(container)).toBe(300));
  });
});
