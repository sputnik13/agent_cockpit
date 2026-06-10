/**
 * xterm.js implementation of {@link PaneRenderer}. This is the original
 * control-mode terminal behavior, lifted verbatim out of `controlPaneRegistry`
 * and put behind the renderer interface so it can coexist with (and is the
 * default/fallback for) other adapters (wterm). It owns the xterm `Terminal`,
 * the `FitAddon`, the
 * opt-in `WebglAddon` (loaded only while attached/visible), the glyph-atlas-
 * rebuild + `refresh` repaint, the font-derived cell measurement, and disposal.
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { fontStack, type AppSettings } from '@shared/settings';
import { TERMINAL_SCROLLBACK } from '@shared/tmux';
import { useSettingsStore } from '../../settings';
import { XTERM_THEMES } from '../../terminal/terminalRegistry';
import { createOscLinkHandler } from '../oscLinkHandler';
import type { CellMetrics, PaneRenderer, PaneRendererOptions, RendererDisposable } from './index';

export class XtermPaneRenderer implements PaneRenderer {
  readonly container: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  /** GPU (WebGL) renderer, loaded only while attached/visible and disposed on
   *  detach so live GL contexts track the visible pane count, never the
   *  accumulated registry size (the browser caps simultaneous contexts). */
  private webgl: WebglAddon | null = null;

  constructor(opts: PaneRendererOptions) {
    const s = opts.settings;
    this.term = new Terminal({
      fontFamily: fontStack(s.fontFamily),
      fontSize: s.fontSize,
      theme: XTERM_THEMES[s.theme],
      cursorBlink: true,
      // Retain enough scrollback to hold the history seeded from tmux on attach
      // (single source: TERMINAL_SCROLLBACK feeds tmux history-limit, the
      // capture-pane -S depth, and this buffer).
      scrollback: TERMINAL_SCROLLBACK,
      // Route OSC 8 hyperlinks through the shared link router (OS browser / file).
      linkHandler: createOscLinkHandler(() => opts.projectId),
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);

    this.container = document.createElement('div');
    this.container.className = 'ac-term h-full w-full bg-bg';
    this.term.open(this.container);
  }

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  onData(handler: (data: string) => void): RendererDisposable {
    return this.term.onData(handler);
  }

  focus(): void {
    this.term.focus();
  }

  onAttach(): void {
    this.ensureWebgl();
  }

  onDetach(): void {
    this.disposeWebgl();
  }

  fit(): void {
    const el = this.container;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      this.fitAddon.fit();
    }
  }

  cellMetrics(): CellMetrics | null {
    // xterm's own font-derived cell dimensions — the actual pixel-per-cell
    // measured against the rendered font, excluding xterm's internal padding and
    // the scrollbar gutter. Returns null if the private surface ever moves; the
    // registry then falls back to container/cols.
    const dims = (this.term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
    })._core?._renderService?.dimensions?.css?.cell;
    return dims && dims.width && dims.height ? { w: dims.width, h: dims.height } : null;
  }

  applyAppearance(settings: AppSettings): void {
    this.term.options.fontFamily = fontStack(settings.fontFamily);
    this.term.options.fontSize = settings.fontSize;
    this.term.options.theme = XTERM_THEMES[settings.theme];
    this.repaintFromBuffer();
  }

  repaintFromBuffer(): void {
    // Drop the glyph atlas so glyphs are re-rasterized. The WebGL renderer owns
    // its own atlas (on the addon); also clear xterm's own in case a pane is
    // momentarily on the DOM-renderer fallback. `refresh(0, rows-1)` re-renders
    // the whole viewport from xterm's own buffer — never a capture-pane re-seed.
    this.webgl?.clearTextureAtlas();
    (this.term as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
    this.term.refresh(0, this.term.rows - 1);
  }

  dispose(): void {
    this.disposeWebgl();
    this.term.dispose();
    this.container.remove();
  }

  /** Load the WebGL renderer when the `terminalRenderer` setting opts into it
   *  (default `dom` loads nothing). Idempotent. On GPU context loss it drops and
   *  reloads; a failed load falls back silently to the DOM renderer. */
  private ensureWebgl(): void {
    if (this.webgl) return;
    if (useSettingsStore.getState().settings.terminalRenderer !== 'webgl') return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        this.disposeWebgl();
        if (this.container.isConnected) this.ensureWebgl();
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      /* WebGL unavailable in this context; xterm uses its DOM renderer. */
    }
  }

  private disposeWebgl(): void {
    if (!this.webgl) return;
    try {
      this.webgl.dispose();
    } catch {
      /* already gone */
    }
    this.webgl = null;
  }
}
