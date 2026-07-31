import * as RDropdown from '@radix-ui/react-dropdown-menu';
import * as RContext from '@radix-ui/react-context-menu';
import type { ReactNode } from 'react';
import { cn } from './cn';

export interface MenuItemDef {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Native hover tooltip — e.g. why a disabled item is disabled. Per
   *  ui-standards ("disabled controls Should indicate why"). */
  title?: string;
}

const CONTENT =
  'z-50 min-w-[160px] rounded-md border border-edge bg-panel p-1 text-[13px] text-fg shadow-xl outline-none';

function itemClass(item: MenuItemDef): string {
  return cn(
    'flex cursor-pointer select-none items-center rounded px-2 py-1 outline-none',
    'data-[highlighted]:bg-accent/20 data-[disabled]:opacity-40 data-[disabled]:pointer-events-none',
    item.danger && 'text-removed',
  );
}

/** Click-triggered dropdown menu. Radix owns keyboard/typeahead/focus/ARIA. */
export function DropdownMenu({ trigger, items }: { trigger: ReactNode; items: MenuItemDef[] }) {
  return (
    <RDropdown.Root>
      <RDropdown.Trigger asChild>{trigger}</RDropdown.Trigger>
      <RDropdown.Portal>
        {/* Don't let Radix restore focus to the trigger on close: a selected
            item may move keyboard focus into a panel (e.g. opening a panel), and
            the default restore would steal it back to the button. */}
        <RDropdown.Content
          className={CONTENT}
          sideOffset={4}
          align="start"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >

          {items.map((item, i) => (
            <RDropdown.Item
              key={i}
              disabled={item.disabled}
              className={itemClass(item)}
              onSelect={item.onSelect}
              title={item.title}
            >
              {item.label}
            </RDropdown.Item>
          ))}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}

/** Right-click context menu over arbitrary content. */
export function ContextMenu({ children, items }: { children: ReactNode; items: MenuItemDef[] }) {
  return (
    <RContext.Root>
      <RContext.Trigger asChild>{children}</RContext.Trigger>
      <RContext.Portal>
        <RContext.Content className={CONTENT}>
          {items.map((item, i) => (
            <RContext.Item
              key={i}
              disabled={item.disabled}
              className={itemClass(item)}
              onSelect={item.onSelect}
              title={item.title}
            >
              {item.label}
            </RContext.Item>
          ))}
        </RContext.Content>
      </RContext.Portal>
    </RContext.Root>
  );
}
