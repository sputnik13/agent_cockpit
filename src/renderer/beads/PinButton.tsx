import type { MouseEvent } from 'react';
import { cn } from '../ui';

interface PinButtonProps {
  pinned: boolean;
  onToggle: () => void;
  /** Accessible label, e.g. `Pin epic <title> to columns`. */
  label: string;
  className?: string;
}

/**
 * Pin/unpin an epic into the side-by-side Columns focus set. A filled ★ means
 * pinned (in the set), an outline ☆ means not. Used on epic rows (tree, list) and
 * epic graph nodes. Stops propagation so toggling the pin never also selects /
 * re-anchors the row.
 */
export function PinButton({ pinned, onToggle, label, className }: PinButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'w-4 shrink-0 text-[11px] leading-none',
        pinned ? 'text-accent' : 'text-dim hover:text-fg',
        className,
      )}
    >
      {pinned ? '★' : '☆'}
    </button>
  );
}
