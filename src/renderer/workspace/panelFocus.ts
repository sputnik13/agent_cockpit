import type { PanelId } from './panelIds';

/**
 * The single seam that routes KEYBOARD (DOM) focus to a panel by id.
 *
 * Visual focus — which Dockview panel/tab is active — is owned by Dockview
 * (`panel.api.setActive()`). Keyboard focus is a separate concern: activating a
 * panel does not move DOM focus into it. This registry closes that gap. Each
 * mounted panel registers a focus handler (PanelHost installs a default;
 * terminal/run override it), and the activation sites in CockpitWorkspace call
 * `focusPanel`/`focusPanelForce` to move keyboard focus through it.
 *
 * Three behaviors make it robust against the real ordering/threading:
 * - **Pending focus:** `focusPanel` for a panel whose handler has not mounted
 *   yet (the common `addPanel` case — the activation event fires before the new
 *   panel's effect registers) records the id as pending; the handler fires the
 *   moment it registers.
 * - **Suppression:** programmatic layout/preset application activates panels in
 *   a cascade; `focusPanel` is a no-op while suppressed so focus does not thrash.
 * - **Force:** explicit restore / Ctrl+` use `focusPanelForce` to move focus
 *   even while suppressed.
 */

type FocusHandler = () => void;

const handlers = new Map<PanelId, FocusHandler>();
let pending: PanelId | null = null;
let suppressed = false;

/**
 * Register a panel's focus handler. Returns an unregister function that only
 * removes the handler if it is still the current one (so a remount that
 * re-registers before the old cleanup runs is not clobbered). If a focus was
 * requested for this id before it mounted, the handler fires immediately.
 */
export function registerPanelFocus(id: PanelId, handler: FocusHandler): () => void {
  handlers.set(id, handler);
  if (pending === id) {
    pending = null;
    handler();
  }
  return () => {
    if (handlers.get(id) === handler) handlers.delete(id);
  };
}

function dispatch(id: PanelId): void {
  const handler = handlers.get(id);
  if (handler) {
    pending = null; // a concrete focus happened; drop any stale pending target
    handler();
  } else {
    pending = id; // focus once the handler registers
  }
}

/** Move keyboard focus into a panel, unless focus is currently suppressed. */
export function focusPanel(id: PanelId): void {
  if (suppressed) return;
  dispatch(id);
}

/** Move keyboard focus into a panel even while suppressed (explicit intent). */
export function focusPanelForce(id: PanelId): void {
  dispatch(id);
}

/** Toggle focus suppression around programmatic layout/preset application. */
export function setFocusSuppressed(value: boolean): void {
  suppressed = value;
}

/** Run `fn` with focus suppressed, restoring the prior flag afterward. */
export function withFocusSuppressed<T>(fn: () => T): T {
  const prev = suppressed;
  suppressed = true;
  try {
    return fn();
  } finally {
    suppressed = prev;
  }
}

/** Test-only: reset all module state. */
export function __resetPanelFocusForTest(): void {
  handlers.clear();
  pending = null;
  suppressed = false;
}
