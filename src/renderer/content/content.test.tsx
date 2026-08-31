// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { ContentSelection } from './selectionStore';
import { useContentSelection } from './selectionStore';
import { useNotesStore } from '../notes';
import type { NoteRecord, ReviewTargetKind } from '@shared/ipc/channels';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { DEFAULT_SETTINGS, structuredFoldReadMaxBytes } from '@shared/settings';

// `watchHandlers`/`onWatch` fake the preload bridge's `events.onWatch` (the
// hub's own subscription target — src/renderer/watch/hub.ts), mirroring
// foldingView.test.tsx's identical `watchHandlers` capture pattern for the
// same hub — ContentViewer's own manual-refresh staleness detection
// (local_repo_explorer-r97u) subscribes to it directly.
const { getFileDiff, getDiffBundle, readFile, readFileBytes, notesList, notesCreate, watchHandlers, onWatch } =
  vi.hoisted(() => {
    const watchHandlers: ((e: {
      projectId?: string;
      worktreePath?: string;
      event?: { paths?: string[]; at?: string };
    }) => void)[] = [];
    const onWatch = (
      h: (e: { projectId?: string; worktreePath?: string; event?: { paths?: string[]; at?: string } }) => void,
    ) => {
      watchHandlers.push(h);
      return () => {
        const i = watchHandlers.indexOf(h);
        if (i >= 0) watchHandlers.splice(i, 1);
      };
    };
    return {
      getFileDiff: vi.fn(),
      getDiffBundle: vi.fn(),
      readFile: vi.fn(),
      readFileBytes: vi.fn(),
      notesList: vi.fn(),
      notesCreate: vi.fn(),
      watchHandlers,
      onWatch,
    };
  });

/** Dispatches a synthetic `working-tree` watch event to every currently
 *  subscribed handler. `paths` are repo-relative POSIX (or, when
 *  `worktreePath` is set, relative to THAT worktree) — matching what the
 *  real hub delivers. See foldingView.test.tsx's identical helper. */
function dispatchWatch(paths: string[], projectId = 'p1', worktreePath?: string): void {
  for (const h of watchHandlers) {
    h({ projectId, worktreePath, event: { paths, at: new Date().toISOString() } });
  }
}

// `cockpit` resolves `window.api` at module load, so mock the provider client
// to expose our stub regardless of evaluation order. The retained child
// components (RawFile/ImageCompare/ImageView) talk to `window.api` directly,
// so set that too for their reads.
vi.mock('../providerClient', () => ({
  agentCockpit: {
    provider: { getFileDiff, getDiffBundle, readFile, readFileBytes },
    // The hub (src/renderer/watch/hub.ts) reads `agentCockpit.events.onWatch`
    // directly — see its module doc comment — so this must be mocked here for
    // ContentViewer's watch subscription to have anything to attach to.
    events: { onWatch },
    // RawFile/notes load through the notes store; list/create are hoisted so
    // individual tests can drive them (e.g. simulate a persisted line note).
    notes: {
      list: notesList,
      create: notesCreate,
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
  provider: { getFileDiff, getDiffBundle, readFile, readFileBytes },
};

import { ContentViewer } from './ContentViewer';
import { BinaryPlaceholder } from './BinaryPlaceholder';

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
  useNotesStore.setState({ notes: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
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
    readFileBytes.mockReset();
    notesList.mockReset();
    notesCreate.mockReset();
    getFileDiff.mockResolvedValue(SAMPLE_DIFF);
    // Diff mode now loads a one-call bundle (patch + both sides' content).
    getDiffBundle.mockResolvedValue({ patch: SAMPLE_DIFF, oldContent: null, newContent: null });
    readFile.mockResolvedValue({ content: '# Title\n\nbody', truncated: false, isBinary: false, sizeBytes: 13 });
    // Image content's default: a tiny "present" byte payload so tests that
    // don't care about the specific image state see a normal 'shown' result.
    readFileBytes.mockResolvedValue({ bytesBase64: 'ZmFrZQ==', sizeBytes: 5, exists: true, reason: null });
    notesList.mockResolvedValue([]);
  });

  it('renders EmptyState when change is null', () => {
    render(<ContentViewer selection={null} />);
    expect(screen.getByText('No file selected')).toBeInTheDocument();
  });

  describe('manual refresh + staleness indicator (local_repo_explorer-r97u)', () => {
    it('shows no stale indicator until a watch event matches this exact (worktreePath, path); an unrelated path or a different worktree never marks it stale', async () => {
      render(<ContentViewer selection={sel('src/file.ts')} />);
      await screen.findByText('const b = 2;', { exact: false });

      expect(screen.getByRole('button', { name: 'Refresh from disk' })).toBeInTheDocument();
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();

      // Unrelated path in the SAME worktree: no staleness.
      act(() => dispatchWatch(['other/file.ts'], 'p1', '/wt'));
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();

      // The SAME path but a DIFFERENT worktree: no staleness (a match must be
      // exact on both path AND worktree, never path alone).
      act(() => dispatchWatch(['src/file.ts'], 'p1', '/other-wt'));
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();

      // The exact displayed (worktreePath, path): staleness fires.
      act(() => dispatchWatch(['src/file.ts'], 'p1', '/wt'));
      expect(screen.getByTitle('Changed on disk — click Refresh to reload')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'File changed on disk — click to refresh' }),
      ).toBeInTheDocument();
    });

    it('an untagged (root-relative) watch event matches a selection whose worktreePath is empty, not one scoped to a worktree', async () => {
      render(<ContentViewer selection={sel('src/file.ts', { worktreePath: '' })} />);
      await screen.findByText('const b = 2;', { exact: false });

      // A worktree-tagged event never matches a root selection.
      act(() => dispatchWatch(['src/file.ts'], 'p1', '/wt'));
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();

      // An untagged (worktreePath undefined) event matches it.
      act(() => dispatchWatch(['src/file.ts']));
      expect(screen.getByTitle('Changed on disk — click Refresh to reload')).toBeInTheDocument();
    });

    it('clicking Refresh re-fetches the diff bundle and clears the stale indicator', async () => {
      render(<ContentViewer selection={sel('src/file.ts')} />);
      await screen.findByText('const b = 2;', { exact: false });
      expect(getDiffBundle).toHaveBeenCalledTimes(1);

      act(() => dispatchWatch(['src/file.ts'], 'p1', '/wt'));
      const staleRefreshBtn = screen.getByRole('button', { name: 'File changed on disk — click to refresh' });
      fireEvent.click(staleRefreshBtn);

      await waitFor(() => expect(getDiffBundle).toHaveBeenCalledTimes(2));
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh from disk' })).toBeInTheDocument();
    });

    it('clicking Refresh remounts a self-fetching child view (RawFile) to force a real re-read from disk', async () => {
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Refresh from disk' }));
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    });

    it('an external-file selection (no git tree membership) offers Refresh but never subscribes to a watch match, and never reports stale', async () => {
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      render(
        <ContentViewer selection={sel('/outside/project/archive.pdf', { kind: 'external-file' })} />,
      );
      await screen.findByText('Binary file (2.0 KiB).');

      act(() => dispatchWatch(['/outside/project/archive.pdf'], 'p1', '/wt'));
      act(() => dispatchWatch(['/outside/project/archive.pdf']));
      expect(screen.queryByTitle('Changed on disk — click Refresh to reload')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh from disk' })).toBeInTheDocument();
    });
  });

  it('defaults to rendered mode for a .md change', async () => {
    render(<ContentViewer selection={sel('docs/readme.md')} />);
    // Rendered mode reads the working-tree source for markdown, scoped to the
    // selection's worktree.
    await waitFor(() =>
      expect(readFile).toHaveBeenCalledWith('docs/readme.md', { worktreePath: '/wt' }),
    );
    const rendered = screen.getByRole('tab', { name: 'Rendered' });
    expect(rendered).toHaveAttribute('aria-selected', 'true');
    await screen.findByText('Title');
  });

  it('the Diff checkbox in the Content panel header gates rendered-markdown diff highlighting (on by default, persisted, global)', async () => {
    const patch = [
      '--- a/docs/readme.md',
      '+++ b/docs/readme.md',
      '@@ -1,3 +1,3 @@',
      '-# Old Title',
      '+# Title',
      ' ',
      ' body',
      '',
    ].join('\n');
    getDiffBundle.mockResolvedValue({ patch, oldContent: null, newContent: null });
    render(<ContentViewer selection={sel('docs/readme.md')} />);

    // Diff highlighting is on by default: the changed heading gets the
    // whole-block "changed" callout (markdown.tsx's ChangedTag) — same
    // fixture shape as markdown.test.tsx's "flags changed blocks with a
    // callout" (changedLineSet only, no oldSource).
    const diffCheckbox = screen.getByRole('checkbox', { name: 'Diff' });
    expect(diffCheckbox).toBeChecked();
    await screen.findByText('changed');
    // The Wrap checkbox is not offered for the rendered-markdown view.
    expect(screen.queryByRole('checkbox', { name: 'Wrap' })).not.toBeInTheDocument();

    // Unchecking it hides the callout and persists the setting.
    fireEvent.click(diffCheckbox);
    await waitFor(() =>
      expect(useSettingsStore.getState().settings.renderedDiffHighlighting).toBe(false),
    );
    expect(screen.queryByText('changed')).not.toBeInTheDocument();
    expect(diffCheckbox).not.toBeChecked();

    // Checking it back on restores the callout.
    fireEvent.click(diffCheckbox);
    await screen.findByText('changed');
    expect(diffCheckbox).toBeChecked();
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
      expect(readFile).toHaveBeenCalledWith('src/file.ts', { ref: 'HEAD', worktreePath: '/wt' }),
    );
    // RawFile renders per-line rows (line-number gutter + code); Raw is always
    // plain (no token spans), so assert the concatenated line text is present.
    await waitFor(() => expect(document.body.textContent).toContain('raw text body'));
    expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
  });

  describe('image content (Diff = ImageCompare, Rendered = ImageView)', () => {
    // Byte-to-<img> mechanism: a `data:` URL (see useImageBytes.ts's doc
    // comment) — there is no object URL to revoke, so there is no
    // revocation test here; that would fabricate coverage for a cleanup
    // mechanism this implementation deliberately does not use.

    it('defaults to Diff mode and offers Diff/Rendered (no Raw) for an image change', async () => {
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Rendered' })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
    });

    it('a changed image (kind:\'change\') whose patch is binary-flagged (git emits "Binary files … differ" for an image diff too, exactly like a generic binary) still renders ImageCompare, never the Diff cannot-compare placeholder, and never a readFile call — regression coverage for a prior bug where ContentViewer\'s Diff-mode size-fallback fired on ANY parsedDiff.binary regardless of which view was actually showing, issuing an extra, unconsumed readFile call on top of ImageCompare\'s own reads', async () => {
      const IMAGE_BINARY_DIFF = [
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index 1234567..89abcde 100644',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
        '',
      ].join('\n');
      getDiffBundle.mockResolvedValue({ patch: IMAGE_BINARY_DIFF, oldContent: null, newContent: null });
      readFileBytes.mockResolvedValue({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null });
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);

      // image's Diff mode dispatches to ImageCompare (viewFor('image', 'diff')
      // === 'image-compare' — modeSwitcher.tsx's VIEW_DISPATCH), never
      // DiffView/BinaryPlaceholder — even though
      // parsePatch(IMAGE_BINARY_DIFF).binary is true here, same as any other
      // changed binary file's patch.
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      const img = (await screen.findByAltText('After (working tree)')) as HTMLImageElement;
      expect(img.src).toBe('data:image/png;base64,Zm9v');
      expect(screen.queryByText(/can't be compared line-by-line/)).not.toBeInTheDocument();
      // ImageCompare fetches bytes via readFileBytes only. `readFile` is the
      // primitive ContentViewer's now-removed Diff-mode size fallback used to
      // call unconditionally whenever the patch signaled binary, with no
      // check on which view was actually rendering — confirm it is never
      // invoked for this selection at all.
      expect(readFile).not.toHaveBeenCalled();
    });

    it('Diff: BOTH panes fetch and show real images (local_repo_explorer-bn8a) — before via a git-ref read, after via the working tree, never the old "(unavailable)"', async () => {
      readFileBytes.mockImplementation((path: string, opts?: { worktreePath?: string; ref?: string }) =>
        Promise.resolve(
          opts?.ref
            ? { bytesBase64: 'QkFTRQ==', sizeBytes: 4, exists: true, reason: null }
            : { bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null },
        ),
      );
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);

      // Before (baseline) pane: a real <img>, fetched via readFileBytes with
      // the selection's baseline threaded through as `ref` — the git-ref-
      // capable read this bead adds. The OLD hardcoded placeholder must never
      // appear again.
      const beforeImg = (await screen.findByAltText('Before (baseline)')) as HTMLImageElement;
      expect(beforeImg.src).toBe('data:image/png;base64,QkFTRQ==');
      expect(readFileBytes).toHaveBeenCalledWith('assets/logo.png', { worktreePath: '/wt', ref: 'HEAD' });
      expect(screen.queryByText(/Baseline preview unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByText('(unavailable)')).not.toBeInTheDocument();

      // After (working tree) pane: unchanged — a real <img>, no ref.
      const afterImg = (await screen.findByAltText('After (working tree)')) as HTMLImageElement;
      expect(afterImg.tagName).toBe('IMG');
      expect(afterImg.src).toBe('data:image/png;base64,Zm9v');
      expect(readFileBytes).toHaveBeenCalledWith('assets/logo.png', { worktreePath: '/wt' });
    });

    it('a rename: the before-pane reads bytes from the OLD path at the baseline ref (oldPath ?? filePath), and the label surfaces it', async () => {
      readFileBytes.mockResolvedValue({ bytesBase64: 'UkVE', sizeBytes: 3, exists: true, reason: null });
      render(
        <ContentViewer
          selection={sel('assets/new-name.png', { baseline: 'HEAD', oldPath: 'assets/old-name.png' })}
        />,
      );
      await screen.findByText(/was assets\/old-name\.png/);
      await waitFor(() =>
        expect(readFileBytes).toHaveBeenCalledWith('assets/old-name.png', { worktreePath: '/wt', ref: 'HEAD' }),
      );
      // The "after" (working-tree) pane still reads the NEW (current) path.
      await waitFor(() =>
        expect(readFileBytes).toHaveBeenCalledWith('assets/new-name.png', { worktreePath: '/wt' }),
      );
    });

    it('an added-only file (no baseline): the before pane resolves to absent (git-show fails at the ref) rather than a fabricated image; the after pane shows the real image', async () => {
      readFileBytes.mockImplementation((path: string, opts?: { ref?: string }) =>
        Promise.resolve(
          opts?.ref
            ? { bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' }
            : { bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null },
        ),
      );
      render(<ContentViewer selection={sel('assets/new.png', { baseline: 'HEAD' })} />);

      // Before pane: reason "missing" at the ref maps to the SAME 'absent'
      // state a deleted working-tree file already used — no new state.
      await screen.findByText('Not present in the working tree.');
      const afterImg = (await screen.findByAltText('After (working tree)')) as HTMLImageElement;
      expect(afterImg.src).toBe('data:image/png;base64,Zm9v');
    });

    it('Rendered: ImageView shows the current image alone (same fetch/state machine as the Diff after-pane)', async () => {
      readFileBytes.mockResolvedValue({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null });
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));

      const img = (await screen.findByAltText('assets/logo.png')) as HTMLImageElement;
      expect(img.src).toBe('data:image/png;base64,Zm9v');
      // No two-pane compare in Rendered mode.
      expect(screen.queryByText(/Baseline preview unavailable/)).not.toBeInTheDocument();
    });

    it('SVG renders through <img src="data:...svg+xml">, never injected as markup', async () => {
      readFileBytes.mockResolvedValue({ bytesBase64: 'PHN2Zy8+', sizeBytes: 8, exists: true, reason: null });
      const { container } = render(<ContentViewer selection={sel('assets/icon.svg', { baseline: 'HEAD' })} />);

      const img = (await screen.findByAltText('After (working tree)')) as HTMLImageElement;
      expect(img.src).toBe('data:image/svg+xml;base64,PHN2Zy8+');
      // The script-inert guardrail: no inline <svg> element anywhere in the
      // DOM — the bytes only ever reach the page via the <img> sink.
      expect(container.querySelector('svg')).toBeNull();
    });

    it('a deleted image: the after (working-tree) pane shows "not present"; the before (baseline) pane now shows the REAL baseline image (git-ref read) instead of the old blanket no-baseline-preview', async () => {
      readFileBytes.mockImplementation((path: string, opts?: { ref?: string }) =>
        Promise.resolve(
          opts?.ref
            ? { bytesBase64: 'UkVE', sizeBytes: 3, exists: true, reason: null }
            : { bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' },
        ),
      );
      render(<ContentViewer selection={sel('assets/gone.png', { baseline: 'HEAD' })} />);

      await screen.findByText('Not present in the working tree.');
      const beforeImg = (await screen.findByAltText('Before (baseline)')) as HTMLImageElement;
      expect(beforeImg.src).toBe('data:image/png;base64,UkVE');
      expect(screen.queryByText(/Baseline preview unavailable/)).not.toBeInTheDocument();
      expect(screen.queryByText('(unavailable)')).not.toBeInTheDocument();
    });

    it('over the preview cap: BOTH panes (working tree AND baseline ref) refuse with the actual size and point at Download — the ref path reuses the SAME FILE_BYTES_CAP, no separate/weaker cap', async () => {
      readFileBytes.mockResolvedValue({
        bytesBase64: null,
        sizeBytes: 12_582_912, // 12 MiB
        exists: true,
        reason: 'too-large',
      });
      render(<ContentViewer selection={sel('assets/huge.png', { baseline: 'HEAD' })} />);
      const messages = await screen.findAllByText(/too large to preview/);
      expect(messages).toHaveLength(2);
      expect(screen.getAllByText(/12\.0 MiB/)).toHaveLength(2);
      expect(screen.getAllByText(/Download/)).toHaveLength(2);
    });

    it('unreadable: a read error renders the unreadable state on BOTH panes (unrecognized-extension coverage lives in useImageBytes.test.ts, since classOf already filters image paths to recognized extensions before ContentViewer ever reaches ImageCompare/ImageView)', async () => {
      readFileBytes.mockRejectedValue(new Error('boom'));
      render(<ContentViewer selection={sel('assets/broken.png', { baseline: 'HEAD' })} />);
      const messages = await screen.findAllByText('Unable to preview this image.');
      expect(messages).toHaveLength(2);
    });
  });

  describe('text-like Rendered vs Raw split (RawFile `highlight` prop)', () => {
    // NOTE: a JSON/YAML row no longer belongs in this table. Since this
    // leaf gave json/yaml their own ContentClass with their OWN Rendered
    // cell (VIEW_DISPATCH: rendered -> 'folding-view', raw -> 'raw-file' —
    // two DIFFERENT ViewKinds, unlike 'text' where both share 'raw-file'),
    // toggling Rendered<->Raw for a json/yaml file now unmounts/remounts a
    // fresh RawFile each time instead of flipping a prop on one persistent
    // instance — so the "from ONE read" invariant this table asserts is no
    // longer true for json/yaml specifically (see modeSwitcher.tsx's
    // VIEW_DISPATCH comment on the json/yaml rows for why this is accepted).
    // The 'json/yaml classes (folding-view dispatch seam)' describe block
    // below covers json/yaml's actual (updated) Rendered<->Raw behavior.
    it.each([{ label: 'a TypeScript file', path: 'src/file.ts', content: 'const a = 1;' }])(
      '$label: Rendered shows highlighted token spans, Raw shows the same plain text, from ONE read',
      async ({ path, content }) => {
        readFile.mockResolvedValue({ content, truncated: false, isBinary: false, sizeBytes: content.length });
        const { container } = render(<ContentViewer selection={sel(path, { kind: 'file' })} />);

        // A plain-file selection defaults to Raw (never an empty diff).
        await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
        expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(container.textContent).toContain(content));
        // Raw is plain: no Shiki-colored token spans anywhere in the content.
        expect(container.querySelectorAll('span[style*="color"]')).toHaveLength(0);

        // Switch to Rendered — same content, same single read (asserted below).
        fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
        await waitFor(() => {
          expect(container.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0);
        });
        expect(container.textContent).toContain(content);

        // Back to Raw — tokens disappear immediately (no stale-highlight flash;
        // see RawText's render-time `highlight` gate), still the same one read.
        fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
        expect(container.querySelectorAll('span[style*="color"]')).toHaveLength(0);
        expect(container.textContent).toContain(content);

        expect(readFile).toHaveBeenCalledTimes(1);
        expect(readFile).toHaveBeenCalledWith(path, { worktreePath: '/wt' });
      },
    );

    // Raw keeps its original terse message unchanged (out of this issue's
    // scope — generic-binary has no Raw mode in its class shape); Rendered
    // now shows the graceful BinaryPlaceholder, which mentions Download for
    // too-large (never for missing — nothing to download). Both come from
    // the SAME single `readFile` call — switching tabs must never re-fetch,
    // and must never reach for the whole-file-bytes primitive
    // (`readFileBytes`) either.
    //
    // NOTE: the `isBinary: true` case is deliberately NOT included here.
    // Unlike too-large/missing, a confirmed-binary result now ALSO
    // reclassifies the effective class (see ContentViewer's
    // `confirmedBinary`/`effectiveMode`) and redirects mode away from Raw
    // entirely before the user ever sees it — so "Raw keeps its plain
    // message" is no longer this case's actual behavior. That behavior is
    // covered by the 'generic-binary reclassification' describe block below.
    it.each([
      {
        label: 'too-large',
        mock: { content: null, truncated: true, isBinary: false, sizeBytes: 5_000_000 },
        rawMatch: /too large to display inline/,
        renderedMatch: /too large to preview inline/,
        expectDownload: true,
      },
      {
        label: 'missing',
        mock: { content: null, truncated: false, isBinary: false, sizeBytes: 0 },
        rawMatch: /not found/,
        renderedMatch: /not found/,
        expectDownload: false,
      },
    ])(
      '$label: Raw keeps its plain message; Rendered shows the graceful placeholder, from one read (no full-byte-read)',
      async ({ mock, rawMatch, renderedMatch, expectDownload }) => {
        readFile.mockResolvedValue(mock);
        render(<ContentViewer selection={sel('data.bin', { kind: 'file' })} />);

        await screen.findByText(rawMatch);
        expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');

        fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
        expect(screen.getByText(renderedMatch)).toBeInTheDocument();
        if (expectDownload) {
          expect(screen.getByText(/Right-click this file in Changes or Explorer and choose Download/)).toBeInTheDocument();
        } else {
          expect(screen.queryByText(/Download/)).not.toBeInTheDocument();
        }

        expect(readFile).toHaveBeenCalledTimes(1);
        // Guardrail: showing the placeholder must never trigger the
        // whole-file-bytes primitive (`.1`'s `readFileBytes`) — the existing
        // text-preview-sized `readFile` result is sufficient.
        expect(readFileBytes).not.toHaveBeenCalled();
      },
    );

    it('keeps the gutter-alignment invariant (flexShrink:0 gutters, minWidth rules) in Raw AND Rendered, with Wrap off and on', async () => {
      const content = 'short\na noticeably longer line than the short one above it, for width contrast';
      readFile.mockResolvedValue({ content, truncated: false, isBinary: false, sizeBytes: content.length });
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));

      function assertGutterContract(wrapExpected: boolean): void {
        const gutters = Array.from(document.querySelectorAll('button[title^="Add a note on line"]'));
        expect(gutters).toHaveLength(2); // one gutter per line
        for (const gutter of gutters) {
          // Guardrail: gutters stay flex-shrink:0 (Tailwind's `shrink-0`).
          expect(gutter.className).toContain('shrink-0');
          const row = gutter.parentElement as HTMLElement;
          // The row's direct children are exactly [gutter button, code span];
          // `row.querySelector('span')` would instead match the gutter
          // button's OWN inner <span> (the line-number/`+` glyphs), so index
          // into direct children rather than searching all descendants.
          const codeSpan = row.children[1] as HTMLElement;
          if (wrapExpected) {
            expect(row.style.whiteSpace).toBe('pre-wrap');
            expect(row.style.minWidth).toBe('');
            expect(codeSpan.style.minWidth).toBe('0px');
            expect(codeSpan.style.overflowWrap).toBe('anywhere');
          } else {
            expect(row.style.whiteSpace).toBe('pre');
            expect(row.style.minWidth).toBe('max-content');
          }
        }
      }

      // Raw, Wrap off (default) — the contract holds.
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      assertGutterContract(false);

      // Rendered, Wrap still off — same contract, same shared row markup.
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      assertGutterContract(false);

      // Toggle Wrap on (global setting) while Rendered — contract holds.
      fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap' }));
      assertGutterContract(true);

      // Back to Raw with Wrap still on — contract holds.
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      assertGutterContract(true);

      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('a line note added while Raw is showing is visible after switching to Rendered (same anchor), with no re-fetch', async () => {
      const content = 'const a = 1;\nconst b = 2;';
      readFile.mockResolvedValue({ content, truncated: false, isBinary: false, sizeBytes: content.length });

      // A minimal in-memory notes "backend": create() appends, list() reads it
      // back — mirrors what addLineNote/load actually do against the real IPC.
      const stored: NoteRecord[] = [];
      let nextId = 1;
      notesCreate.mockImplementation(
        async (input: {
          projectId: string;
          targetKind: ReviewTargetKind;
          targetId: string;
          body: string;
          line?: number | null;
          anchorText?: string | null;
        }): Promise<NoteRecord> => {
          const note: NoteRecord = {
            id: nextId++,
            projectId: input.projectId,
            targetKind: input.targetKind,
            targetId: input.targetId,
            body: input.body,
            createdAt: 'now',
            updatedAt: 'now',
            line: input.line ?? null,
            anchorText: input.anchorText ?? null,
          };
          stored.push(note);
          return note;
        },
      );
      // A fresh array each call: zustand's `set({ notes })` re-renders
      // subscribers on reference change, matching real IPC (which always
      // deserializes a new array) — returning `stored` itself (mutated via
      // push, same reference) would silently skip the re-render.
      notesList.mockImplementation(async () => [...stored]);

      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');

      // Add a note on line 2 while Raw is showing.
      fireEvent.click(screen.getByTitle('Add a note on line 2'));
      fireEvent.change(screen.getByPlaceholderText('Add a note for this line…'), {
        target: { value: 'why not 3?' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      await waitFor(() => expect(screen.getByText('why not 3?')).toBeInTheDocument());

      // Switch to Rendered — same anchor (line 2), same note, no re-fetch.
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      expect(screen.getByText('why not 3?')).toBeInTheDocument();
      expect(readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('json/yaml classes (folding-view dispatch seam — local_repo_explorer-jp2f.2)', () => {
    it('a .json selection in Rendered mode dispatches to FoldingView ([data-testid="folding-view"] in the DOM); the same path in Raw mode does not', async () => {
      const content = '{ "a": 1 }';
      readFile.mockResolvedValue({ content, truncated: false, isBinary: false, sizeBytes: content.length });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);

      // A plain-file selection defaults to Raw (never an empty diff) — same
      // default as today, since json still falls through defaultModeFor's
      // text-like branch (see modeSwitcher.tsx).
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
      await waitFor(() => expect(document.body.textContent).toContain(content));
      // Wrap remains offered for json's Raw view (raw-file is, and always
      // was, in `wrappable`).
      expect(screen.getByRole('checkbox', { name: 'Wrap' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await waitFor(() => expect(screen.getByTestId('folding-view')).toBeInTheDocument());
      // FoldingView's temporary body still delegates to RawFile with
      // highlight on — same Shiki token spans as before, just reached
      // through the new dispatch path (modeSwitcher.tsx's VIEW_DISPATCH).
      await waitFor(() => {
        expect(
          screen.getByTestId('folding-view').querySelectorAll('span[style*="color"]').length,
        ).toBeGreaterThan(0);
      });
      expect(screen.getByTestId('folding-view').textContent).toContain(content);
      // Wrap also remains offered for json's (new) Rendered view — 'folding-view'
      // was added to `wrappable` alongside 'raw-file'.
      expect(screen.getByRole('checkbox', { name: 'Wrap' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      await waitFor(() => expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument());
      await waitFor(() => expect(document.body.textContent).toContain(content));
    });

    it('a .yaml selection: Diff still dispatches to DiffView (unaffected), Rendered dispatches to FoldingView', async () => {
      const content = 'key: value\n';
      readFile.mockResolvedValue({ content, truncated: false, isBinary: false, sizeBytes: content.length });
      render(<ContentViewer selection={sel('config.yaml', { baseline: 'HEAD' })} />);

      // A 'change' selection defaults to Diff — unchanged.
      await waitFor(() =>
        expect(getDiffBundle).toHaveBeenCalledWith('/wt', 'config.yaml', 'HEAD'),
      );
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await waitFor(() => expect(screen.getByTestId('folding-view')).toBeInTheDocument());
      expect(screen.getByTestId('folding-view')).toHaveAttribute('data-format', 'yaml');
    });

    it('a JSON-path file that RawFile confirms binary still reclassifies to generic-binary and gets the existing graceful placeholder — the folding-view dispatch is bypassed entirely once binary is confirmed (the confirmedBinary path is unaffected by the new json/yaml classes)', async () => {
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      const BINARY_DIFF = [
        'diff --git a/data.json b/data.json',
        'index 1234567..89abcde 100644',
        'Binary files a/data.json and b/data.json differ',
        '',
      ].join('\n');
      getDiffBundle.mockResolvedValue({ patch: BINARY_DIFF, oldContent: null, newContent: null });

      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);

      // Reclassifies from 'json' to 'generic-binary' exactly like any other
      // extension (see the 'generic-binary reclassification' describe block
      // below) — generic-binary's Rendered cell is 'raw-file', not
      // 'folding-view', so FoldingView is never reached once binary-ness is
      // confirmed.
      await screen.findByText(/can't be compared line-by-line/);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
    });
  });

  describe('structural-fold size degrade (structuredFoldMaxMb — local_repo_explorer-jp2f.4)', () => {
    const JSON_CONTENT = '{ "a": 1 }';

    it('at the default threshold (10 MB), a small .json file still renders through folding-view in Rendered mode', async () => {
      readFile.mockResolvedValue({
        content: JSON_CONTENT,
        truncated: false,
        isBinary: false,
        sizeBytes: JSON_CONTENT.length,
      });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(document.body.textContent).toContain(JSON_CONTENT));

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await waitFor(() => expect(screen.getByTestId('folding-view')).toBeInTheDocument());
    });

    it('with the threshold set small in the test store, a .json file whose confirmed size is OVER it degrades: Rendered dispatches to the plain raw-file view instead of folding-view, and the mode switcher still shows Diff/Rendered/Raw with Rendered active', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      const oversizeBytes = 2 * 1024 * 1024; // 2 MiB, over the 1 MB threshold
      readFile.mockResolvedValue({
        content: JSON_CONTENT,
        truncated: false,
        isBinary: false,
        sizeBytes: oversizeBytes,
      });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(document.body.textContent).toContain(JSON_CONTENT));
      // local_repo_explorer-ftbq: the read that produced this confirmation must
      // have requested the RAISED cap, not the default — this is the fix that
      // makes the degrade below actually reachable against a real 256 KiB
      // text-read cap (a mocked confirmation alone can't prove the real cap was
      // used; this proves the call args, which is what the real read consults).
      expect(readFile).toHaveBeenCalledWith('data.json', {
        worktreePath: '/wt',
        maxBytes: structuredFoldReadMaxBytes(1),
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      // Degraded: folding-view never mounts; the SAME raw-file view (already
      // showing the content from the Raw tab) stays dispatched.
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
      expect(document.body.textContent).toContain(JSON_CONTENT);

      // Mode switcher is unaffected by the degrade: still Diff/Rendered/Raw,
      // Rendered active — only WHICH component renders changed.
      expect(screen.getByRole('tab', { name: 'Diff' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Raw' })).toBeInTheDocument();

      // Stable across further renders (no flip-flop): re-selecting the SAME
      // mode a few times must not trigger another read or unmount the view.
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
      expect(document.body.textContent).toContain(JSON_CONTENT);
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('with the threshold set small, a .json file whose confirmed size is AT the threshold (not over it) does not degrade — strictly-greater-than semantics', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      const atThresholdBytes = 1 * 1024 * 1024; // exactly 1 MiB, not > 1 MiB
      readFile.mockResolvedValue({
        content: JSON_CONTENT,
        truncated: false,
        isBinary: false,
        sizeBytes: atThresholdBytes,
      });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(document.body.textContent).toContain(JSON_CONTENT));

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await waitFor(() => expect(screen.getByTestId('folding-view')).toBeInTheDocument());
    });

    it('an unknown size (readFile still pending, no confirmation yet) never degrades: Rendered still dispatches to folding-view', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      // Never resolves during this test -- rawConfirmation stays null
      // (unknown), even though the threshold is small enough that almost
      // any real file would exceed it.
      readFile.mockReturnValue(new Promise<never>(() => {}));
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      expect(screen.getByTestId('folding-view')).toBeInTheDocument();
    });

    it('a confirmed-BINARY .json file reclassifies to generic-binary regardless of the fold threshold — the binary rule wins precedence over the size rule', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      const BINARY_DIFF = [
        'diff --git a/data.json b/data.json',
        'index 1234567..89abcde 100644',
        'Binary files a/data.json and b/data.json differ',
        '',
      ].join('\n');
      getDiffBundle.mockResolvedValue({ patch: BINARY_DIFF, oldContent: null, newContent: null });

      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);

      await screen.findByText(/can't be compared line-by-line/);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
    });

    it('a .ts file is unaffected by the fold threshold at any value — never dispatches to folding-view either way', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      const content = 'const a = 1;';
      readFile.mockResolvedValue({
        content,
        truncated: false,
        isBinary: false,
        sizeBytes: 5 * 1024 * 1024, // over the 1 MB threshold -- irrelevant for .ts
      });
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      // local_repo_explorer-ftbq regression guard: the maxBytes override is
      // json/yaml-only — a non-json/yaml class (here 'text', via .ts) must read
      // with NO maxBytes at all, leaving the default cap completely unchanged.
      expect(readFile).toHaveBeenCalledWith('src/file.ts', { worktreePath: '/wt' });
      expect((readFile.mock.calls[0]?.[1] as { maxBytes?: number } | undefined)?.maxBytes).toBeUndefined();

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
      expect(document.body.textContent).toContain(content);
    });

    it('the degrade never writes contentMode: a selection that renders already-degraded (remembered mode "rendered", size already over threshold) with zero user interaction issues no `set` call at all', async () => {
      const setSpy = vi.fn().mockResolvedValue(undefined);
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, contentMode: 'rendered', structuredFoldMaxMb: 1 },
        set: setSpy,
      });
      const oversizeBytes = 2 * 1024 * 1024;
      readFile.mockResolvedValue({
        content: JSON_CONTENT,
        truncated: false,
        isBinary: false,
        sizeBytes: oversizeBytes,
      });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);

      // The remembered 'rendered' mode seeds Rendered directly at mount (json
      // offers 'rendered' -- see the seed logic above `mode`'s useState) --
      // no click anywhere in this test.
      expect(screen.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true');
      await waitFor(() => expect(document.body.textContent).toContain(JSON_CONTENT));
      // Degraded purely from the render-time effectiveCls derivation. This
      // mount sequence is FoldingView first (an unconfirmed json/yaml
      // selection always starts on folding-view — rawConfirmation is null
      // until the read resolves), THEN a remount to raw-file once the degrade
      // is confirmed — exactly the two-mount sequence the "key the read cap
      // on cls, never effectiveCls" fix (structuredFoldReadMaxBytes's doc
      // comment in settings.ts) exists to keep stable.
      expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument();
      // The automatic degrade must never itself persist anything -- it is a
      // display correction, not a user choice (mirrors the existing
      // effectiveMode reclassification-safety invariant for the binary case).
      expect(setSpy).not.toHaveBeenCalled();

      // CRITICAL correctness check (local_repo_explorer-ftbq): FoldingView's
      // initial read AND RawFile's post-degrade read must both have requested
      // the IDENTICAL maxBytes. If the cap were keyed on effectiveCls instead
      // of the pure cls, RawFile's read (mounted only once effectiveCls had
      // already flipped to 'text') would request maxBytes: undefined (the
      // default, smaller cap) — which would refuse a real over-cap file,
      // un-set oversizedStructured, flip effectiveCls back to json/yaml, and
      // remount FoldingView in an infinite loop.
      expect(readFile.mock.calls.length).toBeGreaterThanOrEqual(1);
      const expectedMaxBytes = structuredFoldReadMaxBytes(1);
      for (const call of readFile.mock.calls) {
        expect((call[1] as { maxBytes?: number } | undefined)?.maxBytes).toBe(expectedMaxBytes);
      }
    });

    it('refuses gracefully above the raised cap (R): a .json file whose read is REFUSED (not a successful oversized text read) shows the too-large placeholder and STAYS on folding-view — effectiveCls never degrades to text for a confirmation that isn\'t kind:"text"', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, structuredFoldMaxMb: 1 } });
      // Above R = structuredFoldReadMaxBytes(1) = 2 MiB: a real read this large
      // is REFUSED (content: null, truncated: true), never a successful
      // over-threshold text read — this is what the boundary condition
      // predicts for R+1 and above.
      readFile.mockResolvedValue({
        content: null,
        truncated: true,
        isBinary: false,
        sizeBytes: 5 * 1024 * 1024, // 5 MiB, over R (2 MiB)
      });
      render(<ContentViewer selection={sel('data.json', { kind: 'file' })} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));

      // effectiveCls stays json/yaml (rawConfirmation.kind is 'too-large', not
      // 'text', so oversizedStructured never fires): FoldingView stays
      // mounted and shows ITS OWN too-large placeholder, never degrading to
      // raw-file / never showing the fixture's own content.
      await screen.findByText(/too large to preview inline/);
      expect(screen.getByTestId('folding-view')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(JSON_CONTENT);

      // Stable across further renders — no flip-flop toward the degraded
      // view. FoldingView's cross-mount read cache is disabled under test
      // (FoldingView.tsx's `readCacheDisabled` — see its doc comment), so
      // toggling away and back genuinely remounts and re-reads; await each
      // settle rather than asserting synchronously.
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      await waitFor(() => expect(screen.queryByTestId('folding-view')).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await screen.findByText(/too large to preview inline/);
      expect(screen.getByTestId('folding-view')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(JSON_CONTENT);
    });
  });

  describe('generic-binary Diff placeholder (binary detected from the patch text OR from RawFile\'s own confirmation; size sourced ONLY from RawFile\'s own read, never a separate fallback fetch)', () => {
    const BINARY_DIFF = [
      'diff --git a/data.bin b/data.bin',
      'index 1234567..89abcde 100644',
      'Binary files a/data.bin and b/data.bin differ',
      '',
    ].join('\n');

    it('a changed binary file (kind:\'change\') shows the cannot-compare placeholder under Diff (never an empty diff), with "changed" surfaced from the patch\'s "Binary files … differ" line and a Download pointer, but NO size — RawFile never mounts (Diff is the default AND only mode shown for this selection) and ContentViewer performs no separate fallback read to learn one', async () => {
      getDiffBundle.mockResolvedValue({ patch: BINARY_DIFF, oldContent: null, newContent: null });
      render(<ContentViewer selection={sel('data.bin', { kind: 'change' })} />);

      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      // Exact title match — proves no size suffix was ever appended (the
      // component appends " (<size>)" whenever `size` is non-null).
      await screen.findByText("This file type can't be compared line-by-line.");
      expect(screen.getByText(/changed between the baseline and the working tree/)).toBeInTheDocument();
      expect(screen.queryByText('No textual diff for this file.')).not.toBeInTheDocument();
      expect(
        screen.getByText(/Right-click this file in Changes or Explorer and choose Download/),
      ).toBeInTheDocument();
      // The point of this pass: ContentViewer must not issue ANY readFile
      // call to learn a size for this selection. A prior version fell back
      // to one `provider.readFile` call here, which (a) forced a real,
      // capped read over SSH on remote purely to render a placeholder
      // (violating this issue's own guardrail and AC5), and (b) had no
      // gate on which view was actually rendering, so it fired even when
      // an unrelated changed IMAGE's binary-diff patch was what triggered
      // it (see the image-content describe block's regression test below).
      // Diff mode must also never reach for the whole-file-bytes primitive.
      expect(readFile).not.toHaveBeenCalled();
      expect(readFileBytes).not.toHaveBeenCalled();
    });

    it('an unmodified file (empty diff, no "Binary files … differ" line): Diff falls back to the plain empty-diff hint when RawFile has not independently confirmed anything either — an accepted residual limitation for a kind:\'change\' selection, where Diff is the default and Raw/Rendered are never visited — and no readFile call fires at all', async () => {
      getDiffBundle.mockResolvedValue({ patch: '', oldContent: null, newContent: null });
      render(<ContentViewer selection={sel('data.bin', { kind: 'change' })} />);
      await screen.findByText('No textual diff for this file.');
      expect(readFile).not.toHaveBeenCalled();
    });

    it('once RawFile has independently confirmed a too-large file (by having mounted via Raw, which never reclassifies), switching to Diff shows the SAME too-large reason instead of the generic empty-diff hint — proves the knownReason threading covers too-large, not just binary', async () => {
      getDiffBundle.mockResolvedValue({ patch: '', oldContent: null, newContent: null });
      readFile.mockResolvedValue({ content: null, truncated: true, isBinary: false, sizeBytes: 5_000_000 });
      render(<ContentViewer selection={sel('huge.bin', { kind: 'file' })} />);

      // Raw is the default for an Explorer file; too-large does not
      // reclassify (Raw/Rendered both stay available — see RawFile.tsx's
      // `onBinaryConfirmed` doc comment), so RawFile mounts and confirms
      // too-large purely from the initial paint, no user action needed.
      await screen.findByText(/too large to display inline/);
      expect(screen.getByRole('tab', { name: 'Raw' })).toBeInTheDocument();

      // Switching to Diff now shows the SAME reason DiffView would otherwise
      // have no way to know (the patch is empty) — RawFile already told
      // ContentViewer, and ContentViewer threaded it through as `knownReason`.
      fireEvent.click(screen.getByRole('tab', { name: 'Diff' }));
      await screen.findByText(/too large to compare line-by-line/);
      await screen.findByText(/4\.8 MiB/);
      expect(screen.queryByText('No textual diff for this file.')).not.toBeInTheDocument();
      // No fallback readFile call was needed — RawFile's own result sufficed.
      expect(readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('generic-binary reclassification (RawFile confirms isBinary -> effective class upgrade, no new read)', () => {
    it('an Explorer-opened, runtime-confirmed-binary file redefaults from Raw to Diff, drops the Raw tab, and shows the graceful placeholder instead of the terse "Binary file (N)" line — the exact bug this issue exists to fix', async () => {
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      const BINARY_DIFF = [
        'diff --git a/archive.pdf b/archive.pdf',
        'index 1234567..89abcde 100644',
        'Binary files a/archive.pdf and b/archive.pdf differ',
        '',
      ].join('\n');
      getDiffBundle.mockResolvedValue({ patch: BINARY_DIFF, oldContent: null, newContent: null });

      render(<ContentViewer selection={sel('archive.pdf', { kind: 'file' })} />);

      // Before confirmation: classOf('archive.pdf') is still 'text'
      // (path-only), so `kind: 'file'` starts on Raw — today's
      // un-reclassified default. Once RawFile's readFile resolves and
      // confirms isBinary, ContentViewer reclassifies to generic-binary and
      // re-derives the mode to show, landing on Diff — the reclassified
      // default — with no user action.
      await screen.findByText(/can't be compared line-by-line/);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
      await screen.findByText(/2\.0 KiB/);
      expect(
        screen.getByText(/Right-click this file in Changes or Explorer and choose Download/),
      ).toBeInTheDocument();
      // Never the terse one-liner this issue exists to eliminate.
      expect(screen.queryByText(/^Binary file \(/)).not.toBeInTheDocument();

      // The user can still reach Rendered manually — reclassification only
      // changed availability/default, not which modes are offered. Switching
      // to Rendered crosses from the 'diff-view' to the 'raw-file' dispatch
      // cell, so RawFile remounts and re-reads (unlike a same-cell
      // Rendered<->Raw toggle) — findByText awaits that.
      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      await screen.findByText(/No preview available for this file type/);
    });

    it('a non-binary Explorer file never reclassifies: the Raw tab stays available and active', async () => {
      readFile.mockResolvedValue({ content: 'const a = 1;', truncated: false, isBinary: false, sizeBytes: 13 });
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'Raw' })).toBeInTheDocument();
    });

    it('an Explorer-opened, runtime-confirmed-binary file with an EMPTY diff (unmodified-tracked or untracked — the dominant real-world Explorer case) still shows the graceful cannot-compare/Download placeholder under Diff, with "changed" left unasserted — this is the exact gap the 2nd review pass found: reclassification alone (default -> Diff) is not enough without ALSO threading the confirmed signal into DiffView, since git\'s patch alone carries no signal for an unmodified/untracked file', async () => {
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      // No "Binary files … differ" line at all — this is the case
      // parsePatch.ts's `binary` field doc comment describes: an unmodified
      // or untracked binary file's diff is genuinely empty.
      getDiffBundle.mockResolvedValue({ patch: '', oldContent: null, newContent: null });

      render(<ContentViewer selection={sel('archive.pdf', { kind: 'file' })} />);

      // Reclassifies to Diff exactly as the modified-tracked case above does
      // — Raw is dropped from the tab list either way.
      await screen.findByText(/can't be compared line-by-line/);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
      // Size still comes through — from RawFile's OWN read, no new call.
      await screen.findByText(/2\.0 KiB/);
      expect(
        screen.getByText(/Right-click this file in Changes or Explorer and choose Download/),
      ).toBeInTheDocument();
      // No git signal that the file actually changed -> no changed/unchanged
      // claim either way (never falsely asserts "not changed").
      expect(screen.queryByText(/changed between the baseline and the working tree/)).not.toBeInTheDocument();
      expect(screen.queryByText(/has not changed since the baseline/)).not.toBeInTheDocument();
      // Never the terse one-liner this issue exists to eliminate, and never
      // the OLD empty-diff fallback either — the exact 2nd-review-pass bug:
      // Diff is now the DEFAULT for a confirmed-binary file, so this message
      // must never be what a user sees on first paint.
      expect(screen.queryByText(/^Binary file \(/)).not.toBeInTheDocument();
      expect(screen.queryByText('No textual diff for this file.')).not.toBeInTheDocument();
    });
  });

  describe('external-file binary (raw-only carve-out, no reclassification-driven redirect)', () => {
    it('an out-of-project binary file: Raw keeps the terse "Binary file (N)" message, never the graceful BinaryPlaceholder — external files never reach Diff/Rendered even once confirmed binary (modesFor\'s external-file carve-out is unconditional; see modeSwitcher.tsx)', async () => {
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      render(
        <ContentViewer selection={sel('/outside/project/archive.pdf', { kind: 'external-file' })} />,
      );

      await screen.findByText('Binary file (2.0 KiB).');
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Diff' })).not.toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: 'Rendered' })).not.toBeInTheDocument();
      // An out-of-project file has no git baseline: no diff bundle load, and
      // never the whole-file-bytes primitive either.
      expect(getDiffBundle).not.toHaveBeenCalled();
      expect(readFileBytes).not.toHaveBeenCalled();
    });
  });

  describe('remembered content-mode setting (global persistence)', () => {
    // Some of these tests override the store's `set` action with a spy to
    // assert persistence calls precisely; restore the real implementation
    // afterward so later tests (e.g. the Wrap toggle, which relies on `set`
    // actually applying the optimistic settings update) are unaffected.
    const realSet = useSettingsStore.getState().set;
    afterEach(() => {
      useSettingsStore.setState({ set: realSet });
    });

    it('seeds from the remembered global mode when it is valid for the new selection\'s class, overriding the per-class default (a .ts Explorer file defaults to Raw, but a remembered "rendered" wins)', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, contentMode: 'rendered' } });
      readFile.mockResolvedValue({ content: 'const a = 1;', truncated: false, isBinary: false, sizeBytes: 13 });
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true');
    });

    it('falls back to the per-class default when the remembered mode is not offered for the new selection\'s class (remembered "raw", new selection is an image)', async () => {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, contentMode: 'raw' } });
      readFileBytes.mockResolvedValue({ bytesBase64: 'ZmFrZQ==', sizeBytes: 5, exists: true, reason: null });
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);
      // image's modesFor never offers 'raw' — falls back to defaultModeFor's
      // 'diff' default, never crashes, never silently drops to an
      // unavailable tab.
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.queryByRole('tab', { name: 'Raw' })).not.toBeInTheDocument();
    });

    it('persists an explicit ModeSwitcher click as the new global setting', async () => {
      const setSpy = vi.fn().mockResolvedValue(undefined);
      useSettingsStore.setState({ set: setSpy });
      render(<ContentViewer selection={sel('src/file.ts', { kind: 'file' })} />);
      await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('tab', { name: 'Raw' })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByRole('tab', { name: 'Rendered' }));
      expect(setSpy).toHaveBeenCalledWith({ contentMode: 'rendered' });
      expect(screen.getByRole('tab', { name: 'Rendered' })).toHaveAttribute('aria-selected', 'true');
    });

    it('the effectiveMode reclassification-safety fallback never persists — only a genuine user click does', async () => {
      const setSpy = vi.fn().mockResolvedValue(undefined);
      useSettingsStore.setState({ set: setSpy });
      readFile.mockResolvedValue({ content: null, truncated: false, isBinary: true, sizeBytes: 2048 });
      const BINARY_DIFF = [
        'diff --git a/archive.pdf b/archive.pdf',
        'index 1234567..89abcde 100644',
        'Binary files a/archive.pdf and b/archive.pdf differ',
        '',
      ].join('\n');
      getDiffBundle.mockResolvedValue({ patch: BINARY_DIFF, oldContent: null, newContent: null });

      render(<ContentViewer selection={sel('archive.pdf', { kind: 'file' })} />);

      // Same reclassification as the 'generic-binary reclassification'
      // describe block above (Raw -> Diff, once RawFile confirms isBinary) —
      // this automatic, render-time `effectiveMode` correction must never
      // call the persistence path, since it is a display fix for stale
      // state, not a user choice.
      await screen.findByText(/can't be compared line-by-line/);
      expect(screen.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
      expect(setSpy).not.toHaveBeenCalled();
    });
  });
});

describe('BinaryPlaceholder (shared Diff/Rendered placeholder for generic-binary content)', () => {
  it.each([
    ['diff', 'binary'],
    ['diff', 'too-large'],
    ['diff', 'missing'],
    ['rendered', 'binary'],
    ['rendered', 'too-large'],
    ['rendered', 'missing'],
  ] as const)('renders a message for mode=%s reason=%s', (mode, reason) => {
    render(<BinaryPlaceholder mode={mode} reason={reason} size={2048} changed={reason === 'binary'} />);
    expect(document.body.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('never conflates binary and too-large: distinct messages for both Diff and Rendered', () => {
    for (const mode of ['diff', 'rendered'] as const) {
      const { unmount } = render(<BinaryPlaceholder mode={mode} reason="binary" size={10} />);
      const binaryText = document.body.textContent;
      unmount();
      render(<BinaryPlaceholder mode={mode} reason="too-large" size={10} />);
      expect(document.body.textContent).not.toBe(binaryText);
      cleanup();
    }
  });

  it('missing is distinguishable from binary/too-large in both modes', () => {
    for (const mode of ['diff', 'rendered'] as const) {
      render(<BinaryPlaceholder mode={mode} reason="missing" />);
      expect(screen.getByText(/not found/)).toBeInTheDocument();
      cleanup();
    }
  });

  it('Rendered binary/too-large point at Download with the shipped row-context-menu wording; missing does not', () => {
    render(<BinaryPlaceholder mode="rendered" reason="binary" size={10} />);
    expect(
      screen.getByText('Right-click this file in Changes or Explorer and choose Download to open it in an external application.'),
    ).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="rendered" reason="too-large" size={10} />);
    expect(screen.getByText(/choose Download to open it in an external application/)).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="rendered" reason="missing" />);
    expect(screen.queryByText(/Download/)).not.toBeInTheDocument();
  });

  it('Diff mentions Download for binary/too-large (the file still can\'t be compared, but Download still opens it externally); missing does not (nothing exists to download)', () => {
    render(<BinaryPlaceholder mode="diff" reason="binary" changed size={10} />);
    expect(
      screen.getByText(/Right-click this file in Changes or Explorer and choose Download to open it in an external application\./),
    ).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="diff" reason="too-large" changed size={10} />);
    expect(screen.getByText(/choose Download to open it in an external application/)).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="diff" reason="missing" />);
    expect(screen.queryByText(/Download/)).not.toBeInTheDocument();
  });

  it('size and changed are both optional and omitted gracefully', () => {
    render(<BinaryPlaceholder mode="diff" reason="binary" />);
    expect(screen.getByText("This file type can't be compared line-by-line.")).toBeInTheDocument();
    // No `changed` passed -> the hint is Download alone, not an
    // empty/malformed string.
    expect(screen.getByText(/Right-click this file in Changes or Explorer and choose Download/)).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="rendered" reason="too-large" />);
    expect(screen.getByText('This file is too large to preview inline.')).toBeInTheDocument();
  });

  it('size, when provided, is formatted and appears in the message (both modes)', () => {
    render(<BinaryPlaceholder mode="rendered" reason="binary" size={2_097_152} />);
    expect(screen.getByText(/2\.0 MiB/)).toBeInTheDocument();
    cleanup();

    render(<BinaryPlaceholder mode="diff" reason="binary" size={2_097_152} />);
    expect(screen.getByText(/2\.0 MiB/)).toBeInTheDocument();
  });
});
