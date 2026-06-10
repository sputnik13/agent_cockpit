import { create } from 'zustand';
import type { ConnectionStatus } from '@shared/providers/types';

/**
 * Per-project connection/session state, fed by the main process's status
 * events. Drives the rail state dots and the status region. Every live session
 * (including backgrounded ones) keeps its connection state here; panels and
 * panelDataSync are pure derivations of it (the ConnectionMachine in main is the
 * single owner — CLAUDE.md).
 */
interface SessionState {
  statuses: Record<string, ConnectionStatus>;
  setStatus: (projectId: string, status: ConnectionStatus) => void;
  clear: (projectId: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  statuses: {},
  setStatus: (projectId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [projectId]: status } })),
  clear: (projectId) =>
    set((s) => {
      const next = { ...s.statuses };
      delete next[projectId];
      return { statuses: next };
    }),
}));

/** Subscribe the session store to main's status events. Call once at app start.
 *
 * Subscribes to the evt:status PUSH first, then hydrates from a one-shot PULL of
 * main's current snapshot. A renderer reload resets this store to empty and main
 * only pushes on transitions, so without the snapshot a still-connected session
 * renders as 'disconnected' until the next transition. The snapshot only fills
 * projects not already set by a push that raced in during hydration, so it never
 * clobbers newer truth. Main's ConnectionMachine stays the single owner. */
export function initSessionSync(): () => void {
  const off = window.api.events.onStatus((e) => {
    useSessionStore.getState().setStatus(e.projectId, e.status);
  });
  void window.api.provider.getStatuses().then((statuses) => {
    for (const [projectId, status] of Object.entries(statuses)) {
      const store = useSessionStore.getState();
      if (!store.statuses[projectId]) store.setStatus(projectId, status);
    }
  });
  return off;
}

export const selectStatus =
  (projectId: string | null) =>
  (s: SessionState): ConnectionStatus | null =>
    projectId ? (s.statuses[projectId] ?? null) : null;

/** True when the project's provider is in the `connected` state. */
export const isConnected =
  (projectId: string | null) =>
  (s: SessionState): boolean =>
    projectId ? s.statuses[projectId]?.state === 'connected' : false;

/** True when the project's provider is in `disconnected` or `failed` state. */
export const isDisconnected =
  (projectId: string | null) =>
  (s: SessionState): boolean => {
    if (!projectId) return false;
    const state = s.statuses[projectId]?.state;
    return state === 'disconnected' || state === 'failed';
  };
