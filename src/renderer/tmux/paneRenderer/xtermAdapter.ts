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
import { XTERM_THEMES } from '../../terminal/xtermThemes';
import { createOscLinkHandler } from '../oscLinkHandler';
import { decodeOsc52Write } from '../osc52';
import type { CellMetrics, PaneRenderer, PaneRendererOptions, RendererDisposable } from './index';

export class XtermPaneRenderer implements PaneRenderer {
  readonly container: HTMLDivElement;
  private readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  /** xterm keeps terminal-generated replies and keyboard input on one public
   * event. Its core marks the former with `wasUserInput === false`; retain that
   * provenance at the narrow boundary where xterm has it so reply bytes do not
   * become broadcastable keyboard input. */
  private readonly replyHandlers = new Set<(data: string) => void>();
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
    this.routeTerminalReplies();

    // OSC 52 → system clipboard. tmux emits OSC 52 to the client on copy when
    // `set-clipboard on` + the `Ms` cap are set (see terminalConfig), so a
    // selection lands on the OS clipboard. Only honor SET (writes); read
    // requests are ignored by decodeOsc52Write so a program can't read the
    // clipboard. Clipboard write is permitted by the app (security.ts).
    this.term.parser.registerOscHandler(52, (data: string): boolean => {
      const text = decodeOsc52Write(data);
      if (text !== null) void navigator.clipboard?.writeText(text).catch(() => {});
      return true; // handled (don't pass through to other handlers)
    });

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

  ready(): Promise<void> {
    return Promise.resolve();
  }

  onData(handler: (data: string) => void): RendererDisposable {
    return this.term.onData(handler);
  }

  onReply(handler: (data: string) => void): RendererDisposable {
    this.replyHandlers.add(handler);
    return { dispose: () => this.replyHandlers.delete(handler) };
  }

  focus(): void {
    this.term.focus();
  }

  onAttach(): void {
    this.ensureWebgl();
    // Reparenting an xterm host can leave its DOM rows stale even though the
    // terminal buffer (including its deliberate viewport position) is intact.
    // Repaint only that retained buffer; moving between panes or windows must
    // never force a reader back to the live tail.
    this.repaintFromBuffer();
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
    const dims = (
      this.term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: { css?: { cell?: { width?: number; height?: number } } };
          };
        };
      }
    )._core?._renderService?.dimensions?.css?.cell;
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

  /**
   * `Terminal.onData` intentionally combines browser input with parser replies.
   * The core service's boolean is the only provenance supplied by xterm: true
   * for keyboard input, false for a terminal-generated reply. Intercept only
   * that false path before it reaches the public combined event; preserving the
   * original function for true keeps normal and rapid keyboard delivery on
   * xterm's own path.
   */
  private routeTerminalReplies(): void {
    const core = this.term as unknown as {
      _core?: {
        coreService?: {
          triggerDataEvent?: (data: string, wasUserInput?: boolean) => void;
        };
      };
    };
    const service = core._core?.coreService;
    const original = service?.triggerDataEvent;
    if (!service || !original) return;
    service.triggerDataEvent = (data: string, wasUserInput = false): void => {
      if (!wasUserInput) {
        for (const handler of this.replyHandlers) handler(data);
        return;
      }
      original.call(service, data, wasUserInput);
    };
  }
}
