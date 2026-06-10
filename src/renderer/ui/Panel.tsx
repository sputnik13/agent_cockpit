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

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  actions?: ReactNode;
}

export function PanelHeader({ title, actions, className, ...rest }: PanelHeaderProps) {
  // Maximize/restore control: rendered for every panel hosted in a Dockview
  // group (the host provides the context); `null` outside a host so tests and
  // standalone mounts get no dead button.
  const fullscreen = usePanelFullscreen();
  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 border-b border-edge bg-panel px-2 text-[13px]',
        className,
      )}
      {...rest}
    >
      <span className="truncate font-semibold text-fg">{title}</span>
      {(actions != null || fullscreen) && (
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {fullscreen && (
            <IconButton
              size="sm"
              label={fullscreen.isMaximized ? 'Restore panel' : 'Maximize panel'}
              onClick={fullscreen.toggle}
            >
              {fullscreen.isMaximized ? '❐' : '⛶'}
            </IconButton>
          )}
        </div>
      )}
    </div>
  );
}

export function PanelBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-auto', className)} {...rest}>
      {children}
    </div>
  );
}
