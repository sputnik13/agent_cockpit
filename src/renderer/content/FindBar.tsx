import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../ui';

interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  count: number;
  active: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

/** Compact find bar overlaid on the content panel (Cmd/Ctrl+F to open, Esc to
 *  close). Enter / Shift+Enter step through matches; the count shows n/N. */
export function FindBar({
  query,
  onQueryChange,
  count,
  active,
  onNext,
  onPrev,
  onClose,
}: FindBarProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  }

  const noMatch = query.trim().length > 0 && count === 0;

  return (
    <div
      role="search"
      aria-label="Find in file"
      className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded border border-edge bg-panel px-2 py-1 shadow-lg"
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Find"
        placeholder="Find"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        className={cn(
          'h-6 w-44 min-w-0 rounded border bg-bg px-2 text-[13px] text-fg outline-none',
          'placeholder:text-dim focus-visible:ring-2 focus-visible:ring-accent/60',
          noMatch ? 'border-removed' : 'border-edge',
        )}
      />
      <span className="w-12 text-right text-[11px] tabular-nums text-dim" aria-live="polite">
        {query.trim().length === 0 ? '' : `${active}/${count}`}
      </span>
      <button
        type="button"
        aria-label="Previous match"
        onClick={onPrev}
        disabled={count === 0}
        className="w-5 shrink-0 text-dim hover:text-fg disabled:opacity-40"
      >
        ↑
      </button>
      <button
        type="button"
        aria-label="Next match"
        onClick={onNext}
        disabled={count === 0}
        className="w-5 shrink-0 text-dim hover:text-fg disabled:opacity-40"
      >
        ↓
      </button>
      <button
        type="button"
        aria-label="Close find"
        onClick={onClose}
        className="w-5 shrink-0 text-dim hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}
