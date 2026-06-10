import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/** Horizontal control strip (filters, mode switches) inside a panel header/body. */
export function Toolbar({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-1.5 border-b border-edge bg-panel px-2 py-1.5', className)}
      role="toolbar"
      {...rest}
    />
  );
}

export function ToolbarSpacer() {
  return <span className="flex-1" />;
}
