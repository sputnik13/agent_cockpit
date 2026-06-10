import * as RTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

/** Wrap the app once so tooltips share delay/timing config. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={400} skipDelayDuration={200}>
      {children}
    </RTooltip.Provider>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          sideOffset={4}
          className="z-50 rounded border border-edge bg-panel-2 px-2 py-1 text-xs text-fg shadow-lg"
        >
          {content}
          <RTooltip.Arrow className="fill-[var(--color-panel-2)]" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
