import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn, EmptyState, IconButton } from '../ui';
import { ContentViewer } from './ContentViewer';
import { selectTabs, useContentSelection } from './selectionStore';

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

// Tabs whose viewer has been shown at least once stay mounted (hidden) so a
// tab keeps its mode, zoom, scroll position and find state while other tabs
// are in front. Tabs restored from a previous run mount lazily, on first
// activation, so a restart never fires a read for every remembered file.
const visitedByProject = new Map<string, Set<string>>();

/** Content panel body for one project: tab strip + the open files' viewers. */
export function ContentTabs({ projectId }: { projectId: string }): JSX.Element {
  const { tabs, activeId } = useContentSelection(selectTabs(projectId));
  const activate = useContentSelection((s) => s.activate);
  const close = useContentSelection((s) => s.close);
  const stripRef = useRef<HTMLDivElement>(null);

  let visited = visitedByProject.get(projectId);
  if (!visited) {
    visited = new Set();
    visitedByProject.set(projectId, visited);
  }
  // Forget closed tabs, remember the one in front.
  const open = new Set(tabs.map((t) => t.id));
  for (const id of visited) if (!open.has(id)) visited.delete(id);
  if (activeId) visited.add(activeId);

  // Keep the active tab visible in an overflowing strip.
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  if (tabs.length === 0) {
    return (
      <EmptyState
        title="No file selected"
        hint="Select a file in Changes or Explorer to view it."
      />
    );
  }

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const move = (to: number): void => {
      const next = (to + tabs.length) % tabs.length;
      const target = tabs[next];
      if (!target) return;
      e.preventDefault();
      activate(projectId, target.id);
      const nodes = stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      nodes?.[next]?.focus();
    };
    if (e.key === 'ArrowRight') move(index + 1);
    else if (e.key === 'ArrowLeft') move(index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(tabs.length - 1);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const id = tabs[index]?.id;
      if (id) close(projectId, id);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Open files"
        className="flex shrink-0 items-stretch overflow-x-auto border-b border-edge"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const name = basename(tab.selection.path);
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex shrink-0 items-center border-r border-edge',
                active ? 'bg-panel text-fg' : 'text-dim hover:text-fg',
              )}
            >
              <button
                type="button"
                title={tab.id}
                role="tab"
                id={`content-tab-${index}`}
                aria-selected={active}
                aria-controls={`content-tabpanel-${tab.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => activate(projectId, tab.id)}
                onKeyDown={(e) => onKeyDown(e, index)}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    close(projectId, tab.id);
                  }
                }}
                className={cn(
                  'max-w-[16rem] truncate border-b-2 px-2 py-1.5 text-[13px] outline-none',
                  'focus-visible:text-fg',
                  active ? 'border-accent' : 'border-transparent',
                )}
              >
                {name}
              </button>
              <IconButton
                size="sm"
                label={`Close ${name}`}
                onClick={() => close(projectId, tab.id)}
                className={cn('mr-1', !active && 'opacity-60 group-hover:opacity-100')}
              >
                ×
              </IconButton>
            </div>
          );
        })}
      </div>
      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => {
          if (!visited.has(tab.id)) return null;
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tabpanel"
              id={`content-tabpanel-${tab.id}`}
              aria-hidden={!active}
              // Inactive panels stay laid out (so scroll offsets survive) but are
              // invisible and inert: not focusable, not clickable.
              className={cn('absolute inset-0', !active && 'invisible pointer-events-none')}
            >
              <ContentViewer selection={tab.selection} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
