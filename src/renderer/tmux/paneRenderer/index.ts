/**
 * `PaneRenderer` — the renderer abstraction the control-mode pane registry
 * depends on, so the concrete terminal (xterm.js today, wterm next) is pluggable
 * behind one interface (proposal `wterm-renderer-migration`). The
 * `controlPaneRegistry` owns identity, the `%output` sink, the capture-pane seed,
 * the reaper, and the cell-size cache; the renderer owns only the terminal: byte
 * write, input, fit/measure, repaint, theming, and disposal.
 *
 * Every adapter MUST honor the `CLAUDE.md` invariants this interface carries:
 * `write` takes raw bytes (`Uint8Array`) and never UTF-8-decodes them;
 * `repaintFromBuffer` repaints from the renderer's OWN buffer (never a
 * capture-pane re-seed); scrollback depth is `TERMINAL_SCROLLBACK`.
 */
import type { AppSettings } from '@shared/settings';
import { XtermPaneRenderer } from './xtermAdapter';
import { WtermPaneRenderer } from './wtermAdapter';

/** A disposable subscription handle. */
export interface RendererDisposable {
  dispose: () => void;
}

/** Cell pixel size derived from the rendered font. */
export interface CellMetrics {
  w: number;
  h: number;
}

/**
 * One control-mode pane terminal, behind the renderer boundary. The registry
 * constructs one per `(projectId, paneId)`, reparents its {@link container}
 * across hosts, and drives it through these methods.
 */
export interface PaneRenderer {
  /** The element to reparent across panel hosts (holds the terminal surface). */
  readonly container: HTMLDivElement;
  /** Columns the terminal is currently rendering (0 before first layout). */
  readonly cols: number;
  /** Rows the terminal is currently rendering (0 before first layout). */
  readonly rows: number;

  /** Write raw bytes to the parser. MUST pass bytes verbatim (no UTF-8 decode). */
  write(bytes: Uint8Array): void;
  /** Subscribe to user input (escape sequences to send to the pty). */
  onData(handler: (data: string) => void): RendererDisposable;
  /** Move keyboard focus to the terminal. */
  focus(): void;

  /** Called when the pane becomes visible in a host: load any GPU renderer and
   *  fit. */
  onAttach(): void;
  /** Called when the pane is detached (not visible): drop any GPU renderer; the
   *  buffer/scrollback are preserved. */
  onDetach(): void;
  /** Fit to the current container size (no-op when not laid out). */
  fit(): void;
  /** Cell pixel metrics from the rendered font, or null when not yet measurable. */
  cellMetrics(): CellMetrics | null;

  /** Apply font/theme settings to the live terminal and repaint. */
  applyAppearance(settings: AppSettings): void;
  /** Non-destructively repaint every visible row from the renderer's OWN buffer
   *  (glyph-atlas rebuild + refresh). MUST NOT re-seed from capture-pane. */
  repaintFromBuffer(): void;

  /** Dispose the terminal and remove its container. */
  dispose(): void;
}

/** Options needed to construct a pane renderer. */
export interface PaneRendererOptions {
  settings: AppSettings;
  /** Owning project, used to route OSC-8 links to the correct host. */
  projectId: string;
}

/**
 * Build the pane renderer for the current `terminalRenderer` setting. `wterm`
 * selects the wterm adapter (DOM + libghostty); `dom`/`webgl` select the xterm
 * adapter (the `webgl` sub-choice is handled inside that adapter's `onAttach`).
 * xterm is the default and the fallback.
 */
export function createPaneRenderer(opts: PaneRendererOptions): PaneRenderer {
  if (opts.settings.terminalRenderer === 'wterm') {
    return new WtermPaneRenderer(opts);
  }
  return new XtermPaneRenderer(opts);
}
