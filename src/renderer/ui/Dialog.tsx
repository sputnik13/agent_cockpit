import * as RDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/** Modal dialog. Radix owns focus trap, escape, scroll lock, and ARIA. */
export function Dialog({ open, onOpenChange, title, description, children, footer, className }: DialogProps) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <RDialog.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-edge bg-panel p-4 text-fg shadow-xl outline-none',
            className,
          )}
        >
          <RDialog.Title className="text-sm font-semibold">{title}</RDialog.Title>
          {description != null && (
            <RDialog.Description className="mt-1 text-xs text-dim">{description}</RDialog.Description>
          )}
          {children != null && <div className="mt-3">{children}</div>}
          {footer != null && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
