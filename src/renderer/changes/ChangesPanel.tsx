import { useMemo, useState } from 'react';
import type { FileChange, FileChangeStatus } from '@shared/ipc/channels';
import {
  Badge,
  ContextMenu,
  EmptyState,
  Panel,
  PanelBody,
  PanelFullscreenButton,
  Row,
  Select,
  Spinner,
  Toolbar,
  cn,
} from '@renderer/ui';
import { useActiveChanges, useChangesStore, type DiffTarget } from './changesStore';
import { useActiveWorktree, useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { worktreeSelectOptions } from '@renderer/worktree/worktreeOptions';
import { useFollowTerminalCwd } from './followCwd';
import { useContentSelection } from '@renderer/content';
import {
  useProjectsStore,
  useSessionStore,
  isDisconnected,
  selectActiveProject,
} from '@renderer/providerClient';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { isHiddenFromChanges } from '@shared/watch/policy';
import { buildFileRowMenuItems, useRowMenuFeedback, type FileRowDescriptor } from '@renderer/files/rowMenu';

type Tone = 'neutral' | 'accent' | 'added' | 'removed' | 'warn';

/** Single-letter status glyph + badge tone per change status. */
const STATUS_GLYPH: Record<FileChangeStatus, { letter: string; tone: Tone }> = {
  added: { letter: 'A', tone: 'added' },
  modified: { letter: 'M', tone: 'warn' },
  deleted: { letter: 'D', tone: 'removed' },
  renamed: { letter: 'R', tone: 'accent' },
  untracked: { letter: '?', tone: 'neutral' },
  ignored: { letter: '!', tone: 'neutral' },
  conflicted: { letter: 'C', tone: 'removed' },
};

type FilterMode = 'all' | 'changed' | 'untracked';

const FILTERS: { id: FilterMode; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'changed', label: 'changed' },
  { id: 'untracked', label: 'untracked' },
];

/** Tracked (changed) statuses, i.e. not untracked/ignored. */
function isChanged(status: FileChangeStatus): boolean {
  return status !== 'untracked' && status !== 'ignored';
}

function matchesMode(file: FileChange, mode: FilterMode): boolean {
  switch (mode) {
    case 'changed':
      return isChanged(file.status);
    case 'untracked':
      return file.status === 'untracked';
    case 'all':
    default:
      return true;
  }
}

export function ChangesPanel(): JSX.Element {
  // Auto-follow the active terminal pane's cwd when the toggle is on.
  useFollowTerminalCwd();

  const { changeset, loading, selectedPath, baseline, target, branchPoint } = useActiveChanges();
  const { worktrees, activeWorktree } = useActiveWorktree();
  const setWorktree = useWorktreeStore((s) => s.setWorktree);
  const select = useChangesStore((s) => s.select);
  const setTarget = useChangesStore((s) => s.setTarget);
  const selectContent = useContentSelection((s) => s.select);
  const activeId = useProjectsStore((s) => s.activeId);
  const activeProject = useProjectsStore(selectActiveProject);
  const disconnected = useSessionStore(isDisconnected(activeId));
  // D3/feedback (local_repo_explorer-dpqo): same visible, transient toolbar
  // confirmation ExplorerPanel already renders after a row's Copy/Download
  // action — closes the cross-panel asymmetry flagged in ynz8.5's review.
  const { message: feedbackMessage, notify: onActionComplete } = useRowMenuFeedback();

  const selectFile = (file: FileChange): void => {
    if (!activeId) return;
    select(activeId, file.newPath);
    selectContent(activeId, {
      path: file.newPath,
      worktreePath: activeWorktree ?? '',
      kind: 'change',
      oldPath: file.oldPath,
      ...(baseline !== undefined ? { baseline } : {}),
    });
  };

  const [text, setText] = useState('');
  const [mode, setMode] = useState<FilterMode>('all');
  const showAllChanges = useSettingsStore((s) => s.settings.showAllChanges);

  const files = useMemo(() => changeset?.files ?? [], [changeset]);

  // Surface policy: hide `.git`/`.beads` rows by default (shared watch policy);
  // the "show all changes" setting reveals them. Display-only — these paths are
  // still watched. The count reflects the surfaced (post-policy) set.
  const surfaced = useMemo(
    () => files.filter((f) => !isHiddenFromChanges(f.newPath, { showAll: showAllChanges })),
    [files, showAllChanges],
  );

  const filtered = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return surfaced.filter((f) => {
      if (!matchesMode(f, mode)) return false;
      if (needle.length > 0 && !f.newPath.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [surfaced, mode, text]);

  const worktreeOptions = worktreeSelectOptions(worktrees);

  // Diff-target selector options. The branch-point label shows the resolved
  // parent ref so the user sees exactly what they're comparing against.
  const branchPointLabel =
    target === 'branchPoint' && branchPoint
      ? `Branch point (vs ${branchPoint.parentRef})`
      : target === 'branchPoint' && branchPoint === null
        ? 'Branch point (no parent)'
        : 'Branch point';
  const targetOptions: { value: DiffTarget; label: string }[] = [
    { value: 'head', label: 'Working tree vs HEAD' },
    { value: 'branchPoint', label: branchPointLabel },
  ];

  const count = `${filtered.length}/${surfaced.length}`;

  return (
    <Panel>
      <Toolbar>
        {worktreeOptions.length > 0 && (
          <Select
            aria-label="Worktree"
            value={activeWorktree ?? ''}
            onValueChange={(v) => activeId && void setWorktree(activeId, v)}
            options={worktreeOptions}
            placeholder="Worktree"
            className="max-w-[220px] shrink"
          />
        )}
        <Select
          aria-label="Diff target"
          value={target}
          onValueChange={(v) => activeId && void setTarget(activeId, v as DiffTarget)}
          options={targetOptions}
          className="shrink"
        />
        <input
          aria-label="Filter files"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Filter…"
          className={cn(
            'h-7 min-w-0 flex-1 rounded border border-edge bg-bg px-2 text-[13px] text-fg',
            'outline-none placeholder:text-dim hover:border-accent',
            'focus-visible:ring-2 focus-visible:ring-accent/60',
          )}
        />
        <div className="flex items-center gap-1" role="group" aria-label="Status filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={mode === f.id}
              onClick={() => setMode(f.id)}
              className={cn(
                'rounded border px-1.5 py-px text-[10px] font-medium leading-none',
                mode === f.id
                  ? 'border-accent/40 bg-accent/15 text-accent'
                  : 'border-edge bg-panel-2 text-dim hover:text-fg',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className="shrink-0 text-xs text-dim tabular-nums">{count}</span>
        {feedbackMessage && (
          <span className="shrink-0 text-xs text-dim" role="status">
            {feedbackMessage}
          </span>
        )}
        <PanelFullscreenButton />
      </Toolbar>

      <PanelBody>
        {disconnected ? (
          <EmptyState title="Disconnected" hint="Reconnect to view changes." />
        ) : activeWorktree === null || changeset === null ? (
          loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <EmptyState
              title="No changes"
              hint={worktrees.length === 0 ? 'No worktree available' : 'Select a worktree to inspect'}
            />
          )
        ) : loading && files.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No matching files" hint="Adjust the filter to see changes" />
        ) : (
          filtered.map((file) => {
            const glyph = STATUS_GLYPH[file.status];
            const descriptor: FileRowDescriptor = {
              relPath: file.newPath,
              worktreePath: activeWorktree,
              isDir: false,
              downloadable: file.status !== 'deleted',
            };
            const menuItems = buildFileRowMenuItems(descriptor, { activeProject, onActionComplete });
            return (
              <ContextMenu key={file.newPath} items={menuItems}>
                <Row
                  active={selectedPath === file.newPath}
                  onClick={() => selectFile(file)}
                  prefix={
                    <Badge tone={glyph.tone} aria-label={file.status} title={file.status}>
                      {glyph.letter}
                    </Badge>
                  }
                  suffix={
                    <span className="flex items-center gap-1 text-[10px] text-dim">
                      {file.isBinary && <span title="binary">bin</span>}
                      {file.staged && <span title="staged" className="text-added">staged</span>}
                    </span>
                  }
                >
                  <span className={cn('truncate', file.isGenerated && 'text-dim italic')}>
                    {file.newPath}
                  </span>
                </Row>
              </ContextMenu>
            );
          })
        )}
      </PanelBody>
    </Panel>
  );
}
