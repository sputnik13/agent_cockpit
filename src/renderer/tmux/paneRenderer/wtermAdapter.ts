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
 * Cockpit owns sizing instead of WTerm's ResizeObserver: a mux window may be
 * retained but hidden, and WTerm would otherwise observe that host at zero size.
 * The registry only fits a laid-out host and propagates its resulting cell metric
 * to the daemon.
 *
 * WTerm 0.5 exposes Ghostty's OSC-8 cell metadata and renders its documented
 * direct Kitty PNG/RGB/RGBA subset through a bounded DOM-owned canvas overlay.
 * Cockpit forwards the raw stream and never intercepts or persists image bytes.
 */
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import { GhosttyCore } from '@wterm/ghostty';
import { fontStack, type AppSettings, type ThemeId } from '@shared/settings';
import { TERMINAL_SCROLLBACK } from '@shared/tmux';
import { XTERM_THEMES } from '../../terminal/xtermThemes';
import type { CellMetrics, PaneRenderer, PaneRendererOptions, RendererDisposable } from './index';

const GHOSTTY_WASM_URL = 'cockpit-wasm://ghostty-vt/ghostty-vt.wasm';

/** xterm `ITheme` field → wterm `--term-color-N` index. */
const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

/**
 * A public Ghostty scrollback line that was at the reader's viewport edge.
 * Ghostty exposes scrollback newest-first, which is also the order WTerm maps
 * from its virtual DOM rows. Keeping the line content rather than a pixel
 * distance lets a width reflow preserve the reader's actual place in history.
 */
interface ReaderViewportAnchor {
  line: string;
  offset: number;
  fractionalRow: number;
}

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
  readonly features = ['direct_graphics_v1'] as const;
  private term: WTerm | null = null;
  private core: GhosttyCore | null = null;
  private disposed = false;
  /** Bytes written before init() resolves; flushed in order on boot. */
  private readonly pendingWrites: Uint8Array[] = [];
  private dataHandler: ((data: string) => void) | null = null;
  private replyHandler: ((data: string) => void) | null = null;
  /** WTerm drains parser responses synchronously from `write()`. While Cockpit
   * is delivering PTY output, that otherwise-combined callback is therefore a
   * terminal reply, not keyboard input. JavaScript cannot interleave a browser
   * input event into this synchronous extent. */
  private deliveringHostOutput = false;
  /** DEC private mode 2048 asks the terminal to report geometry in-band. */
  private inBandResizeEnabled = false;
  /** A changed grid must be reported only after its PTY resize commits. */
  private inBandResizePending = false;
  private inBandResizeParser: 'ground' | 'escape' | 'csi' = 'ground';
  private inBandResizeParameters = '';
  private wantFocus = false;
  /** Cockpit records reader intent; WTerm remains the sole virtual-range owner. */
  private followsLiveOutput = true;
  private liveTailFrame: number | null = null;
  private pendingReaderDistanceFromBottom: number | null = null;
  private pendingReaderAnchor: ReaderViewportAnchor | null = null;
  private readerRestoreFrame: number | null = null;
  /** Suppress WTerm's synthetic resize scroll until the live/reader viewport settles. */
  private layoutResizeInProgress = false;
  private liveResizeRestoreFrame: number | null = null;
  /** Observe the actual flex host; WTerm has autoResize disabled by design. */
  private hostResizeObserver: ResizeObserver | null = null;
  /** Completes only after the Ghostty core and its initial DOM grid exist. */
  private readonly bootPromise: Promise<void>;
  private readonly onScroll = (): void => {
    if (!this.container.isConnected || this.container.clientHeight === 0) return;
    // `WTerm.resize()` recreates the virtual DOM grid. The browser emits a
    // scroll event while that grid has no height, which is implementation work
    // rather than a reader action. Preserve the reader intent until the new
    // grid has rendered and the logical anchor can be restored.
    if (this.layoutResizeInProgress) return;
    this.followsLiveOutput = this.isScrolledToBottom();
  };
  /**
   * WTerm's input handler consumes every wheel event as a mouse report,
   * including when the terminal has not enabled mouse tracking. Capture the
   * ordinary scrollback case before that listener without preventing default:
   * the browser updates scrollTop, then WTerm can materialize the new range.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    if (this.core?.mouseTracking() !== 0) return;
    // Leave browser scrolling and WTerm's own scroll listener intact, but do
    // not turn an ordinary wheel gesture into a terminal mouse report.
    this.followsLiveOutput = false;
    event.stopImmediatePropagation();
  };

  constructor(opts: PaneRendererOptions) {
    this.container = document.createElement('div');
    this.container.className = 'ac-term h-full w-full bg-bg';
    applyThemeVars(this.container, opts.settings);
    this.container.addEventListener('scroll', this.onScroll, { passive: true });
    this.container.addEventListener('wheel', this.onWheel, { passive: true, capture: true });
    this.bootPromise = this.boot();
  }

  /** Wait until the renderer can measure its actual host geometry. */
  ready(): Promise<void> {
    return this.bootPromise;
  }

  /**
   * WTerm's `resize()` writes a pixel height for its current row count inline.
   * That is useful for a standalone terminal, but wrong inside a flex mux leaf:
   * after a split the old row count pins the terminal to its former height and
   * prevents the host ResizeObserver from deriving the new PTY geometry.
   */
  private fillHost(): void {
    this.container.style.setProperty('width', '100%', 'important');
    this.container.style.setProperty('height', '100%', 'important');
  }

  private async boot(): Promise<void> {
    const core = await GhosttyCore.load({
      wasmPath: GHOSTTY_WASM_URL,
      scrollbackLimit: TERMINAL_SCROLLBACK,
    });
    if (this.disposed) return;
    const term = new WTerm(this.container, {
      core,
      // A terminal is temporarily detached while Cockpit switches mux windows.
      // WTerm's own observer treats that as a zero-sized host and resizes the
      // Ghostty core to 1x1, which can leave its retained DOM grid blank after
      // reattachment. The registry already observes only visible hosts, so it
      // is the safe owner of resize lifecycle here.
      autoResize: false,
      cursorBlink: true,
      onResize: () => {
        this.flushTerminalReply(core);
      },
    });
    term.onData = (data) => {
      if (this.deliveringHostOutput) this.replyHandler?.(data);
      else this.dataHandler?.(data);
    };
    await term.init();
    if (this.disposed) {
      term.destroy();
      return;
    }
    this.term = term;
    this.core = core;
    for (const bytes of this.pendingWrites) {
      this.writeHostOutput(term, bytes);
      this.observeInBandResizeMode(bytes);
      this.flushTerminalReply(core);
    }
    this.pendingWrites.length = 0;
    this.fillHost();
    this.fit();
    this.queueLiveTail();
    if (this.wantFocus) term.focus();
  }

  get cols(): number {
    return this.term?.cols ?? 0;
  }
  get rows(): number {
    return this.term?.rows ?? 0;
  }

  write(bytes: Uint8Array): void {
    if (this.term) {
      this.writeHostOutput(this.term, bytes);
      this.observeInBandResizeMode(bytes);
      this.flushTerminalReply();
      this.queueLiveTail();
    } else this.pendingWrites.push(bytes);
  }

  onData(handler: (data: string) => void): RendererDisposable {
    this.dataHandler = handler;
    return {
      dispose: () => {
        this.dataHandler = null;
      },
    };
  }

  /** Subscribe to libghostty capability replies generated by terminal output. */
  onReply(handler: (data: string) => void): RendererDisposable {
    this.replyHandler = handler;
    return {
      dispose: () => {
        this.replyHandler = null;
      },
    };
  }

  focus(): void {
    if (this.term) this.term.focus();
    else this.wantFocus = true;
  }

  onAttach(): void {
    // The registry owns host sizing and reparenting. WTerm owns its retained
    // grid and viewport: attaching must not reconstruct rows or reinterpret a
    // transient virtual scroll offset as reader intent.
    this.observeHost();
  }

  onDetach(): void {
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = null;
  }

  fit(): void {
    const term = this.term;
    const row = this.container.querySelector<HTMLElement>('.term-row');
    if (!term || !row) return;
    const probe = document.createElement('span');
    probe.textContent = 'W';
    probe.style.visibility = 'hidden';
    row.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width;
    probe.remove();
    const rowHeight = row.getBoundingClientRect().height;
    if (charWidth <= 0 || rowHeight <= 0) return;
    const style = getComputedStyle(this.container);
    const contentWidth =
      this.container.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0);
    const contentHeight =
      this.container.clientHeight -
      (parseFloat(style.paddingTop) || 0) -
      (parseFloat(style.paddingBottom) || 0);
    const cols = Math.max(1, Math.floor(contentWidth / charWidth));
    const rows = Math.max(1, Math.floor(contentHeight / rowHeight));
    if (cols !== term.cols || rows !== term.rows) {
      // WTerm emits a scroll event while it reconstructs the DOM grid. That
      // event reports its transient top offset, not a reader action. Capture
      // the intent before resize and keep it authoritative until the virtual
      // range has settled, otherwise a split turns a live pane into history.
      const followedLiveOutput = this.followsLiveOutput;
      this.layoutResizeInProgress = true;
      if (!followedLiveOutput) {
        this.pendingReaderDistanceFromBottom = this.distanceFromBottom();
        this.pendingReaderAnchor = this.captureReaderAnchor();
      }
      term.resize(cols, rows);
      this.fillHost();
      if (this.inBandResizeEnabled) this.inBandResizePending = true;
      // The adapter owns DOM measurement, while the registry owns the PTY
      // resize RPC. Notify that boundary after WTerm has accepted the new cell
      // geometry so full-screen applications receive SIGWINCH as well.
      this.container.dispatchEvent(new Event('ac:terminal-geometry'));
      if (followedLiveOutput) this.queueLiveTailAfterResize();
      else this.queueReaderRestore();
    }
  }

  cellMetrics(): CellMetrics | null {
    // WTerm owns its grid sizing, so the measured container/grid ratio is the
    // same physical cell geometry used by its Kitty placement renderer. The
    // daemon needs it for PNGs that omit an explicit rows/columns span.
    if (this.cols <= 0 || this.rows <= 0 || this.container.clientWidth <= 0 || this.container.clientHeight <= 0)
      return null;
    return {
      w: this.container.clientWidth / this.cols,
      h: this.container.clientHeight / this.rows,
    };
  }

  /**
   * Report a mode-2048 resize only once Cockpit has committed the matching
   * kernel PTY geometry. Sending this sequence first lets an application use
   * the new columns while its ioctl still reports the old grid.
   */
  geometryCommitted(): void {
    if (!this.inBandResizePending) return;
    this.emitInBandResizeReport();
  }

  applyAppearance(settings: AppSettings): void {
    applyThemeVars(this.container, settings);
  }

  repaintFromBuffer(): void {
    // WTerm has no public full-repaint API. An empty public write schedules its
    // normal render path without reconstructing the grid or changing geometry.
    const term = this.term;
    if (!term) return;
    term.write(new Uint8Array());
  }

  /**
   * Materialize a bounded range of public libghostty scrollback lines for the
   * Cockpit-owned copy overlay. The overlay, not wterm's internal DOM grid,
   * owns selection and paging. `null` means the asynchronous core is not ready.
   */
  scrollbackLines(offset: number, limit: number): string[] | null {
    const core = this.core;
    if (!core) return null;
    const start = Math.max(0, offset);
    const end = Math.min(core.getScrollbackCount(), start + Math.max(0, limit));
    const lines: string[] = [];
    for (let line = start; line < end; line += 1) {
      const cells: string[] = [];
      for (let col = 0; col < core.getScrollbackLineLen(line); col += 1) {
        const codepoint = core.getScrollbackCell(line, col).char;
        if (codepoint) cells.push(String.fromCodePoint(codepoint));
      }
      lines.push(cells.join('').replace(/\s+$/, ''));
    }
    return lines;
  }

  /** Preserve terminal-generated-response provenance across WTerm's combined
   * public callback. WTerm drains the normal synchronous path inside write(),
   * so this fallback is only for responses generated outside that call (such as
   * its resize hook). */
  private writeHostOutput(term: WTerm, bytes: Uint8Array): void {
    this.deliveringHostOutput = true;
    try {
      term.write(bytes);
    } finally {
      this.deliveringHostOutput = false;
    }
  }

  private flushTerminalReply(core = this.core): void {
    for (let reply = core?.getResponse(); reply; reply = core?.getResponse()) {
      this.replyHandler?.(reply);
    }
  }

  /** Track only the tiny CSI subset that controls DEC mode 2048. This byte
   * state machine intentionally does not decode terminal text, so a split UTF-8
   * grapheme can never corrupt control-sequence recognition. */
  private observeInBandResizeMode(bytes: Uint8Array): void {
    for (const byte of bytes) {
      switch (this.inBandResizeParser) {
        case 'ground':
          if (byte === 0x1b) this.inBandResizeParser = 'escape';
          break;
        case 'escape':
          if (byte === 0x5b) {
            this.inBandResizeParser = 'csi';
            this.inBandResizeParameters = '';
          } else if (byte === 0x63) {
            // RIS (ESC c) resets every DEC private mode, including 2048.  A
            // stale enabled flag would later inject a geometry reply into a
            // shell after the application has reset the terminal.
            this.inBandResizeEnabled = false;
            this.inBandResizePending = false;
            this.inBandResizeParser = 'ground';
          } else this.inBandResizeParser = byte === 0x1b ? 'escape' : 'ground';
          break;
        case 'csi':
          if (byte >= 0x40 && byte <= 0x7e) {
            // DECSET/DECRST accept a semicolon-separated group.  Full-screen
            // apps commonly set bracketed paste and in-band resize together
            // (`CSI ? 2004 ; 2048 h`), so exact-string matching loses the
            // latter even though libghostty enables it.
            const privateModes = this.inBandResizeParameters.startsWith('?')
              ? this.inBandResizeParameters.slice(1).split(';')
              : [];
            if (privateModes.includes('2048')) {
              if (byte === 0x68) {
                this.inBandResizeEnabled = true;
                // The protocol requires an immediate report when an
                // application enables mode 2048, even before its next resize.
                this.inBandResizePending = true;
                this.emitInBandResizeReport();
              } else if (byte === 0x6c) {
                this.inBandResizeEnabled = false;
                this.inBandResizePending = false;
              }
            }
            this.inBandResizeParser = 'ground';
            this.inBandResizeParameters = '';
          } else if (byte >= 0x20 && byte <= 0x3f && this.inBandResizeParameters.length < 64) {
            this.inBandResizeParameters += String.fromCharCode(byte);
          } else {
            this.inBandResizeParser = byte === 0x1b ? 'escape' : 'ground';
            this.inBandResizeParameters = '';
          }
          break;
      }
    }
  }

  private emitInBandResizeReport(): void {
    const term = this.term;
    if (!term || !this.inBandResizeEnabled || !this.replyHandler) return;
    this.inBandResizePending = false;
    // DEC mode 2048: CSI 48 ; rows ; columns ; pixel-height ; pixel-width t.
    // WTerm measures cells but has no stable CSS-pixel contract for this PTY,
    // so zero pixel dimensions explicitly request the portable cell-only form.
    this.replyHandler(`\u001b[48;${term.rows};${term.cols};0;0t`);
  }

  private observeHost(): void {
    const host = this.container.parentElement;
    if (!host || typeof ResizeObserver === 'undefined') return;
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = new ResizeObserver(() => {
      this.fit();
    });
    this.hostResizeObserver.observe(host);
  }

  private isScrolledToBottom(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.container;
    return scrollHeight <= clientHeight || scrollTop >= scrollHeight - clientHeight - 1;
  }

  private distanceFromBottom(): number | null {
    const { scrollTop, scrollHeight, clientHeight } = this.container;
    if (scrollHeight <= clientHeight) return null;
    return Math.max(0, scrollHeight - clientHeight - scrollTop);
  }

  private scrollbackLine(core: GhosttyCore, offset: number): string {
    const cells: string[] = [];
    for (let col = 0; col < core.getScrollbackLineLen(offset); col += 1) {
      const codepoint = core.getScrollbackCell(offset, col).char;
      if (codepoint) cells.push(String.fromCodePoint(codepoint));
    }
    return cells.join('').replace(/\s+$/, '');
  }

  /** Capture a stable public Ghostty line at the reader's current viewport edge. */
  private captureReaderAnchor(): ReaderViewportAnchor | null {
    const core = this.core;
    const row = this.container.querySelector<HTMLElement>('.term-row');
    if (!core || !row) return null;
    const rowHeight = row.getBoundingClientRect().height;
    if (rowHeight <= 0) return null;
    const count = core.getScrollbackCount();
    const rowIndex = Math.floor(this.container.scrollTop / rowHeight);
    const offset = count - 1 - rowIndex;
    if (offset < 0 || offset >= count) return null;
    const line = this.scrollbackLine(core, offset);
    if (!line) return null;
    return {
      line,
      offset,
      fractionalRow: (this.container.scrollTop % rowHeight) / rowHeight,
    };
  }

  /**
   * Restore the same logical Ghostty scrollback line after a resize. WTerm's
   * public API does not expose a logical viewport position; its DOM scroll
   * surface does, while Ghostty publicly supplies the line identity needed to
   * translate that position after reflow. Prefer the nearest duplicate so
   * repeated prompts do not unexpectedly jump through history.
   */
  private restoreReaderAnchor(anchor: ReaderViewportAnchor): boolean {
    const core = this.core;
    const row = this.container.querySelector<HTMLElement>('.term-row');
    if (!core || !row) return false;
    const rowHeight = row.getBoundingClientRect().height;
    const count = core.getScrollbackCount();
    if (rowHeight <= 0 || count === 0) return false;
    let match: number | null = null;
    for (let offset = 0; offset < count; offset += 1) {
      if (this.scrollbackLine(core, offset) !== anchor.line) continue;
      if (match === null || Math.abs(offset - anchor.offset) < Math.abs(match - anchor.offset))
        match = offset;
    }
    if (match === null) return false;
    const rowIndex = count - 1 - match;
    this.container.scrollTop = Math.max(0, rowIndex * rowHeight + anchor.fractionalRow * rowHeight);
    return true;
  }

  /**
   * WTerm exposes no public scroll-to-tail API. Queue one ordinary DOM scroll
   * after its own write/resize frame has materialized rows. This does not force
   * a virtual render or rebuild the grid; WTerm's native scroll listener owns
   * the resulting range. A reader scroll turns this off immediately.
   */
  private queueLiveTail(): void {
    if (!this.followsLiveOutput || this.liveTailFrame !== null) return;
    this.liveTailFrame = requestAnimationFrame(() => {
      this.liveTailFrame = null;
      if (
        !this.followsLiveOutput ||
        !this.container.isConnected ||
        this.container.clientHeight === 0
      )
        return;
      this.container.scrollTop = Math.max(
        0,
        this.container.scrollHeight - this.container.clientHeight,
      );
    });
  }

  /**
   * Restore a live pane only after WTerm's resize render has consumed its
   * synthetic top-of-history scroll event. A double frame gives WTerm's own
   * queued virtual-range rebuild precedence; this adapter then restores the
   * reader-visible live tail without touching deliberate scrollback.
   */
  private queueLiveTailAfterResize(): void {
    if (this.liveResizeRestoreFrame !== null) return;
    this.liveResizeRestoreFrame = requestAnimationFrame(() => {
      this.liveResizeRestoreFrame = requestAnimationFrame(() => {
        this.liveResizeRestoreFrame = null;
        if (
          this.followsLiveOutput &&
          this.container.isConnected &&
          this.container.clientHeight > 0
        ) {
          this.container.scrollTop = Math.max(
            0,
            this.container.scrollHeight - this.container.clientHeight,
          );
        }
        this.layoutResizeInProgress = false;
      });
    });
  }

  /**
   * WTerm preserves a raw pixel offset through a reflow. For a reader in
   * history, restore the pre-resize distance from the bottom after WTerm's own
   * queued resize render so wrapping changes above the viewport do not move the
   * reader to unrelated output. This is an ordinary DOM scroll, never a forced
   * WTerm render.
   */
  private queueReaderRestore(): void {
    if (this.readerRestoreFrame !== null) return;
    this.readerRestoreFrame = requestAnimationFrame(() => {
      this.readerRestoreFrame = null;
      const distance = this.pendingReaderDistanceFromBottom;
      const anchor = this.pendingReaderAnchor;
      this.pendingReaderDistanceFromBottom = null;
      this.pendingReaderAnchor = null;
      if (distance === null || !this.container.isConnected || this.followsLiveOutput) {
        this.layoutResizeInProgress = false;
        return;
      }
      if (!(anchor && this.restoreReaderAnchor(anchor))) {
        this.container.scrollTop = Math.max(
          0,
          this.container.scrollHeight - this.container.clientHeight - distance,
        );
      }
      this.layoutResizeInProgress = false;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.container.removeEventListener('scroll', this.onScroll);
    this.container.removeEventListener('wheel', this.onWheel, true);
    if (this.liveTailFrame !== null) cancelAnimationFrame(this.liveTailFrame);
    if (this.readerRestoreFrame !== null) cancelAnimationFrame(this.readerRestoreFrame);
    if (this.liveResizeRestoreFrame !== null) cancelAnimationFrame(this.liveResizeRestoreFrame);
    this.hostResizeObserver?.disconnect();
    this.hostResizeObserver = null;
    try {
      this.term?.destroy();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.core = null;
    this.container.remove();
  }
}
