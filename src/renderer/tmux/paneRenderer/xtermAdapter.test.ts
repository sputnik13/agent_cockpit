// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy/irrelevant modules so we can assert the adapter's contract
// against a fake xterm Terminal. @shared/* stays real. The fake + its instance
// log live in vi.hoisted so they exist when the hoisted vi.mock factory runs.
const h = vi.hoisted(() => {
  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    write = vi.fn();
    dataHandler: ((data: string) => void) | null = null;
    coreService = {
      triggerDataEvent: vi.fn((data: string, _wasUserInput = false) => {
        this.dataHandler?.(data);
      }),
    };
    _core = { coreService: this.coreService };
    onData = vi.fn((handler: (data: string) => void) => {
      this.dataHandler = handler;
      return {
        dispose: vi.fn(() => {
          this.dataHandler = null;
        }),
      };
    });
    focus = vi.fn();
    scrollToBottom = vi.fn();
    refresh = vi.fn();
    clearTextureAtlas = vi.fn();
    loadAddon = vi.fn();
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    open = vi.fn();
    dispose = vi.fn();
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      termInstances.push(this);
    }
  }
  const termInstances: FakeTerminal[] = [];
  return { FakeTerminal, termInstances };
});
const termInstances = h.termInstances;

vi.mock('@xterm/xterm', () => ({ Terminal: h.FakeTerminal }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss = vi.fn();
    clearTextureAtlas = vi.fn();
    dispose = vi.fn();
  },
}));
vi.mock('../../terminal/terminalRegistry', () => ({
  XTERM_THEMES: { 'solarized-dark': { background: '#002b36' }, 'solarized-light': {} },
}));
vi.mock('../oscLinkHandler', () => ({ createOscLinkHandler: vi.fn(() => ({})) }));

const settings = vi.hoisted(() => ({
  value: { terminalRenderer: 'dom' } as { terminalRenderer: string },
}));
vi.mock('../../settings', () => ({
  useSettingsStore: { getState: () => ({ settings: settings.value }) },
}));

import { XtermPaneRenderer } from './xtermAdapter';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { TERMINAL_SCROLLBACK } from '@shared/tmux/scrollback';

function make(): XtermPaneRenderer {
  return new XtermPaneRenderer({ settings: DEFAULT_SETTINGS, projectId: 'p1' });
}

afterEach(() => {
  termInstances.length = 0;
  settings.value = { terminalRenderer: 'dom' };
});

describe('XtermPaneRenderer', () => {
  it('constructs with TERMINAL_SCROLLBACK and opens into its container', () => {
    const r = make();
    const t = termInstances[0]!;
    expect(t.options.scrollback).toBe(TERMINAL_SCROLLBACK);
    expect(t.open).toHaveBeenCalledWith(r.container);
  });

  it('write() forwards the Uint8Array verbatim (raw-byte invariant)', () => {
    const r = make();
    const t = termInstances[0]!;
    const bytes = new Uint8Array([0x9b, 0xe2, 0x94, 0x80]); // C1 CSI + a box-drawing UTF-8 lead
    r.write(bytes);
    expect(t.write).toHaveBeenCalledTimes(1);
    expect(t.write.mock.calls[0]![0]).toBe(bytes); // same reference, not re-encoded
  });

  it('keeps keyboard input separate from terminal-generated replies', async () => {
    const r = make();
    const t = termInstances[0]!;
    const input = vi.fn();
    const reply = vi.fn();
    r.onData(input);
    const replySub = r.onReply(reply);

    await expect(r.ready()).resolves.toBeUndefined();
    // Modified F3 remains browser input even though it resembles a reply.
    t.coreService.triggerDataEvent('\x1b[1;2R', true);
    expect(input).toHaveBeenCalledWith('\x1b[1;2R');
    expect(reply).not.toHaveBeenCalled();

    // Rapid keyboard input remains input; classification occurs at the exact
    // core dispatch call rather than through an asynchronously drained queue.
    t.coreService.triggerDataEvent('a', true);
    t.coreService.triggerDataEvent('b', true);
    expect(input).toHaveBeenNthCalledWith(2, 'a');
    expect(input).toHaveBeenNthCalledWith(3, 'b');
    expect(reply).not.toHaveBeenCalled();

    // Parser replies carry wasUserInput=false and must never enter the input
    // path: a broadcast-enabled mux pane would otherwise replicate them.
    t.coreService.triggerDataEvent('\x1b[?1;2$y', false);
    expect(reply).toHaveBeenCalledWith('\x1b[?1;2$y');
    expect(input).toHaveBeenCalledTimes(3);

    replySub.dispose();
    t.coreService.triggerDataEvent('\x1b[?1;2$y', false);
    expect(input).toHaveBeenCalledTimes(3);
  });

  it('repaintFromBuffer() clears the atlas and refreshes the full viewport (no re-seed)', () => {
    const r = make();
    const t = termInstances[0]!;
    r.repaintFromBuffer();
    expect(t.clearTextureAtlas).toHaveBeenCalled();
    expect(t.refresh).toHaveBeenCalledWith(0, t.rows - 1);
  });

  it('onAttach repaints the retained buffer without changing its viewport', () => {
    // dom: onAttach adds no addon (the FitAddon was loaded in the ctor), but
    // always refreshes the retained terminal after reparenting.
    const r = make();
    const t = termInstances[0]!;
    const domBefore = t.loadAddon.mock.calls.length;
    r.onAttach();
    expect(t.loadAddon.mock.calls.length).toBe(domBefore);
    expect(t.scrollToBottom).not.toHaveBeenCalled();
    expect(t.refresh).toHaveBeenCalledWith(0, t.rows - 1);

    // webgl: onAttach loads exactly one more addon (the WebglAddon).
    settings.value = { terminalRenderer: 'webgl' };
    const r2 = make();
    const t2 = termInstances[1]!;
    const webglBefore = t2.loadAddon.mock.calls.length;
    r2.onAttach();
    expect(t2.loadAddon.mock.calls.length).toBe(webglBefore + 1);
  });

});
