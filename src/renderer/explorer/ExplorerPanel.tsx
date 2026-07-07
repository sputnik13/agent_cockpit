import { useEffect, useRef, useState } from 'react';
import type { DirEntry } from '@shared/providers/types';
import { agentCockpit, useProjectsStore, useSessionStore, isDisconnected } from '../providerClient';
import { useActiveWorktree, useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { useContentSelection } from '../content';
import { useExplorerStore } from './explorerStore';
import { FileTypeIcon } from './icons/FileTypeIcon';
import { FolderIcon } from './icons/FolderIcon';
import { EmptyState, Panel, PanelBody, PanelHeader, Row, Select, Spinner, Toolbar } from '../ui';

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
const INDENT = 12;

/** File-tree Explorer for the active project. Lazily lists directories and
 *  feeds file selections into the shared content viewer. */
export function ExplorerPanel(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const disconnected = useSessionStore(isDisconnected(activeId));
  // Which worktree the Explorer lists/opens from — the shared SSOT (also drives
  // Changes). Null (or the primary worktree) reads from the project root.
  const { worktrees, activeWorktree } = useActiveWorktree();
  const setWorktree = useWorktreeStore((s) => s.setWorktree);
  // Same option shape/label rule as the Changes panel selector, bound to the
  // shared store so a switch here also moves Changes (and vice-versa).
  const worktreeOptions = worktrees.map((w) => ({ value: w.path, label: w.branch ?? w.path }));
  if (!activeId) {
    return (
      <Panel>
        <PanelHeader title="Explorer" />
        <EmptyState title="No active project" hint="Select a project to browse its files." />
      </Panel>
    );
  }
  if (disconnected) {
    return (
      <Panel>
        <PanelHeader title="Explorer" />
        <EmptyState title="Disconnected" hint="Reconnect to view files." />
      </Panel>
    );
  }
  return (
    <Panel>
      <PanelHeader title="Explorer" />
      {worktreeOptions.length > 0 && (
        <Toolbar>
          <Select
            aria-label="Worktree"
            value={activeWorktree ?? ''}
            onValueChange={(v) => void setWorktree(activeId, v)}
            options={worktreeOptions}
            placeholder="Worktree"
            className="max-w-[220px] shrink"
          />
        </Toolbar>
      )}
      <PanelBody>
        {/* key on project+worktree so the tree resets on reconnect AND on a
            worktree switch (drops stale expanded children of the old worktree) */}
        <DirChildren
          key={`${activeId}:${activeWorktree ?? ''}`}
          dirPath=""
          depth={0}
          worktreePath={activeWorktree ?? undefined}
        />
      </PanelBody>
    </Panel>
  );
}

function DirChildren({
  dirPath,
  depth,
  worktreePath,
}: {
  dirPath: string;
  depth: number;
  worktreePath?: string;
}): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    let active = true;
    void agentCockpit.provider
      .listDir(dirPath, worktreePath)
      .then((es) => {
        if (active) setEntries(es.filter((e) => !IGNORED.has(e.name)));
      })
      .catch(() => active && setEntries([]));
    return () => {
      active = false;
    };
  }, [dirPath, worktreePath]);

  if (entries === null) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-dim" style={{ paddingLeft: depth * INDENT + 8 }}>
        <Spinner /> loading…
      </div>
    );
  }
  return (
    <>
      {entries.map((e) =>
        e.isDir ? (
          <DirNode key={e.path} entry={e} depth={depth} worktreePath={worktreePath} />
        ) : (
          <FileNode key={e.path} entry={e} depth={depth} worktreePath={worktreePath} />
        ),
      )}
    </>
  );
}

function DirNode({
  entry,
  depth,
  worktreePath,
}: {
  entry: DirEntry;
  depth: number;
  worktreePath?: string;
}): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  // Expansion lives in the store so a programmatic reveal (from a clicked link)
  // can expand ancestor directories of a target file.
  const open = useExplorerStore((s) => (activeId ? s.expanded[activeId]?.has(entry.path) ?? false : false));
  const toggle = useExplorerStore((s) => s.toggle);
  return (
    <>
      <Row
        onClick={() => activeId && toggle(activeId, entry.path)}
        prefix={
          <span className="flex items-center gap-1">
            <span className="w-3 text-dim">{open ? '▾' : '▸'}</span>
            <FolderIcon open={open} />
          </span>
        }
        style={{ paddingLeft: depth * INDENT + 8 }}
        title={entry.path}
      >
        {entry.name}
      </Row>
      {open && <DirChildren dirPath={entry.path} depth={depth + 1} worktreePath={worktreePath} />}
    </>
  );
}

function FileNode({
  entry,
  depth,
  worktreePath,
}: {
  entry: DirEntry;
  depth: number;
  worktreePath?: string;
}): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const select = useContentSelection((s) => s.select);
  // Subscribe to the active project's selection slice (not the stable
  // `selectionFor` action) so the active-row highlight re-renders when the
  // selection changes; see panels.tsx ContentPanelHost for the same fix.
  const activeSelection = useContentSelection((s) =>
    activeId ? s.selections[activeId] ?? null : null,
  );
  const active = activeSelection?.kind === 'file' && activeSelection.path === entry.path;
  // Scroll into view when this file is the reveal target of a clicked link.
  const isRevealTarget = useExplorerStore((s) => (activeId ? s.revealTarget[activeId] === entry.path : false));
  const consumeRevealTarget = useExplorerStore((s) => s.consumeRevealTarget);
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isRevealTarget && activeId) {
      rowRef.current?.scrollIntoView({ block: 'nearest' });
      consumeRevealTarget(activeId);
    }
  }, [isRevealTarget, activeId, consumeRevealTarget]);
  return (
    <div ref={rowRef}>
      <Row
        active={active}
        onClick={() => {
          if (activeId) {
            select(activeId, {
              path: entry.path,
              worktreePath: worktreePath ?? '',
              baseline: 'HEAD',
              kind: 'file',
            });
          }
        }}
        prefix={
          <span className="flex items-center gap-1">
            {/* spacer aligns the file icon under the folder chevron column */}
            <span className="w-3" />
            <FileTypeIcon name={entry.name} />
          </span>
        }
        style={{ paddingLeft: depth * INDENT + 8 }}
        title={entry.path}
      >
        {entry.name}
      </Row>
    </div>
  );
}
