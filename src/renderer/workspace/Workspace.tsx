import type { FunctionComponent } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
} from 'dockview-react';

// Dockview's base chrome styles plus the cockpit theme overrides. Importing
// here keeps the host self-contained: any consumer rendering <Workspace />
// gets the themed Dockview without managing CSS load order itself.
import 'dockview-react/dist/styles/dockview.css';
import './dockview-theme.css';

/**
 * Cockpit Dockview theme descriptor.
 *
 * `className` points at the `.dockview-theme-agent-cockpit` rule in
 * `dockview-theme.css`, which sets dockview's `--dv-*` custom properties to the
 * cockpit design tokens. dockview-react applies this class to its root and the
 * drag overlay so all chrome inherits the cockpit palette.
 */
export const agentCockpitDockviewTheme: DockviewTheme = {
  name: 'agent-cockpit',
  className: 'dockview-theme-agent-cockpit',
};

export interface WorkspaceProps {
  /** Panel components keyed by the name referenced when adding panels. */
  components: Record<string, FunctionComponent<IDockviewPanelProps>>;
  /** Fired once the Dockview API is ready; consumers add panels here. */
  onReady: (event: DockviewReadyEvent) => void;
  /** Optional extra class names appended to the themed host root. */
  className?: string;
}

/**
 * Thin, reusable themed Dockview host.
 *
 * It applies the cockpit theme and forwards `components` / `onReady` straight
 * through to {@link DockviewReact}. Layout presets, flip, and persistence are
 * intentionally out of scope and handled by separate consumers.
 */
export function Workspace({ components, onReady, className }: WorkspaceProps): JSX.Element {
  const hostClassName = ['agent-cockpit-workspace', agentCockpitDockviewTheme.className, className]
    .filter(Boolean)
    .join(' ');

  return (
    <DockviewReact
      className={hostClassName}
      theme={agentCockpitDockviewTheme}
      components={components}
      onReady={onReady}
    />
  );
}

export default Workspace;

export type { DockviewApi, DockviewReadyEvent };
