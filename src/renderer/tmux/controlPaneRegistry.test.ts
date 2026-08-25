// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneEntry } from './controlPaneRegistry';
import {
  acquire,
  disposeAll,
  hardRecoverTab,
  mayReseed,
  parseAltScreenReply,
  recover,
  recoverTab,
  reseedPane,
  stopReaper,
} from './controlPaneRegistry';
import type { PaneRenderer } from './paneRenderer';
import { emptyView, useTmuxStore } from './tmuxStore';
import type { LayoutNode } from '@shared/tmux';

const h = vi.hoisted(() => ({ capturePane: vi.fn(), command: vi.fn() }));
vi.mock('../providerClient', () => ({
  agentCockpit: { tmuxControl: { capturePane: h.capturePane, command: h.command } },
}));

// A fresh, fully-spied fake PaneRenderer per acquire() call — real xterm.js
// construction is unnecessary for testing the registry's own iteration/
// dispatch logic (recoverTab/hardRecoverTab), and a fake keeps each acquired
// entry's fit/repaintFromBuffer/write independently assertable, mirroring the
// hand-built fakes `makeEntry()` already uses for the single-entry tests below.
vi.mock('./paneRenderer', () => ({
  createPaneRenderer: (): PaneRenderer => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true });
    return {
      container,
      cols: 80,
      rows: 24,
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      focus: vi.fn(),
      onAttach: vi.fn(),
      onDetach: vi.fn(),
      fit: vi.fn(),
      cellMetrics: () => ({ w: 8, h: 17 }),
      applyAppearance: vi.fn(),
      repaintFromBuffer: vi.fn(),
      dispose: vi.fn(),
    };
  },
}));

afterEach(() => {
  h.capturePane.mockReset();
  h.command.mockReset();
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

// Coverage gap flagged by the bvni diagnosis: recoverTab/hardRecoverTab's
// multi-pane iteration had ZERO prior coverage (only the single-entry
// recover()/reseedPane() primitives were tested), which is exactly what let
// the "refresh only fixes the first pane" bug ship undetected. These tests
// register 2+ REAL entries via the actual acquire() registration path (the
// only way to populate the registry's module-private `entries` map) and
// assert each entry's renderer methods actually fired — not just that the
// loop's source (the layout tree) iterates correctly.
describe('recoverTab / hardRecoverTab (multi-pane iteration — local_repo_explorer-bvni)', () => {
  const PROJ = 'p-multi';
  const WIN = '@0';

  /** A 2-leaf top/bottom split, matching the topology the diagnosis found the
   *  refresh-only-first-pane bug on. */
  const twoLeafLayout = (): LayoutNode => ({
    type: 'split',
    dir: 'tb',
    w: 80,
    h: 48,
    x: 0,
    y: 0,
    children: [
      { type: 'leaf', paneId: '%0', w: 80, h: 24, x: 0, y: 0 },
      { type: 'leaf', paneId: '%1', w: 80, h: 23, x: 0, y: 25 },
    ],
  });

  function seedLayout(projectId: string, windowId: string, layout: LayoutNode): void {
    useTmuxStore.setState((st) => ({
      byProject: {
        ...st.byProject,
        [projectId]: {
          ...(st.byProject[projectId] ?? emptyView()),
          windows: {
            ...(st.byProject[projectId]?.windows ?? {}),
            [windowId]: { windowId, name: windowId, layout, isZoomed: false, visibleLayout: layout },
          },
        },
      },
    }));
  }

  beforeEach(() => {
    useTmuxStore.getState().reset();
    h.command.mockReset();
    h.command.mockResolvedValue({ num: 1, error: false, lines: [] });
    h.capturePane.mockReset();
    h.capturePane.mockResolvedValue([]); // blank by default so acquire()'s ambient backfill never writes
  });
  afterEach(() => {
    disposeAll();
    stopReaper();
  });

  it('recoverTab fits + repaints EVERY registered pane in a 2-leaf layout, not just one', () => {
    seedLayout(PROJ, WIN, twoLeafLayout());
    const e0 = acquire(PROJ, '%0');
    const e1 = acquire(PROJ, '%1');

    recoverTab(PROJ, WIN);

    expect(e0.renderer.fit).toHaveBeenCalledTimes(1);
    expect(e0.renderer.repaintFromBuffer).toHaveBeenCalledTimes(1);
    expect(e1.renderer.fit).toHaveBeenCalledTimes(1);
    expect(e1.renderer.repaintFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('hardRecoverTab reseeds the normal-screen pane and repaint-onlys the alt-screen pane — every pane touched', async () => {
    seedLayout(PROJ, WIN, twoLeafLayout());
    const e0 = acquire(PROJ, '%0');
    const e1 = acquire(PROJ, '%1');
    // Let acquire()'s own ambient capture-pane backfill settle (blank content,
    // so it writes nothing) BEFORE reconfiguring the mocks for the explicit
    // hardRecoverTab call below — otherwise the ambient backfill's write()
    // would pollute the reseed-vs-repaint-only assertions.
    await vi.waitFor(() => expect(h.capturePane).toHaveBeenCalledTimes(2));
    expect(e0.renderer.write).not.toHaveBeenCalled();
    expect(e1.renderer.write).not.toHaveBeenCalled();

    // %0 is on the normal screen (safe to re-seed); %1 is alternate (a live
    // TUI — must never be re-seeded, only repainted, per the runaway-scroll
    // guardrail).
    h.command.mockImplementation(async (args: string) =>
      args.startsWith('list-panes')
        ? { num: 1, error: false, lines: ['%0 0', '%1 1'] }
        : { num: 1, error: false, lines: [] },
    );
    h.capturePane.mockReset();
    h.capturePane.mockResolvedValue(['line one', 'line two']);

    await hardRecoverTab(PROJ, WIN);

    // %0: destructively re-seeded — CLEAR write + content write, plus the
    // trailing fit/repaint reseedPane always performs.
    expect(e0.renderer.write).toHaveBeenCalledTimes(2);
    expect(e0.renderer.fit).toHaveBeenCalledTimes(1);
    expect(e0.renderer.repaintFromBuffer).toHaveBeenCalledTimes(1);

    // %1: alternate screen — never re-seeded, but still touched (repaint-only,
    // the non-destructive path).
    expect(e1.renderer.write).not.toHaveBeenCalled();
    expect(e1.renderer.fit).toHaveBeenCalledTimes(1);
    expect(e1.renderer.repaintFromBuffer).toHaveBeenCalledTimes(1);
  });

  it('a second concurrent hardRecoverTab for the SAME window is a no-op, not an interleaved double re-seed', async () => {
    seedLayout(PROJ, WIN, { type: 'leaf', paneId: '%0', w: 80, h: 24, x: 0, y: 0 });
    const e0 = acquire(PROJ, '%0');
    await vi.waitFor(() => expect(h.capturePane).toHaveBeenCalledTimes(1));

    h.command.mockImplementation(async (args: string) =>
      args.startsWith('list-panes') ? { num: 1, error: false, lines: ['%0 0'] } : { num: 1, error: false, lines: [] },
    );
    // A capture-pane that never resolves on its own — the first call is left
    // deliberately in flight so a second call has something to race against.
    let resolveCapture: (lines: string[]) => void = () => {};
    h.capturePane.mockReset();
    h.capturePane.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapture = resolve;
        }),
    );

    const first = hardRecoverTab(PROJ, WIN);
    const second = hardRecoverTab(PROJ, WIN); // fires synchronously — bails on the guard `first` already set
    await second; // resolves immediately: it never awaits anything

    // Let `first` actually progress past list-panes into reseedPane/capturePane
    // before resolving it — otherwise `resolveCapture` would still be the
    // stale no-op from before capturePane was ever called.
    await vi.waitFor(() => expect(h.capturePane).toHaveBeenCalledTimes(1));
    resolveCapture(['line one']);
    await first;

    // Exactly ONE capture-pane round trip and ONE re-seed write pair — the
    // second call bailed immediately on the in-flight guard instead of
    // independently re-querying/re-seeding the same pane.
    expect(h.capturePane).toHaveBeenCalledTimes(1);
    expect(e0.renderer.write).toHaveBeenCalledTimes(2); // CLEAR + content, once

    // The guard clears once the call settles: a THIRD call afterward runs
    // normally (not permanently stuck).
    h.capturePane.mockReset();
    h.capturePane.mockResolvedValue(['line two']);
    await hardRecoverTab(PROJ, WIN);
    expect(h.capturePane).toHaveBeenCalledTimes(1);
  });
});
