// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Fakes for the WASM-backed wterm so the adapter's buffering, byte passthrough,
// and theming are testable without instantiating WASM.
const h = vi.hoisted(() => {
  class FakeWTerm {
    element: HTMLElement;
    cols = 80;
    rows = 24;
    onData: ((d: string) => void) | null = null;
    write = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    focus = vi.fn();
    destroy = vi.fn();
    init = vi.fn(async () => this);
    constructor(element: HTMLElement, opts: Record<string, unknown>) {
      this.element = element;
      instances.push({ term: this, opts });
    }
  }
  const instances: { term: FakeWTerm; opts: Record<string, unknown> }[] = [];
  const responses: string[] = [];
  return { FakeWTerm, instances, responses };
});
const instances = h.instances;

vi.mock('@wterm/dom', () => ({ WTerm: h.FakeWTerm }));
vi.mock('@wterm/dom/css', () => ({}));
vi.mock('@wterm/ghostty', () => ({
  GhosttyCore: {
    load: vi.fn(async () => ({
      kind: 'core',
      getScrollbackCount: () => 2,
      getScrollbackLineLen: (line: number) => (line === 0 ? 3 : 2),
      getScrollbackCell: (line: number, col: number) => ({
        char: line === 0 ? [65, 66, 32][col] : [67, 68][col],
      }),
      getResponse: () => h.responses.shift() ?? null,
      mouseTracking: () => 0,
    })),
  },
}));
vi.mock('../../terminal/xtermThemes', () => ({
  XTERM_THEMES: {
    'solarized-dark': {
      foreground: '#93a1a1',
      background: '#002b36',
      cursor: '#fff',
      black: '#073642',
      red: '#dc322f',
    },
    'solarized-light': {},
  },
}));

import { WtermPaneRenderer } from './wtermAdapter';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { TERMINAL_SCROLLBACK } from '@shared/tmux';

function make(): WtermPaneRenderer {
  return new WtermPaneRenderer({ settings: DEFAULT_SETTINGS, projectId: 'p1' });
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  instances.length = 0;
  h.responses.length = 0;
});

describe('WtermPaneRenderer', () => {
  it('maps the xterm theme onto wterm CSS custom properties on the container', () => {
    const r = make(); // applyThemeVars runs synchronously in the constructor
    expect(r.container.style.getPropertyValue('--term-fg')).toBe('#93a1a1');
    expect(r.container.style.getPropertyValue('--term-bg')).toBe('#002b36');
    expect(r.container.style.getPropertyValue('--term-cursor')).toBe('#fff');
    expect(r.container.style.getPropertyValue('--term-color-0')).toBe('#073642');
    expect(r.container.style.getPropertyValue('--term-color-1')).toBe('#dc322f');
  });

  it('boots WTerm with a libghostty core and Cockpit-owned resize lifecycle', async () => {
    make();
    expect(instances).toHaveLength(0); // not constructed synchronously
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.opts.core).toMatchObject({ kind: 'core' });
    expect(instances[0]!.opts.autoResize).toBe(false);
    expect(instances[0]!.term.init).toHaveBeenCalled();
    const { GhosttyCore } = await import('@wterm/ghostty');
    expect(GhosttyCore.load).toHaveBeenCalledWith({
      wasmPath: 'cockpit-wasm://ghostty-vt/ghostty-vt.wasm',
      scrollbackLimit: TERMINAL_SCROLLBACK,
    });
  });

  it('buffers writes issued before boot and flushes them verbatim, in order (FR2/FR3)', async () => {
    const r = make();
    const a = new Uint8Array([0x9b, 0x41]); // C1 CSI + A
    const b = new Uint8Array([0xe2, 0x94, 0x80]); // box-drawing UTF-8
    r.write(a);
    r.write(b);
    await flush();
    expect(instances[0]!.term.write.mock.calls.map((c) => c[0])).toEqual([a, b]);
  });

  it('writes straight through once booted', async () => {
    const r = make();
    await flush();
    const c = new Uint8Array([0x68, 0x69]);
    r.write(c);
    expect(instances[0]!.term.write).toHaveBeenLastCalledWith(c);
  });

  it('materializes bounded scrollback through the public GhosttyCore API', async () => {
    const r = make();
    await flush();
    expect(r.scrollbackLines(0, 1)).toEqual(['AB']);
    expect(r.scrollbackLines(1, 2)).toEqual(['CD']);
  });

  it('wires an onData handler registered before boot', async () => {
    const r = make();
    const handler = vi.fn();
    r.onData(handler);
    await flush();
    expect(instances[0]!.term.onData).toBeTypeOf('function');
    instances[0]!.term.onData?.('typed');
    expect(handler).toHaveBeenCalledWith('typed');
  });

  it('separates a Ghostty capability reply from user input before mux dispatch', async () => {
    const r = make();
    const input = vi.fn();
    const reply = vi.fn();
    r.onData(input);
    r.onReply(reply);
    await flush();

    instances[0]!.term.onData?.('typed');
    h.responses.push('\u001b[?1;2c', '\u001bP1+r0m\u001b\\');
    r.write(new Uint8Array([0x1b, 0x5b, 0x63]));

    expect(input).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledWith('typed');
    expect(reply).toHaveBeenNthCalledWith(1, '\u001b[?1;2c');
    expect(reply).toHaveBeenNthCalledWith(2, '\u001bP1+r0m\u001b\\');
  });

  it('classifies WTerm’s synchronous parser reply as a mux reply, not keyboard input', async () => {
    const r = make();
    const input = vi.fn();
    const reply = vi.fn();
    r.onData(input);
    r.onReply(reply);
    await flush();

    // WTerm itself calls its combined onData callback while write() drains a
    // parser response. The adapter must retain the host-output provenance at
    // that synchronous boundary; draining GhosttyCore afterward is too late.
    instances[0]!.term.write.mockImplementationOnce(() => {
      instances[0]!.term.onData?.('\u001b[?1;2c');
    });
    r.write(new Uint8Array([0x1b, 0x5b, 0x63]));

    expect(reply).toHaveBeenCalledWith('\u001b[?1;2c');
    expect(input).not.toHaveBeenCalled();
  });

  it('drains a capability-reply burst larger than WTerm’s deferred poll budget', async () => {
    const r = make();
    const input = vi.fn();
    const reply = vi.fn();
    r.onData(input);
    r.onReply(reply);
    await flush();

    const first = `\u001bP1+r${'a'.repeat(4_096)}\u001b\\`;
    const second = `\u001bP1+r${'b'.repeat(768)}\u001b\\`;
    h.responses.push(first, second);
    r.write(new Uint8Array([0x1b, 0x5b, 0x63]));

    expect(reply).toHaveBeenNthCalledWith(1, first);
    expect(reply).toHaveBeenNthCalledWith(2, second);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(input).not.toHaveBeenCalled();
  });

  it('drains replies when WTerm reports a resize', async () => {
    const r = make();
    const reply = vi.fn();
    r.onReply(reply);
    await flush();

    h.responses.push('\u001b[8;24;80t');
    (instances[0]!.opts.onResize as (cols: number, rows: number) => void)(80, 24);

    expect(reply).toHaveBeenCalledWith('\u001b[8;24;80t');
  });

  it('emits a mode-2048 in-band report only after Cockpit commits a changed WTerm grid', async () => {
    const r = make();
    const reply = vi.fn();
    r.onReply(reply);
    await flush();

    // Split the enable sequence across raw PTY chunks to prove the tracker is
    // framing-safe. Enabling receives the current size immediately.
    r.write(new Uint8Array([0x1b, 0x5b, 0x3f, 0x32]));
    r.write(new Uint8Array([0x30, 0x34, 0x38, 0x68]));
    expect(reply).toHaveBeenLastCalledWith('\u001b[48;24;80;0;0t');

    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
    });
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;
    instances[0]!.term.cols = 80;
    instances[0]!.term.rows = 24;
    r.fit();
    HTMLSpanElement.prototype.getBoundingClientRect = original;

    // fit updates the grid but waits for the registry's successful PTY resize.
    expect(reply).toHaveBeenCalledTimes(1);
    instances[0]!.term.cols = 10;
    instances[0]!.term.rows = 3;
    r.geometryCommitted();
    expect(reply).toHaveBeenLastCalledWith('\u001b[48;3;10;0;0t');

    r.write(new Uint8Array([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x34, 0x38, 0x6c]));
    r.geometryCommitted();
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('tracks grouped DECSET/DECRST and RIS so in-band resize replies match Ghostty mode state', async () => {
    const r = make();
    const reply = vi.fn();
    r.onReply(reply);
    await flush();

    // Full-screen programs often enable bracketed paste and in-band resize in
    // one DECSET.
    r.write(
      new Uint8Array([
        0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x3b, 0x32, 0x30, 0x34, 0x38, 0x68,
      ]),
    );
    expect(reply).toHaveBeenLastCalledWith('\u001b[48;24;80;0;0t');

    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
    });
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;
    r.fit();
    // The fake resize spy does not update its grid fields as real WTerm does.
    instances[0]!.term.cols = 10;
    instances[0]!.term.rows = 3;
    r.geometryCommitted();
    expect(reply).toHaveBeenLastCalledWith('\u001b[48;3;10;0;0t');

    // RIS resets private modes.  A later fit must not manufacture a stale
    // geometry response after an application resets its terminal.
    r.write(new Uint8Array([0x1b, 0x63]));
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 80 },
      clientHeight: { configurable: true, value: 40 },
    });
    r.fit();
    r.geometryCommitted();
    expect(reply).toHaveBeenCalledTimes(2);
    HTMLSpanElement.prototype.getBoundingClientRect = original;

    r.write(
      new Uint8Array([
        0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x30, 0x34, 0x3b, 0x32, 0x30, 0x34, 0x38, 0x6c,
      ]),
    );
    r.geometryCommitted();
    expect(reply).toHaveBeenCalledTimes(2);
  });

  it('does not mistake UTF-8 continuation bytes for a Ghostty DECSET control', async () => {
    const r = make();
    const reply = vi.fn();
    r.onReply(reply);
    await flush();

    // U+011B encodes as c4 9b.  Ghostty treats this as ordinary text; a raw
    // byte scanner must not enable in-band resize merely because 9b precedes
    // text that resembles a private-mode sequence.
    r.write(new TextEncoder().encode('\u011b?2048h'));
    r.geometryCommitted();

    expect(reply).not.toHaveBeenCalled();
  });

  it('focuses after boot when focus() was called early', async () => {
    const r = make();
    r.focus();
    await flush();
    expect(instances[0]!.term.focus).toHaveBeenCalled();
  });

  it('requests a public render without reconstructing the grid', async () => {
    const r = make();
    await flush();

    r.repaintFromBuffer();

    expect(instances[0]!.term.write).toHaveBeenCalledWith(new Uint8Array());
    expect(instances[0]!.term.resize).not.toHaveBeenCalled();
  });

  it('does not reconstruct retained rows when a hidden mux window becomes visible again', async () => {
    const r = make();
    await flush();
    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
    });
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;

    // Visibility changes retain the same WTerm container and core. Reattaching
    // may observe geometry, but must not turn it into a same-size grid rebuild.
    r.onAttach();
    r.fit();
    instances[0]!.term.resize.mockClear();
    r.onAttach();
    r.fit();

    expect(instances[0]!.term.resize).not.toHaveBeenCalled();
    HTMLSpanElement.prototype.getBoundingClientRect = original;
  });

  it('fits from its visible host without observing detached zero-size containers', async () => {
    const r = make();
    await flush();
    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
    });
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;

    r.fit();

    expect(instances[0]!.term.resize).toHaveBeenCalledWith(10, 3);
    HTMLSpanElement.prototype.getBoundingClientRect = original;
  });

  it('leaves reader viewport ownership to WTerm through reattachment and output', async () => {
    const r = make();
    let scrollTop = 10;
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value) => {
          scrollTop = value;
        },
      },
    });
    document.body.append(r.container);
    await flush();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // A reader position is an explicit scroll event, not merely a test fixture
    // assigning scrollTop. The adapter must preserve that intent through
    // reattachment and subsequent output.
    scrollTop = 10;
    r.container.dispatchEvent(new Event('scroll'));

    r.onDetach();
    r.onAttach();
    r.write(new Uint8Array([65]));

    expect(scrollTop).toBe(10);
    r.dispose();
  });

  it('preserves the reader anchor across WTerm DOM reconstruction during a layout resize', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const r = make();
    await flush();
    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    let scrollTop = 20;
    let scrollHeight = 500;
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value) => {
          scrollTop = value;
        },
      },
    });
    document.body.append(r.container);
    r.container.dispatchEvent(new Event('scroll'));
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;

    r.fit();
    // WTerm clears its grid while reconstructing it. The browser reports that
    // transient top position as a scroll event, but it must not erase reader
    // intent before the anchor restoration frame runs.
    scrollTop = 0;
    scrollHeight = 1_000;
    r.container.dispatchEvent(new Event('scroll'));
    while (frames.length) frames.shift()?.(0);

    // The public Ghostty line anchor wins over the stale pixel distance (which
    // would otherwise restore to 520 after the virtual height changes).
    expect(scrollTop).toBe(20);
    HTMLSpanElement.prototype.getBoundingClientRect = original;
    r.dispose();
    vi.unstubAllGlobals();
  });

  it('preserves live-tail intent across WTerm’s synthetic resize scroll', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const r = make();
    await flush();
    // Drain the initial boot tail request before giving this fixture real DOM
    // geometry; the resize path below must own the frame sequence under test.
    while (frames.length) frames.shift()?.(0);

    const row = document.createElement('div');
    row.className = 'term-row';
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ width: 100, height: 20 }),
    });
    r.container.append(row);
    let scrollTop = 440;
    let scrollHeight = 500;
    Object.defineProperties(r.container, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 60 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value) => {
          scrollTop = value;
        },
      },
    });
    document.body.append(r.container);
    r.container.dispatchEvent(new Event('scroll'));
    instances[0]!.term.resize.mockImplementation((cols: number, rows: number) => {
      instances[0]!.term.cols = cols;
      instances[0]!.term.rows = rows;
      // This is the browser event WTerm emits as its resized virtual grid
      // starts at offset zero. It must not be interpreted as user scrollback.
      scrollTop = 0;
      scrollHeight = 1_000;
      r.container.dispatchEvent(new Event('scroll'));
    });
    const original = HTMLSpanElement.prototype.getBoundingClientRect;
    HTMLSpanElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 20 }) as DOMRect;

    r.fit();
    while (frames.length) frames.shift()?.(0);

    expect(scrollTop).toBe(940);
    expect((r as unknown as { followsLiveOutput: boolean }).followsLiveOutput).toBe(true);
    HTMLSpanElement.prototype.getBoundingClientRect = original;
    r.dispose();
    vi.unstubAllGlobals();
  });

  it('preserves ordinary browser wheel scrolling unless the terminal enables mouse tracking', async () => {
    const r = make();
    const wtermWheelHandler = vi.fn((event: WheelEvent) => event.preventDefault());
    r.container.addEventListener('wheel', wtermWheelHandler);
    await flush();

    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
    r.container.dispatchEvent(event);

    expect(wtermWheelHandler).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect((r as unknown as { followsLiveOutput: boolean }).followsLiveOutput).toBe(false);
    r.dispose();
  });

  it('dispose before boot prevents the terminal from being constructed', async () => {
    const r = make();
    r.dispose();
    await flush();
    expect(instances).toHaveLength(0);
  });
});
