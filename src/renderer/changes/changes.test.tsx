// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Changeset, FileChange, WorktreeRecord } from '@shared/ipc/channels';
import {
  COPY_ABSOLUTE_LABEL,
  COPY_RELATIVE_LABEL,
  DOWNLOAD_LABEL,
  DOWNLOAD_UNAVAILABLE_TITLE,
} from '@renderer/files/rowMenu';

// `cockpit` resolves `window.api` at module-import time, so the bridge mock must
// be installed before the panel/store modules are dynamically imported.

const PROJECT = 'test-project';

function makeWorktree(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    path: '/repo/main',
    branch: 'main',
    head: 'abc123',
    locked: false,
    prunable: false,
    detached: false,
    ...over,
  };
}

function makeFile(over: Partial<FileChange> & Pick<FileChange, 'status' | 'newPath'>): FileChange {
  return {
    oldPath: null,
    isBinary: false,
    isGenerated: false,
    sizeBytes: null,
    staged: false,
    ...over,
  };
}

function makeChangeset(files: FileChange[]): Changeset {
  return {
    worktree: '/repo/main',
    baseline: 'HEAD',
    baselineKind: 'HEAD',
    files,
    generatedAt: '2026-05-24T00:00:00.000Z',
  };
}

function makeLargeChangeset(count: number): Changeset {
  return makeChangeset(
    Array.from({ length: count }, (_, index) =>
      makeFile({
        status: index % 2 === 0 ? 'modified' : 'untracked',
        newPath: `src/${index.toString().padStart(5, '0')}.ts`,
      }),
    ),
  );
}

function installApi(overrides: {
  listWorktrees?: ReturnType<typeof vi.fn>;
  getChangeset?: ReturnType<typeof vi.fn>;
  onWatch?: ReturnType<typeof vi.fn>;
  saveAs?: ReturnType<typeof vi.fn>;
} = {}) {
  const api = {
    provider: {
      listWorktrees:
        overrides.listWorktrees ?? vi.fn().mockResolvedValue([makeWorktree()]),
      getChangeset:
        overrides.getChangeset ??
        vi.fn().mockResolvedValue(
          makeChangeset([
            makeFile({ status: 'added', newPath: 'src/new.ts' }),
            makeFile({ status: 'modified', newPath: 'src/edit.ts', staged: true }),
            makeFile({ status: 'deleted', newPath: 'src/gone.ts' }),
            makeFile({ status: 'untracked', newPath: 'tmp/scratch.log' }),
          ]),
        ),
    },
    events: {
      onWatch: overrides.onWatch ?? vi.fn(() => () => {}),
    },
    files: {
      saveAs: overrides.saveAs ?? vi.fn().mockResolvedValue(null),
    },
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  return api;
}

/** Stub `navigator.clipboard.writeText`; returns the spy. */
function installClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

/** Flush every pending microtask (the copy/download `.then()` chains) — same
 *  pattern as rowMenu.test.tsx, needed to prove a silent (non-)outcome rather
 *  than racing a `waitFor` that would pass on its first, too-early check. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function loadModules() {
  vi.resetModules();
  const mod = await import('./ChangesPanel');
  const store = await import('./changesStore');
  const { useProjectsStore } = await import('@renderer/providerClient');
  // The active slice selector reads byProject[activeId]; tests need an active id.
  useProjectsStore.setState({ activeId: PROJECT });
  return { ...mod, ...store };
}

/** panelDataSync drives loads from connection status; tests drive the addressed
 *  slice load directly: worktreeStore lists worktrees (single owner of the
 *  selection), then changesStore refreshes the changeset for it. */
async function loadSlice(): Promise<void> {
  const { useChangesStore } = await import('./changesStore');
  const { useWorktreeStore } = await import('@renderer/worktree/worktreeStore');
  await act(async () => {
    await useWorktreeStore.getState().loadWorktrees(PROJECT);
    await useChangesStore.getState().refresh(PROJECT);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  // Fresh store state per test via resetModules() in loadModules().
});

describe('ChangesPanel', () => {
  it('renders one row per file with status letters', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/new.ts');
    expect(screen.getByText('src/edit.ts')).toBeInTheDocument();
    expect(screen.getByText('src/gone.ts')).toBeInTheDocument();
    expect(screen.getByText('tmp/scratch.log')).toBeInTheDocument();

    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();

    expect(screen.getByTitle('staged')).toBeInTheDocument();
    expect(screen.getByText('4/4')).toBeInTheDocument();
  });

  it('narrows the list via the text filter', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/new.ts');
    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'edit' } });

    expect(screen.getByText('src/edit.ts')).toBeInTheDocument();
    expect(screen.queryByText('src/new.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('tmp/scratch.log')).not.toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
  });

  it('narrows the list via the untracked filter pill', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/new.ts');
    fireEvent.click(screen.getByRole('button', { name: 'untracked' }));

    expect(screen.getByText('tmp/scratch.log')).toBeInTheDocument();
    expect(screen.queryByText('src/new.ts')).not.toBeInTheDocument();
    expect(screen.getByText('1/4')).toBeInTheDocument();
  });

  it('marks a row active when selected', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    const { useChangesStore } = await import('./changesStore');
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.click(row);

    await waitFor(() => {
      expect(useChangesStore.getState().byProject[PROJECT]!.selectedPath).toBe('src/new.ts');
    });
  });

  it('shows an empty state when no worktrees exist', async () => {
    installApi({ listWorktrees: vi.fn().mockResolvedValue([]) });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    expect(await screen.findByText('No worktree available')).toBeInTheDocument();
  });

  it('hides .beads rows by default and reveals them when showAllChanges is on', async () => {
    installApi({
      getChangeset: vi.fn().mockResolvedValue(
        makeChangeset([
          makeFile({ status: 'modified', newPath: 'src/edit.ts' }),
          makeFile({ status: 'modified', newPath: '.beads/issues.jsonl' }),
        ]),
      ),
    });
    const { ChangesPanel } = await loadModules();
    const { useSettingsStore } = await import('@renderer/settings/settingsStore');
    const { DEFAULT_SETTINGS } = await import('@shared/settings');
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/edit.ts');
    expect(screen.queryByText('.beads/issues.jsonl')).not.toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();

    await act(async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, showAllChanges: true } });
    });
    await screen.findByText('.beads/issues.jsonl');
    expect(screen.getByText('2/2')).toBeInTheDocument();
  });

  it('virtualizes a 10,000-row list while preserving scroll, selection, and context menus', async () => {
    installApi({ getChangeset: vi.fn().mockResolvedValue(makeLargeChangeset(10_000)) });
    const { ChangesPanel, useChangesStore } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/00000.ts');
    // jsdom has no layout, so ChangesPanel's documented 400 px viewport fallback
    // mounts at most 31 rows: ceil(400 / 28) visible + 8-row overscan per side.
    expect(screen.getAllByTestId('change-file-row')).toHaveLength(23);

    const list = screen.getByTestId('changes-virtual-list');
    expect(list).toHaveStyle({ height: '280000px' });
    const scroller = list.parentElement!;
    scroller.scrollTop = 28 * 9_000;
    fireEvent.scroll(scroller);

    const laterRow = await screen.findByText('src/09000.ts');
    expect(screen.queryByText('src/00000.ts')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('change-file-row').length).toBeLessThanOrEqual(31);

    fireEvent.click(laterRow);
    await waitFor(() => {
      expect(useChangesStore.getState().byProject[PROJECT]!.selectedPath).toBe('src/09000.ts');
    });

    fireEvent.contextMenu(laterRow);
    expect(await screen.findByText(COPY_RELATIVE_LABEL)).toBeInTheDocument();
  });

  it('clamps virtual scrolling when a text filter or refreshed changeset shrinks the list', async () => {
    const getChangeset = vi
      .fn()
      .mockResolvedValueOnce(makeLargeChangeset(10_000))
      .mockResolvedValueOnce(makeChangeset([makeFile({ status: 'modified', newPath: 'src/after.ts' })]));
    installApi({ getChangeset });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const list = await screen.findByTestId('changes-virtual-list');
    const scroller = list.parentElement!;
    scroller.scrollTop = 28 * 9_000;
    fireEvent.scroll(scroller);
    await screen.findByText('src/09000.ts');

    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: '09999' } });
    expect(await screen.findByText('src/09999.ts')).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);

    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: '' } });
    scroller.scrollTop = 28 * 9_000;
    fireEvent.scroll(scroller);
    await screen.findByText('src/09000.ts');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }));
    expect(await screen.findByText('src/after.ts')).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);
  });
});

describe('row context menu', () => {
  it('opens on a context-menu event with exactly the three expected labels', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);

    expect(await screen.findByText(COPY_ABSOLUTE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(COPY_RELATIVE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(DOWNLOAD_LABEL)).toBeInTheDocument();
  });

  it('Copy path (relative) copies file.newPath verbatim', async () => {
    installApi();
    const writeText = installClipboard();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(COPY_RELATIVE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src/new.ts'));
  });

  it('Copy path (fully qualified) copies the path resolved under the active worktree', async () => {
    installApi();
    const writeText = installClipboard();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice(); // default worktree is '/repo/main' (makeWorktree())

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(COPY_ABSOLUTE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/repo/main/src/new.ts'));
  });

  it('Download calls the saveAs bridge with the row path and the active worktree', async () => {
    const saveAs = vi.fn().mockResolvedValue('/Users/me/Downloads/new.ts');
    installApi({ saveAs });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    await waitFor(() =>
      expect(saveAs).toHaveBeenCalledWith('src/new.ts', {
        worktreePath: '/repo/main',
        projectId: undefined,
        suggestedName: 'new.ts',
      }),
    );
  });

  it('disables Download on a deleted row with an explanatory title, leaving both copy actions enabled', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/gone.ts');
    fireEvent.contextMenu(row);

    const download = await screen.findByText(DOWNLOAD_LABEL);
    expect(download).toHaveAttribute('aria-disabled', 'true');
    expect(download).toHaveAttribute('title', DOWNLOAD_UNAVAILABLE_TITLE);

    const copyAbsolute = screen.getByText(COPY_ABSOLUTE_LABEL);
    const copyRelative = screen.getByText(COPY_RELATIVE_LABEL);
    expect(copyAbsolute).not.toHaveAttribute('aria-disabled', 'true');
    expect(copyRelative).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('does not change the selection, content selection, or active-row highlight on right-click', async () => {
    installApi();
    const { ChangesPanel, useChangesStore } = await loadModules();
    const { useContentSelection } = await import('@renderer/content');
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    const rowEl = row.closest('div')!;
    const classNameBefore = rowEl.className;
    expect(useChangesStore.getState().byProject[PROJECT]!.selectedPath).toBeNull();
    expect(useContentSelection.getState().selections[PROJECT] ?? null).toBeNull();

    fireEvent.contextMenu(row);
    // Let the menu open (and any microtasks settle) before asserting nothing moved.
    await screen.findByText(DOWNLOAD_LABEL);

    expect(useChangesStore.getState().byProject[PROJECT]!.selectedPath).toBeNull();
    expect(useContentSelection.getState().selections[PROJECT] ?? null).toBeNull();
    expect(rowEl.className).toBe(classNameBefore);
    expect(rowEl.className).not.toMatch(/border-accent/);
  });
});

describe('row menu feedback (D3, wired per local_repo_explorer-dpqo)', () => {
  it('shows a transient confirmation in the toolbar after a successful copy', async () => {
    installApi();
    const writeText = installClipboard();
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(COPY_RELATIVE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src/new.ts'));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied relative path');
  });

  it('shows a transient confirmation after a completed download', async () => {
    const saveAs = vi.fn().mockResolvedValue('/Users/me/Downloads/new.ts');
    installApi({ saveAs });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded');
  });

  it('stays silent on a canceled download (saveAs resolves null)', async () => {
    const saveAs = vi.fn().mockResolvedValue(null);
    installApi({ saveAs });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    await waitFor(() => expect(saveAs).toHaveBeenCalled());
    await flush();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stays silent on a failed copy (clipboard write rejects)', async () => {
    installApi();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    const row = await screen.findByText('src/new.ts');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText(COPY_RELATIVE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('src/new.ts'));
    await flush();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('worktree selection drives the changeset reload', () => {
  it('drops the selection and reloads the new first worktree when the selection disappears', async () => {
    // makeChangeset stamps worktree '/repo/main'; the selected worktree here is
    // '/repo/A' then '/repo/B', so the changeset.worktree mismatch on the second
    // refresh clears the stale selection (worktree switch), matching the picker.
    const getChangeset = vi.fn().mockResolvedValue(makeChangeset([]));
    const listWorktrees = vi
      .fn()
      .mockResolvedValueOnce([makeWorktree({ path: '/repo/A' })])
      .mockResolvedValueOnce([makeWorktree({ path: '/repo/B' })]); // A no longer present
    installApi({ listWorktrees, getChangeset });
    const { useChangesStore } = await loadModules();
    const { useWorktreeStore } = await import('@renderer/worktree/worktreeStore');

    await useWorktreeStore.getState().loadWorktrees(PROJECT);
    await useChangesStore.getState().refresh(PROJECT);
    expect(useWorktreeStore.getState().byProject[PROJECT]!.activeWorktree).toBe('/repo/A');
    useChangesStore.getState().select(PROJECT, 'src/old.ts');

    await useWorktreeStore.getState().loadWorktrees(PROJECT); // reload; A gone → B
    await useChangesStore.getState().refresh(PROJECT);
    expect(useWorktreeStore.getState().byProject[PROJECT]!.activeWorktree).toBe('/repo/B');
    expect(useChangesStore.getState().byProject[PROJECT]!.selectedPath).toBeNull();
    expect(getChangeset).toHaveBeenLastCalledWith('/repo/B', undefined, PROJECT);
  });

  it('keeps a still-valid selection across reloads', async () => {
    const listWorktrees = vi
      .fn()
      .mockResolvedValue([makeWorktree({ path: '/repo/A' }), makeWorktree({ path: '/repo/B' })]);
    installApi({ listWorktrees, getChangeset: vi.fn().mockResolvedValue(makeChangeset([])) });
    await loadModules();
    const { useWorktreeStore } = await import('@renderer/worktree/worktreeStore');

    useWorktreeStore.getState().setWorktree(PROJECT, '/repo/B');
    await useWorktreeStore.getState().loadWorktrees(PROJECT);
    expect(useWorktreeStore.getState().byProject[PROJECT]!.activeWorktree).toBe('/repo/B');
  });
});

describe('manual refresh (vqyh)', () => {
  it('renders "Refresh changes" and clicking it reloads the active project exactly once', async () => {
    const getChangeset = vi
      .fn()
      .mockResolvedValue(makeChangeset([makeFile({ status: 'modified', newPath: 'src/edit.ts' })]));
    installApi({ getChangeset });
    const { ChangesPanel } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();
    expect(getChangeset).toHaveBeenCalledTimes(1);

    const refresh = screen.getByRole('button', { name: 'Refresh changes' });
    // Byte-consistent with the TerminalPanel/RunPanel/ControlTerminalPanel
    // precedent: an IconButton whose only child is the '⟳' glyph.
    expect(refresh).toHaveTextContent('⟳');
    expect(refresh).toHaveAttribute('title', 'Refresh changes');

    await act(async () => {
      fireEvent.click(refresh);
      // Flush refresh()'s microtasks (getChangeset resolves immediately here —
      // no deferred promise in this test).
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Exactly one additional read landed from the single click — proves
    // refresh(activeId) fired exactly once, not zero or multiple times.
    expect(getChangeset).toHaveBeenCalledTimes(2);
  });

  it('disables "Refresh changes" when there is no active project', async () => {
    installApi();
    const { ChangesPanel } = await loadModules();
    const { useProjectsStore } = await import('@renderer/providerClient');
    render(<ChangesPanel />);
    await loadSlice();
    expect(screen.getByRole('button', { name: 'Refresh changes' })).not.toBeDisabled();

    act(() => {
      useProjectsStore.setState({ activeId: null });
    });

    expect(screen.getByRole('button', { name: 'Refresh changes' })).toBeDisabled();
  });

  it('manual refresh on the same worktree keeps previously rendered rows visible throughout — no flicker', async () => {
    const row = makeFile({ status: 'modified', newPath: 'src/edit.ts' });
    const getChangeset = vi.fn().mockResolvedValue(makeChangeset([row]));
    installApi({ getChangeset });
    const { ChangesPanel, useChangesStore } = await loadModules();
    render(<ChangesPanel />);
    await loadSlice();

    await screen.findByText('src/edit.ts');

    // Defer the next read so the click's loading:true window is actually
    // observable while the previous changeset is still held.
    let resolveChangeset!: (c: Changeset) => void;
    getChangeset.mockReturnValueOnce(
      new Promise<Changeset>((r) => {
        resolveChangeset = r;
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }));

    // Mid-refresh, same worktree: changesStore.refresh() does NOT clear the
    // changeset before the read resolves (changesStore.ts:90-96) — verified
    // here, not assumed. The row must stay visible the whole time, never a
    // blank frame.
    await waitFor(() => {
      expect(useChangesStore.getState().byProject[PROJECT]!.loading).toBe(true);
    });
    expect(screen.getByText('src/edit.ts')).toBeInTheDocument();

    resolveChangeset(makeChangeset([row]));

    await waitFor(() => {
      expect(useChangesStore.getState().byProject[PROJECT]!.loading).toBe(false);
    });
    expect(screen.getByText('src/edit.ts')).toBeInTheDocument();
  });
});
