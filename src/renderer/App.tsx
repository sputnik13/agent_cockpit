import { AppShell } from './shell';
import { CockpitWorkspace } from './workspace/CockpitWorkspace';

/**
 * Agent Cockpit root: the app shell (project rail + status region) wrapping the
 * Dockview workbench (terminal + content + changes + workgraph panels).
 */
export function App(): JSX.Element {
  return (
    <AppShell>
      <CockpitWorkspace />
    </AppShell>
  );
}
