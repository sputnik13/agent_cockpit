import { useEffect, useMemo, useState } from 'react';
import {
  DEV_ENV_MODE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  MUX_SCROLLBACK_LINES_MAX,
  MUX_SCROLLBACK_LINES_MIN,
  STRUCTURED_FOLD_MAX_MB_MAX,
  STRUCTURED_FOLD_MAX_MB_MIN,
  TERMINAL_BACKEND_OPTIONS,
  TERMINAL_RENDERER_OPTIONS,
  THEME_OPTIONS,
  type DevEnvMode,
  type SelectOptionDef,
  type TerminalBackend,
  type TerminalRenderer,
  type ThemeId,
} from '@shared/settings';
import { Button, Dialog, Select, Tooltip, cn } from '../ui';
import { agentCockpit } from '../providerClient';
import { switchTerminalBackend, switchTerminalRenderer } from '../terminal/backendSwitch';
import { useSettingsStore } from './settingsStore';

/** macOS-style Preferences. Opened via ⌘, (or the gear). Changes apply live. */
export function SettingsDialog(): JSX.Element {
  const open = useSettingsStore((s) => s.open);
  const setOpen = useSettingsStore((s) => s.setOpen);
  const settings = useSettingsStore((s) => s.settings);
  const set = useSettingsStore((s) => s.set);
  const fonts = useSettingsStore((s) => s.fonts);
  const loadFonts = useSettingsStore((s) => s.loadFonts);
  const [confirmMuxShutdown, setConfirmMuxShutdown] = useState(false);
  const [muxShutdownMessage, setMuxShutdownMessage] = useState<string | null>(null);

  // Enumerate system fonts the first time the dialog opens.
  useEffect(() => {
    if (open) void loadFonts();
  }, [open, loadFonts]);

  // Prefer the full system font list; fall back to the curated set. Always
  // include the current value so the Select shows it even if enumeration fails.
  // Memoized for a stable array identity so the Select's options don't churn
  // every render (which made Radix flip its controlled state).
  const fontOptions: SelectOptionDef[] = useMemo(() => {
    const base: SelectOptionDef[] =
      fonts.length > 0 ? fonts.map((f) => ({ value: f, label: f })) : FONT_FAMILY_OPTIONS;
    return base.some((o) => o.value === settings.fontFamily)
      ? base
      : [{ value: settings.fontFamily, label: settings.fontFamily }, ...base];
  }, [fonts, settings.fontFamily]);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Preferences"
      description="Settings are saved to your config file."
    >
      <div className="flex flex-col gap-3">
        <Field label="Color theme" help="Light or dark color palette for the whole app.">
          <Select
            aria-label="Color theme"
            value={settings.theme}
            onValueChange={(v) => void set({ theme: v as ThemeId })}
            options={THEME_OPTIONS}
          />
        </Field>
        <Field label="Font family" help="Monospace font for the terminal and the code/diff views.">
          <Select
            aria-label="Font family"
            value={settings.fontFamily}
            onValueChange={(v) => void set({ fontFamily: v })}
            options={fontOptions}
          />
        </Field>
        <Field label="Font size" help="Base monospace text size, in pixels.">
          <Select
            aria-label="Font size"
            value={String(settings.fontSize)}
            onValueChange={(v) => void set({ fontSize: Number(v) })}
            options={FONT_SIZE_OPTIONS}
          />
        </Field>
        <Field
          label="Terminal backend"
          help="Choose tmux session tabs, tmux control mode, or the Ghostty-backed Cockpit mux for local and remote projects."
        >
          <Select
            aria-label="Terminal backend"
            value={settings.terminalBackend ?? 'control-mode'}
            onValueChange={(v) => void switchTerminalBackend(v as TerminalBackend)}
            options={TERMINAL_BACKEND_OPTIONS}
          />
        </Field>
        <Field
          label="Cockpit mux daemon"
          help="Stops existing experimental mux daemons only after their live sessions are explicitly destroyed. This never starts a daemon just to stop it."
        >
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="danger"
              onClick={() => {
                if (!confirmMuxShutdown) {
                  setConfirmMuxShutdown(true);
                  setMuxShutdownMessage(
                    'Confirm to stop all currently connected Cockpit mux daemons.',
                  );
                  return;
                }
                void agentCockpit.muxSessions.shutdown().then((failedProjectIds) => {
                  setConfirmMuxShutdown(false);
                  setMuxShutdownMessage(
                    failedProjectIds.length === 0
                      ? 'Cockpit mux daemons stopped.'
                      : `Could not stop the mux daemon for ${String(failedProjectIds.length)} project(s).`,
                  );
                });
              }}
            >
              {confirmMuxShutdown ? 'Confirm shutdown' : 'Shut down Cockpit mux'}
            </Button>
            {muxShutdownMessage && <span className="text-xs text-dim">{muxShutdownMessage}</span>}
          </div>
        </Field>
        <Field
          label="Persist Cockpit mux scrollback"
          help="Keep terminal recovery content in Cockpit mux's private database. Turn this off for sensitive hosts: existing stored terminal content is erased the next time a Cockpit mux terminal is opened or reconnected. The optional long-term archive is configured separately."
        >
          <input
            type="checkbox"
            aria-label="Persist Cockpit mux scrollback"
            checked={settings.muxPersistScrollback ?? true}
            onChange={(e) => void set({ muxPersistScrollback: e.target.checked })}
          />
        </Field>
        <Field
          label="Cockpit mux live scrollback lines"
          help="Finite history target per pane (default 10,000). Ghostty trims at page boundaries, so the exact retained count can vary slightly."
        >
          <input
            aria-label="Cockpit mux live scrollback lines"
            type="number"
            min={MUX_SCROLLBACK_LINES_MIN}
            max={MUX_SCROLLBACK_LINES_MAX}
            value={settings.muxScrollbackLines ?? 10_000}
            onChange={(event) => void set({ muxScrollbackLines: Number(event.target.value) })}
          />
        </Field>
        <Field
          label="Terminal renderer"
          help="How terminal panes are drawn. xterm.js DOM is broadly compatible; xterm.js WebGL paints to the GPU (experimental, can briefly show stale cells); wterm renders to the DOM with the libghostty VT core (experimental). Changing this rebuilds the terminal without killing the mux or tmux session."
        >
          <Select
            aria-label="Terminal renderer"
            value={settings.terminalRenderer ?? 'dom'}
            onValueChange={(v) => void switchTerminalRenderer(v as TerminalRenderer)}
            options={TERMINAL_RENDERER_OPTIONS}
          />
        </Field>
        <Field
          label="Show all files in Changes panel"
          help="When off, the Changes panel hides .git and .beads entries (internal stores that are noise in the changeset). They are still watched — only hidden from the list."
        >
          <input
            type="checkbox"
            aria-label="Show all files in Changes panel"
            checked={settings.showAllChanges ?? false}
            onChange={(e) => void set({ showAllChanges: e.target.checked })}
          />
        </Field>
        <Field
          label="Changes panel follows terminal cwd"
          help="When on, the Changes panel auto-selects the worktree matching the active terminal pane's current directory (longest-prefix match). Updates within ~1.5 s of a cd. Off by default."
        >
          <input
            type="checkbox"
            aria-label="Changes panel follows terminal cwd"
            checked={settings.followTerminalCwd ?? false}
            onChange={(e) => void set({ followTerminalCwd: e.target.checked })}
          />
        </Field>
        <Field
          label="Deterministic session names (share across machines)"
          help="Name tmux sessions from a hash of the project root instead of a per-machine id, so opening the same project (especially a remote one) from different client machines attaches to the SAME session. Off by default. Takes effect on the next connect; existing per-machine sessions are left orphaned."
        >
          <input
            type="checkbox"
            aria-label="Deterministic session names"
            checked={settings.deterministicSessionNames ?? false}
            onChange={(e) => void set({ deterministicSessionNames: e.target.checked })}
          />
        </Field>
        <Field
          label="tmux flow control (pause-mode, experimental)"
          help="On tmux >= 3.2, let the server pause a pane's output if the client falls behind (refresh-client -fpause-after), bounding memory for a flooding pane; the client resumes and re-seeds the pane on focus. Off by default — it changes the server output path and should be verified per host. No effect on tmux < 3.2. Takes effect on the next connect."
        >
          <input
            type="checkbox"
            aria-label="tmux flow control (pause-mode)"
            checked={settings.tmuxPauseMode ?? false}
            onChange={(e) => void set({ tmuxPauseMode: e.target.checked })}
          />
        </Field>
        <Field
          label="tmux format subscriptions (titles/mouse, experimental)"
          help="On tmux >= 3.2, use refresh-client -B subscriptions so tmux pushes pane title and mouse-mode changes, instead of scraping titles and polling for mouse mode. Off by default — experimental and host-dependent. On tmux < 3.2 (or off) the scrape/poll path is used. Takes effect on the next connect."
        >
          <input
            type="checkbox"
            aria-label="tmux format subscriptions"
            checked={settings.tmuxFormatSubscriptions ?? false}
            onChange={(e) => void set({ tmuxFormatSubscriptions: e.target.checked })}
          />
        </Field>
        <Field
          label="Workgraph side-by-side columns"
          help="Comfortable number of epic columns in the workgraph Columns view. Up to this many pinned-epic columns fill the panel; pinning more is still allowed but shows a density hint. Raise it (e.g. to 3) if you routinely compare more epics. Default 2."
        >
          <input
            type="number"
            min={1}
            max={6}
            step={1}
            aria-label="Workgraph side-by-side columns"
            className="w-20 rounded border border-dim bg-bg px-2 py-1 text-right text-[13px] text-fg"
            value={settings.workgraphColumnsSoftCap ?? 2}
            onChange={(e) => void set({ workgraphColumnsSoftCap: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Show Run panel"
          help="Show the Run panel and create its dedicated tmux window. Off by default."
        >
          <input
            type="checkbox"
            aria-label="Show Run panel"
            checked={settings.showRunPanel ?? false}
            onChange={(e) => void set({ showRunPanel: e.target.checked })}
          />
        </Field>
        <Field
          label="Byobu/screen keybindings"
          help="Screen-style shortcuts are on by default: Ctrl+a prefix in control-mode, plus Shift+Arrow to move between split panes in either terminal backend. Ctrl+a, then a forwards a literal Ctrl+a to the shell; turn this off to retain readline Ctrl+a. The existing ⌘ shortcuts always work."
        >
          <input
            type="checkbox"
            aria-label="Byobu/screen keybindings"
            checked={settings.byobuKeybindings ?? true}
            onChange={(e) => void set({ byobuKeybindings: e.target.checked })}
          />
        </Field>
        <Field
          label="Idle session timeout (minutes)"
          help="Remote sessions left unused this long are disconnected to free SSH/RPC and memory; the project stays in the list and reconnects when re-selected (server-side tmux is untouched). 0 disables. Local sessions are never aged out."
        >
          <input
            type="number"
            min={0}
            max={1440}
            step={1}
            aria-label="Idle session timeout (minutes)"
            className="w-20 rounded border border-dim bg-bg px-2 py-1 text-right text-[13px] text-fg"
            value={settings.sessionIdleTimeoutMin ?? 20}
            onChange={(e) => void set({ sessionIdleTimeoutMin: Number(e.target.value) })}
          />
        </Field>
        <Field
          label="Dev environment mode"
          help="How each remote project's tmux server is launched. systemd scope caps its memory (and all its panes) on capable Linux hosts (requires 'loginctl enable-linger'); straight tmux runs uncapped. Hosts that can't support the scope fall back to tmux automatically (surfaced as 'uncapped' in diagnostics)."
        >
          <Select
            aria-label="Dev environment mode"
            value={settings.devEnv?.mode ?? 'systemd-scope'}
            onValueChange={(v) =>
              void set({ devEnv: { ...settings.devEnv, mode: v as DevEnvMode } })
            }
            options={DEV_ENV_MODE_OPTIONS}
          />
        </Field>
        <Field
          label="Dev environment memory cap (MB)"
          help="Per-project memory ceiling for systemd scope mode (MemoryMax). A runaway is OOM-killed inside its own scope instead of crashing the host. Default 16384 (16 GB). Ignored in straight-tmux mode."
        >
          <input
            type="number"
            min={256}
            step={256}
            aria-label="Dev environment memory cap (MB)"
            className="w-24 rounded border border-dim bg-bg px-2 py-1 text-right text-[13px] text-fg"
            value={settings.devEnv?.memoryMaxMb ?? 16384}
            onChange={(e) =>
              void set({ devEnv: { ...settings.devEnv, memoryMaxMb: Number(e.target.value) } })
            }
          />
        </Field>
        <Field
          label="Structural fold max size (MB)"
          help="Largest JSON/YAML file the Content panel will structurally fold. Above this size the file falls back to the plain syntax-highlighted line view. Default 10."
        >
          <input
            type="number"
            min={STRUCTURED_FOLD_MAX_MB_MIN}
            max={STRUCTURED_FOLD_MAX_MB_MAX}
            step={1}
            aria-label="Structural fold max size (MB)"
            className="w-20 rounded border border-dim bg-bg px-2 py-1 text-right text-[13px] text-fg"
            value={settings.structuredFoldMaxMb ?? 10}
            onChange={(e) => void set({ structuredFoldMaxMb: Number(e.target.value) })}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}): JSX.Element {
  const labelEl = (
    <span
      className={cn(
        'text-[13px] text-fg',
        help && 'cursor-help underline decoration-dotted decoration-dim underline-offset-4',
      )}
    >
      {label}
    </span>
  );
  return (
    <label className="flex items-center justify-between gap-4">
      {help ? <Tooltip content={help}>{labelEl}</Tooltip> : labelEl}
      {children}
    </label>
  );
}
