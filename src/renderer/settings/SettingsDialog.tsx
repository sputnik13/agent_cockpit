import { useEffect, useMemo } from 'react';
import {
  DEV_ENV_MODE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  FONT_SIZE_OPTIONS,
  TERMINAL_BACKEND_OPTIONS,
  TERMINAL_RENDERER_OPTIONS,
  THEME_OPTIONS,
  type DevEnvMode,
  type SelectOptionDef,
  type TerminalBackend,
  type TerminalRenderer,
  type ThemeId,
} from '@shared/settings';
import { Dialog, Select, Tooltip, cn } from '../ui';
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
    <Dialog open={open} onOpenChange={setOpen} title="Preferences" description="Settings are saved to your config file.">
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
          help="How terminals run: one tmux session per tab, or a single tmux control-mode (-CC) session per project mapping windows to tabs and panes to splits."
        >
          <Select
            aria-label="Terminal backend"
            value={settings.terminalBackend ?? 'control-mode'}
            onValueChange={(v) => void switchTerminalBackend(v as TerminalBackend)}
            options={TERMINAL_BACKEND_OPTIONS}
          />
        </Field>
        <Field
          label="Terminal renderer"
          help="How control-mode panes are drawn. xterm.js DOM is broadly compatible; xterm.js WebGL paints to the GPU (experimental, can briefly show stale cells); wterm renders to the DOM with the libghostty VT core (experimental). Changing this rebuilds the terminal without killing tmux."
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
          help="Enable screen-style shortcuts in the control-mode terminal: Ctrl+a prefix (z=zoom active pane, n/p=next/previous tab, a=send a literal Ctrl+a) plus Shift+Arrow to move between split panes. Off by default; the existing ⌘ shortcuts always work."
        >
          <input
            type="checkbox"
            aria-label="Byobu/screen keybindings"
            checked={settings.byobuKeybindings ?? false}
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
