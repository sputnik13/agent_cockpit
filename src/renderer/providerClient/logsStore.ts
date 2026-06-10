import { create } from 'zustand';
import type { LogEntry, LogLevel } from '@shared/ipc/channels';

const LOGS_CAP = 1000;

/**
 * Renderer-side log store. Entries are fed by the main-process ring buffer
 * (fetched once at init) and then kept live by the evt:log push subscription.
 * Capped at LOGS_CAP entries (oldest dropped) to mirror the main buffer.
 */
interface LogsState {
  entries: LogEntry[];
  addEntry: (entry: LogEntry) => void;
  clearEntries: () => void;
}

export const useLogsStore = create<LogsState>((set) => ({
  entries: [],
  addEntry: (entry) =>
    set((s) => {
      const next = [...s.entries, entry];
      return { entries: next.length > LOGS_CAP ? next.slice(next.length - LOGS_CAP) : next };
    }),
  clearEntries: () => set({ entries: [] }),
}));

/**
 * Record a renderer-originated diagnostic entry into the local log store and
 * mirror it to the console. The renderer logs API is read-only (no main-process
 * append channel), so a renderer-side event lives in this store (surfaced by the
 * LogViewer in the same renderer) plus a console mirror — the established
 * renderer logging path for events that do not originate in the main process.
 */
export function logDiagnostic(
  level: LogLevel,
  context: string,
  message: string,
): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, context, message };
  useLogsStore.getState().addEntry(entry);
  const line = `[${context}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

/**
 * Fetch the main-process ring buffer once, then subscribe to new entries.
 * Call once at app start. Returns an unsubscribe function.
 */
export function initLogsSync(): () => void {
  // Seed from the ring buffer.
  void window.api.logs.get().then((entries) => {
    const state = useLogsStore.getState();
    for (const e of entries) state.addEntry(e);
  });
  // Subscribe to live entries.
  return window.api.events.onLog((e) => {
    useLogsStore.getState().addEntry(e);
  });
}
