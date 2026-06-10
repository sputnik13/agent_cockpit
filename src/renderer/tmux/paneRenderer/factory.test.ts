import { describe, expect, it, vi } from 'vitest';

// Mock both adapters so the factory can be tested without constructing real
// terminals (xterm DOM / wterm WASM). The fakes live in vi.hoisted so they exist
// when the hoisted vi.mock factories run.
const fakes = vi.hoisted(() => ({
  FakeXterm: class { kind = 'xterm'; },
  FakeWterm: class { kind = 'wterm'; },
}));
const { FakeXterm, FakeWterm } = fakes;
vi.mock('./xtermAdapter', () => ({ XtermPaneRenderer: fakes.FakeXterm }));
vi.mock('./wtermAdapter', () => ({ WtermPaneRenderer: fakes.FakeWterm }));

import { createPaneRenderer } from './index';
import { DEFAULT_SETTINGS, type TerminalRenderer } from '@shared/settings';

function make(terminalRenderer: TerminalRenderer): unknown {
  return createPaneRenderer({
    settings: { ...DEFAULT_SETTINGS, terminalRenderer },
    projectId: 'p1',
  });
}

describe('createPaneRenderer (terminalRenderer selector)', () => {
  it('selects the wterm adapter for terminalRenderer="wterm"', () => {
    expect(make('wterm')).toBeInstanceOf(FakeWterm);
  });

  it('selects the xterm adapter for dom and webgl (xterm family, default)', () => {
    expect(make('dom')).toBeInstanceOf(FakeXterm);
    expect(make('webgl')).toBeInstanceOf(FakeXterm);
  });
});
