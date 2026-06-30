// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { ContentSelection } from './selectionStore';
import { useContentSelection } from './selectionStore';

const { getFileDiff, getDiffBundle, readFile } = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  getDiffBundle: vi.fn(),
  readFile: vi.fn(),
}));

// `cockpit` resolves `window.api` at module load, so mock the provider client
// to expose our stub regardless of evaluation order. The retained child
// components (RawFile/ImageCompare) talk to `window.api` directly, so set that
// too for their reads.
vi.mock('../providerClient', () => ({
  agentCockpit: {
    provider: { getFileDiff, getDiffBundle, readFile },
    // RawFile/notes load through the notes store; stub an empty list.
    notes: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      exportMarkdown: vi.fn().mockResolvedValue(''),
    },
  },
  // ContentViewer reads the active project id (selector form); the notes store
  // reads it imperatively via getState().
  useProjectsStore: Object.assign(
    (sel: (s: { activeId: string | null }) => unknown) => sel({ activeId: 'p1' }),
    { getState: () => ({ activeId: 'p1' }) },
  ),
}));

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = {
  provider: { getFileDiff, getDiffBundle, readFile },
};

import { ContentViewer } from './ContentViewer';

function sel(path: string, over: Partial<ContentSelection> = {}): ContentSelection {
  return { path, worktreePath: '/wt', kind: 'change', ...over };
}

const SAMPLE_DIFF = [
  '--- a/file.ts',
  '+++ b/file.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

afterEach(() => {
  cleanup();
  // Reset zustand store state between tests.
  useContentSelection.setState({ selections: {} });
});

describe('useContentSelection (per-project store)', () => {
  it('starts with no selection for any project', () => {
    expect(useContentSelection.getState().selectionFor('proj-a')).toBeNull();
  });

  it('stores selections per project independently', () => {
    const { select, selectionFor } = useContentSelection.getState();
    const selA: ContentSelection = { path: 'a.ts', worktreePath: '', kind: 'file' };
    const selB: ContentSelection = { path: 'b.ts', worktreePath: '', kind: 'file' };
    select('proj-a', selA);
    select('proj-b', selB);
    expect(selectionFor('proj-a')).toEqual(selA);
    expect(selectionFor('proj-b')).toEqual(selB);
  });

  it('switching project A -> B -> A restores A selection', () => {
    const { select, selectionFor } = useContentSelection.getState();
    const selA: ContentSelection = { path: 'a.ts', worktreePath: '', kind: 'file' };
    const selB: ContentSelection = { path: 'b.ts', worktreePath: '', kind: 'file' };
    select('proj-a', selA);
    // Switch to B (select a file in B)
    select('proj-b', selB);
    // B selection must not bleed into A
    expect(selectionFor('proj-a')).toEqual(selA);
    // Returning to A still shows A's selection
    expect(selectionFor('proj-a')).toEqual(selA);
  });

  it('clear removes a specific project selection without affecting others', () => {
    const { select, clear, selectionFor } = useContentSelection.getState();
    const selA: ContentSelection = { path: 'a.ts', worktreePath: '', kind: 'file' };
    const selB: ContentSelection = { path: 'b.ts', worktreePath: '', kind: 'file' };
    select('proj-a', selA);
    select('proj-b', selB);
    clear('proj-a');
    expect(selectionFor('proj-a')).toBeNull();
    expect(selectionFor('proj-b')).toEqual(selB);
  });
});

describe('ContentViewer', () => {
  beforeEach(() => {
    getFileDiff.mockReset();
    getDiffBundle.mockReset();
    readFile.mockReset();
    getFileDiff.mockResolvedValue(SAMPLE_DIFF);
    // Diff mode now loads a one-call bundle (patch + both sides' content).
    getDiffBundle.mockResolvedValue({ patch: SAMPLE_DIFF, oldContent: null, newContent: null });
    readFile.mockResolvedValue({ content: '# Title\n\nbody', truncated: false, isBinary: false, sizeBytes: 13 });
  });

  it('renders EmptyState when change is null', () => {
    render(<ContentViewer selection={null} />);
    expect(screen.getByText('No file selected')).toBeInTheDocument();
  });

  it('defaults to rendered mode for a .md change', async () => {
    render(<ContentViewer selection={sel('docs/readme.md')} />);
    // Rendered mode reads the working-tree source for markdown.
    await waitFor(() => expect(readFile).toHaveBeenCalledWith('docs/readme.md'));
    const rendered = screen.getByRole('tab', { name: 'Rendered' });
    expect(rendered).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('Title');
  });

  it('defaults to diff mode for a .ts change', async () => {
    render(<ContentViewer selection={sel('src/file.ts')} />);
    await waitFor(() =>
      expect(getDiffBundle).toHaveBeenCalledWith('/wt', 'src/file.ts', undefined),
    );
    const diff = screen.getByRole('tab', { name: 'Diff' });
    expect(diff).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('const b = 2;', { exact: false });
  });

  it('switches modes when a mode tab is clicked', async () => {
    render(<ContentViewer selection={sel('src/file.ts', { baseline: 'HEAD' })} />);
    await screen.findByText('const b = 2;', { exact: false });

    // Switch to Raw -> RawFile reads file content.
    readFile.mockResolvedValue({ content: 'raw text body', truncated: false, isBinary: false, sizeBytes: 13 });
    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    await waitFor(() =>
      expect(readFile).toHaveBeenCalledWith('src/file.ts', { ref: 'HEAD' }),
    );
    // RawFile renders per-line rows (line-number gutter + code) and may split the
    // line into token spans; assert the concatenated line text is present.
    await waitFor(() => expect(document.body.textContent).toContain('raw text body'));
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
  });

  it('defaults to image mode and offers image/raw for an image change', async () => {
    render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);
    expect(screen.getByRole('tab', { name: 'Image' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Raw' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Diff' })).not.toBeInTheDocument();
    await screen.findByText('Before (baseline)');
  });
});
