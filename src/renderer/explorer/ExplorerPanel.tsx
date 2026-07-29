import { useEffect, useRef, useState } from 'react';
import type { DirEntry } from '@shared/providers/types';
import { agentCockpit, useProjectsStore, useSessionStore, isDisconnected } from '../providerClient';
import { useActiveWorktree, useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { worktreeSelectOptions } from '@renderer/worktree/worktreeOptions';
import { useContentSelection } from '../content';
import { useExplorerStore } from './explorerStore';
import { FileTypeIcon } from './icons/FileTypeIcon';
import { FolderIcon } from './icons/FolderIcon';
import {
  EmptyState,
  Panel,
  PanelBody,
  PanelFullscreenButton,
  Row,
  Select,
  Spinner,
  Toolbar,
  ToolbarSpacer,
} from '../ui';

const IGNORED = new Set(['.git', 'node_modules', '.DS_Store']);
const INDENT = 12;

/** Join a base directory and a base-relative entry path into one absolute path
 *  (POSIX). Used for root browsing, where entry paths are relative to `/`. */
function absoluteUnder(base: string, relPath: string): string {
  return `${base.replace(/\/+$/, '')}/${relPath}`;
}

/** File-tree Explorer for the active project. Lazily lists directories and
 *  feeds file selections into the shared content viewer. */
/** Dropdown value that selects the filesystem root (browse outside the project).
 *  Doubles as the read base: no worktree lives at `/`, so it never collides. */
const ROOT_VALUE = '/';

export function ExplorerPanel(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const disconnected = useSessionStore(isDisconnected(activeId));
  // Which worktree the Explorer lists/opens from — the shared SSOT (also drives
  // Changes). Null (or the primary worktree) reads from the project root.
  const { worktrees, activeWorktree } = useActiveWorktree();
  const setWorktree = useWorktreeStore((s) => s.setWorktree);
  // Explorer-only "browse the filesystem root" toggle. Kept in Explorer-local
  // state (NOT the shared worktree selection) so it never moves the Changes panel.
  const rootBrowse = useExplorerStore((s) => (activeId ? s.rootBrowse[activeId] ?? false : false));
  const setRootBrowse = useExplorerStore((s) => s.setRootBrowse);
  if (!activeId) {
    return (
      <Panel>
        <EmptyState title="No active project" hint="Select a project to browse its files." />
      </Panel>
    );
  }
  if (disconnected) {
    return (
      <Panel>
        <EmptyState title="Disconnected" hint="Reconnect to view files." />
      </Panel>
    );
  }
  // Same "<workspace> - <branch>" options as the Changes selector, plus an
  // Explorer-only trailing "Root (/)" entry for browsing outside the project.
  const options = [...worktreeSelectOptions(worktrees), { value: ROOT_VALUE, label: 'Root (/)' }];
  const selectValue = rootBrowse ? ROOT_VALUE : (activeWorktree ?? '');
  // Read base: `/` when browsing root, else the selected worktree (undefined =
  // project root). Root selections are external (absolute path, no git diff).
  const base = rootBrowse ? ROOT_VALUE : (activeWorktree ?? undefined);
  return (
    <Panel>
      <Toolbar>
        <Select
          aria-label="Worktree"
          value={selectValue}
          onValueChange={(v) => {
            if (v === ROOT_VALUE) {
              // Browse root — Explorer-local only; leave the shared worktree as-is.
              setRootBrowse(activeId, true);
            } else {
              setWorktree(activeId, v);
              setRootBrowse(activeId, false);
            }
          }}
          options={options}
          placeholder="Worktree"
          className="max-w-[240px] shrink"
        />
        <ToolbarSpacer />
        <PanelFullscreenButton />
      </Toolbar>
      <PanelBody>
        {/* key on project+base so the tree resets on reconnect AND on a base
            switch (worktree or root) — drops stale expanded children */}
        <DirChildren
          key={`${activeId}:${base ?? ''}`}
          dirPath=""
          depth={0}
          worktreePath={base}
          external={rootBrowse}
        />
      </PanelBody>
    </Panel>
  );
}

function DirChildren({
  dirPath,
  depth,
  worktreePath,
  external = false,
}: {
  dirPath: string;
  depth: number;
  worktreePath?: string;
  /** True when browsing the filesystem root: file selections are external
   *  (absolute path, no git diff) rather than in-project. */
  external?: boolean;
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
          <DirNode key={e.path} entry={e} depth={depth} worktreePath={worktreePath} external={external} />
        ) : (
          <FileNode key={e.path} entry={e} depth={depth} worktreePath={worktreePath} external={external} />
        ),
      )}
    </>
  );
}

function DirNode({
  entry,
  depth,
  worktreePath,
  external = false,
}: {
  entry: DirEntry;
  depth: number;
  worktreePath?: string;
  external?: boolean;
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
      {open && (
        <DirChildren dirPath={entry.path} depth={depth + 1} worktreePath={worktreePath} external={external} />
      )}
    </>
  );
}

function FileNode({
  entry,
  depth,
  worktreePath,
  external = false,
}: {
  entry: DirEntry;
  depth: number;
  worktreePath?: string;
  external?: boolean;
}): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const select = useContentSelection((s) => s.select);
  // Subscribe to the active project's selection slice (not the stable
  // `selectionFor` action) so the active-row highlight re-renders when the
  // selection changes; see panels.tsx ContentPanelHost for the same fix.
  const activeSelection = useContentSelection((s) =>
    activeId ? s.selections[activeId] ?? null : null,
  );
  // A root-browsed file is outside any repo: select it as an absolute
  // 'external-file' (no git diff) instead of an in-project 'file'.
  const targetPath = external ? absoluteUnder(worktreePath ?? ROOT_VALUE, entry.path) : entry.path;
  const targetKind = external ? 'external-file' : 'file';
  const active = activeSelection?.kind === targetKind && activeSelection.path === targetPath;
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
          if (!activeId) return;
          if (external) {
            // External read: absolute path, empty base, no baseline (no git diff).
            select(activeId, { path: targetPath, worktreePath: '', kind: 'external-file' });
          } else {
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
