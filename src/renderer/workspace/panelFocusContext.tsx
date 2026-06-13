import { createContext, useContext, useEffect, useRef } from 'react';

/**
 * Lets a panel override PanelHost's default keyboard-focus behavior with its own
 * focus target — e.g. the terminal focuses its active xterm pane, the Run panel
 * focuses its command input — instead of focusing the panel's wrapper root.
 *
 * PanelHost provides the setter; a panel calls `usePanelFocusOverride` to install
 * its handler while mounted. The override is cleared on unmount so the default
 * (focus the wrapper) applies again.
 */
type SetFocusOverride = (handler: (() => void) | null) => void;

const PanelFocusContext = createContext<SetFocusOverride | null>(null);

export const PanelFocusProvider = PanelFocusContext.Provider;

/**
 * Register this panel's focus handler with its PanelHost. The handler may be an
 * inline closure — it is held in a ref and called via a stable wrapper, so the
 * override is installed once on mount and cleared on unmount (no re-register
 * churn when the component re-renders).
 */
export function usePanelFocusOverride(handler: () => void): void {
  const setOverride = useContext(PanelFocusContext);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!setOverride) return;
    setOverride(() => ref.current());
    return () => setOverride(null);
  }, [setOverride]);
}
