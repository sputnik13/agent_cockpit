import * as RSelect from '@radix-ui/react-select';
import { cn } from './cn';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

/** Compact select. Radix owns keyboard/typeahead/focus/ARIA. */
export function Select({ value, onValueChange, options, placeholder, className, ...rest }: SelectProps) {
  // De-dupe by value: callers can pass lists with repeats (e.g. system fonts
  // that report the same family twice), which would collide React keys and let
  // Radix churn the selected item between renders.
  const seen = new Set<string>();
  const uniqueOptions = options.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
  return (
    <RSelect.Root value={value} onValueChange={onValueChange}>
      <RSelect.Trigger
        aria-label={rest['aria-label']}
        className={cn(
          'inline-flex h-7 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded border border-edge bg-panel px-2 text-[13px] text-fg',
          'outline-none hover:border-accent focus-visible:ring-2 focus-visible:ring-accent/60',
          className,
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <RSelect.Value placeholder={placeholder} />
        </span>
        <RSelect.Icon className="shrink-0 text-dim">▾</RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-[min(60vh,320px)] max-w-[min(90vw,420px)] overflow-hidden rounded-md border border-edge bg-panel text-[13px] text-fg shadow-xl"
        >
          <RSelect.Viewport className="p-1">
            {uniqueOptions.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className={cn(
                  'flex max-w-full cursor-pointer select-none items-center truncate rounded px-2 py-1 outline-none',
                  'data-[highlighted]:bg-accent/20 data-[state=checked]:text-accent',
                )}
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
