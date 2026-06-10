/**
 * wterm implementation of {@link PaneRenderer} — @wterm/dom's DOM renderer driven
 * by the @wterm/ghostty (libghostty) VT core. DOM rendering means the browser's
 * font engine shapes/falls-back glyphs and snaps the monospace grid (so powerline/
 * nerd glyphs align, unlike a canvas reimplementation), with native selection/
 * find/clipboard for free.
 *
 * The same `CLAUDE.md` invariants apply as interface contracts:
 * - **Raw bytes (FR2):** `write(Uint8Array)` forwards bytes verbatim to
 *   `WTerm.write(Uint8Array)`; never UTF-8-decoded.
 * - **Async init (FR3):** `await term.init()` loads the WASM, so the terminal is
 *   not ready synchronously while the registry seeds/sinks immediately; writes,
 *   the onData handler, and focus issued before ready are buffered and flushed in
 *   order once `init()` resolves.
 * - **Theme (FR6):** the xterm `XTERM_THEMES` palette is mapped onto wterm's CSS
 *   custom properties (`--term-fg`/`--term-bg`/`--term-cursor`/`--term-color-0..15`
 *   + font vars) on the container.
 *
 * Sizing is left to wterm's own `autoResize` (its ResizeObserver + char
 * measurement) so it tracks the tmux-driven container size; the registry derives
 * its tmux cell metric from container/cols as it already does for the fallback.
 *
 * Known gaps (validated/refined at runtime — wterm 0.3.x): no OSC-8 hyperlink API
 * (links render as text), and no scrollback-limit setter (uses libghostty's
 * default ring buffer; the capture-pane seed still writes).
 */
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import { GhosttyCore } from '@wterm/ghostty';
import { fontStack, type AppSettings, type ThemeId } from '@shared/settings';
import { XTERM_THEMES } from '../../terminal/terminalRegistry';
import type { CellMetrics, PaneRenderer, PaneRendererOptions, RendererDisposable } from './index';

/** xterm `ITheme` field → wterm `--term-color-N` index. */
const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue',
  'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

/** Apply the xterm theme + font as wterm CSS custom properties on `el`. */
function applyThemeVars(el: HTMLElement, settings: AppSettings): void {
  const theme = XTERM_THEMES[settings.theme as ThemeId] as Record<string, string | undefined>;
  const set = (name: string, value: string | undefined): void => {
    if (value) el.style.setProperty(name, value);
  };
  set('--term-fg', theme.foreground);
  set('--term-bg', theme.background);
  set('--term-cursor', theme.cursor);
  ANSI_KEYS.forEach((key, i) => set(`--term-color-${i}`, theme[key]));
  el.style.setProperty('--term-font-family', fontStack(settings.fontFamily));
  el.style.setProperty('--term-font-size', `${settings.fontSize}px`);
}

export class WtermPaneRenderer implements PaneRenderer {
  readonly container: HTMLDivElement;
  private term: WTerm | null = null;
  private disposed = false;
  /** Bytes written before init() resolves; flushed in order on boot. */
  private readonly pendingWrites: Uint8Array[] = [];
  private dataHandler: ((data: string) => void) | null = null;
  private wantFocus = false;

  constructor(opts: PaneRendererOptions) {
    this.container = document.createElement('div');
    this.container.className = 'ac-term h-full w-full bg-bg';
    applyThemeVars(this.container, opts.settings);
    void this.boot();
  }

  private async boot(): Promise<void> {
    const core = await GhosttyCore.load(); // wasm via vite (new URL(import.meta.url))
    if (this.disposed) return;
    const term = new WTerm(this.container, {
      core,
      // wterm owns sizing via its ResizeObserver; it tracks the tmux-driven
      // container size and the registry reads cols/rows + a container/cols cell
      // metric from it (matching the xterm fallback path).
      autoResize: true,
      cursorBlink: true,
    });
    if (this.dataHandler) term.onData = this.dataHandler;
    await term.init();
    if (this.disposed) {
      term.destroy();
      return;
    }
    this.term = term;
    for (const bytes of this.pendingWrites) term.write(bytes);
    this.pendingWrites.length = 0;
    if (this.wantFocus) term.focus();
  }

  get cols(): number {
    return this.term?.cols ?? 0;
  }
  get rows(): number {
    return this.term?.rows ?? 0;
  }

  write(bytes: Uint8Array): void {
    if (this.term) this.term.write(bytes);
    else this.pendingWrites.push(bytes);
  }

  onData(handler: (data: string) => void): RendererDisposable {
    this.dataHandler = handler;
    if (this.term) this.term.onData = handler;
    return {
      dispose: () => {
        this.dataHandler = null;
        if (this.term) this.term.onData = null;
      },
    };
  }

  focus(): void {
    if (this.term) this.term.focus();
    else this.wantFocus = true;
  }

  onAttach(): void {
    // DOM survives reparenting; wterm's ResizeObserver refits when the container
    // gains size in the new host. Nothing to load/dispose (no GPU context).
  }

  onDetach(): void {
    // No GPU context to drop; the DOM subtree is preserved across reparenting.
  }

  fit(): void {
    // wterm `autoResize` handles fitting via its own ResizeObserver.
  }

  cellMetrics(): CellMetrics | null {
    // Let the registry derive the cell size from container/cols — accurate
    // because wterm sized cols to fit the container.
    return null;
  }

  applyAppearance(settings: AppSettings): void {
    applyThemeVars(this.container, settings);
  }

  repaintFromBuffer(): void {
    // wterm repaints from its own model via a per-frame dirty-row redraw, so DOM
    // corruption is not the GPU-atlas class xterm/WebGL had; nothing to force.
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.term?.destroy();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.container.remove();
  }
}
