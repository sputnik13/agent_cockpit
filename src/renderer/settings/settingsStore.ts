import { create } from 'zustand';
import { DEFAULT_SETTINGS, fontStack, type AppSettings } from '@shared/settings';

/**
 * Renderer settings store. Loads from the persisted config file via IPC, applies
 * theme + font live (data-theme attribute swaps the token palette; CSS vars feed
 * the terminal/code surfaces), and persists changes. Also owns the Preferences
 * dialog open state.
 */
interface SettingsState {
  settings: AppSettings;
  open: boolean;
  /** System font families (loaded lazily); empty until fetched. */
  fonts: string[];
  load: () => Promise<void>;
  loadFonts: () => Promise<void>;
  set: (patch: Partial<AppSettings>) => Promise<void>;
  setOpen: (open: boolean) => void;
}

function applySettings(s: AppSettings): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', s.theme);
  root.style.setProperty('--font-mono', fontStack(s.fontFamily));
  root.style.setProperty('--mono-size', `${s.fontSize}px`);
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  open: false,
  fonts: [],

  loadFonts: async () => {
    if (get().fonts.length > 0) return;
    try {
      const fonts = await window.api.settings.listFonts();
      set({ fonts });
    } catch {
      /* keep empty -> dialog falls back to the curated list */
    }
  },

  load: async () => {
    try {
      const settings = await window.api.settings.get();
      applySettings(settings);
      set({ settings });
    } catch {
      applySettings(DEFAULT_SETTINGS);
    }
  },

  set: async (patch) => {
    // Optimistic apply for instant feedback, then persist.
    const next = { ...get().settings, ...patch };
    applySettings(next);
    set({ settings: next });
    try {
      const saved = await window.api.settings.set(patch);
      applySettings(saved);
      set({ settings: saved });
    } catch {
      /* keep optimistic value */
    }
  },

  setOpen: (open) => set({ open }),
}));

/** Apply settings on boot and keep in sync with external changes. */
export function initSettingsSync(): () => void {
  void useSettingsStore.getState().load();
  return window.api.events.onSettingsChanged((s) => {
    applySettings(s);
    useSettingsStore.setState({ settings: s });
  });
}
