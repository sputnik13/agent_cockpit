import { agentCockpit } from '../providerClient';
import { useSettingsStore } from '../settings';
import { type AppSettings } from '@shared/settings';
import type { TerminalKind, TerminalWriteKind } from '@shared/providers/types';
import type { TerminalScrollbackLine } from '@shared/providers/types';
import { createPaneRenderer, type PaneRenderer } from '../tmux/paneRenderer';
export { XTERM_THEMES } from './xtermThemes';

/** Window event asking the mounted terminal panel to move keyboard focus into
 *  its active xterm (dispatched by the Ctrl+` shortcut after activating the
 *  Dockview terminal panel). Both terminal backends listen for it. */
export const FOCUS_TERMINAL_EVENT = 'ac:focus-terminal';

/**
 * A terminal's renderer can mount before its asynchronous provider open has
 * registered the corresponding daemon pane. Mux topology controls listen for
 * this completion signal rather than relying on a bounded polling window.
 */
export const TERMINAL_OPENED_EVENT = 'ac:terminal-opened';

export interface TerminalOpenedDetail {
  projectId: string;
  kind: TerminalKind;
  key: string;
}

// xterm needs concrete colors (not CSS vars). Solarized Dark/Light ANSI palettes.

/**
 * A live terminal instance, owned by the module-level registry rather than by
 * any React component. The renderer renders into `container`, a detached div that
 * is reparented into whichever panel host is currently showing this terminal —
 * so the instance (and its scrollback + PTY subscription) survives Dockview
 * layout rebuilds and project switches.
 */
export interface TerminalEntry {
  /** Terminal presentation only; provider lifecycle belongs to this registry. */
  readonly renderer: PaneRenderer;
  readonly container: HTMLDivElement;
  readonly projectId: string;
  readonly kind: TerminalKind;
  readonly key: string;
  opened: boolean;
  /** Ask the provider controller to use the renderer's current geometry. */
  syncGeometry: () => void;
  /** Last time the user accessed this terminal (acquire/attach). Background PTY
   *  output does not count, so a chatty inactive project still gets reaped. */
  lastTouched: number;
  /** Only daemon-backed mux terminals can safely rehydrate durable history. */
  readonly hydrateScrollback: boolean;
  attachedOnce: boolean;
  dispose: () => void;
}

const entries = new Map<string, TerminalEntry>();
const explicitMuxCreates = new Set<string>();
const hydrationInFlight = new WeakMap<TerminalEntry, Promise<void>>();
const encoder = new TextEncoder();
const CLEAR_BEFORE_REHYDRATE = encoder.encode('\x1b[3J\x1b[2J\x1b[H');

function asBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? encoder.encode(data) : data;
}

/** Identity is (projectId, kind, key): the renderer key (`t1`/`run`) alone is
 *  not unique across projects, which is what caused cross-project output bleed. */
function compositeId(projectId: string, kind: TerminalKind, key: string): string {
  return `${projectId} ${kind} ${key}`;
}

/**
 * Get (or lazily create) the terminal for `(projectId, kind, key)`. Creation
 * builds a renderer in a detached container, wires PTY data/exit
 * subscriptions filtered by BOTH projectId and terminalId, and opens the PTY
 * exactly once. Idempotent: a second call returns the same instance without
 * re-opening.
 */
export function acquire(projectId: string, kind: TerminalKind, key: string): TerminalEntry {
  const id = compositeId(projectId, kind, key);
  const existing = entries.get(id);
  if (existing) return existing;

  const s = useSettingsStore.getState().settings;
  const hydrateScrollback = s.terminalBackend === 'cockpit-mux';
  // Cockpit mux uses the configured renderer. Keep the legacy terminal backend
  // on its established DOM xterm implementation, independent of renderer
  // experiments that belong to mux/control-mode panes.
  const renderer = createPaneRenderer({
    settings: s.terminalBackend === 'cockpit-mux' ? s : { ...s, terminalRenderer: 'dom' },
    projectId,
  });
  const container = renderer.container;

  const offData = agentCockpit.events.onTerminalData((e) => {
    if (e.projectId === projectId && e.terminalId === key) {
      renderer.write(asBytes(e.data));
    }
  });
  const offExit = agentCockpit.events.onTerminalExit((e) => {
    if (e.projectId === projectId && e.terminalId === key) {
      renderer.write(encoder.encode('\r\n[session ended]\r\n'));
    }
  });
  const pendingWrites: Array<{ data: string; kind: TerminalWriteKind }> = [];
  let opened = false;
  let disposed = false;
  // Electron IPC dispatch and daemon writes are asynchronous. A terminal emits
  // each keystroke separately, so fire-and-forget invokes can overtake one
  // another under load and turn a shell command into reordered/duplicated
  // input. Serialize both user input and terminal replies per pane.
  let writeChain: Promise<void> = Promise.resolve();
  const writeTerminal = (data: string, kind: TerminalWriteKind): void => {
    // A newly visible WTerm can receive a keystroke before its asynchronous
    // terminal.open IPC round trip completes. Preserve that first input instead
    // of silently sending it to a main-process terminal key that does not exist.
    if (!opened) {
      pendingWrites.push({ data, kind });
      return;
    }
    writeChain = writeChain
      .catch(() => {
        // A failed write must not strand later user input behind a rejected
        // promise. The provider logs the operation in Diagnostics.
      })
      .then(async () => {
        if (disposed) return;
        await agentCockpit.terminal.write(key, data, kind, projectId);
      });
  };
  const inputSub = renderer.onData((data) => writeTerminal(data, 'input'));
  const replySub = renderer.onReply((data) => writeTerminal(data, 'reply'));
  let pendingGeometry: { cols: number; rows: number } | null = null;
  let geometryGeneration = 0;
  let geometryChain: Promise<void> = Promise.resolve();
  const commitGeometry = (cols: number, rows: number): void => {
    const generation = ++geometryGeneration;
    geometryChain = geometryChain
      .catch(() => {
        // An old failed resize must not strand the latest geometry update.
      })
      .then(async () => {
        if (disposed || !opened || generation !== geometryGeneration) return;
        await agentCockpit.terminal.resize(key, cols, rows, projectId);
        // Mode-gated replies (notably Ghostty's DEC 2048 resize report) must
        // follow the successful PTY ioctl, never race ahead of it.
        if (!disposed && generation === geometryGeneration) renderer.geometryCommitted?.();
      });
    void geometryChain.catch((error: unknown) => {
      // A geometry failure must be visible during diagnosis; silently keeping
      // the renderer grid while the PTY retains stale dimensions breaks TUI
      // applications without any actionable signal.
      console.error('Failed to resize terminal', { key, cols, rows, error });
    });
  };

  const entry: TerminalEntry = {
    renderer,
    container,
    projectId,
    kind,
    key,
    opened: false,
    hydrateScrollback,
    attachedOnce: false,
    syncGeometry: () => {
      const cols = renderer.cols;
      const rows = renderer.rows;
      if (cols <= 0 || rows <= 0) return;
      if (!opened) {
        pendingGeometry = { cols, rows };
        return;
      }
      commitGeometry(cols, rows);
    },
    lastTouched: Date.now(),
    dispose: () => {
      // Renderer-side teardown only. A daemon pane is addressed by a reusable
      // key, so this registry cannot safely close a late open: a successor may
      // already have attached the same key. Explicit close/reset own provider
      // teardown and always carry the project identity.
      disposed = true;
      pendingWrites.length = 0;
      offData();
      offExit();
      inputSub.dispose();
      replySub.dispose();
      renderer.dispose();
      entries.delete(id);
    },
  };
  entries.set(id, entry);
  startReaper();

  const openTerminal = () => {
    const geometry = pendingGeometry ?? {
      cols: Math.max(1, renderer.cols || 80),
      rows: Math.max(1, renderer.rows || 24),
    };
    const cell = renderer.cellMetrics() ?? {
      w: container.clientWidth / Math.max(1, geometry.cols),
      h: container.clientHeight / Math.max(1, geometry.rows),
    };
    // libghostty uses integral physical pixels for Kitty placement geometry.
    // A zero value deliberately denotes a terminal without usable pixel data.
    const cellWidth = Number.isFinite(cell.w) && cell.w > 0 ? Math.max(1, Math.round(cell.w)) : 0;
    const cellHeight = Number.isFinite(cell.h) && cell.h > 0 ? Math.max(1, Math.round(cell.h)) : 0;
    return agentCockpit.terminal.open(
      {
        key,
        kind,
        cols: geometry.cols,
        rows: geometry.rows,
        hydrateScrollback,
        rendererFeatures: [...(renderer.features ?? [])],
        cellWidth,
        cellHeight,
        createIfMissing:
          kind === 'run' || (kind === 'terminal' && explicitMuxCreates.delete(compositeId(projectId, kind, key))),
      },
      projectId,
    );
  };
  const openedTerminal = () => {
    if (disposed) {
      // WTerm boot and terminal.open are asynchronous. The explicit close path
      // owns daemon destruction; this late renderer completion cannot safely
      // act on a reusable key because a new renderer may already own it.
      return;
    }
    entry.opened = true;
    opened = true;
    if (pendingGeometry) {
      commitGeometry(pendingGeometry.cols, pendingGeometry.rows);
      pendingGeometry = null;
    }
    for (const write of pendingWrites.splice(0)) writeTerminal(write.data, write.kind);
    window.dispatchEvent(
      new CustomEvent<TerminalOpenedDetail>(TERMINAL_OPENED_EVENT, {
        detail: { projectId, kind, key },
      }),
    );
    // XtermView/control selection owns focus. A slower sibling must not steal
    // keyboard input merely because its renderer became ready last.
    if (container.classList.contains('focused')) renderer.focus();
  };
  const failedTerminal = (err: unknown) => {
    // A late failure from an entry that has already been replaced must not
    // render into the disposed terminal (or into a same-key successor).
    if (disposed) return;
    const message = `\r\n[failed to start terminal: ${String(err)}]\r\n`;
    renderer.write(encoder.encode(message));
    console.error('Failed to start terminal', err);
  };
  // Every renderer crosses the same readiness boundary. xterm resolves on the
  // next microtask; WTerm waits for Ghostty WASM + its DOM grid. The mux never
  // needs renderer-specific open, resize, or reply lifecycle code.
  void renderer
    .ready()
    .then(async () => {
      if (disposed) return false;
      fitTerminal(entry);
      await openTerminal();
      return true;
    })
    .then((didOpen) => {
      if (didOpen) openedTerminal();
    })
    .catch(failedTerminal);

  return entry;
}

/** Authorize the next renderer open for this key to start a new mux session. */
export function allowMuxCreate(projectId: string, key: string): void {
  explicitMuxCreates.add(compositeId(projectId, 'terminal', key));
}

/** Reparent the entry's container into `host` and fit to its current size. */
export function attach(entry: TerminalEntry, host: HTMLElement): boolean {
  const reattached = entry.attachedOnce;
  entry.attachedOnce = true;
  entry.lastTouched = Date.now();
  host.appendChild(entry.container);
  entry.renderer.onAttach();
  fitTerminal(entry);
  return reattached;
}

/** Remove the container from this host without disposing the instance.
 *
 * React can mount a keyed mux leaf before the previous fallback view's effect
 * cleanup runs. Never let that stale cleanup remove the registry-owned
 * container after it has been reparented into its successor host. */
export function detach(entry: TerminalEntry, host?: HTMLElement): void {
  if (host && entry.container.parentElement !== host) return;
  entry.renderer.onDetach();
  entry.container.remove();
}

/** Fit + push the new size to the PTY, but only when the container is laid out
 *  (a detached or zero-size host cannot be measured). */
function fitTerminal(entry: TerminalEntry): void {
  const el = entry.container;
  if (el.clientWidth > 0 && el.clientHeight > 0) {
    entry.renderer.fit();
    entry.syncGeometry();
  }
}

/** Fit a visible terminal and propagate its size to the host PTY. */
export { fitTerminal as fit };

export function focus(entry: TerminalEntry): void {
  // Renderer implementations expose different focus DOM details. Keep the
  // mux-visible focus state at the controller boundary so keyboard routing and
  // accessibility/test selectors agree for xterm and WTerm alike.
  for (const candidate of entries.values()) {
    if (candidate.projectId === entry.projectId && candidate.kind === entry.kind) {
      candidate.container.classList.remove('focused');
    }
  }
  entry.container.classList.add('focused');
  entry.renderer.focus();
}

/** Focus the terminal for `(projectId, kind, key)` if it exists (no-op otherwise). */
export function focusEntry(projectId: string | null, kind: TerminalKind, key: string | null): void {
  if (!projectId || !key) return;
  const entry = entries.get(compositeId(projectId, kind, key));
  if (entry) focus(entry);
}

/** Refit a mounted renderer by durable mux identity and propagate its PTY size. */
export function fitEntry(projectId: string | null, kind: TerminalKind, key: string | null): void {
  if (!projectId || !key) return;
  const entry = entries.get(compositeId(projectId, kind, key));
  if (entry) fitTerminal(entry);
}

/** Public renderer-local history source used by the mux copy overlay. */
export function scrollbackLines(
  projectId: string,
  kind: TerminalKind,
  key: string,
  offset: number,
  limit: number,
): string[] | null {
  return (
    entries.get(compositeId(projectId, kind, key))?.renderer.scrollbackLines?.(offset, limit) ??
    null
  );
}

/**
 * Repopulate a retained mux renderer from daemon-owned history after its host
 * was hidden or rebuilt. The provider's hydration protocol has a sequence
 * barrier, so clearing first cannot drop output emitted during the transition.
 * Legacy terminals remain attached to their live stream and must not replay.
 */
export async function rehydrateMuxTerminal(entry: TerminalEntry): Promise<void> {
  if (!entry.hydrateScrollback || !entry.opened) return;
  const inFlight = hydrationInFlight.get(entry);
  if (inFlight) return inFlight;
  // Clear immediately before the provider starts its sequence-barrier attach;
  // output emitted during the handoff is included by that attach, never lost.
  entry.renderer.write(CLEAR_BEFORE_REHYDRATE);
  const cell = entry.renderer.cellMetrics() ?? {
    w: entry.container.clientWidth / Math.max(1, entry.renderer.cols || 80),
    h: entry.container.clientHeight / Math.max(1, entry.renderer.rows || 24),
  };
  const hydration = agentCockpit.terminal
    .open(
      {
        key: entry.key,
        kind: entry.kind,
        cols: Math.max(1, entry.renderer.cols || 80),
        rows: Math.max(1, entry.renderer.rows || 24),
        hydrateScrollback: true,
        rendererFeatures: [...(entry.renderer.features ?? [])],
        cellWidth: Number.isFinite(cell.w) && cell.w > 0 ? Math.max(1, Math.round(cell.w)) : 0,
        cellHeight: Number.isFinite(cell.h) && cell.h > 0 ? Math.max(1, Math.round(cell.h)) : 0,
        createIfMissing: false,
      },
      entry.projectId,
    )
    .then(() => undefined);
  hydrationInFlight.set(entry, hydration);
  try {
    await hydration;
  } finally {
    hydrationInFlight.delete(entry);
  }
}

/** Rehydrate a mounted mux pane by its stable topology identity. */
export async function rehydrateMuxTerminalEntry(
  projectId: string,
  kind: TerminalKind,
  key: string,
): Promise<void> {
  const entry = entries.get(compositeId(projectId, kind, key));
  if (entry) await rehydrateMuxTerminal(entry);
}

/** Query daemon-owned mux history first; the local renderer buffer is a bounded fallback. */
export async function muxScrollbackLines(
  projectId: string,
  kind: TerminalKind,
  key: string,
  before: number,
  count: number,
): Promise<TerminalScrollbackLine[]> {
  try {
    const lines = await agentCockpit.terminal.scrollback(key, before, count, projectId);
    if (lines.length > 0) return lines;
  } catch {
    // Legacy/local terminals do not expose daemon history.
  }
  return (scrollbackLines(projectId, kind, key, before, count) ?? []).map((text, line) => ({
    line: before + line,
    runs: [{ text, sgr: '' }],
  }));
}

export async function setBroadcast(
  projectId: string,
  key: string,
  enabled: boolean,
): Promise<void> {
  await agentCockpit.terminal.setBroadcast(key, enabled, projectId);
}

export async function setBroadcastScope(
  projectId: string,
  key: string,
  scope: 'window' | 'session',
): Promise<void> {
  await agentCockpit.terminal.setBroadcastScope(key, scope, projectId);
}

/** Dispose the terminal for `(projectId, kind, key)` if present (explicit close). */
export function dispose(projectId: string, kind: TerminalKind, key: string): void {
  entries.get(compositeId(projectId, kind, key))?.dispose();
}

/** Dispose every live terminal instance (renderer-side teardown). Used when
 *  switching terminal backends for a clean slate. */
export function disposeAll(): void {
  for (const e of [...entries.values()]) e.dispose();
}

/**
 * Reset a terminal to its startup state: tear down the renderer xterm AND detach
 * the host PTY client from the tmux session (without killing the session), then
 * let the consuming view re-acquire — which re-opens a single fresh PTY that
 * reattaches and repaints, exactly like a fresh app launch. Awaiting the host
 * detach before re-open is essential: re-opening while the old node-pty is still
 * attached would leave two clients on one tmux session (size conflicts + garbled
 * output), which is why a renderer-only reset left the tty broken. No-op if absent.
 */
export async function reset(projectId: string, kind: TerminalKind, key: string): Promise<void> {
  dispose(projectId, kind, key); // renderer teardown (term, subs, container)
  try {
    // kill:false -> kills the old node-pty client but keeps the tmux session.
    await agentCockpit.terminal.close(key, false, projectId);
  } catch {
    // Best effort; the re-acquire below still reattaches if the session survived.
  }
}

/**
 * Dispose every terminal that is detached from the live DOM (i.e. not shown in
 * any mounted panel — the case for non-active projects after a switch) and has
 * not been accessed within `thresholdMs`. The tmux session is left running, so
 * returning to the project reattaches it. Returns the number reaped.
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

/** Start the idle-terminal reaper (idempotent: a single interval). */
export function startReaper({
  thresholdMs = REAP_THRESHOLD_MS,
  intervalMs = REAP_INTERVAL_MS,
} = {}): void {
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

/** Apply current font/theme settings to a live entry (called on settings change).
 *  Setting `term.options.fontFamily` updates the option but does not by itself
 *  redraw already-rendered rows or invalidate the renderer's glyph atlas, so we
 *  clear the atlas and force a refresh — otherwise existing terminal content
 *  stays in the old font/metrics until it scrolls away. */
export function applyAppearance(entry: TerminalEntry, settings: AppSettings): void {
  entry.renderer.applyAppearance(settings);
}
