import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { agentCockpit } from '../providerClient';
import { useSettingsStore } from '../settings';
import { fontStack, type AppSettings, type ThemeId } from '@shared/settings';
import type { TerminalKind } from '@shared/providers/types';
import { createOscLinkHandler } from '../tmux/oscLinkHandler';

/** Window event asking the mounted terminal panel to move keyboard focus into
 *  its active xterm (dispatched by the Ctrl+` shortcut after activating the
 *  Dockview terminal panel). Both terminal backends listen for it. */
export const FOCUS_TERMINAL_EVENT = 'ac:focus-terminal';

// xterm needs concrete colors (not CSS vars). Solarized Dark/Light ANSI palettes.
export const XTERM_THEMES: Record<ThemeId, ITheme> = {
  'solarized-dark': {
    background: '#002b36',
    foreground: '#93a1a1',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#0d4150',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
  'solarized-light': {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
    brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

/**
 * A live terminal instance, owned by the module-level registry rather than by
 * any React component. The xterm renders into `container`, a detached div that
 * is reparented into whichever panel host is currently showing this terminal —
 * so the instance (and its scrollback + PTY subscription) survives Dockview
 * layout rebuilds and project switches.
 */
export interface TerminalEntry {
  readonly term: Terminal;
  readonly fit: FitAddon;
  readonly container: HTMLDivElement;
  readonly projectId: string;
  readonly kind: TerminalKind;
  readonly key: string;
  opened: boolean;
  /** Last time the user accessed this terminal (acquire/attach). Background PTY
   *  output does not count, so a chatty inactive project still gets reaped. */
  lastTouched: number;
  dispose: () => void;
}

const entries = new Map<string, TerminalEntry>();

/** Identity is (projectId, kind, key): the renderer key (`t1`/`run`) alone is
 *  not unique across projects, which is what caused cross-project output bleed. */
function compositeId(projectId: string, kind: TerminalKind, key: string): string {
  return `${projectId} ${kind} ${key}`;
}

/**
 * Get (or lazily create) the terminal for `(projectId, kind, key)`. Creation
 * builds the xterm + fit addon in a detached container, wires PTY data/exit
 * subscriptions filtered by BOTH projectId and terminalId, and opens the PTY
 * exactly once. Idempotent: a second call returns the same instance without
 * re-opening.
 */
export function acquire(projectId: string, kind: TerminalKind, key: string): TerminalEntry {
  const id = compositeId(projectId, kind, key);
  const existing = entries.get(id);
  if (existing) return existing;

  const s = useSettingsStore.getState().settings;
  const term = new Terminal({
    fontFamily: fontStack(s.fontFamily),
    fontSize: s.fontSize,
    theme: XTERM_THEMES[s.theme],
    cursorBlink: true,
    // Route OSC 8 hyperlinks through the shared link router (OS browser / file).
    linkHandler: createOscLinkHandler(() => projectId),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const container = document.createElement('div');
  container.className = 'ac-term h-full w-full bg-bg';
  term.open(container);

  const offData = agentCockpit.events.onTerminalData((e) => {
    if (e.projectId === projectId && e.terminalId === key) term.write(e.data);
  });
  const offExit = agentCockpit.events.onTerminalExit((e) => {
    if (e.projectId === projectId && e.terminalId === key) term.write('\r\n[session ended]\r\n');
  });
  const inputSub = term.onData((data) => void agentCockpit.terminal.write(key, data));

  const entry: TerminalEntry = {
    term,
    fit,
    container,
    projectId,
    kind,
    key,
    opened: false,
    lastTouched: Date.now(),
    dispose: () => {
      // Renderer-side teardown only. Killing the tmux session is the caller's
      // job (terminalsStore.close issues terminal.close), so we do not re-issue
      // the IPC close here and risk a double-close.
      offData();
      offExit();
      inputSub.dispose();
      term.dispose();
      container.remove();
      entries.delete(id);
    },
  };
  entries.set(id, entry);
  startReaper();

  agentCockpit.terminal
    .open({ key, kind, cols: term.cols, rows: term.rows })
    .then(() => {
      entry.opened = true;
      term.focus();
    })
    .catch((err: unknown) => term.write(`\r\n[failed to start terminal: ${String(err)}]\r\n`));

  return entry;
}

/** Reparent the entry's container into `host` and fit to its current size. */
export function attach(entry: TerminalEntry, host: HTMLElement): void {
  entry.lastTouched = Date.now();
  host.appendChild(entry.container);
  fit(entry);
}

/** Remove the container from its current parent without disposing the instance. */
export function detach(entry: TerminalEntry): void {
  entry.container.remove();
}

/** Fit + push the new size to the PTY, but only when the container is laid out
 *  (a detached or zero-size host cannot be measured). */
export function fit(entry: TerminalEntry): void {
  const el = entry.container;
  if (el.clientWidth > 0 && el.clientHeight > 0) {
    entry.fit.fit();
    void agentCockpit.terminal.resize(entry.key, entry.term.cols, entry.term.rows);
  }
}

export function focus(entry: TerminalEntry): void {
  entry.term.focus();
}

/** Focus the terminal for `(projectId, kind, key)` if it exists (no-op otherwise). */
export function focusEntry(projectId: string | null, kind: TerminalKind, key: string | null): void {
  if (!projectId || !key) return;
  entries.get(compositeId(projectId, kind, key))?.term.focus();
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
    await agentCockpit.terminal.close(key, false);
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

/** Apply current font/theme settings to a live entry (called on settings change).
 *  Setting `term.options.fontFamily` updates the option but does not by itself
 *  redraw already-rendered rows or invalidate the renderer's glyph atlas, so we
 *  clear the atlas and force a refresh — otherwise existing terminal content
 *  stays in the old font/metrics until it scrolls away. */
export function applyAppearance(entry: TerminalEntry, settings: AppSettings): void {
  entry.term.options.fontFamily = fontStack(settings.fontFamily);
  entry.term.options.fontSize = settings.fontSize;
  entry.term.options.theme = XTERM_THEMES[settings.theme];
  // clearTextureAtlas only exists on the canvas/webgl renderers (xterm 5+).
  (entry.term as unknown as { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
  entry.term.refresh(0, entry.term.rows - 1);
}
