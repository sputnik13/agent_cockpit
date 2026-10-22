// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import type { ProjectInfo } from '@shared/ipc/channels';
import { useContentSelection } from './selectionStore';
import { useProjectsStore } from '../providerClient';

// Mirror content.test.tsx: the ContentViewer subtree resolves its reads through
// the provider client and window.api, so stub both before importing the host.
const { getFileDiff, getDiffBundle, readFile } = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  getDiffBundle: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../providerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providerClient')>();
  return {
    ...actual,
    agentCockpit: {
      provider: { getFileDiff, getDiffBundle, readFile },
      // The watch hub (src/renderer/watch/hub.ts) reads `agentCockpit.events.
      // onWatch` directly — ContentViewer's manual-refresh staleness
      // subscription (local_repo_explorer-r97u) needs this to exist even
      // though this suite never dispatches a synthetic watch event.
      events: { onWatch: vi.fn().mockReturnValue(() => {}) },
    },
  };
});

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = {
  provider: { getFileDiff, getDiffBundle, readFile },
};

// Import the real host (renders the real ContentViewer subtree) after the shims.
import { ContentPanelHost } from '../workspace/panels';

const SAMPLE_DIFF = [
  '--- a/file.ts',
  '+++ b/file.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const ADDED = 2;',
  ' const c = 3;',
  '',
].join('\n');

// ContentPanelHost only reads `activeId`; project record shape is otherwise
// irrelevant to rendering, so a minimal cast keeps the fixture focused.
const PROJECTS = [
  { id: 'p1', connection: { kind: 'local', rootPath: '/repo/p1' } },
  { id: 'p2', connection: { kind: 'local', rootPath: '/repo/p2' } },
] as unknown as ProjectInfo[];

function setActive(id: string | null): void {
  act(() => {
    useProjectsStore.setState({ activeId: id, projects: PROJECTS });
  });
}

// The strip of open files (the viewer's own mode switcher also uses role=tab).
const fileTabs = (): HTMLElement[] =>
  within(screen.getByRole('tablist', { name: 'Open files' })).getAllByRole('tab');

function select(projectId: string, path: string, kind: 'change' | 'file', baseline?: string): void {
  act(() => {
    useContentSelection
      .getState()
      .select(projectId, { path, worktreePath: '', kind, ...(baseline ? { baseline } : {}) });
  });
}

beforeEach(() => {
  getFileDiff.mockReset();
  getDiffBundle.mockReset();
  readFile.mockReset();
  getFileDiff.mockResolvedValue(SAMPLE_DIFF);
  getDiffBundle.mockResolvedValue({ patch: SAMPLE_DIFF, oldContent: null, newContent: null });
  readFile.mockResolvedValue({
    content: '# Title\n\nbody',
    truncated: false,
    isBinary: false,
    sizeBytes: 13,
  });
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ activeId: null, projects: [] });
});

afterEach(() => {
  cleanup();
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ activeId: null, projects: [] });
});

describe('ContentPanelHost (store -> panel reactivity)', () => {
  it('shows the empty state with an active project but no selection', () => {
    setActive('p1');
    render(<ContentPanelHost />);
    expect(screen.getByText('No file selected')).toBeInTheDocument();
  });

  it('reactively renders content when a selection is added for the active project', async () => {
    setActive('p1');
    render(<ContentPanelHost />);
    expect(screen.getByText('No file selected')).toBeInTheDocument();

    // This is the regression: without a reactive subscription the panel never
    // re-renders after the selection write and stays on "No file selected".
    select('p1', 'a.ts', 'change', 'HEAD');

    await waitFor(() => expect(screen.queryByText('No file selected')).not.toBeInTheDocument());
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'a.ts', 'HEAD'));
  });

  it('shows each project its own selection and restores on switch-back', async () => {
    select('p1', 'p1-file.ts', 'change', 'HEAD'); // .ts change -> diff -> getDiffBundle
    select('p2', 'p2-readme.md', 'file'); // .md file -> rendered -> readFile

    setActive('p1');
    render(<ContentPanelHost />);
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD'));

    // Switch to p2 -> p2's own selection (markdown renders the working-tree
    // source, so readFile is called for the p2 path). The diff is also fetched
    // for p2's path (it drives markdown change callouts), confirming the panel
    // reacted to the active-project switch rather than retaining p1's content.
    getDiffBundle.mockClear();
    readFile.mockClear();
    setActive('p2');
    await waitFor(() =>
      expect(readFile.mock.calls.some((c) => c[0] === 'p2-readme.md')).toBe(true),
    );
    expect(getDiffBundle).not.toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD');

    // Switch back to p1 -> p1's selection is restored.
    getDiffBundle.mockClear();
    setActive('p1');
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD'));
  });

  it('updates the view when a different file is selected under the same project', async () => {
    select('p1', 'first.ts', 'change', 'HEAD');
    setActive('p1');
    render(<ContentPanelHost />);
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'first.ts', 'HEAD'));

    getDiffBundle.mockClear();
    select('p1', 'second.ts', 'change', 'HEAD');
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'second.ts', 'HEAD'));
  });

  it('opens each file in its own tab and reuses the tab for a file already open', async () => {
    setActive('p1');
    render(<ContentPanelHost />);
    select('p1', 'a.ts', 'change', 'HEAD');
    select('p1', 'b.ts', 'file');
    await waitFor(() => expect(fileTabs()).toHaveLength(2));
    // Re-opening a.ts (here as a plain file, e.g. from a link) reuses its tab.
    select('p1', 'a.ts', 'file');
    expect(fileTabs()).toHaveLength(2);
    const tabs = fileTabs();
    expect(tabs[0]).toHaveTextContent('a.ts');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    // Label is the filename; the fully-qualified path is on hover.
    expect(tabs[0]).toHaveAttribute('title', '/repo/p1/a.ts');
  });

  it('keeps a previously shown tab mounted so switching back does not reload it', async () => {
    setActive('p1');
    render(<ContentPanelHost />);
    select('p1', 'a.ts', 'change', 'HEAD');
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'a.ts', 'HEAD'));
    select('p1', 'b.ts', 'change', 'HEAD');
    await waitFor(() => expect(getDiffBundle).toHaveBeenCalledWith('', 'b.ts', 'HEAD'));
    getDiffBundle.mockClear();
    act(() => {
      fileTabs()[0]!.click();
    });
    expect(fileTabs()[0]).toHaveAttribute('aria-selected', 'true');
    // a.ts's viewer (and its mode/zoom/scroll state) was never unmounted.
    expect(getDiffBundle).not.toHaveBeenCalled();
  });

  it('closes tabs, activating a neighbour, and shows the empty state after the last', async () => {
    setActive('p1');
    render(<ContentPanelHost />);
    select('p1', 'a.ts', 'file');
    select('p1', 'b.ts', 'file');
    await waitFor(() => expect(fileTabs()).toHaveLength(2));
    act(() => {
      screen.getByRole('button', { name: 'Close b.ts' }).click();
    });
    expect(fileTabs()).toHaveLength(1);
    expect(fileTabs()[0]).toHaveAttribute('aria-selected', 'true');
    act(() => {
      screen.getByRole('button', { name: 'Close a.ts' }).click();
    });
    expect(screen.getByText('No file selected')).toBeInTheDocument();
  });

  it("shows only the active project's tabs", async () => {
    select('p1', 'only-p1.ts', 'file');
    select('p2', 'only-p2.ts', 'file');
    setActive('p1');
    render(<ContentPanelHost />);
    await waitFor(() => expect(fileTabs()).toHaveLength(1));
    expect(fileTabs()[0]!).toHaveTextContent('only-p1.ts');
    setActive('p2');
    await waitFor(() => expect(fileTabs()[0]!).toHaveTextContent('only-p2.ts'));
  });

  it('moves between tabs with the arrow keys and closes the focused tab with Delete', async () => {
    setActive('p1');
    render(<ContentPanelHost />);
    select('p1', 'a.ts', 'file');
    select('p1', 'b.ts', 'file');
    await waitFor(() => expect(fileTabs()).toHaveLength(2));
    // b.ts is in front; ArrowLeft wraps/moves to a.ts, ArrowRight comes back.
    act(() => {
      fireEvent.keyDown(fileTabs()[1]!, { key: 'ArrowLeft' });
    });
    expect(fileTabs()[0]).toHaveAttribute('aria-selected', 'true');
    act(() => {
      fireEvent.keyDown(fileTabs()[0]!, { key: 'ArrowRight' });
    });
    expect(fileTabs()[1]).toHaveAttribute('aria-selected', 'true');
    act(() => {
      fireEvent.keyDown(fileTabs()[1]!, { key: 'Delete' });
    });
    expect(fileTabs()).toHaveLength(1);
    expect(fileTabs()[0]).toHaveTextContent('a.ts');
  });
});
