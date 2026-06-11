import { useEffect, useState } from 'react';
import { useProjectsStore } from '../providerClient';
import { useTerminalsStore } from './terminalsStore';
import { XtermView } from './XtermView';
import * as registry from './terminalRegistry';
import { SessionsDialog } from '../sessions';
import { ControlTerminalPanel } from '../tmux/ControlTerminalPanel';
import { useSettingsStore } from '../settings';
import { Button, EmptyState, IconButton, TabbedPanelHeader, cn } from '../ui';

/**
 * Terminal dock panel. Switches between the session-per-tab backend and the
 * tmux control-mode (-CC) backend based on the persisted setting. Only the
 * selected backend's component mounts, so the other's sessions/effects stay
 * inert.
 */
export function TerminalPanel(): JSX.Element {
  const backend = useSettingsStore((s) => s.settings.terminalBackend);
  return backend === 'control-mode' ? <ControlTerminalPanel /> : <SessionTerminalPanel />;
}

/**
 * Embedded terminal surface: a tab strip of independent terminals (each its own
 * persistent tmux session) plus the active terminal's xterm. Switching tabs is
 * client-side only; the other IDE panels do not follow terminal focus.
 */
function SessionTerminalPanel(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const keys = useTerminalsStore((s) => s.keys);
  const activeKey = useTerminalsStore((s) => s.activeKey);
  const init = useTerminalsStore((s) => s.init);
  const add = useTerminalsStore((s) => s.add);
  const close = useTerminalsStore((s) => s.close);
  const setActive = useTerminalsStore((s) => s.setActive);
  // Per-key reset counter; bumping it re-acquires that terminal's xterm.
  const [resetTokens, setResetTokens] = useState<Record<string, number>>({});
  const [sessionsOpen, setSessionsOpen] = useState(false);

  useEffect(() => {
    void init();
  }, [activeId, init]);

  // Ctrl+` (handled in CockpitWorkspace) asks us to focus the active terminal.
  useEffect(() => {
    const onFocus = (): void => registry.focusEntry(activeId, 'terminal', activeKey);
    window.addEventListener(registry.FOCUS_TERMINAL_EVENT, onFocus);
    return () => window.removeEventListener(registry.FOCUS_TERMINAL_EVENT, onFocus);
  }, [activeId, activeKey]);

  if (!activeId) {
    return <EmptyState title="No active project" hint="Select a project to start a terminal." />;
  }

  // Reset the active tab: detach the host PTY, then re-acquire to reattach the
  // tmux session fresh (token bump must follow the await so re-open happens after
  // the old node-pty is gone, not alongside it).
  const resetActive = async (): Promise<void> => {
    if (!activeKey) return;
    await registry.reset(activeId, 'terminal', activeKey);
    setResetTokens((t) => ({ ...t, [activeKey]: (t[activeKey] ?? 0) + 1 }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <TabbedPanelHeader
        tabs={
          <>
            {keys.map((k) => (
              <div
                key={k}
                onClick={() => setActive(k)}
                className={cn(
                  'group flex cursor-pointer items-center gap-1 border-t-2 px-2.5 py-1 text-xs',
                  k === activeKey
                    ? 'border-accent bg-bg text-fg'
                    : 'border-transparent text-dim hover:bg-elev hover:text-fg',
                )}
              >
                <span>{k}</span>
                {keys.length > 1 && (
                  <span
                    role="button"
                    aria-label={`Close terminal ${k}`}
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      // Tear down the renderer instance; store.close kills the session.
                      registry.dispose(activeId, 'terminal', k);
                      void close(k);
                    }}
                  >
                    ×
                  </span>
                )}
              </div>
            ))}
            <IconButton label="New terminal" size="sm" onClick={() => add()}>
              +
            </IconButton>
          </>
        }
        actions={
          <>
            <IconButton
              label="Reset terminal (reattach session)"
              size="sm"
              disabled={!activeKey}
              onClick={() => void resetActive()}
            >
              ⟳
            </IconButton>
            <Button size="sm" title="Manage sessions" onClick={() => setSessionsOpen(true)}>
              Sessions
            </Button>
          </>
        }
      />
      <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
      <div className="relative min-h-0 flex-1">
        {keys.map((k) => (
          <div key={k} className="absolute inset-0">
            <XtermView
              projectId={activeId}
              terminalKey={k}
              visible={k === activeKey}
              resetToken={resetTokens[k] ?? 0}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
