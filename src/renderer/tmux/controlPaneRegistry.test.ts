// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneEntry } from './controlPaneRegistry';
import { mayReseed, parseAltScreenReply, recover, reseedPane } from './controlPaneRegistry';
import type { PaneRenderer } from './paneRenderer';

const h = vi.hoisted(() => ({ capturePane: vi.fn() }));
vi.mock('../providerClient', () => ({
  agentCockpit: { tmuxControl: { capturePane: h.capturePane } },
}));

afterEach(() => {
  h.capturePane.mockReset();
});

/** Decode a written Uint8Array (latin1 1:1) back to a string for assertions. */
const decode = (b: Uint8Array): string => String.fromCharCode(...b);

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

describe('controlPaneRegistry.reseedPane (destructive — normal-screen only)', () => {
  it('clears the buffer (ESC[3J ESC[2J ESC[H) then re-writes the captured content', async () => {
    const { entry, fitSpy, repaintSpy } = makeEntry();
    h.capturePane.mockResolvedValue(['line one', 'line two']);
    const writeSpy = entry.renderer.write as ReturnType<typeof vi.fn>;

    await reseedPane(entry);

    expect(h.capturePane).toHaveBeenCalledWith('%0', expect.any(Number));
    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect(decode(writeSpy.mock.calls[0]![0] as Uint8Array)).toBe('\x1b[3J\x1b[2J\x1b[H');
    expect(decode(writeSpy.mock.calls[1]![0] as Uint8Array)).toBe('line one\r\nline two\r\n');
    expect(fitSpy).toHaveBeenCalledTimes(1);
    expect(repaintSpy).toHaveBeenCalledTimes(1);
  });

  it('clears but does not re-write when the capture is all-blank', async () => {
    const { entry } = makeEntry();
    h.capturePane.mockResolvedValue(['', '   ']);
    const writeSpy = entry.renderer.write as ReturnType<typeof vi.fn>;

    await reseedPane(entry);

    expect(writeSpy).toHaveBeenCalledTimes(1); // CLEAR only
    expect(decode(writeSpy.mock.calls[0]![0] as Uint8Array)).toBe('\x1b[3J\x1b[2J\x1b[H');
  });
});

describe('hard-refresh gating', () => {
  it('parseAltScreenReply maps pane → alternate-screen flag, skipping junk', () => {
    const m = parseAltScreenReply(['%0 1', '%1 0', '  ', 'garbage', '%2 1']);
    expect(m.get('%0')).toBe(true);
    expect(m.get('%1')).toBe(false);
    expect(m.get('%2')).toBe(true);
    expect(m.get('garbage')).toBe(false); // a lone token parses as non-alternate
  });

  it('mayReseed is true ONLY for a positively normal-screen pane (safe default)', () => {
    expect(mayReseed(false)).toBe(true); // normal screen → re-seed allowed
    expect(mayReseed(true)).toBe(false); // alternate screen → never
    expect(mayReseed(undefined)).toBe(false); // unknown / query failed → never
  });
});
