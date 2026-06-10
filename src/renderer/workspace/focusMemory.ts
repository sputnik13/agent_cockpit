/**
 * Per-project focus memory — small localStorage helpers so the workbench can
 * remember and restore focus-ish state across project switches (active terminal
 * pane, focused panel, panel selections). Mirrors the existing per-project
 * persistence pattern in `layoutKeys.ts` / `beadsStore.viewKey`.
 *
 * Best-effort: all access is wrapped so a disabled/quota-exceeded localStorage
 * degrades to "no memory" rather than throwing.
 */

const FOCUS_VERSION = 1;

/** localStorage key for a namespaced per-project focus value. */
function focusKey(ns: string, projectId: string): string {
  return `agent-cockpit:focus:${ns}:v${FOCUS_VERSION}:${projectId}`;
}

/** Read a remembered value for (ns, projectId); null if absent/unreadable. */
export function readFocus(ns: string, projectId: string | null): string | null {
  if (!projectId) return null;
  try {
    return localStorage.getItem(focusKey(ns, projectId));
  } catch {
    return null;
  }
}

/** Write (or, when value is null, clear) a remembered value. No-op on error. */
export function writeFocus(ns: string, projectId: string | null, value: string | null): void {
  if (!projectId) return;
  try {
    if (value === null) {
      localStorage.removeItem(focusKey(ns, projectId));
    } else {
      localStorage.setItem(focusKey(ns, projectId), value);
    }
  } catch {
    // best-effort; ignore quota/access errors
  }
}
