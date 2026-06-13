import { useEffect, useRef, useState } from 'react';
import { agentCockpit, selectActiveProject, useProjectsStore } from '../providerClient';
import { XtermView } from '../terminal/XtermView';
import * as registry from '../terminal/terminalRegistry';
import { useSettingsStore } from '../settings';
import { usePanelFocusOverride } from '../workspace/panelFocusContext';
import { selectActiveView, useTmuxStore } from '../tmux/tmuxStore';
import { PaneXterm, firstPaneId } from '../tmux/PaneXterm';
import {
  RUN_WINDOW,
  acquireControlSession,
  controlBridgeReady,
  createReservedWindow,
  releaseControlSession,
  whenReady,
} from '../tmux/controlSession';
import { Button, EmptyState, IconButton } from '../ui';

/**
 * Per-project Run surface: an editable command bound to the active project's
 * persisted run command, plus a persistent tty with Run/Stop controls. The tty
 * backend follows the terminal-backend setting: in `session-per-tab` mode it is
 * a dedicated `run` tmux session via XtermView; in `control-mode` it is the
 * control session's `run-1` window pane.
 */
const RUN_KEY = 'run';

export function RunPanel(): JSX.Element {
  const backend = useSettingsStore((s) => s.settings.terminalBackend);
  const activeId = useProjectsStore((s) => s.activeId);
  const project = useProjectsStore(selectActiveProject);
  const setRunCommand = useProjectsStore((s) => s.setRunCommand);
  const saved = project?.runCommand ?? '';
  const [draft, setDraft] = useState(saved);
  const [resetToken, setResetToken] = useState(0);

  const control = backend === 'control-mode';
  const windowOrder = useTmuxStore((s) => selectActiveView(s).windowOrder);
  const windows = useTmuxStore((s) => selectActiveView(s).windows);
  const runWindowId = control ? windowOrder.find((id) => windows[id]?.name === RUN_WINDOW) ?? null : null;
  const runPaneId = control && runWindowId ? firstPaneId(windows[runWindowId]?.layout ?? null) : null;
  // Per-project guard so the on-demand create fires at most once per project
  // (runWindowId stays null until tmux's %window-add lands in the store).
  const creatingRunFor = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Activating the Run panel focuses the command input (no-ops before a project
  // is selected, when the input is not rendered).
  usePanelFocusOverride(() => inputRef.current?.focus());

  // Rebind the field when the active project (or its saved command) changes.
  useEffect(() => {
    setDraft(saved);
  }, [activeId, saved]);

  // In control mode, share the project's control session with the terminal panel.
  useEffect(() => {
    if (!control || !activeId || !controlBridgeReady()) return;
    acquireControlSession(activeId);
    return () => releaseControlSession();
  }, [control, activeId]);

  // On-demand creation: opening the Run panel while `showRunPanel` is off (so
  // ensureWindows never created `run-1`) creates the window now. Guarded per
  // project so it fires once; reconcile keeps that single survivor afterward.
  useEffect(() => {
    if (!control || !activeId || !controlBridgeReady()) return;
    if (runWindowId || creatingRunFor.current === activeId) return;
    creatingRunFor.current = activeId;
    void whenReady(activeId).then(() => createReservedWindow(RUN_WINDOW));
  }, [control, activeId, runWindowId]);

  if (!activeId) {
    return (
      <EmptyState title="No active project" hint="Select a project to configure a run command." />
    );
  }

  const persist = (): void => {
    const next = draft.trim();
    if (next !== saved) void setRunCommand(activeId, next.length > 0 ? next : null);
  };

  const sendToTty = (data: string): void => {
    if (control) {
      if (runPaneId) void useTmuxStore.getState().sendInput(activeId, runPaneId, data);
    } else {
      void agentCockpit.terminal.write(RUN_KEY, data);
    }
  };

  const run = (): void => {
    const cmd = draft.trim();
    if (!cmd) return;
    persist();
    sendToTty(`${cmd}\n`);
  };
  const stop = (): void => sendToTty('\x03'); // Ctrl-C
  const reset = (): void => {
    if (control) {
      if (runPaneId) void useTmuxStore.getState().command(`respawn-pane -k -t ${runPaneId}`);
    } else {
      void registry.reset(activeId, 'run', RUN_KEY).then(() => setResetToken((n) => n + 1));
    }
  };

  const field =
    'w-full rounded border border-edge bg-bg px-2 py-1 font-mono text-[13px] text-fg outline-none focus-visible:border-accent';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge bg-panel px-2 py-1.5">
        <input
          ref={inputRef}
          className={field}
          placeholder="Run command (e.g. npm run dev)"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={persist}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              run();
            }
          }}
        />
        <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={run}>
          Run
        </Button>
        <Button size="sm" onClick={stop}>
          Stop
        </Button>
        <IconButton label="Reset run tty" size="sm" onClick={reset}>
          ⟳
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {control ? (
          runPaneId ? (
            <PaneXterm projectId={activeId} paneId={runPaneId} />
          ) : (
            <EmptyState title="Starting run window…" />
          )
        ) : (
          <XtermView
            projectId={activeId}
            terminalKey={RUN_KEY}
            kind="run"
            visible
            resetToken={resetToken}
          />
        )}
      </div>
    </div>
  );
}
