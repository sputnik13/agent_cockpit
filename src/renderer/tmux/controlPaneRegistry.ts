/**
 * Module-level registry of control-mode pane xterms, keyed by (projectId,
 * paneId). This mirrors {@link import('../terminal/terminalRegistry')} for the
 * session-per-tab terminal: the xterm renders into a detached container that is
 * reparented into whichever panel host is currently showing the pane, so the
 * instance (and its scrollback + output subscription) survives React unmounts,
 * Dockview layout rebuilds, and project switches. Switching projects therefore
 * never disposes or recreates a pane — see the lifecycle-decoupling invariant in
 * docs/ARCHITECTURE.md.
 *
 * The tmux pane id (`%0`) repeats across each project's session, so the project
 * is part of the identity; output is delivered through the per-project store
 * sink, and disposal is explicit (pane/window close) or via the idle reaper.
 */
import { type AppSettings } from '@shared/settings';
import { TERMINAL_SCROLLBACK, listPanesAltScreen, type LayoutNode } from '@shared/tmux';
import { agentCockpit } from '../providerClient';
import { useSettingsStore } from '../settings';
import { createPaneRenderer, type PaneRenderer } from './paneRenderer';
import { useTmuxStore } from './tmuxStore';
import { whenReady } from './controlSession';
import { extractScreenTitle, resetScreenTitleState } from './extractScreenTitle';
import { encodeWheel } from './wheelEncode';

/** A live control-mode pane terminal owned by the registry, not by React. The
 *  concrete terminal lives behind {@link PaneRenderer} (xterm today, wterm
 *  next); the registry owns identity, the output sink, the seed, and the reaper. */
export interface PaneEntry {
  readonly renderer: PaneRenderer;
  /** The reparent-able container (== `renderer.container`), kept for the hot
   *  attach/detach/`isConnected` paths the registry drives directly. */
  readonly container: HTMLDivElement;
  readonly projectId: string;
  readonly paneId: string;
  /** Last time the user accessed this pane (acquire/attach); background output
   *  does not count, so an idle pane is still eligible for reaping. */
  lastTouched: number;
  dispose: () => void;
}

const entries = new Map<string, PaneEntry>();

/** Identity is (projectId, paneId): the tmux pane id alone is not unique across
 *  projects' sessions, which would otherwise cross-wire output. */
function compositeId(projectId: string, paneId: string): string {
  return `${projectId} ${paneId}`;
}

/**
 * Get (or lazily create) the terminal for `(projectId, paneId)`. Creation builds
 * the xterm + fit addon in a detached container, binds the project's pane output
 * sink, wires keystrokes back to the pane, and seeds prior scrollback via
 * `capture-pane` (valid because a pane is first acquired while its project is
 * active). Idempotent: a second call returns the same instance.
 */
export function acquire(projectId: string, paneId: string): PaneEntry {
  const id = compositeId(projectId, paneId);
  const existing = entries.get(id);
  if (existing) {
    existing.lastTouched = Date.now();
    return existing;
  }

  const s = useSettingsStore.getState().settings;
  // The concrete terminal (xterm today) lives behind the renderer interface; it
  // owns the scrollback depth (TERMINAL_SCROLLBACK, single source with the tmux
  // history-limit + capture-pane seed), theming, and OSC-8 link routing.
  const renderer = createPaneRenderer({ settings: s, projectId });
  const container = renderer.container;

  // Bind live sink and onData immediately so a freshly-created pane (new-window
  // / split-window) shows its prompt as soon as the shell emits %output — even
  // if that arrives before the capture-pane seed below resolves.
  let sinkWroteAny = false;
  let disposed = false;
  const unbind = useTmuxStore.getState().bindPaneSink(projectId, paneId, (bytes) => {
    sinkWroteAny = true;
    const filtered = extractScreenTitle(projectId, paneId, bytes, (title) => {
      // Promote the captured SCREEN-style title to the owning window's
      // displayName so the tab strip reflects the active command/cwd.
      const view = useTmuxStore.getState().byProject[projectId];
      const winId = view?.panes[paneId]?.windowId;
      if (winId) useTmuxStore.getState().setWindowDisplayName(projectId, winId, title);
    });
    renderer.write(filtered);
  });
  const inputSub = renderer.onData((data) => void useTmuxStore.getState().sendInput(projectId, paneId, data));

  // Mouse-wheel forwarding (control mode). tmux does NOT put the `-CC` control
  // client into mouse mode, so the renderer would just scroll its own buffer and
  // the wheel would never reach the app. For a pane whose foreground app has
  // mouse tracking on (`#{mouse_any_flag}`), synthesize SGR wheel events and send
  // them to the pane so the app scrolls (Claude, vim, htop, …); for a non-mouse
  // pane, let the renderer scroll its own scrollback. The flag is queried lazily
  // and cached (self-correcting within a gesture). This is a capture-phase
  // listener on the container, so it fires before the terminal's own wheel
  // handling and works for any backend (xterm.js or wterm). Only the visible
  // (active-project) pane receives wheel events.
  // `paneSgr` tracks whether the app negotiated SGR (1006) vs the legacy
  // X10/standard (1000) protocol — they are mutually unparseable, so the wheel
  // must be encoded to match (see `wheelEncode`). Both flags are queried together;
  // without this, X10-mode apps (e.g. vim, `mouse_sgr_flag=0`) silently dropped
  // every SGR-encoded wheel and never scrolled.
  let paneHasMouse = false;
  let paneSgr = false;
  let mouseFlagInFlight = false;
  const refreshMouseFlag = (): void => {
    if (mouseFlagInFlight) return;
    mouseFlagInFlight = true;
    void useTmuxStore
      .getState()
      .command(`display-message -p -t ${paneId} '#{mouse_any_flag} #{mouse_sgr_flag}'`)
      .then((r) => {
        const [any, sgr] = (r.lines[0]?.trim() ?? '').split(/\s+/);
        paneHasMouse = any === '1';
        paneSgr = sgr === '1';
      })
      .catch(() => {})
      .finally(() => {
        mouseFlagInFlight = false;
      });
  };
  // Warm the flags eagerly so the first wheel of the first gesture is not lost
  // while the lazy query round-trips.
  refreshMouseFlag();
  const onWheel = (e: WheelEvent): void => {
    refreshMouseFlag();
    if (!paneHasMouse) return; // let the renderer scroll its own buffer
    e.preventDefault();
    e.stopPropagation();
    const m = renderer.cellMetrics();
    const rect = container.getBoundingClientRect();
    const col =
      m && m.w > 0
        ? Math.min(Math.max(1, Math.floor((e.clientX - rect.left) / m.w) + 1), renderer.cols || 1)
        : 1;
    const row =
      m && m.h > 0
        ? Math.min(Math.max(1, Math.floor((e.clientY - rect.top) / m.h) + 1), renderer.rows || 1)
        : 1;
    const ticks = Math.min(5, Math.max(1, Math.round(Math.abs(e.deltaY) / 40)));
    // Encode in the protocol the app negotiated (SGR vs X10) — emitting the
    // wrong one is silently dropped. X10 produces raw high bytes, so this MUST
    // travel as a Uint8Array (the string path would UTF-8-mangle it).
    const seq = encodeWheel({ sgr: paneSgr, up: e.deltaY < 0, col, row }, ticks);
    void useTmuxStore.getState().sendInput(projectId, paneId, seq);
  };
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });

  // Backfill scrollback once the session is open via capture-pane — but ONLY if
  // the live sink hasn't already rendered anything for this pane. capture-pane
  // returns the pane buffer AS IT IS RIGHT NOW, so writing it after the sink
  // has emitted would re-render the same bytes (the "repeated keystrokes" /
  // doubled-prompt artifact). Skipping when live output already arrived is
  // correct: the sink is authoritative for ongoing content, and for a fresh
  // pane there is nothing to backfill anyway. Gating on whenReady() also avoids
  // hitting a not-yet-open session after a dev main restart.
  void whenReady(projectId)
    .then(() => agentCockpit.tmuxControl.capturePane(paneId, TERMINAL_SCROLLBACK))
    .then((lines) => {
      if (disposed || sinkWroteAny || lines.length === 0) return;
      // Skip when the captured pane is all blank — that's a freshly-created
      // pane whose shell hasn't printed anything yet AND the capture-pane
      // RPC won the race against the first %output. Writing N blank rows
      // would fill the xterm buffer and scroll the cursor to the bottom,
      // so the prompt that arrives moments later via %output would print
      // at the visible bottom instead of the top (the "new tab starts at
      // the bottom of the window" symptom). For reattach scenarios (post-
      // reaper / app restart) the captured content is non-blank, so the
      // seed still restores scrollback.
      if (!lines.some((line) => line.trim().length > 0)) return;
      renderer.write(seedBytesFromCapture(lines));
    })
    .catch(() => {
      /* sink is already bound; nothing to do */
    });

  const entry: PaneEntry = {
    renderer,
    container,
    projectId,
    paneId,
    lastTouched: Date.now(),
    dispose: () => {
      disposed = true;
      unbind();
      inputSub.dispose();
      container.removeEventListener('wheel', onWheel, true);
      // The renderer disposes its terminal (incl. any GPU renderer) and removes
      // its container.
      renderer.dispose();
      entries.delete(id);
      // Namespace the title-state clear by projectId+paneId so we only drop
      // this pane's state, not another project's pane with the same paneId.
      resetScreenTitleState(projectId, paneId);
    },
  };
  entries.set(id, entry);
  startReaper();
  return entry;
}

/** Reparent the entry's container into `host`, load the GPU renderer, and fit to
 *  its current size. */
export function attach(entry: PaneEntry, host: HTMLElement): void {
  entry.lastTouched = Date.now();
  host.appendChild(entry.container);
  entry.renderer.onAttach();
  fit(entry);
}

/** Remove the container from its current parent without disposing the instance.
 *  Drops the GPU renderer too: a detached (non-visible) pane needs no live GL
 *  context, so this keeps simultaneous WebGL contexts bounded to visible panes
 *  rather than the whole accumulated registry. The xterm instance, scrollback,
 *  and output subscription are preserved; re-attaching reloads the renderer. */
export function detach(entry: PaneEntry): void {
  entry.renderer.onDetach();
  entry.container.remove();
}

/** Fit only when the container is laid out (a detached/zero-size host cannot be
 *  measured). Pane size is driven by tmux layout, so this does not push a resize.
 *  After a successful fit, opportunistically populate the cell-size cache so
 *  ControlTerminalPanel's onCellSizeReady listener fires once — this is what
 *  makes the initial pushClientSize use real font metrics instead of the
 *  8x17 default. Subsequent pushes are driven by explicit triggers
 *  (host RO, font change, structural commands, drag-resize completion). */
export function fit(entry: PaneEntry): void {
  const el = entry.container;
  if (el.clientWidth > 0 && el.clientHeight > 0) {
    entry.renderer.fit();
    if (!cellCache) populateCellCacheFrom(entry);
  }
}

function populateCellCacheFrom(entry: PaneEntry): void {
  // Prefer the renderer's own font-derived dimensions when available — the
  // actual pixel-per-cell measured against the rendered font, excluding internal
  // padding / the scrollbar gutter. Fall back to container/cols otherwise.
  let nextCell: { w: number; h: number } | null = entry.renderer.cellMetrics();
  if (!nextCell) {
    const w = entry.container.clientWidth;
    const h = entry.container.clientHeight;
    if (w > 0 && h > 0 && entry.renderer.cols >= 10 && entry.renderer.rows >= 5) {
      nextCell = { w: w / entry.renderer.cols, h: h / entry.renderer.rows };
    }
  }
  if (!nextCell) return;
  // Capture per-pane chrome: the pixels of the container the terminal doesn't
  // render cells into (the .ac-term 6px horizontal padding + the overflow-y:
  // auto scrollbar gutter). Without this, cols pushed to tmux exceed what is
  // actually displayed and content wraps by chrome/cellW cells (~3 columns at
  // default font).
  const chromeW = Math.max(0, entry.container.clientWidth - entry.renderer.cols * nextCell.w);
  const chromeH = Math.max(0, entry.container.clientHeight - entry.renderer.rows * nextCell.h);
  cellCache = nextCell;
  chromeCache = { w: chromeW, h: chromeH };
  for (const fn of cellSizeListeners) {
    try {
      fn();
    } catch {
      /* listener errors must not break the registry */
    }
  }
}

/** Per-pane horizontal/vertical chrome (padding + scrollbar) in CSS px,
 *  captured at fit time. {@link clientCells} subtracts this before
 *  dividing by cellW so cols/rows pushed to tmux match what xterm actually
 *  renders. Null until the first valid fit. */
export function getChromeSize(): { w: number; h: number } | null {
  return chromeCache;
}

/** Live (cols, rows) that a pane's xterm is actually rendering, or null
 *  when the pane is not in the registry (e.g. cross-project lookup before
 *  acquire). The values reflect the most recent {@link fit} and are what
 *  the host should push to tmux to guarantee no off-by-one wrap. */
export function getPaneTermSize(
  projectId: string,
  paneId: string,
): { cols: number; rows: number } | null {
  const e = entries.get(compositeId(projectId, paneId));
  if (!e) return null;
  if (e.renderer.cols <= 0 || e.renderer.rows <= 0) return null;
  return { cols: e.renderer.cols, rows: e.renderer.rows };
}

export function focus(entry: PaneEntry): void {
  entry.renderer.focus();
}

/** Focus the pane's terminal if it exists (no-op otherwise). */
export function focusEntry(projectId: string | null, paneId: string | null): void {
  if (!projectId || !paneId) return;
  entries.get(compositeId(projectId, paneId))?.renderer.focus();
}

/** Dispose the terminal for `(projectId, paneId)` if present (explicit close). */
export function dispose(projectId: string, paneId: string): void {
  entries.get(compositeId(projectId, paneId))?.dispose();
}

/** Dispose every pane belonging to a project (e.g. its control session reset). */
export function disposeProject(projectId: string): void {
  for (const e of [...entries.values()]) if (e.projectId === projectId) e.dispose();
}

/** Dispose every live pane instance (renderer-side teardown / backend switch). */
export function disposeAll(): void {
  for (const e of [...entries.values()]) e.dispose();
}

/**
 * Dispose every pane that is detached from the live DOM (not shown in any
 * mounted panel — the case for non-active projects after a switch) and has not
 * been accessed within `thresholdMs`. The tmux session is left running, so
 * returning to the project re-acquires and re-seeds. Returns the number reaped.
 */
export function sweepIdle(thresholdMs: number, now: number = Date.now()): number {
  const stale = [...entries.values()].filter(
    (e) => !e.container.isConnected && now - e.lastTouched > thresholdMs,
  );
  for (const e of stale) e.dispose();
  return stale.length;
}

const REAP_THRESHOLD_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 5 * 60_000;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

/** Start the idle-pane reaper (idempotent: a single interval). */
export function startReaper(
  { thresholdMs = REAP_THRESHOLD_MS, intervalMs = REAP_INTERVAL_MS } = {},
): void {
  if (reaperTimer != null) return;
  reaperTimer = setInterval(() => sweepIdle(thresholdMs), intervalMs);
}

/** Stop the reaper (teardown/tests). */
export function stopReaper(): void {
  if (reaperTimer != null) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}

/** Cell pixel size derived from any live, attached, fit entry — cached per font
 *  so a resize doesn't read a stale ratio. Computing this from `container_w /
 *  term.cols` on the fly is fragile: when the host resizes, the container
 *  updates one frame BEFORE xterm refits, so the ratio is wrong (new width /
 *  old cols) and the size pushed to tmux is wrong. The cell metric is a
 *  property of the font, not of the current container, so we lock it in once an
 *  entry has a non-trivial grid and reuse it until {@link invalidateCellSize}
 *  clears the cache (e.g. on font change in {@link applyAppearance}). */
let cellCache: { w: number; h: number } | null = null;
// Per-pane horizontal chrome (padding + scrollbar gutter) in CSS pixels:
// container.clientWidth - term.cols * cellW. Subtracted from the host
// width before dividing by cellW so cols pushed to tmux match what xterm
// actually renders. Vertical chrome is normally zero (no top/bottom
// padding in our .ac-term .xterm CSS) but is captured the same way.
let chromeCache: { w: number; h: number } | null = null;
const cellSizeListeners = new Set<() => void>();
export function getCellSize(): { w: number; h: number } | null {
  if (cellCache) return cellCache;
  for (const e of entries.values()) {
    if (!e.container.isConnected) continue;
    populateCellCacheFrom(e);
    if (cellCache) return cellCache;
  }
  return null;
}

/** Register a listener fired whenever the cached cell metric transitions
 *  null -> populated (i.e. on first valid fit after startup or after
 *  {@link invalidateCellSize}). Returns an unsubscribe. */
export function onCellSizeReady(fn: () => void): () => void {
  cellSizeListeners.add(fn);
  return () => cellSizeListeners.delete(fn);
}

/** Drop the cached cell metric so the next {@link getCellSize} re-measures —
 *  call on any change that alters the font (or the entry's font rendering). */
export function invalidateCellSize(): void {
  cellCache = null;
  chromeCache = null;
}

/** Apply current font/theme settings to a live entry (called on settings change).
 *  The renderer updates its font/theme and repaints from its own buffer (setting
 *  the option alone does not redraw already-rendered rows). The cell metric is
 *  font-dependent, so the cache is dropped here so the next size push re-measures
 *  against the refit-to-new-font entry. */
export function applyAppearance(entry: PaneEntry, settings: AppSettings): void {
  entry.renderer.applyAppearance(settings);
  invalidateCellSize();
}

/** Re-encode `capture-pane` reply lines back to the raw byte stream xterm
 *  expects. The parser stores reply lines via its latin1Decode path (each JS char
 *  code IS the original byte 0..255); passing the string straight to `term.write`
 *  would make xterm read bytes ≥ 0x80 as Unicode codepoints (0x9B → U+009B/CSI),
 *  wedging the VT parser ("Parsing error: [object Object]"). Re-encoding to bytes
 *  and joining rows with CRLF reproduces the wire faithfully. See CLAUDE.md. */
function seedBytesFromCapture(lines: string[]): Uint8Array {
  const text = lines.join('\r\n') + '\r\n';
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

/** Non-destructively recover a display-corrupted pane: refit to the host and
 *  repaint every visible row from the renderer's OWN buffer — the same primitives
 *  a window-resize or {@link applyAppearance} already uses. It MUST NOT dispose
 *  the terminal, re-seed from `capture-pane`, or remount: for a live alt-screen
 *  TUI (Claude Code, vim, htop) a re-seed writes the captured visible screen as
 *  plain lines into the buffer, which the app's own redraw then overlays —
 *  producing runaway scroll. Repainting from the existing buffer leaves tmux state
 *  untouched. */
export function recover(entry: PaneEntry): void {
  fit(entry);
  entry.renderer.repaintFromBuffer();
  invalidateCellSize();
}

/** Recover every live pane in the active tab (tmux window) of `projectId`. Panes
 *  are keyed by (projectId, paneId); the window→panes mapping is resolved from the
 *  tmux store's layout for `windowId`. Non-destructive — see {@link recover}. */
export function recoverTab(projectId: string, windowId: string | null): void {
  if (!windowId) return;
  const layout = useTmuxStore.getState().byProject[projectId]?.windows[windowId]?.layout ?? null;
  for (const paneId of collectLayoutPaneIds(layout)) {
    const e = entries.get(compositeId(projectId, paneId));
    if (e) recover(e);
  }
}

// ESC[3J ESC[2J ESC[H — clear scrollback, clear screen, home cursor. Written
// before a re-seed so the captured buffer replaces the stale content instead of
// appending after it.
const CLEAR_BEFORE_SEED = new Uint8Array([
  0x1b, 0x5b, 0x33, 0x4a, 0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48,
]);

/**
 * DESTRUCTIVELY re-seed a pane from tmux's current `capture-pane` output: clear
 * the renderer buffer, then re-write the captured content (reusing the latin1
 * re-encode seed path — see {@link seedBytesFromCapture} and the CLAUDE.md
 * raw-byte invariant), then refit and repaint.
 *
 * The caller MUST have confirmed the pane is on the NORMAL screen
 * (`#{alternate_on}` == 0). Re-seeding a live alternate-screen TUI (vim, htop,
 * Claude Code) makes the app's own redraw overlay the seeded lines and scroll
 * them away — the runaway-scroll hazard that {@link recover} exists to avoid.
 * This is the deep-desync path that otherwise needs a full renderer reload.
 */
export async function reseedPane(entry: PaneEntry): Promise<void> {
  const lines = await agentCockpit.tmuxControl.capturePane(entry.paneId, TERMINAL_SCROLLBACK);
  entry.renderer.write(CLEAR_BEFORE_SEED);
  if (lines.length > 0 && lines.some((line) => line.trim().length > 0)) {
    entry.renderer.write(seedBytesFromCapture(lines));
  }
  fit(entry);
  entry.renderer.repaintFromBuffer();
  invalidateCellSize();
}

/** Parse a `list-panes … '#{pane_id} #{alternate_on}'` reply into
 *  paneId → isAlternateScreen. Unparseable lines are skipped. */
export function parseAltScreenReply(lines: string[]): Map<string, boolean> {
  const byPane = new Map<string, boolean>();
  for (const line of lines) {
    const [pane, alt] = line.trim().split(/\s+/);
    if (pane) byPane.set(pane, alt === '1');
  }
  return byPane;
}

/** Whether a pane may be DESTRUCTIVELY re-seeded — only when positively known to
 *  be on the normal screen. Unknown (`undefined`, e.g. query failed) or alternate
 *  (`true`) → false, so a live TUI is never re-seeded. */
export function mayReseed(alt: boolean | undefined): boolean {
  return alt === false;
}

/**
 * HARD-recover every pane in the active tab: re-seed panes on the NORMAL screen
 * from `capture-pane`, and cheap-repaint panes on the ALTERNATE screen (whose
 * correct hard fix is the client resize round-trip the panel issues alongside
 * this — its SIGWINCH makes the TUI redraw itself). One `list-panes` round-trip
 * learns each pane's `#{alternate_on}`. Safe default ({@link mayReseed}): a pane
 * is re-seeded ONLY when positively known to be on the normal screen; unknown /
 * query-failed / alternate all fall back to the non-destructive repaint.
 */
export async function hardRecoverTab(projectId: string, windowId: string | null): Promise<void> {
  if (!windowId) return;
  const layout = useTmuxStore.getState().byProject[projectId]?.windows[windowId]?.layout ?? null;
  const paneIds = collectLayoutPaneIds(layout);
  if (paneIds.length === 0) return;

  let altById = new Map<string, boolean>();
  try {
    const reply = await useTmuxStore.getState().command(listPanesAltScreen(windowId));
    if (!reply.error) altById = parseAltScreenReply(reply.lines);
  } catch {
    /* query failed; every pane falls back to the safe repaint below */
  }

  for (const paneId of paneIds) {
    const e = entries.get(compositeId(projectId, paneId));
    if (!e) continue;
    if (mayReseed(altById.get(paneId))) {
      await reseedPane(e); // positively normal-screen: full re-seed is safe
    } else {
      recover(e); // alt-screen / unknown: non-destructive repaint only
    }
  }
}

/** Leaf pane ids of a layout tree (depth-first). Local copy to avoid importing
 *  the renderer view module (PaneXterm) into the registry. */
function collectLayoutPaneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.paneId];
  return node.children.flatMap(collectLayoutPaneIds);
}
