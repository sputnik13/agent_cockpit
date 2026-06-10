import { useState } from 'react';
import { useProjectsStore, useSessionStore, selectActiveProject, selectStatus } from '../providerClient';
import type { ConnectionState } from '@shared/providers/types';
import { Badge, Button, StatusDot } from '../ui';

const STATE_TONE: Record<ConnectionState, 'neutral' | 'accent' | 'added' | 'removed' | 'warn'> = {
  disconnected: 'neutral',
  connecting: 'warn',
  connected: 'added',
  reconnecting: 'warn',
  failed: 'removed',
};

/**
 * The clickable connection-state control for remote projects. Clicking when
 * connected shows an inline confirm→disconnect affordance (mirrors the
 * ManageProjectRow pattern). Clicking when disconnected/failed triggers
 * reconnect immediately. In-flight states (connecting/reconnecting) are
 * shown as non-interactive/pulsing.
 */
function ConnectionToggle({
  state,
  onDisconnect,
  onReconnect,
}: {
  state: ConnectionState;
  onDisconnect: () => void;
  onReconnect: () => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const inFlight = state === 'connecting' || state === 'reconnecting';

  if (inFlight) {
    // Non-interactive while connecting/reconnecting — just render the label.
    return <span className="text-dim">{state}</span>;
  }

  if (state === 'connected') {
    if (confirming) {
      return (
        <>
          <span className="text-dim">Disconnect?</span>
          <Button
            size="sm"
            variant="danger"
            onClick={() => {
              setConfirming(false);
              onDisconnect();
            }}
          >
            Confirm
          </Button>
          <Button size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      );
    }
    return (
      <button
        type="button"
        className="cursor-pointer underline-offset-2 hover:underline"
        title="Click to disconnect"
        onClick={() => setConfirming(true)}
      >
        {state}
      </button>
    );
  }

  // disconnected or failed — click reconnects immediately (no confirm needed).
  return (
    <button
      type="button"
      className="cursor-pointer underline-offset-2 hover:underline"
      title="Click to reconnect"
      onClick={onReconnect}
    >
      {state}
    </button>
  );
}

/** Bottom status bar: active project + live connection state + recovery. */
export function StatusRegion(): JSX.Element {
  const active = useProjectsStore(selectActiveProject);
  const disconnect = useProjectsStore((s) => s.disconnect);
  const reconnect = useProjectsStore((s) => s.reconnect);
  const status = useSessionStore(selectStatus(active?.id ?? null));
  const state: ConnectionState = status?.state ?? 'disconnected';

  return (
    <div className="flex h-6 shrink-0 items-center gap-2 border-t border-edge bg-panel px-2 text-[11px] text-dim">
      {active ? (
        <>
          <StatusDot
            tone={STATE_TONE[state]}
            pulse={state === 'connecting' || state === 'reconnecting'}
          />
          <span className="text-fg">{active.label}</span>
          <Badge tone={active.kind === 'remote' ? 'warn' : 'neutral'}>{active.kind}</Badge>
          {active.kind === 'remote' ? (
            <ConnectionToggle
              state={state}
              onDisconnect={() => {
                // Disconnect errors are best-effort; state propagates via evtStatus.
                void disconnect(active.id).catch(() => {});
              }}
              onReconnect={() => {
                // Reconnect errors surface via evtStatus (state=failed + detail).
                void reconnect(active.id).catch(() => {});
              }}
            />
          ) : (
            <span>{state}</span>
          )}
          {status?.detail && <span className="truncate">· {status.detail}</span>}
        </>
      ) : (
        <span>No active project</span>
      )}
      <span className="flex-1" />
      <span>Agent Cockpit</span>
    </div>
  );
}
