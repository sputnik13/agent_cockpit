import type { TerminalBackend, TerminalRenderer } from '@shared/settings';
import { agentCockpit, useProjectsStore } from '../providerClient';
import { useSettingsStore } from '../settings';
import { useTmuxStore } from '../tmux/tmuxStore';
import * as controlPaneRegistry from '../tmux/controlPaneRegistry';
import {
  acquireControlSession,
  controlBridgeReady,
  releaseControlSession,
  resetControlSession,
} from '../tmux/controlSession';
import { useTerminalsStore } from './terminalsStore';
import * as registry from './terminalRegistry';

/**
 * Switch the terminal backend with a clean slate: every cockpit tmux session is
 * killed (both the session-per-tab and control-mode namespaces) and all renderer
 * terminal state is torn down, so the newly selected backend starts fresh. The
 * persisted setting flip remounts the workbench's terminal panel, which then
 * re-initializes for the new backend.
 */
export async function switchTerminalBackend(next: TerminalBackend): Promise<void> {
  if (useSettingsStore.getState().settings.terminalBackend === next) return;

  // Clean slate: kill every session on the cockpit socket.
  try {
    const sessions = await agentCockpit.sessions.list();
    await Promise.all(sessions.map((s) => agentCockpit.sessions.kill(s.name).catch(() => {})));
  } catch {
    // best effort — proceed to reset renderer state regardless
  }

  // Tear down renderer terminal state for both backends.
  registry.disposeAll();
  useTerminalsStore.setState({ keys: [], activeKey: null });
  useTmuxStore.getState().reset();

  // Persist the new backend; the terminal panel remounts and re-initializes.
  await useSettingsStore.getState().set({ terminalBackend: next });
}

/**
 * Switch the control-mode pane renderer (xterm `dom`/`webgl`; `wterm` added by the
 * wterm migration) with a
 * clean rebuild that does NOT kill tmux. After persisting the setting, the active
 * project's control-mode renderer state is torn down and re-acquired — the exact
 * teardown + re-acquire the panel runs on a reconnect — so tmux replays its
 * windows/panes and each pane is re-created on the now-selected adapter while the
 * tmux server/session stays alive. Other projects pick up the new renderer the
 * next time their panes are (re)acquired. No-op when the value is unchanged.
 */
export async function switchTerminalRenderer(next: TerminalRenderer): Promise<void> {
  const store = useSettingsStore.getState();
  if (store.settings.terminalRenderer === next) return;

  // Persist first so panes re-acquired below build on the selected adapter.
  await store.set({ terminalRenderer: next });

  const projectId = useProjectsStore.getState().activeId;
  if (!projectId) return;

  // Teardown (mirrors the panel's disconnect branch): dispose this project's pane
  // terminals, release + reset the control session, and clear its tmux view.
  controlPaneRegistry.disposeProject(projectId);
  releaseControlSession();
  resetControlSession();
  useTmuxStore.getState().resetProject(projectId);

  // Re-acquire (mirrors the panel's reconnect branch) so tmux replays and panes
  // rebuild on the new adapter. Guard on the preload bridge like the panel does.
  controlPaneRegistry.invalidateCellSize();
  if (controlBridgeReady()) acquireControlSession(projectId);
}
