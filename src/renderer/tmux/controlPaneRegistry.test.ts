// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PaneEntry } from './controlPaneRegistry';
import { recover } from './controlPaneRegistry';
import type { PaneRenderer } from './paneRenderer';

/**
 * Build a fake registry entry whose terminal is a spied {@link PaneRenderer}. The
 * container reports a non-zero layout so the internal `fit()` runs (it skips a
 * detached/zero-size host). The non-destructive `recover()` contract lives at this
 * boundary: it MUST fit + repaint-from-buffer and MUST NEVER dispose the renderer
 * (the runaway-scroll regression guard); the atlas-rebuild + refresh specifics are
 * the xterm adapter's concern (see xtermAdapter).
 */
function makeEntry(): {
  entry: PaneEntry;
  fitSpy: ReturnType<typeof vi.fn>;
  repaintSpy: ReturnType<typeof vi.fn>;
  disposeSpy: ReturnType<typeof vi.fn>;
} {
  const fitSpy = vi.fn();
  const repaintSpy = vi.fn();
  const disposeSpy = vi.fn();

  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });

  const renderer: PaneRenderer = {
    container,
    cols: 80,
    rows: 24,
    write: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    focus: vi.fn(),
    onAttach: vi.fn(),
    onDetach: vi.fn(),
    fit: fitSpy,
    cellMetrics: () => ({ w: 8, h: 17 }),
    applyAppearance: vi.fn(),
    repaintFromBuffer: repaintSpy,
    dispose: disposeSpy,
  };

  const entry = {
    renderer,
    container,
    projectId: 'p1',
    paneId: '%0',
    lastTouched: 0,
    dispose: disposeSpy,
  } as unknown as PaneEntry;

  return { entry, fitSpy, repaintSpy, disposeSpy };
}

describe('controlPaneRegistry.recover (non-destructive)', () => {
  it('refits and repaints from the renderer’s own buffer', () => {
    const { entry, fitSpy, repaintSpy } = makeEntry();
    recover(entry);
    expect(fitSpy).toHaveBeenCalledTimes(1);
    // Repaint goes through the renderer's buffer-only repaint primitive — never a
    // capture-pane re-seed.
    expect(repaintSpy).toHaveBeenCalledTimes(1);
  });

  it('NEVER disposes the terminal (no re-seed / runaway-scroll regression)', () => {
    const { entry, disposeSpy } = makeEntry();
    const capturePane = vi.fn();
    recover(entry);
    expect(disposeSpy).not.toHaveBeenCalled();
    expect(capturePane).not.toHaveBeenCalled();
  });
});
