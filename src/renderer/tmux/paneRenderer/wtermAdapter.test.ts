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
    resize = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    init = vi.fn(async () => this);
    constructor(element: HTMLElement, opts: Record<string, unknown>) {
      this.element = element;
      instances.push({ term: this, opts });
    }
  }
  const instances: { term: FakeWTerm; opts: Record<string, unknown> }[] = [];
  return { FakeWTerm, instances };
});
const instances = h.instances;

vi.mock('@wterm/dom', () => ({ WTerm: h.FakeWTerm }));
vi.mock('@wterm/dom/css', () => ({}));
vi.mock('@wterm/ghostty', () => ({ GhosttyCore: { load: vi.fn(async () => ({ kind: 'core' })) } }));
vi.mock('../../terminal/terminalRegistry', () => ({
  XTERM_THEMES: {
    'solarized-dark': { foreground: '#93a1a1', background: '#002b36', cursor: '#fff', black: '#073642', red: '#dc322f' },
    'solarized-light': {},
  },
}));

import { WtermPaneRenderer } from './wtermAdapter';
import { DEFAULT_SETTINGS } from '@shared/settings';

function make(): WtermPaneRenderer {
  return new WtermPaneRenderer({ settings: DEFAULT_SETTINGS, projectId: 'p1' });
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  instances.length = 0;
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

  it('boots WTerm with a libghostty core + autoResize (after WASM load)', async () => {
    make();
    expect(instances).toHaveLength(0); // not constructed synchronously
    await flush();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.opts.core).toEqual({ kind: 'core' });
    expect(instances[0]!.opts.autoResize).toBe(true);
    expect(instances[0]!.term.init).toHaveBeenCalled();
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

  it('wires an onData handler registered before boot', async () => {
    const r = make();
    const handler = vi.fn();
    r.onData(handler);
    await flush();
    expect(instances[0]!.term.onData).toBe(handler);
  });

  it('focuses after boot when focus() was called early', async () => {
    const r = make();
    r.focus();
    await flush();
    expect(instances[0]!.term.focus).toHaveBeenCalled();
  });

  it('dispose before boot prevents the terminal from being constructed', async () => {
    const r = make();
    r.dispose();
    await flush();
    expect(instances).toHaveLength(0);
  });
});
