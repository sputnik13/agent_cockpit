// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Changeset, FileChange, WorktreeRecord } from '@shared/ipc/channels';

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

function installApi(overrides: {
  listWorktrees?: ReturnType<typeof vi.fn>;
  getChangeset?: ReturnType<typeof vi.fn>;
  onWatch?: ReturnType<typeof vi.fn>;
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
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  return api;
}

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
 *  slice load directly. */
async function loadSlice(): Promise<void> {
  const { useChangesStore } = await import('./changesStore');
  await act(async () => {
    await useChangesStore.getState().loadWorktrees(PROJECT);
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
});

describe('changesStore.loadWorktrees worktree resolution', () => {
  it('drops a stale activeWorktree and reloads the new first worktree on reload', async () => {
    const getChangeset = vi.fn().mockResolvedValue(makeChangeset([]));
    const listWorktrees = vi
      .fn()
      .mockResolvedValueOnce([makeWorktree({ path: '/repo/A' })])
      .mockResolvedValueOnce([makeWorktree({ path: '/repo/B' })]); // A no longer present
    installApi({ listWorktrees, getChangeset });
    const { useChangesStore } = await loadModules();

    await useChangesStore.getState().loadWorktrees(PROJECT);
    expect(useChangesStore.getState().byProject[PROJECT]!.activeWorktree).toBe('/repo/A');
    useChangesStore.getState().select(PROJECT, 'src/old.ts');

    await useChangesStore.getState().loadWorktrees(PROJECT); // reload; A gone
    const slice = useChangesStore.getState().byProject[PROJECT]!;
    expect(slice.activeWorktree).toBe('/repo/B');
    expect(slice.selectedPath).toBeNull();
    expect(getChangeset).toHaveBeenLastCalledWith('/repo/B', undefined, PROJECT);
  });

  it('keeps a still-valid activeWorktree across reloads', async () => {
    const listWorktrees = vi
      .fn()
      .mockResolvedValue([makeWorktree({ path: '/repo/A' }), makeWorktree({ path: '/repo/B' })]);
    installApi({ listWorktrees, getChangeset: vi.fn().mockResolvedValue(makeChangeset([])) });
    const { useChangesStore } = await loadModules();

    await useChangesStore.getState().setWorktree(PROJECT, '/repo/B');
    await useChangesStore.getState().loadWorktrees(PROJECT);
    expect(useChangesStore.getState().byProject[PROJECT]!.activeWorktree).toBe('/repo/B');
  });
});
