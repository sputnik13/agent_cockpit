/**
 * sessionReaper — the single periodic main-process timer that ages out idle
 * sessions. It scans the live session set on a coarse cadence and ends any
 * session that has gone unused past the configured threshold via the clean
 * `SessionManager.close()` teardown path (eviction listeners + ConnectionMachine
 * disconnect). Aging-out is non-destructive: the project stays in the list and
 * server-side tmux survives, so re-selecting it reconnects on demand.
 *
 * Distinct from the renderer-side pane/terminal reapers (`startReaper`/
 * `sweepIdle` in terminalRegistry.ts / controlPaneRegistry.ts), which GC DOM
 * terminals with the opposite "background output doesn't count" rule. This one
 * is the FIRST periodic timer in the main process.
 *
 * See docs/proposals/_active_session-idle-aging.md.
 */
import type { AppSettings } from '@shared/settings';
import type { ConnectionStatus } from './types';
import { logger } from '../logger';

const CTX = 'session-reaper';

/** Sweep cadence (ms). Coarse and independent of the idle threshold (NFR2). */
export const REAP_INTERVAL_MS = 60_000;

/** Distinct `ConnectionStatus.detail` cue set on an aged-out session (OQ-4). */
export const AGED_OUT_DETAIL = 'idle — aged out (re-select to reconnect)';

/**
 * The subset of SessionManager the reaper depends on. Narrowed to an interface
 * so unit tests can pass a fake with a recording `close` and per-id status.
 */
export interface ReaperSessionManager {
  listOpen(): string[];
  activeProjectId(): string | null;
  get(id: string): { readonly kind: 'local' | 'remote' } | undefined;
  statusOf(id: string): ConnectionStatus | undefined;
  activityOf(id: string): number | undefined;
  close(id: string, detail?: string): Promise<void>;
}

export interface SessionReaperDeps {
  sessionManager: ReaperSessionManager;
  /** Read current settings each sweep so threshold changes apply without restart. */
  loadSettings: () => AppSettings;
  /** Injected clock (epoch ms) for deterministic tests. */
  now: () => number;
}

/** A stop handle for the reaper's interval. */
export interface SessionReaperHandle {
  stop(): void;
}

/**
 * One sweep: end every idle, non-active, settled, REMOTE session whose idle
 * time exceeds the configured threshold. Exported for direct unit testing
 * (tests call this rather than relying on a real setInterval).
 *
 * Candidate gating (per FR1–FR3 + remote-only v1):
 *   - skip the active/focused session (FR2)
 *   - skip non-remote sessions (remote-only v1)
 *   - skip sessions whose status is not `connected` (covers connecting/
 *     reconnecting/failed/disconnected — FR3)
 *   - reap only when `now - lastActivity > thresholdMs`
 *
 * Each `close()` is isolated in try/catch so one failure neither stops the loop
 * nor affects other sessions (FR7). The focus race is closed by re-checking
 * `activeProjectId() !== id` immediately before `close()`.
 */
export async function sweepIdleSessions(deps: SessionReaperDeps): Promise<void> {
  const { sessionManager: sm, loadSettings, now } = deps;
  const timeoutMin = loadSettings().sessionIdleTimeoutMin;
  if (!(timeoutMin > 0)) return; // 0 (or any non-positive) disables aging-out (FR5)
  const thresholdMs = timeoutMin * 60_000;
  const at = now();

  for (const id of sm.listOpen()) {
    if (id === sm.activeProjectId()) continue; // never reap the active session (FR2)
    if (sm.get(id)?.kind !== 'remote') continue; // remote-only aging in v1
    if (sm.statusOf(id)?.state !== 'connected') continue; // only settled live sessions (FR3)

    const lastActivity = sm.activityOf(id) ?? 0;
    if (at - lastActivity <= thresholdMs) continue;

    // Focus race: the user could have activated this session between the scan
    // above and here. Re-check immediately before close().
    if (sm.activeProjectId() === id) continue;

    try {
      await sm.close(id, AGED_OUT_DETAIL);
      logger.info(`aged out idle session '${id}' (idle ${Math.round((at - lastActivity) / 1000)}s)`, CTX);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`failed to age out session '${id}': ${msg}`, CTX);
      // Continue: one failed close must not stop the loop or affect others (FR7).
    }
  }
}

/**
 * Start the periodic idle reaper. Returns a stop handle; call `stop()` on app
 * quit BEFORE `closeAll()` so no tick runs during teardown (FR7, no leaked
 * interval). The interval is `unref`'d so it never keeps the process alive.
 */
export function startSessionReaper(deps: SessionReaperDeps): SessionReaperHandle {
  const timer = setInterval(() => {
    void sweepIdleSessions(deps).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`sweep failed: ${msg}`, CTX);
    });
  }, REAP_INTERVAL_MS);
  timer.unref?.();
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
