import * as RTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface TabDef {
  value: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  tabs: TabDef[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  className?: string;
}

/** Tab strip + panels. Radix owns roving focus, arrow keys, and ARIA. */
export function Tabs({ tabs, value, defaultValue, onValueChange, className }: TabsProps) {
  return (
    <RTabs.Root
      className={cn('flex h-full min-h-0 flex-col', className)}
      value={value}
      defaultValue={defaultValue ?? tabs[0]?.value}
      onValueChange={onValueChange}
    >
      <RTabs.List className="flex shrink-0 items-center gap-1 border-b border-edge px-1">
        {tabs.map((t) => (
          <RTabs.Trigger
            key={t.value}
            value={t.value}
            className={cn(
              'border-b-2 border-transparent px-2 py-1.5 text-[13px] text-dim outline-none',
              'hover:text-fg focus-visible:text-fg',
              'data-[state=active]:border-accent data-[state=active]:text-fg',
            )}
          >
            {t.label}
          </RTabs.Trigger>
        ))}
      </RTabs.List>
      {tabs.map((t) => (
        <RTabs.Content key={t.value} value={t.value} className="min-h-0 flex-1 overflow-auto outline-none">
          {t.content}
        </RTabs.Content>
      ))}
    </RTabs.Root>
  );
}
