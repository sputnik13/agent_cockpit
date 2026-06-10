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
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    focus = vi.fn();
    refresh = vi.fn();
    clearTextureAtlas = vi.fn();
    loadAddon = vi.fn();
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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit = vi.fn(); } }));
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

const settings = vi.hoisted(() => ({ value: { terminalRenderer: 'dom' } as { terminalRenderer: string } }));
vi.mock('../../settings', () => ({
  useSettingsStore: { getState: () => ({ settings: settings.value }) },
}));

import { XtermPaneRenderer } from './xtermAdapter';
import { DEFAULT_SETTINGS } from '@shared/settings';

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
    expect(t.options.scrollback).toBe(5000);
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

  it('repaintFromBuffer() clears the atlas and refreshes the full viewport (no re-seed)', () => {
    const r = make();
    const t = termInstances[0]!;
    r.repaintFromBuffer();
    expect(t.clearTextureAtlas).toHaveBeenCalled();
    expect(t.refresh).toHaveBeenCalledWith(0, t.rows - 1);
  });

  it('onAttach loads WebGL only when terminalRenderer === webgl', () => {
    // dom: onAttach adds no addon (the FitAddon was loaded in the ctor).
    const r = make();
    const t = termInstances[0]!;
    const domBefore = t.loadAddon.mock.calls.length;
    r.onAttach();
    expect(t.loadAddon.mock.calls.length).toBe(domBefore);

    // webgl: onAttach loads exactly one more addon (the WebglAddon).
    settings.value = { terminalRenderer: 'webgl' };
    const r2 = make();
    const t2 = termInstances[1]!;
    const webglBefore = t2.loadAddon.mock.calls.length;
    r2.onAttach();
    expect(t2.loadAddon.mock.calls.length).toBe(webglBefore + 1);
  });
});
