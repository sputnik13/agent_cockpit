import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface RowProps extends Omit<HTMLAttributes<HTMLDivElement>, 'prefix'> {
  active?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Renders as a clickable row with pointer + hover affordance. */
  interactive?: boolean;
}

/** Compact list row used by change lists, worktrees, task lists, notes. */
export function Row({
  active = false,
  interactive = true,
  prefix,
  suffix,
  className,
  children,
  ...rest
}: RowProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-2 py-1 text-[13px] border-l-2',
        active ? 'border-accent bg-accent/15' : 'border-transparent',
        interactive && 'cursor-pointer hover:bg-elev',
        className,
      )}
      {...rest}
    >
      {prefix != null && <span className="shrink-0">{prefix}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {suffix != null && <span className="shrink-0">{suffix}</span>}
    </div>
  );
}
