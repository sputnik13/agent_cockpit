import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export interface EmptyStateProps {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/** Centered placeholder for empty/no-selection panel states. */
export function EmptyState({ title, hint, icon, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-dim',
        className,
      )}
    >
      {icon != null && <div className="mb-1 opacity-60">{icon}</div>}
      <div className="text-[13px] text-fg">{title}</div>
      {hint != null && <div className="text-xs">{hint}</div>}
    </div>
  );
}

export function Spinner({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-edge border-t-accent',
        className,
      )}
      {...rest}
    />
  );
}
