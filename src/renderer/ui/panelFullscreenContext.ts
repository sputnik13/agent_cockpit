/**
 * Panel fullscreen (maximize/restore) context.
 *
 * The Dockview panel host (`workspace/panels.tsx`) provides this around every
 * hosted panel so the shared {@link import('./Panel').PanelHeader} can render a
 * maximize/restore control without any per-panel wiring. The value is sourced
 * from the live Dockview panel API, and the host re-renders on
 * `onDidMaximizedGroupChange`, so `isMaximized` tracks maximize/restore even when
 * it is driven from elsewhere.
 *
 * Outside a Dockview host (tests, standalone mounts) the context is `null`, and
 * the header renders no control — a safe no-op rather than a dead button. The
 * context lives in `ui/` so the dependency points inward (workspace imports the
 * Provider from ui; ui never imports workspace).
 */
import { createContext, useContext } from 'react';

export interface PanelFullscreenState {
  /** Whether this panel's group is currently maximized. */
  isMaximized: boolean;
  /** Maximize the panel's group, or restore it if already maximized. */
  toggle: () => void;
}

const PanelFullscreenContext = createContext<PanelFullscreenState | null>(null);

/** Provider — wraps each hosted panel with its live maximize state. */
export const PanelFullscreenProvider = PanelFullscreenContext.Provider;

/** Read the current panel's fullscreen state, or `null` outside a host. */
export function usePanelFullscreen(): PanelFullscreenState | null {
  return useContext(PanelFullscreenContext);
}
