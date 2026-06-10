import { useEffect, useMemo, useReducer, type FunctionComponent } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { BeadsPanel, TaskDetail } from '../beads';
import { ChangesPanel } from '../changes';
import { ContentViewer, useContentSelection } from '../content';
import { ExplorerPanel } from '../explorer';
import { RunPanel } from '../run';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { NotesPanel } from '../notes';
import { EmptyState, PanelFullscreenProvider } from '../ui';
import { useProjectsStore } from '../providerClient';
import { PanelIds, type PanelId } from './panelIds';

/**
 * Content panel host: renders the per-project content selection. Exported for
 * the store -> panel reactivity integration test.
 *
 * Subscribe to the per-project `selections` slice directly (not the stable
 * `selectionFor` action) so the panel re-renders when the active project's
 * selection changes. Selecting `s.selectionFor` returned the same function
 * identity on every store update, so zustand never re-rendered the panel after
 * a selection write and the Content panel stayed empty/stale until an unrelated
 * render happened to flush it.
 */
export function ContentPanelHost(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const selection = useContentSelection((s) => (activeId ? s.selections[activeId] ?? null : null));
  return <ContentViewer selection={selection} />;
}

const REGISTRY: Record<PanelId, FunctionComponent> = {
  [PanelIds.terminal]: TerminalPanel,
  [PanelIds.content]: ContentPanelHost,
  [PanelIds.changes]: ChangesPanel,
  [PanelIds.beads]: BeadsPanel,
  [PanelIds.taskDetail]: TaskDetail,
  [PanelIds.run]: RunPanel,
  [PanelIds.notes]: NotesPanel,
  [PanelIds.explorer]: ExplorerPanel,
};

function PanelHost(props: IDockviewPanelProps<{ panelId: PanelId }>): JSX.Element {
  const { api, containerApi } = props;
  // Re-render when any group's maximize state changes so the header control
  // reflects the live state, even when maximize/restore is driven elsewhere.
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sub = containerApi.onDidMaximizedGroupChange(() => force());
    return () => sub.dispose();
  }, [containerApi]);
  const isMaximized = api.isMaximized();
  const fullscreen = useMemo(
    () => ({
      isMaximized,
      toggle: () => (api.isMaximized() ? api.exitMaximized() : api.maximize()),
    }),
    [api, isMaximized],
  );
  const Comp = REGISTRY[props.params.panelId];
  return (
    <PanelFullscreenProvider value={fullscreen}>
      {Comp ? <Comp /> : <EmptyState title="Unknown panel" hint={props.params.panelId} />}
    </PanelFullscreenProvider>
  );
}

export const dockviewComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  'panel-host': PanelHost,
};
