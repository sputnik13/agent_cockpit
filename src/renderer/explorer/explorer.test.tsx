// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DirEntry } from '@shared/providers/types';
import type { WorktreeRecord } from '@shared/ipc/channels';

const PROJECT = 'test-project';
const WT: WorktreeRecord = {
  path: '/repo/agent_cockpit',
  branch: 'main',
  head: 'abc1234',
  locked: false,
  prunable: false,
  detached: false,
};

const dir = (name: string, isDir = false): DirEntry => ({ name, path: name, isDir });

/** listDir keyed on the read base: `/` returns filesystem-root entries, the
 *  worktree path returns in-project entries. */
function makeListDir(): ReturnType<typeof vi.fn> {
  return vi.fn((_dirPath: string, worktreePath?: string) =>
    Promise.resolve(worktreePath === '/' ? [dir('etc', true), dir('hostfile')] : [dir('README.md')]),
  );
}

function installApi(listDir: ReturnType<typeof vi.fn>) {
  const api = {
    provider: {
      listWorktrees: vi.fn().mockResolvedValue([WT]),
      listDir,
      readFile: vi.fn().mockResolvedValue({ content: 'x', truncated: false, isBinary: false, sizeBytes: 1 }),
    },
    events: { onWatch: vi.fn(() => () => {}) },
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  return api;
}

async function loadModules() {
  vi.resetModules();
  const { ExplorerPanel } = await import('./ExplorerPanel');
  const { useExplorerStore } = await import('./explorerStore');
  const { useWorktreeStore } = await import('@renderer/worktree/worktreeStore');
  const { useContentSelection } = await import('@renderer/content');
  const { useProjectsStore } = await import('@renderer/providerClient');
  useProjectsStore.setState({ activeId: PROJECT });
  return { ExplorerPanel, useExplorerStore, useWorktreeStore, useContentSelection };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExplorerPanel root browsing', () => {
  it('lists the active worktree base and opens files in-project', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useWorktreeStore, useContentSelection } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    await waitFor(() => expect(listDir).toHaveBeenCalledWith('', '/repo/agent_cockpit'));
    fireEvent.click(await screen.findByText('README.md'));
    expect(useContentSelection.getState().selectionFor(PROJECT)).toMatchObject({
      kind: 'file',
      path: 'README.md',
      worktreePath: '/repo/agent_cockpit',
      baseline: 'HEAD',
    });
  });

  it('browsing root lists "/" WITHOUT changing the shared worktree (Changes isolation)', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    await screen.findByText('README.md');

    // The dropdown's onValueChange('/') calls this — drive it directly to avoid
    // Radix portal interaction; the important behavior is the base + isolation.
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    await waitFor(() => expect(listDir).toHaveBeenCalledWith('', '/'));
    await screen.findByText('hostfile');
    // The shared worktree selection (which also drives Changes) is untouched.
    expect(useWorktreeStore.getState().byProject[PROJECT]?.activeWorktree).toBe('/repo/agent_cockpit');
  });

  it('opens a root file as an absolute external-file (no git diff)', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore, useContentSelection } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    fireEvent.click(await screen.findByText('hostfile'));
    expect(useContentSelection.getState().selectionFor(PROJECT)).toMatchObject({
      kind: 'external-file',
      path: '/hostfile',
      worktreePath: '',
    });
  });

  it('returning to a workspace clears root browsing', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));
    await screen.findByText('hostfile');

    // Selecting a workspace (onValueChange(path)) sets the worktree AND clears root.
    act(() => {
      useWorktreeStore.getState().setWorktree(PROJECT, '/repo/agent_cockpit');
      useExplorerStore.getState().setRootBrowse(PROJECT, false);
    });

    await screen.findByText('README.md');
    expect(useExplorerStore.getState().isRootBrowse(PROJECT)).toBe(false);
  });
});
