/**
 * App settings — persisted to a JSON config file in the app's userData dir and
 * applied live to the renderer (theme tokens, fonts) and the terminal.
 */
export type ThemeId = 'solarized-dark' | 'solarized-light';

/**
 * Terminal backend: `session-per-tab` runs one tmux session per terminal tab
 * (the original model); `control-mode` drives a single per-project `tmux -CC`
 * control session mapping tmux windows->tabs and panes->splits.
 */
export type TerminalBackend = 'session-per-tab' | 'control-mode';

/**
 * xterm renderer for control-mode panes. `dom` is xterm's built-in renderer
 * (no addon) — broadly compatible and artifact-free. `webgl` paints to a GPU
 * canvas (cheaper layout for large grids) but is opt-in: on this xterm line it
 * can briefly show stale cells right after a pane first loads. Canvas is
 * intentionally absent — xterm deprecated it and there is no clean release for
 * our xterm major, so the realistic choices are `dom` (default) and `webgl`.
 */
/**
 * Control-mode pane renderer. `dom` and `webgl` both use the xterm.js adapter
 * (the latter loads xterm's WebGL addon); `wterm` uses the wterm adapter (DOM
 * rendering + the libghostty VT core). Default `dom`.
 */
export type TerminalRenderer = 'dom' | 'webgl' | 'wterm';

/**
 * How a project's dev environment (its control-mode tmux server and therefore
 * every pane / process beneath it) is launched on the host. `systemd-scope`
 * wraps the tmux server in a memory-capped systemd transient scope (the default,
 * Linux + lingering only); `tmux` is straight tmux with no cap — both an explicit
 * choice AND the automatic, surfaced fallback when a host can't support the scope.
 * (`devcontainer` is reserved for a future mode and is not offered here.)
 */
export type DevEnvMode = 'systemd-scope' | 'tmux';

export interface DevEnvConfig {
  mode: DevEnvMode;
  /** Hard memory cap (MB) applied to each project's tmux server in
   *  `systemd-scope` mode (`MemoryMax`). Ignored by `tmux` mode. */
  memoryMaxMb: number;
}

export interface AppSettings {
  theme: ThemeId;
  /** Monospace family for the terminal and code/diff surfaces. */
  fontFamily: string;
  /** Base monospace font size in px. */
  fontSize: number;
  /** Which terminal backend the workbench uses. */
  terminalBackend: TerminalBackend;
  /** xterm renderer for control-mode panes. */
  terminalRenderer: TerminalRenderer;
  /**
   * Show all changed files in the Changes panel, including entries the watch
   * policy hides by default (`.git`, `.beads`). Off by default — these stores
   * are noise in the changeset. Display-only; it does not affect watching.
   */
  showAllChanges: boolean;
  /**
   * Show the Run panel and create its dedicated `run-1` tmux window. Off by
   * default — the panel consumes a lot of space and isn't always useful. When
   * off, the Run panel is omitted from the default layout and `run-1` is not
   * created on attach; it remains available in the Panels reopen menu and is
   * created on demand when opened. An already-existing `run-1` is never reaped
   * because of this setting.
   */
  showRunPanel: boolean;
  /**
   * Idle timeout (minutes) after which an unused remote session is aged out
   * (disconnected via clean teardown; the project stays in the list and
   * server-side tmux survives). `0` disables aging-out entirely. Default 20.
   */
  sessionIdleTimeoutMin: number;
  /**
   * How each project's dev environment is launched on the host (global, applies
   * to all projects for now). Default: `systemd-scope` capped at 16 GB; falls
   * back to straight `tmux` (surfaced) on hosts that can't support the scope.
   */
  devEnv: DevEnvConfig;
  /**
   * Enable byobu/screen-style keybindings in the control-mode terminal: a
   * `Ctrl+a` prefix (z=zoom, n/p=next/prev tab, a=literal Ctrl+a) plus
   * Shift+Arrow pane navigation. Off by default — `Ctrl+a` is otherwise
   * readline beginning-of-line, so this is opt-in. The existing ⌘-based
   * shortcuts are unaffected and coexist.
   */
  byobuKeybindings: boolean;
  /**
   * When on, the Changes view auto-selects the worktree matching the active
   * terminal pane's current directory (longest-prefix match against the known
   * worktree list). Updates within ~1.5 s of a `cd`. Off by default.
   */
  followTerminalCwd: boolean;
  /**
   * Derive tmux session names from a hash of the project ROOT (local rootPath /
   * remote repo path) instead of the per-machine random project id. When on,
   * opening the same project from different client machines maps to the SAME
   * tmux session, so they share it (attach to the same panes). Off by default —
   * turning it on changes session names, leaving any existing per-machine
   * sessions orphaned (one-time). Resolved at session-open time, so toggling
   * never renames a live session. Mainly useful for remote projects.
   */
  deterministicSessionNames: boolean;
  /**
   * Enable tmux server-side flow control (pause-mode) for control-mode terminals
   * on tmux >= 3.2. When on, the client sets `refresh-client -fpause-after=N` so
   * tmux pauses a pane's output (and the client resumes + re-seeds it on focus)
   * if the client falls behind — bounding memory for a flooding pane. Off by
   * default: it switches `%output` to `%extended-output` server-side and needs
   * live verification per host, so it is opt-in. No effect on tmux < 3.2.
   */
  tmuxPauseMode: boolean;
  /**
   * Use tmux format subscriptions (`refresh-client -B`) for control-mode pane
   * titles and mouse flags on tmux >= 3.2, instead of screen-scraping titles and
   * polling `display-message` for mouse mode. tmux pushes `%subscription-changed`
   * when a subscribed format changes. Off by default: experimental and host-
   * dependent. On tmux < 3.2 (or when off) the scrape/poll path is used. */
  tmuxFormatSubscriptions: boolean;
  /**
   * Comfortable column count for the workgraph side-by-side `Columns` view. Up to
   * this many pinned-epic columns fill the panel; pinning beyond it is
   * warn-and-allow (the column is still shown, with a non-blocking density
   * signal). Raising it (e.g. to 3) suppresses the signal at the higher count.
   * Default 2.
   */
  workgraphColumnsSoftCap: number;
  /**
   * Soft-wrap long lines in the Content panel's code views (diff + raw) instead
   * of scrolling them horizontally. Off by default (horizontal scroll). Toggled
   * from the control at the top of the Content panel; persisted so the choice
   * survives file switches and restarts. Line-number gutters stay aligned in
   * both modes.
   */
  wrapLines: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'solarized-dark',
  fontFamily: 'SF Mono',
  fontSize: 13,
  terminalBackend: 'control-mode',
  terminalRenderer: 'dom',
  showAllChanges: false,
  showRunPanel: false,
  sessionIdleTimeoutMin: 20,
  devEnv: { mode: 'systemd-scope', memoryMaxMb: 16384 },
  byobuKeybindings: false,
  followTerminalCwd: false,
  deterministicSessionNames: false,
  tmuxPauseMode: false,
  tmuxFormatSubscriptions: false,
  workgraphColumnsSoftCap: 2,
  wrapLines: false,
};

/** Upper sanity bound for the idle timeout (minutes) — one day. */
export const SESSION_IDLE_TIMEOUT_MAX_MIN = 1440;

/** Bounds for the workgraph columns soft cap (comfortable column count). */
export const WORKGRAPH_COLUMNS_SOFT_CAP_MIN = 1;
export const WORKGRAPH_COLUMNS_SOFT_CAP_MAX = 6;

/** Floor for the dev-env memory cap (MB). Below this a tmux server can't run. */
export const DEV_ENV_MEMORY_MIN_MB = 256;

export interface SelectOptionDef {
  value: string;
  label: string;
}

export const THEME_OPTIONS: SelectOptionDef[] = [
  { value: 'solarized-dark', label: 'Solarized Dark' },
  { value: 'solarized-light', label: 'Solarized Light' },
];

export const FONT_FAMILY_OPTIONS: SelectOptionDef[] = [
  'SF Mono',
  'Menlo',
  'Monaco',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Source Code Pro',
  'IBM Plex Mono',
  'Consolas',
  'monospace',
].map((f) => ({ value: f, label: f }));

export const FONT_SIZE_OPTIONS: SelectOptionDef[] = [10, 11, 12, 13, 14, 15, 16, 18, 20].map((n) => ({
  value: String(n),
  label: `${n}px`,
}));

export const TERMINAL_BACKEND_OPTIONS: SelectOptionDef[] = [
  { value: 'session-per-tab', label: 'Session per tab' },
  { value: 'control-mode', label: 'tmux control mode (-CC)' },
];

export const TERMINAL_RENDERER_OPTIONS: SelectOptionDef[] = [
  { value: 'dom', label: 'xterm.js — DOM (default)' },
  { value: 'webgl', label: 'xterm.js — WebGL (experimental)' },
  { value: 'wterm', label: 'wterm — DOM + libghostty (experimental)' },
];

export const DEV_ENV_MODE_OPTIONS: SelectOptionDef[] = [
  { value: 'systemd-scope', label: 'systemd scope (memory-capped)' },
  { value: 'tmux', label: 'Straight tmux (no cap)' },
];

/** Full font-family stack (chosen family + monospace fallback) for CSS/xterm. */
export function fontStack(family: string): string {
  return family === 'monospace' ? 'monospace' : `'${family}', ui-monospace, monospace`;
}

/** Merge a partial/untrusted config object onto defaults with light validation. */
export function normalizeSettings(input: unknown): AppSettings {
  const o = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>;
  const theme: ThemeId = o.theme === 'solarized-light' ? 'solarized-light' : 'solarized-dark';
  const fontFamily =
    typeof o.fontFamily === 'string' && o.fontFamily.length > 0 ? o.fontFamily : DEFAULT_SETTINGS.fontFamily;
  const fontSize =
    typeof o.fontSize === 'number' && o.fontSize >= 8 && o.fontSize <= 32
      ? o.fontSize
      : DEFAULT_SETTINGS.fontSize;
  const terminalBackend: TerminalBackend =
    o.terminalBackend === 'session-per-tab' ? 'session-per-tab' : 'control-mode';
  const terminalRenderer: TerminalRenderer =
    o.terminalRenderer === 'webgl' ? 'webgl' : o.terminalRenderer === 'wterm' ? 'wterm' : 'dom';
  const showAllChanges = o.showAllChanges === true;
  const showRunPanel = o.showRunPanel === true;
  const byobuKeybindings = o.byobuKeybindings === true;
  const followTerminalCwd = o.followTerminalCwd === true;
  const deterministicSessionNames = o.deterministicSessionNames === true;
  const tmuxPauseMode = o.tmuxPauseMode === true;
  const tmuxFormatSubscriptions = o.tmuxFormatSubscriptions === true;
  const wrapLines = o.wrapLines === true;
  // Idle timeout: 0 = disabled; reject negatives/non-numbers -> default; clamp
  // to an upper sanity bound. Mirrors the fontSize precedent (validate then
  // fall back to the default on invalid input).
  const rawIdle = o.sessionIdleTimeoutMin;
  const sessionIdleTimeoutMin =
    typeof rawIdle === 'number' && Number.isFinite(rawIdle) && rawIdle >= 0
      ? Math.min(Math.floor(rawIdle), SESSION_IDLE_TIMEOUT_MAX_MIN)
      : DEFAULT_SETTINGS.sessionIdleTimeoutMin;
  // devEnv: mode falls back to the default on anything but the two valid values;
  // memoryMaxMb must be a finite number >= the floor (else default), floored.
  const dm = (o.devEnv && typeof o.devEnv === 'object' ? o.devEnv : {}) as Partial<DevEnvConfig>;
  const devEnvMode: DevEnvMode = dm.mode === 'tmux' ? 'tmux' : 'systemd-scope';
  const rawMem = dm.memoryMaxMb;
  const memoryMaxMb =
    typeof rawMem === 'number' && Number.isFinite(rawMem) && rawMem >= DEV_ENV_MEMORY_MIN_MB
      ? Math.floor(rawMem)
      : DEFAULT_SETTINGS.devEnv.memoryMaxMb;
  const devEnv: DevEnvConfig = { mode: devEnvMode, memoryMaxMb };
  // Columns soft cap: finite integer clamped to [MIN, MAX]; else default.
  const rawCap = o.workgraphColumnsSoftCap;
  const workgraphColumnsSoftCap =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= WORKGRAPH_COLUMNS_SOFT_CAP_MIN
      ? Math.min(Math.floor(rawCap), WORKGRAPH_COLUMNS_SOFT_CAP_MAX)
      : DEFAULT_SETTINGS.workgraphColumnsSoftCap;
  return {
    theme,
    fontFamily,
    fontSize,
    terminalBackend,
    terminalRenderer,
    showAllChanges,
    showRunPanel,
    sessionIdleTimeoutMin,
    devEnv,
    byobuKeybindings,
    followTerminalCwd,
    deterministicSessionNames,
    tmuxPauseMode,
    tmuxFormatSubscriptions,
    workgraphColumnsSoftCap,
    wrapLines,
  };
}
