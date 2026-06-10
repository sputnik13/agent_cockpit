import type { HTMLAttributes } from 'react';
import { cn } from './cn';

type Tone = 'neutral' | 'accent' | 'added' | 'removed' | 'warn';

const TONE: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-dim border-edge',
  accent: 'bg-accent/15 text-accent border-accent/40',
  added: 'bg-added/15 text-added border-added/40',
  removed: 'bg-removed/15 text-removed border-removed/40',
  warn: 'bg-warn/15 text-warn border-warn/40',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[10px] font-medium leading-none',
        TONE[tone],
        className,
      )}
      {...rest}
    />
  );
}

const DOT_TONE: Record<Tone, string> = {
  neutral: 'bg-dim',
  accent: 'bg-accent',
  added: 'bg-added',
  removed: 'bg-removed',
  warn: 'bg-warn',
};

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  pulse?: boolean;
}

/** Small connection/state indicator dot. */
export function StatusDot({ tone = 'neutral', pulse = false, className, ...rest }: StatusDotProps) {
  return (
    <span
      className={cn('inline-block h-2 w-2 rounded-full', DOT_TONE[tone], pulse && 'animate-pulse', className)}
      {...rest}
    />
  );
}
