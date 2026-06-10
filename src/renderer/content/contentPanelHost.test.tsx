// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import type { ProjectInfo } from '@shared/ipc/channels';
import { useContentSelection } from './selectionStore';
import { useProjectsStore } from '../providerClient';

// Mirror content.test.tsx: the ContentViewer subtree resolves its reads through
// the provider client and window.api, so stub both before importing the host.
const { getFileDiff, readFile } = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../providerClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providerClient')>();
  return { ...actual, agentCockpit: { provider: { getFileDiff, readFile } } };
});

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = { provider: { getFileDiff, readFile } };

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
const PROJECTS = [{ id: 'p1' }, { id: 'p2' }] as unknown as ProjectInfo[];

function setActive(id: string | null): void {
  act(() => {
    useProjectsStore.setState({ activeId: id, projects: PROJECTS });
  });
}

function select(projectId: string, path: string, kind: 'change' | 'file', baseline?: string): void {
  act(() => {
    useContentSelection
      .getState()
      .select(projectId, { path, worktreePath: '', kind, ...(baseline ? { baseline } : {}) });
  });
}

beforeEach(() => {
  getFileDiff.mockReset();
  readFile.mockReset();
  getFileDiff.mockResolvedValue(SAMPLE_DIFF);
  readFile.mockResolvedValue({ content: '# Title\n\nbody', truncated: false, isBinary: false, sizeBytes: 13 });
  useContentSelection.setState({ selections: {} });
  useProjectsStore.setState({ activeId: null, projects: [] });
});

afterEach(() => {
  cleanup();
  useContentSelection.setState({ selections: {} });
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
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith('', 'a.ts', 'HEAD'));
  });

  it('shows each project its own selection and restores on switch-back', async () => {
    select('p1', 'p1-file.ts', 'change', 'HEAD'); // .ts change -> diff -> getFileDiff
    select('p2', 'p2-readme.md', 'file'); // .md file -> rendered -> readFile

    setActive('p1');
    render(<ContentPanelHost />);
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD'));

    // Switch to p2 -> p2's own selection (markdown renders the working-tree
    // source, so readFile is called for the p2 path). The diff is also fetched
    // for p2's path (it drives markdown change callouts), confirming the panel
    // reacted to the active-project switch rather than retaining p1's content.
    getFileDiff.mockClear();
    readFile.mockClear();
    setActive('p2');
    await waitFor(() => expect(readFile.mock.calls.some((c) => c[0] === 'p2-readme.md')).toBe(true));
    expect(getFileDiff).not.toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD');

    // Switch back to p1 -> p1's selection is restored.
    getFileDiff.mockClear();
    setActive('p1');
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith('', 'p1-file.ts', 'HEAD'));
  });

  it('updates the view when a different file is selected under the same project', async () => {
    select('p1', 'first.ts', 'change', 'HEAD');
    setActive('p1');
    render(<ContentPanelHost />);
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith('', 'first.ts', 'HEAD'));

    getFileDiff.mockClear();
    select('p1', 'second.ts', 'change', 'HEAD');
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith('', 'second.ts', 'HEAD'));
  });
});
