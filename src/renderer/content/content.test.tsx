// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { ContentSelection } from './selectionStore';
import { useContentSelection } from './selectionStore';
import { useNotesStore } from '../notes';
import type { NoteRecord, ReviewTargetKind } from '@shared/ipc/channels';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { DEFAULT_SETTINGS } from '@shared/settings';

const { getFileDiff, getDiffBundle, readFile, readFileBytes, notesList, notesCreate } = vi.hoisted(() => ({
  getFileDiff: vi.fn(),
  getDiffBundle: vi.fn(),
  readFile: vi.fn(),
  readFileBytes: vi.fn(),
  notesList: vi.fn(),
  notesCreate: vi.fn(),
}));

// `cockpit` resolves `window.api` at module load, so mock the provider client
// to expose our stub regardless of evaluation order. The retained child
// components (RawFile/ImageCompare/ImageView) talk to `window.api` directly,
// so set that too for their reads.
vi.mock('../providerClient', () => ({
  agentCockpit: {
    provider: { getFileDiff, getDiffBundle, readFile, readFileBytes },
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

    it('Diff: before pane shows an honest no-baseline-preview message (never the old "(unavailable)"); after pane shows the real working-tree image', async () => {
      readFileBytes.mockResolvedValue({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null });
      render(<ContentViewer selection={sel('assets/logo.png', { baseline: 'HEAD' })} />);

      // Before (baseline) pane: readFileBytes has no `ref` support (see
      // ImageCompare.tsx's doc comment) — the settled option (a) decision —
      // so this pane never attempts a fetch and always shows this state.
      await screen.findByText(/Baseline preview unavailable/);
      expect(screen.queryByText('(unavailable)')).not.toBeInTheDocument();

      // After (working tree) pane: a real <img> with a data: URL, fetched
      // via readFileBytes with the selection's worktreePath.
      const img = (await screen.findByAltText('After (working tree)')) as HTMLImageElement;
      expect(img.tagName).toBe('IMG');
      expect(img.src).toBe('data:image/png;base64,Zm9v');
      expect(readFileBytes).toHaveBeenCalledWith('assets/logo.png', { worktreePath: '/wt' });
    });

    it('a rename: the before-pane label surfaces the old path (oldPath ?? filePath shape preserved)', async () => {
      render(
        <ContentViewer
          selection={sel('assets/new-name.png', { baseline: 'HEAD', oldPath: 'assets/old-name.png' })}
        />,
      );
      await screen.findByText(/was assets\/old-name\.png/);
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

    it('a deleted image: the after (working-tree) pane shows "not present"; the before pane still shows no-baseline-preview (v1 has no baseline byte source at all, regardless of file status)', async () => {
      readFileBytes.mockResolvedValue({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
      render(<ContentViewer selection={sel('assets/gone.png', { baseline: 'HEAD' })} />);

      await screen.findByText('Not present in the working tree.');
      expect(screen.getByText(/Baseline preview unavailable/)).toBeInTheDocument();
      expect(screen.queryByText('(unavailable)')).not.toBeInTheDocument();
    });

    it('over the preview cap: shows the actual size and points at Download', async () => {
      readFileBytes.mockResolvedValue({
        bytesBase64: null,
        sizeBytes: 12_582_912, // 12 MiB
        exists: true,
        reason: 'too-large',
      });
      render(<ContentViewer selection={sel('assets/huge.png', { baseline: 'HEAD' })} />);
      await screen.findByText(/too large to preview/);
      expect(screen.getByText(/12\.0 MiB/)).toBeInTheDocument();
      expect(screen.getByText(/Download/)).toBeInTheDocument();
    });

    it('unreadable: a read error renders the unreadable state (unrecognized-extension coverage lives in useImageBytes.test.ts, since classOf already filters image paths to recognized extensions before ContentViewer ever reaches ImageCompare/ImageView)', async () => {
      readFileBytes.mockRejectedValue(new Error('boom'));
      render(<ContentViewer selection={sel('assets/broken.png', { baseline: 'HEAD' })} />);
      await screen.findByText('Unable to preview this image.');
    });
  });

  describe('text-like Rendered vs Raw split (RawFile `highlight` prop)', () => {
    it.each([
      { label: 'a TypeScript file', path: 'src/file.ts', content: 'const a = 1;' },
      { label: 'a JSON file', path: 'data.json', content: '{ "a": 1 }' },
    ])(
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
      fireEvent.click(screen.getByRole('button', { name: 'Wrap' }));
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
