import type { MuxSessionInfo } from '@shared/providers/types';

export interface MuxTabState {
  broadcast: Record<string, boolean>;
  scope: Record<string, 'window' | 'session'>;
}

/** Project-scoped daemon inventory is the authority for mux tab controls. */
export function muxTabState(
  sessions: Array<MuxSessionInfo & { projectId: string }>,
  projectId: string,
): MuxTabState {
  const broadcast: Record<string, boolean> = {};
  const scope: Record<string, 'window' | 'session'> = {};
  for (const session of sessions) {
    if (session.projectId !== projectId || !session.key) continue;
    broadcast[session.key] = session.broadcast;
    scope[session.key] = session.broadcastScope;
  }
  return { broadcast, scope };
}
