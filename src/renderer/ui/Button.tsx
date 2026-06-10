import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'default' | 'primary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, string> = {
  default: 'bg-panel-2 border-edge text-fg hover:bg-elev hover:border-edge-strong',
  primary: 'bg-accent border-accent text-white hover:brightness-110',
  ghost: 'bg-transparent border-transparent text-dim hover:text-fg hover:bg-elev',
  danger: 'bg-panel-2 border-edge text-removed hover:border-removed hover:bg-elev',
};

const SIZE: Record<Size, string> = {
  sm: 'h-6 px-2 text-xs gap-1',
  md: 'h-8 px-3 text-[13px] gap-1.5',
};

const BASE =
  'inline-flex items-center justify-center rounded border font-medium select-none ' +
  'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ' +
  'disabled:opacity-50 disabled:pointer-events-none';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(BASE, VARIANT[variant], SIZE[size], className)} {...rest} />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  label: string;
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', size = 'md', label, className, type = 'button', children, ...rest },
  ref,
) {
  const square = size === 'sm' ? 'w-6 px-0' : 'w-8 px-0';
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(BASE, VARIANT[variant], SIZE[size], square, className)}
      {...rest}
    >
      {children}
    </button>
  );
});
