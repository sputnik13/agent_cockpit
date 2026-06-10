import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@shared/ipc/channels';
import { Button, cn } from '../ui';
import { useLogsStore } from '../providerClient/logsStore';

const LEVEL_CLASS: Record<LogEntry['level'], string> = {
  info: 'text-fg',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

function formatTs(ts: string): string {
  // Show only HH:MM:SS.mmm for compactness.
  try {
    const d = new Date(ts);
    return d.toISOString().slice(11, 23);
  } catch {
    return ts;
  }
}

export function LogRow({ entry }: { entry: LogEntry }): JSX.Element {
  return (
    <div className={cn('flex gap-2 font-mono text-[11px] leading-4', LEVEL_CLASS[entry.level])}>
      <span className="shrink-0 text-dim">{formatTs(entry.ts)}</span>
      <span className="shrink-0 w-10 uppercase">{entry.level}</span>
      {entry.context && (
        <span className="shrink-0 text-dim">[{entry.context}]</span>
      )}
      <span className="min-w-0 break-all">{entry.message}</span>
    </div>
  );
}

/**
 * Presentational log viewer body — scrollable list with level colors,
 * auto-scroll/pause, Copy all, and Clear. Used by both the pop-out window
 * (diagnosticsMain.tsx) and could be embedded anywhere without a Dialog wrapper.
 */
export function LogViewerBody(): JSX.Element {
  const entries = useLogsStore((s) => s.entries);
  const clearEntries = useLogsStore((s) => s.clearEntries);
  const [paused, setPaused] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries arrive (unless paused).
  useEffect(() => {
    if (!paused) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [entries, paused]);

  // Scroll to bottom on mount.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    // Pause auto-scroll when the user is not within 32px of the bottom.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    setPaused(!atBottom);
  }

  function copyAll(): void {
    const text = entries
      .map((e) => `${e.ts} ${e.level.toUpperCase()} ${e.context ? `[${e.context}] ` : ''}${e.message}`)
      .join('\n');
    void navigator.clipboard.writeText(text);
  }

  return (
    <div className="flex h-full flex-col gap-1 bg-bg p-2">
      <div className="flex shrink-0 items-center gap-1">
        <span className="flex-1 text-[11px] font-semibold text-dim uppercase tracking-wide">
          Main-process logs · remote connect tracing
        </span>
        <Button size="sm" variant="ghost" onClick={clearEntries}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={copyAll}>
          Copy all
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto flex flex-col gap-0.5 rounded border border-edge bg-bg p-2"
      >
        {entries.length === 0 ? (
          <span className="text-xs text-dim">No log entries yet.</span>
        ) : (
          entries.map((e, i) => <LogRow key={i} entry={e} />)
        )}
        <div ref={bottomRef} />
      </div>
      {paused && (
        <p className="shrink-0 text-[10px] text-dim">
          Scroll paused — scroll to bottom to resume auto-scroll.
        </p>
      )}
    </div>
  );
}
