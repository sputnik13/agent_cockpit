import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type FunctionComponent,
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { registerPanelFocus } from './panelFocus';
import { PanelFocusProvider } from './panelFocusContext';
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
  const panelId = props.params.panelId;
  const Comp = REGISTRY[panelId];

  // Keyboard-focus seam: a focusable wrapper root + a registered focus handler.
  // A panel may override the default (terminal -> xterm, run -> input) via the
  // PanelFocusProvider; otherwise the default focuses the wrapper, but only when
  // focus is not already inside the panel (so clicking an inner element is not
  // refocused away).
  const rootRef = useRef<HTMLDivElement>(null);
  const overrideRef = useRef<(() => void) | null>(null);
  const setFocusOverride = useCallback((handler: (() => void) | null) => {
    overrideRef.current = handler;
  }, []);
  useEffect(
    () =>
      registerPanelFocus(panelId, () => {
        if (overrideRef.current) {
          overrideRef.current();
          return;
        }
        const root = rootRef.current;
        if (root && !root.contains(document.activeElement)) root.focus();
      }),
    [panelId],
  );

  return (
    <PanelFullscreenProvider value={fullscreen}>
      <PanelFocusProvider value={setFocusOverride}>
        <div ref={rootRef} tabIndex={-1} className="h-full min-h-0 outline-none">
          {Comp ? <Comp /> : <EmptyState title="Unknown panel" hint={panelId} />}
        </div>
      </PanelFocusProvider>
    </PanelFullscreenProvider>
  );
}

export const dockviewComponents: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  'panel-host': PanelHost,
};
