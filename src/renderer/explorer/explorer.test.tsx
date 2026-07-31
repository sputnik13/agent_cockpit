// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { DirEntry } from '@shared/providers/types';
import type { WorktreeRecord } from '@shared/ipc/channels';
import {
  COPY_ABSOLUTE_LABEL,
  COPY_RELATIVE_LABEL,
  COPY_RELATIVE_UNAVAILABLE_TITLE,
  DOWNLOAD_LABEL,
  DOWNLOAD_DIR_TITLE,
} from '@renderer/files/rowMenu';

// jsdom does not implement scrollIntoView — stub it globally (see
// diagnostics/logViewerBody.test.tsx for the established pattern).
Element.prototype.scrollIntoView = vi.fn();

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
 *  worktree path returns in-project entries (one file, one dir — so both row
 *  kinds are exercised in-project without a second listDir call). */
function makeListDir(): ReturnType<typeof vi.fn> {
  return vi.fn((_dirPath: string, worktreePath?: string) =>
    Promise.resolve(
      worktreePath === '/' ? [dir('etc', true), dir('hostfile')] : [dir('README.md'), dir('src', true)],
    ),
  );
}

function installApi(listDir: ReturnType<typeof vi.fn>, overrides: { saveAs?: ReturnType<typeof vi.fn> } = {}) {
  const api = {
    provider: {
      listWorktrees: vi.fn().mockResolvedValue([WT]),
      listDir,
      readFile: vi.fn().mockResolvedValue({ content: 'x', truncated: false, isBinary: false, sizeBytes: 1 }),
    },
    events: { onWatch: vi.fn(() => () => {}) },
    files: { saveAs: overrides.saveAs ?? vi.fn().mockResolvedValue(null) },
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  return api;
}

/** Stub `navigator.clipboard.writeText`; returns the spy. */
function installClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
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

describe('row context menu (in-project)', () => {
  it('opens on a file row with the three expected labels', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));

    expect(await screen.findByText(COPY_ABSOLUTE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(COPY_RELATIVE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(DOWNLOAD_LABEL)).toBeInTheDocument();
  });

  it('opens on a directory row with the three expected labels', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('src'));

    expect(await screen.findByText(COPY_ABSOLUTE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(COPY_RELATIVE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(DOWNLOAD_LABEL)).toBeInTheDocument();
  });

  it('Copy path (relative) copies entry.path verbatim', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const writeText = installClipboard();
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(COPY_RELATIVE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('README.md'));
  });

  it('Copy path (fully qualified) copies the absolute path under the active worktree, and updates when the worktree changes', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const writeText = installClipboard();
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(COPY_ABSOLUTE_LABEL));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/repo/agent_cockpit/README.md'));

    act(() => useWorktreeStore.getState().setWorktree(PROJECT, '/repo/other-worktree'));

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(COPY_ABSOLUTE_LABEL));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('/repo/other-worktree/README.md'));
  });

  it('Download calls the saveAs bridge with the row path and the active worktree', async () => {
    const saveAs = vi.fn().mockResolvedValue('/Users/me/Downloads/README.md');
    const listDir = makeListDir();
    installApi(listDir, { saveAs });
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    await waitFor(() =>
      expect(saveAs).toHaveBeenCalledWith('README.md', {
        worktreePath: '/repo/agent_cockpit',
        projectId: undefined,
        suggestedName: 'README.md',
      }),
    );
  });

  it('disables Download on a directory row with an explanatory title, leaving both copy actions enabled', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('src'));

    const download = await screen.findByText(DOWNLOAD_LABEL);
    expect(download).toHaveAttribute('aria-disabled', 'true');
    expect(download).toHaveAttribute('title', DOWNLOAD_DIR_TITLE);

    const copyAbsolute = screen.getByText(COPY_ABSOLUTE_LABEL);
    const copyRelative = screen.getByText(COPY_RELATIVE_LABEL);
    expect(copyAbsolute).not.toHaveAttribute('aria-disabled', 'true');
    expect(copyRelative).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('right-click on a directory row does not toggle expansion', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    const dirRow = await screen.findByText('src');
    expect(useExplorerStore.getState().isExpanded(PROJECT, 'src')).toBe(false);

    fireEvent.contextMenu(dirRow);
    await screen.findByText(DOWNLOAD_LABEL); // let the menu open (and any microtasks settle)

    expect(useExplorerStore.getState().isExpanded(PROJECT, 'src')).toBe(false);
    // The children were never listed as a result of the right-click.
    expect(listDir).not.toHaveBeenCalledWith('src', expect.anything());
  });

  it('right-click on a file row does not change the content selection or active-row highlight', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useWorktreeStore, useContentSelection } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    const fileRow = await screen.findByText('README.md');
    const rowEl = fileRow.closest('div')!;
    const classNameBefore = rowEl.className;
    expect(useContentSelection.getState().selections[PROJECT] ?? null).toBeNull();

    fireEvent.contextMenu(fileRow);
    await screen.findByText(DOWNLOAD_LABEL);

    expect(useContentSelection.getState().selections[PROJECT] ?? null).toBeNull();
    expect(rowEl.className).toBe(classNameBefore);
    expect(rowEl.className).not.toMatch(/border-accent/);
  });

  it('right-click does not consume an unrelated pending reveal target', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    await screen.findByText('README.md');

    // A pending reveal target for a file that is not currently mounted, so
    // the (unrelated) scroll-into-view/consume effect never fires on its own.
    act(() => useExplorerStore.getState().reveal(PROJECT, 'not-rendered.md'));
    expect(useExplorerStore.getState().revealTarget[PROJECT]).toBe('not-rendered.md');

    fireEvent.contextMenu(await screen.findByText('README.md'));
    await screen.findByText(DOWNLOAD_LABEL);

    expect(useExplorerStore.getState().revealTarget[PROJECT]).toBe('not-rendered.md');
  });
});

describe('row context menu (root-browse)', () => {
  it('Copy path (fully qualified) copies the root-joined absolute path for a file', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const writeText = installClipboard();
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    fireEvent.contextMenu(await screen.findByText('hostfile'));
    fireEvent.click(await screen.findByText(COPY_ABSOLUTE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/hostfile'));
  });

  it('D1: disables Copy path (relative) with an explanatory title for a root-browse file', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    fireEvent.contextMenu(await screen.findByText('hostfile'));

    const relative = await screen.findByText(COPY_RELATIVE_LABEL);
    expect(relative).toHaveAttribute('aria-disabled', 'true');
    expect(relative).toHaveAttribute('title', COPY_RELATIVE_UNAVAILABLE_TITLE);
    // The absolute copy stays enabled.
    expect(screen.getByText(COPY_ABSOLUTE_LABEL)).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('D1: disables Copy path (relative) for a root-browse directory too', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    fireEvent.contextMenu(await screen.findByText('etc'));

    const relative = await screen.findByText(COPY_RELATIVE_LABEL);
    expect(relative).toHaveAttribute('aria-disabled', 'true');
    expect(relative).toHaveAttribute('title', COPY_RELATIVE_UNAVAILABLE_TITLE);
  });

  it('Download calls the saveAs bridge with the resolved absolute path for a root-browse file', async () => {
    const saveAs = vi.fn().mockResolvedValue('/Users/me/Downloads/hostfile');
    const listDir = makeListDir();
    installApi(listDir, { saveAs });
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    fireEvent.contextMenu(await screen.findByText('hostfile'));
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    await waitFor(() =>
      expect(saveAs).toHaveBeenCalledWith('/hostfile', {
        worktreePath: '',
        projectId: undefined,
        suggestedName: 'hostfile',
      }),
    );
  });

  it('right-click on a root-browse directory row does not toggle expansion', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    act(() => useExplorerStore.getState().setRootBrowse(PROJECT, true));

    const dirRow = await screen.findByText('etc');
    fireEvent.contextMenu(dirRow);
    await screen.findByText(DOWNLOAD_LABEL);

    expect(useExplorerStore.getState().isExpanded(PROJECT, 'etc')).toBe(false);
    expect(listDir).not.toHaveBeenCalledWith('etc', expect.anything());
  });
});

describe('row menu feedback (D3, wired in Explorer per the coordinator note)', () => {
  it('shows a transient confirmation in the toolbar after a successful copy', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const writeText = installClipboard();
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(COPY_RELATIVE_LABEL));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('README.md'));
    expect(await screen.findByRole('status')).toHaveTextContent('Copied relative path');
  });

  it('shows a transient confirmation after a completed download', async () => {
    const saveAs = vi.fn().mockResolvedValue('/Users/me/Downloads/README.md');
    const listDir = makeListDir();
    installApi(listDir, { saveAs });
    const { ExplorerPanel, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });

    fireEvent.contextMenu(await screen.findByText('README.md'));
    fireEvent.click(await screen.findByText(DOWNLOAD_LABEL));

    expect(await screen.findByRole('status')).toHaveTextContent('Downloaded');
  });
});

describe('FileNode scroll-into-view (Row forwardRef, wrapper <div> dropped)', () => {
  it('scrolls the row into view when it becomes the reveal target, using Row itself as the ref target', async () => {
    const listDir = makeListDir();
    installApi(listDir);
    const { ExplorerPanel, useExplorerStore, useWorktreeStore } = await loadModules();
    render(<ExplorerPanel />);
    await act(async () => {
      await useWorktreeStore.getState().loadWorktrees(PROJECT);
    });
    await screen.findByText('README.md');

    const scrollSpy = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    scrollSpy.mockClear();

    act(() => useExplorerStore.getState().reveal(PROJECT, 'README.md'));

    await waitFor(() => expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' }));
    // The store-side reveal target is consumed once scrolled — existing
    // behavior, unaffected by dropping FileNode's wrapper <div>.
    expect(useExplorerStore.getState().revealTarget[PROJECT]).toBeNull();
  });
});
