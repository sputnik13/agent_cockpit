import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { IconButton } from './Button';
import { usePanelFullscreen } from './panelFullscreenContext';

/** Panel fills its Dockview/host cell as a column: header + scrollable body. */
export function Panel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col bg-bg text-fg', className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * Maximize/restore control for a Dockview-hosted panel. Rendered only when the
 * host provides the fullscreen context; `null` outside a host (tests, standalone
 * mounts) so there is no dead button. Shared by every panel-header variant so the
 * control's glyph, label, and behavior have a single definition.
 */
export function PanelFullscreenButton() {
  const fullscreen = usePanelFullscreen();
  if (!fullscreen) return null;
  return (
    <IconButton
      size="sm"
      label={fullscreen.isMaximized ? 'Restore panel' : 'Maximize panel'}
      onClick={fullscreen.toggle}
    >
      {fullscreen.isMaximized ? '❐' : '⛶'}
    </IconButton>
  );
}

interface PanelHeaderShellProps extends HTMLAttributes<HTMLDivElement> {
  /** Leading content — a title (PanelHeader) or a tab strip (TabbedPanelHeader). */
  leading: ReactNode;
  actions?: ReactNode;
}

/**
 * Shared panel-header chrome: the bordered bar plus a right-aligned actions group
 * that always ends in the maximize/restore control. PanelHeader and
 * TabbedPanelHeader differ only in their leading content, so they compose this.
 */
function PanelHeaderShell({ leading, actions, className, ...rest }: PanelHeaderShellProps) {
  const fullscreen = usePanelFullscreen();
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-2 text-[13px]',
        className,
      )}
      {...rest}
    >
      {leading}
      {(actions != null || fullscreen) && (
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <PanelFullscreenButton />
        </div>
      )}
    </div>
  );
}

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  actions?: ReactNode;
}

/** Standard panel header: a single truncating title plus right-aligned actions. */
export function PanelHeader({ title, actions, ...rest }: PanelHeaderProps) {
  return (
    <PanelHeaderShell
      leading={<span className="truncate font-semibold text-fg">{title}</span>}
      actions={actions}
      {...rest}
    />
  );
}

export interface TabbedPanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The tab strip — caller-rendered tabs plus any new-tab affordance. */
  tabs: ReactNode;
  actions?: ReactNode;
}

/**
 * Panel header whose leading region is a tab strip instead of a title. Shares the
 * bordered bar, actions group, and maximize control with {@link PanelHeader} so a
 * tabbed panel (e.g. the terminal) matches every other panel. Tabs are laid out
 * in a tight `gap-1` row that can shrink; the actions group sits at the far right.
 */
export function TabbedPanelHeader({ tabs, actions, ...rest }: TabbedPanelHeaderProps) {
  return (
    <PanelHeaderShell
      leading={<div className="flex min-w-0 items-center gap-1">{tabs}</div>}
      actions={actions}
      {...rest}
    />
  );
}

export function PanelBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-auto', className)} {...rest}>
      {children}
    </div>
  );
}
