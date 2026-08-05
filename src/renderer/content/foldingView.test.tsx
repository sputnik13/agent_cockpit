// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import type { NoteRecord, ReviewTargetKind, WorktreeRecord } from '@shared/ipc/channels';
import { useNotesStore } from '../notes';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useWorktreeStore } from '@renderer/worktree/worktreeStore';
import { DEFAULT_SETTINGS } from '@shared/settings';
import { TooltipProvider } from '../ui';

// Radix Tooltip's Popper positioning observes element sizing via
// ResizeObserver, which jsdom does not implement — mirrors the identical
// stub in workspace.test.tsx (dockview-core has the same requirement).
// Only exercised once a badge's Tooltip content actually mounts (on focus).
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

// `watchHandlers`/`onWatch` fake the preload bridge's `events.onWatch` (the
// hub's own subscription target — src/renderer/watch/hub.ts) so tests can
// dispatch synthetic watch events, mirroring beads.test.tsx's identical
// `watchHandlers` capture pattern for the same hub.
const { readFile, notesList, notesCreate, watchHandlers, onWatch } = vi.hoisted(() => {
  const watchHandlers: ((e: {
    projectId?: string;
    worktreePath?: string;
    event?: { paths?: string[]; at?: string };
  }) => void)[] = [];
  const onWatch = (
    h: (e: {
      projectId?: string;
      worktreePath?: string;
      event?: { paths?: string[]; at?: string };
    }) => void,
  ) => {
    watchHandlers.push(h);
    return () => {
      const i = watchHandlers.indexOf(h);
      if (i >= 0) watchHandlers.splice(i, 1);
    };
  };
  return {
    readFile: vi.fn(),
    notesList: vi.fn(),
    notesCreate: vi.fn(),
    watchHandlers,
    onWatch,
  };
});

/** Dispatches a synthetic `working-tree` watch event to every currently
 *  subscribed handler — i.e. only has an effect once the read cache is
 *  enabled (`__setReadCacheEnabledForTest(true)`), since that's what
 *  establishes FoldingView's hub subscription (see FoldingView.tsx's
 *  `ensureWatchSubscription`). `paths` are repo-relative POSIX (or, when
 *  `worktreePath` is set, relative to THAT worktree), matching what the real
 *  hub delivers. `worktreePath` mirrors the real `worktreePath`-tagged batch
 *  from the active-external-worktree watch (local_repo_explorer-g1je) —
 *  omitted (undefined) reproduces an UNTAGGED, primary-watch event. */
function dispatchWatch(paths: string[], projectId = 'p1', worktreePath?: string): void {
  for (const h of watchHandlers) {
    h({ projectId, worktreePath, event: { paths, at: new Date().toISOString() } });
  }
}

// `computeFoldModelMock` wraps the REAL `computeFoldModel` by default (via
// `importOriginal`), so every test gets a REAL, unmocked fold model computed
// from the actual fixture text unless a specific test overrides it for one
// call (`mockRejectedValueOnce`/`mockImplementationOnce`) to exercise the
// `unavailable` degrade path — mirrors folding/useFoldModel.test.tsx's own
// mocking shape, just wrapping instead of fully replacing.
const { computeFoldModelMock } = vi.hoisted(() => ({ computeFoldModelMock: vi.fn() }));
vi.mock('./folding/foldClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./folding/foldClient')>();
  computeFoldModelMock.mockImplementation(actual.computeFoldModel);
  return { ...actual, computeFoldModel: computeFoldModelMock };
});

vi.mock('../providerClient', () => ({
  agentCockpit: {
    provider: { readFile },
    // The hub (src/renderer/watch/hub.ts) reads `agentCockpit.events.onWatch`
    // directly — see its module doc comment — so this must be mocked here
    // too, not just on `window.api` below, for FoldingView's watch
    // subscription (`ensureWatchSubscription`) to have anything to attach to.
    events: { onWatch },
    notes: {
      list: notesList,
      create: notesCreate,
      update: vi.fn(),
      remove: vi.fn(),
      exportMarkdown: vi.fn().mockResolvedValue(''),
    },
  },
  useProjectsStore: Object.assign(
    (sel: (s: { activeId: string | null }) => unknown) => sel({ activeId: 'p1' }),
    { getState: () => ({ activeId: 'p1' }) },
  ),
}));

(globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
(window as unknown as { api: unknown }).api = { provider: { readFile } };

import {
  FoldingView,
  __resetFoldingReadCacheForTest,
  __setReadCacheEnabledForTest,
} from './FoldingView';

// Same nested fixture shape as folding/jsonFold.test.ts's primary case:
//   0/1 '{'
//   1/2 '  "a": {'      <- region A (object, 1 item: "b")
//   2/3 '    "b": ['    <- region B (array, 2 items: 1, 2) -- nested in A
//   3/4 '      1,'
//   4/5 '      2'
//   5/6 '    ]'          <- B closes, no trailing chars
//   6/7 '  },'            <- A closes, trailing ','
//   7/8 '  "c": 3'
//   8/9 '}'
const NESTED_JSON = [
  '{',
  '  "a": {',
  '    "b": [',
  '      1,',
  '      2',
  '    ]',
  '  },',
  '  "c": 3',
  '}',
].join('\n');

const JSONC_WITH_COMMENTS = [
  '{',
  '  // a comment describing "a"',
  '  "a": {',
  '    "b": 1 /* trailing block comment */',
  '  },',
  '  "c": 3',
  '}',
].join('\n');

// local_repo_explorer-jp2f.6 fixtures — a single-document YAML file (parity
// with .5 is asserted against this one), a three-document stream (each
// document has its OWN nested foldable region, so per-document fold
// isolation is directly exercisable), and two anchor/alias fixtures
// (plural and singular alias count).

const SINGLE_DOC_YAML = ['a:', '  b: 1', '  c: 2'].join('\n');

// Line numbers (0-based / 1-based):
//   0/1 'a: 1'          <- document 0 (no '---', no fold region)
//   1/2 '---'           <- document 1 starts here
//   2/3 'b:'
//   3/4 '  c: 2'        <- doc 1's inner region (value of "b") starts here
//   4/5 '  d: 3'        <- ends here (region.end lands exactly on line 5's
//                           own start — the document-boundary regression
//                           this leaf fixed in foldingRows.ts)
//   5/6 '---'           <- document 2 starts here
//   6/7 'e:'
//   7/8 '  f: 4'        <- doc 2's inner region (value of "e") starts here
//   8/9 '  g: 5'        <- ends here (EOF, no trailing newline)
const THREE_DOC_YAML = [
  'a: 1',
  '---',
  'b:',
  '  c: 2',
  '  d: 3',
  '---',
  'e:',
  '  f: 4',
  '  g: 5',
].join('\n');

// Two aliases -> plural tooltip wording.
//   0/1 'defaults: &defaults'  <- anchor definition
//   1/2 '  timeout: 30'
//   2/3 'job_a:'
//   3/4 '  config: *defaults'  <- alias 1
//   4/5 'job_b:'
//   5/6 '  config: *defaults'  <- alias 2
const ANCHOR_TWO_ALIASES_YAML = [
  'defaults: &defaults',
  '  timeout: 30',
  'job_a:',
  '  config: *defaults',
  'job_b:',
  '  config: *defaults',
].join('\n');

// One alias -> singular tooltip wording.
const ANCHOR_ONE_ALIAS_YAML = [
  'defaults: &defaults',
  '  timeout: 30',
  'job_a:',
  '  config: *defaults',
].join('\n');

// The anchor definition sits INSIDE a foldable region (config's value);
// the alias sits OUTSIDE it, on its own always-visible line.
//   0/1 'config:'
//   1/2 '  defaults: &defaults'  <- definition, INSIDE the fold region
//   2/3 '    timeout: 30'
//   3/4 'use: *defaults'         <- alias, always visible
const ANCHOR_INSIDE_FOLD_YAML = [
  'config:',
  '  defaults: &defaults',
  '    timeout: 30',
  'use: *defaults',
].join('\n');

function textOk(sizeBytes?: number) {
  return (content: string) => ({
    content,
    truncated: false,
    isBinary: false,
    sizeBytes: sizeBytes ?? content.length,
  });
}

/** Minimal `WorktreeRecord` fixture builder, mirroring
 *  worktreeStore.test.ts's own `wt()` helper. Used only by the linked-
 *  worktree filesystem-watch tests below (local_repo_explorer-w5x0) to seed
 *  `useWorktreeStore` directly — the same idiom `explorer.test.tsx`/
 *  `changes.test.tsx` use for tests that need a KNOWN worktree list without
 *  round-tripping through the async `loadWorktrees` action. */
function wt(path: string, over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    path,
    branch: 'main',
    head: 'abc',
    locked: false,
    prunable: false,
    detached: false,
    ...over,
  };
}

/** The rendered CODE portion of every currently-visible row, in DOM order —
 *  the code span is the only element in this markup with an inline
 *  `padding-left` style, so this selector is specific to it (gutter/toggle
 *  cells use Tailwind classes, not this inline style). Anchor/alias badges
 *  (local_repo_explorer-jp2f.6) are ADDITIVE chrome inside this same code
 *  span, marked with `data-fold-badge` (never styled — a pure DOM/test
 *  marker); they are stripped from a CLONE before reading `textContent` so
 *  round-trip source-text comparisons see only real source characters,
 *  never a badge's own glyph text. */
function codeLines(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll('span[style*="padding-left"]')).map((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-fold-badge]').forEach((b) => b.remove());
    return clone.textContent ?? '';
  });
}

function gutterButtons(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll('button[title^="Add a note on line"]')) as HTMLElement[];
}

/** Every anchor/alias badge currently in the DOM, in document order. */
function badgeElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll('[data-fold-badge]')) as HTMLElement[];
}

/** Every document-group region (`role="region"`) currently in the DOM, in
 *  document order — present only when `documents.length > 1`. */
function documentRegions(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll('[role="region"]')) as HTMLElement[];
}

function separators(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll('[data-fold-separator]')) as HTMLElement[];
}

interface FoldingElProps {
  filePath?: string;
  format?: 'json' | 'yaml';
  wrap?: boolean;
  gitRef?: string;
  onBinaryConfirmed?: (c: unknown) => void;
  /** Defaults to '/wt' — an inert placeholder every EXISTING test in this
   *  file relies on (the pre-w5x0 matching logic ignored `worktreePath`
   *  entirely, so any non-empty value behaved identically). The linked-
   *  worktree tests below (local_repo_explorer-w5x0) override this to a
   *  KNOWN, non-primary worktree path to exercise the real conversion. */
  worktreePath?: string;
}

/**
 * Wrapped in TooltipProvider (mirrors AppShell.tsx mounting it once at the
 * app root) since a badge-bearing YAML fixture renders this repo's Radix
 * `Tooltip`, which throws without a Provider ancestor — harmless/inert for
 * every anchor-free (JSON, or plain YAML) fixture, which never instantiates
 * a `<Tooltip>` at all. Every `render`/`rerender` call in this file MUST go
 * through this SAME wrapped shape (never a bare `<FoldingView/>` once a test
 * has rendered through it) — React reconciles a changed top-level element
 * type as a full unmount/remount, which would force-remount FoldingView
 * itself between a `render`/`rerender` pair and silently break the "one
 * read per selection" / cache-hit assertions that assume the SAME mounted
 * instance survives a `wrap`/prop-only rerender.
 */
function foldingEl(props: FoldingElProps) {
  return (
    <TooltipProvider>
      <FoldingView
        worktreePath={props.worktreePath ?? '/wt'}
        filePath={props.filePath ?? 'data.json'}
        format={props.format ?? 'json'}
        wrap={props.wrap}
        gitRef={props.gitRef}
        onBinaryConfirmed={props.onBinaryConfirmed}
      />
    </TooltipProvider>
  );
}

async function renderReady(props: FoldingElProps) {
  const utils = render(foldingEl(props));
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  return utils;
}

beforeEach(() => {
  readFile.mockReset();
  notesList.mockReset();
  notesCreate.mockReset();
  notesList.mockResolvedValue([]);
  computeFoldModelMock.mockClear();
  __resetFoldingReadCacheForTest();
});

afterEach(() => {
  cleanup();
  useNotesStore.setState({ notes: [] });
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  // No test outside the linked-worktree describe block (local_repo_explorer-
  // w5x0) seeds this store; resetting it here (rather than per-test) keeps
  // that seeding out of every other test's setup/teardown, mirroring the
  // useNotesStore/useSettingsStore resets above.
  useWorktreeStore.setState({ byProject: {} });
  __resetFoldingReadCacheForTest();
  // Defensive, in addition to any test's own try/finally around
  // `__setReadCacheEnabledForTest(true)`: guarantees the cache is back to
  // its default disabled state AND its watch-hub subscription (if any test
  // established one) is torn down before the next test runs, regardless of
  // whether that test cleaned up after itself. See the "filesystem-watch
  // invalidation" describe block's own leak-check test for a direct
  // assertion on `watchHandlers`.
  __setReadCacheEnabledForTest(false);
});

describe('FoldingView', () => {
  describe('byte-exact round trip (everything expanded)', () => {
    it('a nested JSON fixture: the concatenation of all rendered row text equals the original file content exactly', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});
      expect(codeLines(container).join('\n')).toBe(NESTED_JSON);
    });

    it('a .jsonc fixture with line and block comments round-trips byte-for-byte, including the comments', async () => {
      readFile.mockResolvedValue(textOk()(JSONC_WITH_COMMENTS));
      const { container } = await renderReady({ filePath: 'data.jsonc' });
      expect(codeLines(container).join('\n')).toBe(JSONC_WITH_COMMENTS);
      expect(codeLines(container).join('\n')).toContain('// a comment describing "a"');
      expect(codeLines(container).join('\n')).toContain('/* trailing block comment */');
    });
  });

  describe('collapse / expand', () => {
    it('collapsing region A hides exactly (headerEnd, end], keeps the opening delimiter and trailing close-line source visible, and shows a correctly-counted placeholder', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );

      // Lines 3-7 (1-based) -- B's header/interior/close AND A's own close
      // line -- are gone; line 1, the folded placeholder, and lines 8-9
      // remain.
      const lines = codeLines(container);
      expect(lines).toHaveLength(4); // line1, folded(A), line8, line9
      expect(lines[0]).toBe('{');
      // The folded row: opening delimiter through headerEnd, then the chip
      // text, then the trailing ',' from A's close line -- concatenated
      // into ONE row's textContent.
      expect(lines[1]).toBe('  "a": {{…} 1 item,');
      expect(lines[2]).toBe('  "c": 3');
      expect(lines[3]).toBe('}');

      // The chip itself: correct glyph + singular count.
      expect(screen.getByRole('button', { name: 'Expand object, 1 item' })).toBeInTheDocument();

      // Interior text is genuinely gone from the DOM, not just visually hidden.
      expect(container.textContent).not.toContain('"b": [');
      expect(container.textContent).not.toContain('      1,');
    });

    it('re-expanding restores the identical original text', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );
      expect(codeLines(container).join('\n')).not.toBe(NESTED_JSON);

      fireEvent.click(screen.getByRole('button', { name: 'Expand object, 1 item' }));
      expect(codeLines(container).join('\n')).toBe(NESTED_JSON);
    });

    it('collapsing an outer region and re-expanding it preserves the collapsed state of a region nested inside it', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});

      // Collapse the INNER region B first (while A is still expanded).
      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse array starting on line 3, 2 items' }),
      );
      expect(screen.getByRole('button', { name: 'Expand array, 2 items' })).toBeInTheDocument();

      // Now collapse the OUTER region A -- B's already-folded row is
      // absorbed (no longer in the DOM at all).
      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );
      expect(
        screen.queryByRole('button', { name: 'Expand array, 2 items' }),
      ).not.toBeInTheDocument();

      // Re-expand A: B reappears STILL collapsed (its own state was
      // retained the whole time A hid it), not reset back to expanded.
      fireEvent.click(screen.getByRole('button', { name: 'Expand object, 1 item' }));
      expect(screen.getByRole('button', { name: 'Expand array, 2 items' })).toBeInTheDocument();
      expect(container.textContent).not.toContain('      1,'); // B's interior still hidden
    });
  });

  describe('original line numbers', () => {
    it('the gutter always shows ORIGINAL source line numbers, never renumbered, in every fold state', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});

      const lineNumbers = () =>
        gutterButtons(container).map((b) => b.querySelector('span')?.textContent);
      expect(lineNumbers()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );
      // Line 1, then the folded row anchored at ORIGINAL line 2 (not
      // renumbered to "2" of a new count), then original lines 8 and 9.
      expect(lineNumbers()).toEqual(['1', '2', '8', '9']);
    });
  });

  describe('line notes survive unrelated folds', () => {
    it('a note added to a visible line stays attached to that line after collapsing and re-expanding an unrelated region', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
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
      notesList.mockImplementation(async () => [...stored]);

      const { container } = await renderReady({});

      // Line 8 ('  "c": 3') is unrelated to region A (which spans lines 2-7).
      fireEvent.click(screen.getByTitle('Add a note on line 8'));
      fireEvent.change(screen.getByPlaceholderText('Add a note for this line…'), {
        target: { value: 'why 3?' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
      await waitFor(() => expect(screen.getByText('why 3?')).toBeInTheDocument());

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );
      expect(screen.getByText('why 3?')).toBeInTheDocument(); // still visible, unaffected

      fireEvent.click(screen.getByRole('button', { name: 'Expand object, 1 item' }));
      expect(screen.getByText('why 3?')).toBeInTheDocument();
      // Still anchored to line 8, not shifted.
      expect(gutterButtons(container).find((b) => b.title === 'Add a note on line 8')).toBeTruthy();
    });
  });

  describe('keyboard operability', () => {
    it('every fold toggle is reachable, visible without hovering, has aria-expanded reflecting its state, and toggles on both Enter and Space', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      await renderReady({});

      const toggle = screen.getByRole('button', {
        name: 'Collapse object starting on line 2, 1 item',
      });
      // Visible and focusable without any hover simulation.
      expect(toggle).toBeVisible();
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      toggle.focus();
      expect(document.activeElement).toBe(toggle);

      fireEvent.keyDown(toggle, { key: 'Enter' });
      const collapsedToggle = screen.getByRole('button', {
        name: 'Expand object starting on line 2, 1 item',
      });
      expect(collapsedToggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.keyDown(collapsedToggle, { key: ' ' });
      expect(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      ).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('syntax highlighting', () => {
    it('JSON Rendered shows highlighted token spans (does not regress to plain text)', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});
      await waitFor(() =>
        expect(container.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0),
      );
    });

    it('tokens still align to the correct original line after collapsing a region ABOVE it', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});
      await waitFor(() =>
        expect(container.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0),
      );

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );

      // Line 8 ('  "c": 3') is AFTER the now-collapsed region; its code span
      // (original line index 7) must still carry real highlighted tokens,
      // not fall back to a flat, uncolored string.
      const lineCells = codeLines(container);
      const cLine = lineCells.find((t) => t.includes('"c": 3'));
      expect(cLine).toBe('  "c": 3');
      const cGutter = gutterButtons(container).find((b) => b.title === 'Add a note on line 8');
      const cCodeSpan = cGutter!.parentElement!.children[2] as HTMLElement;
      expect(cCodeSpan.querySelectorAll('span[style*="color"]').length).toBeGreaterThan(0);
    });
  });

  describe('onBinaryConfirmed', () => {
    it.each([
      {
        label: 'text',
        mock: { content: '{}', truncated: false, isBinary: false, sizeBytes: 2 },
        expected: { kind: 'text', sizeBytes: 2 },
      },
      {
        label: 'binary',
        mock: { content: null, truncated: false, isBinary: true, sizeBytes: 99 },
        expected: { kind: 'binary', sizeBytes: 99 },
      },
      {
        label: 'too-large',
        mock: { content: null, truncated: true, isBinary: false, sizeBytes: 12345 },
        expected: { kind: 'too-large', sizeBytes: 12345 },
      },
      {
        label: 'missing',
        mock: { content: null, truncated: false, isBinary: false, sizeBytes: 0 },
        expected: { kind: 'missing' },
      },
    ])(
      '$label: fires exactly once with the correct RawFileConfirmation shape',
      async ({ mock, expected }) => {
        readFile.mockResolvedValue(mock);
        const onBinaryConfirmed = vi.fn();
        render(
          <FoldingView
            worktreePath="/wt"
            filePath="data.json"
            format="json"
            onBinaryConfirmed={onBinaryConfirmed}
          />,
        );
        await waitFor(() => expect(onBinaryConfirmed).toHaveBeenCalledTimes(1));
        expect(onBinaryConfirmed).toHaveBeenCalledWith(expected);
        expect(onBinaryConfirmed).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe("the four read-outcome placeholders match RawFile's Rendered (highlight=true) presentation", () => {
    it('binary shows the graceful no-preview placeholder with size and a Download pointer', async () => {
      readFile.mockResolvedValue({
        content: null,
        truncated: false,
        isBinary: true,
        sizeBytes: 2048,
      });
      await renderReady({});
      expect(
        screen.getByText(/No preview available for this file type \(2\.0 KiB\)/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/Right-click this file in Changes or Explorer and choose Download/),
      ).toBeInTheDocument();
    });

    it('too-large shows the graceful too-large placeholder with size and a Download pointer', async () => {
      readFile.mockResolvedValue({
        content: null,
        truncated: true,
        isBinary: false,
        sizeBytes: 5_000_000,
      });
      await renderReady({});
      expect(screen.getByText(/too large to preview inline \(4\.8 MiB\)/)).toBeInTheDocument();
      expect(
        screen.getByText(/Right-click this file in Changes or Explorer and choose Download/),
      ).toBeInTheDocument();
    });

    it('missing shows "File not found at ref." with no Download pointer', async () => {
      readFile.mockResolvedValue({
        content: null,
        truncated: false,
        isBinary: false,
        sizeBytes: 0,
      });
      await renderReady({});
      expect(screen.getByText('File not found at ref.')).toBeInTheDocument();
      expect(screen.queryByText(/Download/)).not.toBeInTheDocument();
    });

    it('a missing/pending read shows the same "Loading…" affordance RawFile uses, synchronously on first paint', () => {
      readFile.mockReturnValue(new Promise<never>(() => {}));
      render(<FoldingView worktreePath="/wt" filePath="data.json" format="json" />);
      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });
  });

  describe('graceful degrade: never blank, only the model-unavailable/errors cases get a notice', () => {
    it('a file with zero foldable regions (single-line JSON) renders plain highlighted lines with NO notice and no toggle buttons', async () => {
      const content = '{ "a": 1 }';
      readFile.mockResolvedValue(textOk()(content));
      const { container } = await renderReady({});
      expect(container.textContent).toContain(content);
      expect(document.querySelectorAll('button[aria-expanded]')).toHaveLength(0);
      expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
    });

    it('an empty file renders one empty, styled line — not a blank pane — with no notice', async () => {
      readFile.mockResolvedValue(textOk()(''));
      const { container } = await renderReady({});
      expect(gutterButtons(container)).toHaveLength(1);
      expect(gutterButtons(container)[0].querySelector('span')?.textContent).toBe('1');
      expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
    });

    it('an unavailable fold model (compute failure) degrades to the plain highlighted view with a non-blocking notice and no crash', async () => {
      computeFoldModelMock.mockRejectedValueOnce(new Error('boom'));
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { container } = await renderReady({});
      expect(
        screen.getByText('Folding is unavailable for this file. Showing plain text.'),
      ).toBeInTheDocument();
      // Still the readable content -- never blank.
      expect(container.textContent).toContain('"c": 3');
      expect(document.querySelectorAll('button[aria-expanded]')).toHaveLength(0);
    });

    it('a model with errors (malformed JSON, partial recovery) degrades to the plain highlighted view naming the error count, no crash', async () => {
      const malformed = '{\n  "a": [1, 2, \n}';
      readFile.mockResolvedValue(textOk()(malformed));
      const { container } = await renderReady({});
      expect(
        screen.getByText(/Folding is unavailable: this file has \d+ syntax error/),
      ).toBeInTheDocument();
      expect(container.textContent).toContain('"a": [1, 2,');
      expect(document.querySelectorAll('button[aria-expanded]')).toHaveLength(0);
    });
  });

  describe('gutter/toggle alignment invariant (wrap off and on)', () => {
    it('gutter and fold-toggle columns stay flexShrink:0 and correctly styled per wrap mode; the toggle column never shrinks', async () => {
      const content = [
        '{',
        '  "s": 1,',
        '  "long": "a noticeably longer value than the short one above it, for width contrast"',
        '}',
      ].join('\n');
      readFile.mockResolvedValue(textOk()(content));
      const { container, rerender } = await renderReady({ wrap: false });

      function assertContract(wrapExpected: boolean): void {
        const gutters = gutterButtons(container);
        expect(gutters).toHaveLength(4);
        for (const gutter of gutters) {
          expect(gutter.className).toContain('shrink-0');
          const row = gutter.parentElement as HTMLElement;
          const toggle = row.children[1] as HTMLElement;
          const codeSpan = row.children[2] as HTMLElement;
          expect(toggle.className).toContain('shrink-0');
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

      assertContract(false);

      rerender(foldingEl({ wrap: true }));
      assertContract(true);
    });
  });

  describe('one read per selection', () => {
    it('does not re-fetch when only `wrap` changes (rerender with the same selection)', async () => {
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { rerender } = await renderReady({ wrap: false });
      expect(readFile).toHaveBeenCalledTimes(1);

      rerender(foldingEl({ wrap: true }));
      rerender(foldingEl({ wrap: false }));
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('switching Rendered -> Raw -> Rendered (unmount then remount the same selection) does not re-read the file', async () => {
      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({});
        expect(readFile).toHaveBeenCalledTimes(1);

        // Simulate ContentViewer swapping 'folding-view' out for 'raw-file'
        // (Raw) and then back in (Rendered) -- a genuine unmount/remount of
        // this exact component, which is what a mode toggle does for
        // json/yaml (see modeSwitcher.tsx's VIEW_DISPATCH doc comment).
        unmount();
        const { container } = await renderReady({});
        expect(readFile).toHaveBeenCalledTimes(1); // still just the one read
        expect(codeLines(container).join('\n')).toBe(NESTED_JSON);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });
  });

  describe('filesystem-watch invalidation (local_repo_explorer-cks4)', () => {
    it("a working-tree watch event matching the open file's path evicts its cache entry, so toggling Rendered -> Raw -> Rendered re-reads and shows the updated content", async () => {
      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({ filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(1);

        // Toggle away (Rendered -> Raw): the cache entry survives the unmount
        // (that's the whole point of the cache — see its module doc comment).
        unmount();

        // The file is edited externally WHILE nothing currently displays it —
        // the watch event for the SAME repo-relative path must still evict
        // the (currently unmounted) cache entry. This is deliberately NOT
        // "while still mounted": see FoldingView.tsx's `ensureWatchSubscription`
        // doc comment for why invalidation is module-scoped (tied to the
        // cache's own lifetime) rather than tied to a live mount.
        const EDITED = NESTED_JSON.replace('"c": 3', '"c": 42');
        expect(EDITED).not.toBe(NESTED_JSON);
        readFile.mockResolvedValue(textOk()(EDITED));
        dispatchWatch(['data.json']);

        // Toggle back (Raw -> Rendered): must re-read, not serve the stale entry.
        const { container } = await renderReady({ filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(codeLines(container).join('\n')).toBe(EDITED);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });

    it('an unrelated watch event (a different path) does not invalidate the cache — the existing no-re-read guarantee holds', async () => {
      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({ filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(1);

        unmount();
        dispatchWatch(['some/other-file.json']);

        const { container } = await renderReady({ filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(1); // still just the one read
        expect(codeLines(container).join('\n')).toBe(NESTED_JSON);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });

    it('subscribes to the watch hub only while the cache is enabled, independent of any single mount, and leaves no listener behind once disabled', async () => {
      expect(watchHandlers).toHaveLength(0); // disabled by default under test — nothing subscribed

      __setReadCacheEnabledForTest(true);
      expect(watchHandlers).toHaveLength(1);

      // Mounting/unmounting FoldingView instances must not add a second
      // listener — the subscription is established once, for the cache's own
      // lifetime, never per component mount (see `ensureWatchSubscription`'s
      // doc comment in FoldingView.tsx).
      readFile.mockResolvedValue(textOk()(NESTED_JSON));
      const { unmount } = await renderReady({});
      expect(watchHandlers).toHaveLength(1);
      unmount();
      expect(watchHandlers).toHaveLength(1);

      __setReadCacheEnabledForTest(false);
      expect(watchHandlers).toHaveLength(0);
    });
  });

  describe('filesystem-watch invalidation — linked worktree (local_repo_explorer-w5x0)', () => {
    it("a working-tree watch event for a file in a LINKED (non-primary) worktree, expressed as a project-root-relative path (as the real hub always delivers), evicts that entry's cache too — not just the primary-worktree case cks4 fixed", async () => {
      // A linked worktree nested inside the project root (e.g. a `git
      // worktree add` under `.worktrees/`) — the only shape a LOCAL watch
      // (rootPath-scoped) can ever observe at all; see toWatchTarget's
      // doc comment in FoldingView.tsx. `worktrees[0]` is the primary/root
      // per worktreeOptions.ts's own documented invariant.
      useWorktreeStore.setState({
        byProject: {
          p1: {
            worktrees: [wt('/repo'), wt('/repo/.worktrees/feature', { branch: 'feature' })],
            activeWorktree: '/repo/.worktrees/feature',
            loading: false,
          },
        },
      });

      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({
          worktreePath: '/repo/.worktrees/feature',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(1);

        unmount();

        const EDITED = NESTED_JSON.replace('"c": 3', '"c": 42');
        expect(EDITED).not.toBe(NESTED_JSON);
        readFile.mockResolvedValue(textOk()(EDITED));
        // Project-root-relative, NOT worktree-relative — comparing this
        // as-is against the cache's own worktree-relative 'data.json'
        // (cks4's original matching) would never match, reproducing the
        // bug this bead fixes.
        dispatchWatch(['.worktrees/feature/data.json']);

        const { container } = await renderReady({
          worktreePath: '/repo/.worktrees/feature',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(codeLines(container).join('\n')).toBe(EDITED);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });

    it('a working-tree watch event for the PRIMARY worktree, expressed via an empty worktreePath (the other real primary representation — see ContentSelection.worktreePath), still evicts the cache entry exactly as before — no regression from the worktree-aware conversion', async () => {
      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({ worktreePath: '', filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(1);

        unmount();

        const EDITED = NESTED_JSON.replace('"c": 3', '"c": 42');
        readFile.mockResolvedValue(textOk()(EDITED));
        dispatchWatch(['data.json']);

        const { container } = await renderReady({ worktreePath: '', filePath: 'data.json' });
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(codeLines(container).join('\n')).toBe(EDITED);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });

  });

  describe('filesystem-watch invalidation — sibling/external worktree (local_repo_explorer-g1je)', () => {
    it("an UNTAGGED root-level watch event of the same relative filename does NOT falsely evict a sibling/external worktree's cache entry (no regression from the g1je conversion), but a properly worktreePath-TAGGED event for that sibling DOES evict it and a subsequent read shows the edited content (the bead's AC)", async () => {
      // '/sibling-wt' is NOT nested under '/repo' (the common `git worktree
      // add` shape). Before g1je NO watch mechanism could ever observe it at
      // all (the local watch was rootPath-scoped only — see CLAUDE.md
      // "Filesystem watch: single-source what to watch"), so an entry cached
      // for it was PERMANENTLY unmatchable — this test's negative half (an
      // untagged event never cross-matches) preserves that safety property
      // byte-for-byte. g1je adds a lazy, active-external-worktree watch
      // (SessionManager.setActiveWorktree) whose events carry an explicit
      // `worktreePath` tag — this test's positive half is the actual bead AC:
      // a correctly tagged event DOES evict and a re-read shows the edit.
      useWorktreeStore.setState({
        byProject: {
          p1: {
            worktrees: [wt('/repo'), wt('/sibling-wt', { branch: 'sibling' })],
            activeWorktree: '/sibling-wt',
            loading: false,
          },
        },
      });

      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({
          worktreePath: '/sibling-wt',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(1);

        unmount();

        // 1) An UNTAGGED event naming the ROOT's own unrelated 'data.json'
        // (a different file entirely) must not cross-match the sibling's
        // cache entry — the negative case w5x0/g1je's design both require.
        dispatchWatch(['data.json']);
        {
          const { container, unmount: unmountFirst } = await renderReady({
            worktreePath: '/sibling-wt',
            filePath: 'data.json',
          });
          expect(readFile).toHaveBeenCalledTimes(1); // still just the one read — no false invalidation
          expect(codeLines(container).join('\n')).toBe(NESTED_JSON);
          unmountFirst();
        }

        // 2) A worktreePath-TAGGED event for '/sibling-wt' itself — the
        // active-external-worktree watch's own paths are relative to THAT
        // worktree, matching this entry's `rel` — DOES evict.
        const EDITED = NESTED_JSON.replace('"c": 3', '"c": 42');
        expect(EDITED).not.toBe(NESTED_JSON);
        readFile.mockResolvedValue(textOk()(EDITED));
        dispatchWatch(['data.json'], 'p1', '/sibling-wt');

        const { container } = await renderReady({
          worktreePath: '/sibling-wt',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(2);
        expect(codeLines(container).join('\n')).toBe(EDITED);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });

    it('switching the active worktree AWAY from a sibling/external worktree evicts its cached entries (the unwatched-interval staleness guard) even with no watch event at all', async () => {
      // The active-external-worktree watch only ever covers the CURRENTLY
      // active worktree; once the selection moves away, SessionManager tears
      // that watch down, so an edit made during the resulting unwatched
      // interval would never arrive as a watch event. This guard evicts on
      // the SELECTION transition itself — deliberately no dispatchWatch call
      // anywhere in this test.
      useWorktreeStore.setState({
        byProject: {
          p1: {
            worktrees: [wt('/repo'), wt('/sibling-wt', { branch: 'sibling' })],
            activeWorktree: '/sibling-wt',
            loading: false,
          },
        },
      });

      __setReadCacheEnabledForTest(true);
      try {
        readFile.mockResolvedValue(textOk()(NESTED_JSON));
        const { unmount } = await renderReady({
          worktreePath: '/sibling-wt',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(1);
        unmount();

        // Selection moves away from '/sibling-wt' (e.g. the user picks the
        // root worktree). No watch event is dispatched.
        useWorktreeStore.setState({
          byProject: {
            p1: {
              worktrees: [wt('/repo'), wt('/sibling-wt', { branch: 'sibling' })],
              activeWorktree: '/repo',
              loading: false,
            },
          },
        });

        const EDITED = NESTED_JSON.replace('"c": 3', '"c": 42');
        readFile.mockResolvedValue(textOk()(EDITED));

        const { container } = await renderReady({
          worktreePath: '/sibling-wt',
          filePath: 'data.json',
        });
        expect(readFile).toHaveBeenCalledTimes(2); // re-read, not served stale
        expect(codeLines(container).join('\n')).toBe(EDITED);
      } finally {
        __setReadCacheEnabledForTest(false);
      }
    });
  });

  describe('fold state resets on selection change', () => {
    it('collapsing a region, then switching to a different filePath, does not carry the collapsed state over — even when the new file has a region starting at the IDENTICAL offset', async () => {
      // FILE2 only changes "c"'s value, which comes AFTER region A's entire
      // span -- so region A parses to the EXACT SAME `start` offset in both
      // files. This is the adversarial version of this test: if the reset
      // effect did NOT fire, the stale collapsed-offset Set from FILE1 would
      // still match FILE2's region A by coincidence, and this would pass
      // even with a missing reset. Distinct tail content also makes the
      // `waitFor` below genuinely wait for the second read, rather than
      // being trivially satisfied by FILE1's (identical) still-displayed text.
      const FILE1 = NESTED_JSON;
      const FILE2 = NESTED_JSON.replace('"c": 3', '"c": 99');
      expect(FILE2).not.toBe(FILE1);

      readFile.mockResolvedValue(textOk()(FILE1));
      const { container, rerender } = await renderReady({ filePath: 'first.json' });

      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );
      expect(
        screen.queryByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      ).not.toBeInTheDocument();

      readFile.mockResolvedValue(textOk()(FILE2));
      rerender(foldingEl({ filePath: 'second.json' }));
      await waitFor(() => expect(container.textContent).toContain('"c": 99'));

      // Region A is expanded again in FILE2, proving the reset fired rather
      // than the stale offset happening to miss a match.
      expect(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      ).toBeInTheDocument();
      expect(codeLines(container).join('\n')).toBe(FILE2);
    });
  });

  describe('multi-document YAML rendering (local_repo_explorer-jp2f.6)', () => {
    it('renders all three documents in source order, with two separator bands and per-document accessible labels; "---" marker lines remain literal source lines', async () => {
      readFile.mockResolvedValue(textOk()(THREE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      const regions = documentRegions(container);
      expect(regions).toHaveLength(3);
      expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
        'Document 1 of 3',
        'Document 2 of 3',
        'Document 3 of 3',
      ]);
      expect(separators(container)).toHaveLength(2); // N documents -> N-1 bands

      // The '---' marker lines are still present as literal, unaltered rows
      // (chrome only ADDS the separator band; it never replaces them).
      const lines = codeLines(container);
      expect(lines.filter((l) => l === '---')).toHaveLength(2);
    });

    it('line numbers are continuous and file-global across documents (document 2 does not restart at line 1)', async () => {
      readFile.mockResolvedValue(textOk()(THREE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      const lineNumbers = gutterButtons(container).map((b) => b.querySelector('span')?.textContent);
      expect(lineNumbers).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    });

    it('with everything expanded, the concatenation of all rendered row text equals the original file content exactly — separators are chrome, not text', async () => {
      readFile.mockResolvedValue(textOk()(THREE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      expect(codeLines(container).join('\n')).toBe(THREE_DOC_YAML);
    });

    it('folding a mapping inside document 2 does not affect documents 1 or 3', async () => {
      readFile.mockResolvedValue(textOk()(THREE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      // Document 2's own inner region (the value of "e": {f: 4, g: 5}).
      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 8, 2 items' }),
      );

      const regions = documentRegions(container);
      expect(regions).toHaveLength(3);
      // Document 1 (index 0, 'a: 1') and document 2 (index 1, the 'b'
      // stream) are untouched — same text as the unfolded original.
      expect(regions[0].textContent).toContain('a: 1');
      expect(regions[1].textContent).toContain('c: 2');
      expect(regions[1].textContent).toContain('d: 3');
      // Document 3 (index 2) lost exactly its collapsed region's interior.
      expect(regions[2].textContent).not.toContain('g: 5');
      expect(screen.getByRole('button', { name: 'Expand object, 2 items' })).toBeInTheDocument();

      // Re-expanding restores document 3 with no effect on the others.
      fireEvent.click(screen.getByRole('button', { name: 'Expand object, 2 items' }));
      expect(codeLines(container).join('\n')).toBe(THREE_DOC_YAML);
    });

    it('a single-document YAML file renders identically to .5 — no separator, no document label, no layout change', async () => {
      readFile.mockResolvedValue(textOk()(SINGLE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      expect(documentRegions(container)).toHaveLength(0);
      expect(separators(container)).toHaveLength(0);
      expect(screen.queryByText(/Document \d+ of \d+/)).not.toBeInTheDocument();
      expect(codeLines(container).join('\n')).toBe(SINGLE_DOC_YAML);
    });
  });

  describe('anchor/alias linkage badges (local_repo_explorer-jp2f.6)', () => {
    it('a fixture with &defaults and two *defaults references renders three badges; the definition badge names the anchor and count, each alias badge names the anchor and its definition line', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_TWO_ALIASES_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      const badges = badgeElements(container);
      expect(badges).toHaveLength(3);
      const defBadge = badges.find((b) => b.dataset.foldBadge === 'definition')!;
      const aliasBadges = badges.filter((b) => b.dataset.foldBadge === 'alias');
      expect(aliasBadges).toHaveLength(2);

      expect(defBadge.getAttribute('aria-label')).toBe(
        'Anchor &defaults — referenced by 2 aliases',
      );
      for (const alias of aliasBadges) {
        expect(alias.getAttribute('aria-label')).toBe('Alias of &defaults, defined on line 1');
      }
    });

    it('a fixture with exactly one alias uses the singular tooltip form', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_ONE_ALIAS_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      const badges = badgeElements(container);
      expect(badges).toHaveLength(2); // one definition, one alias
      const defBadge = badges.find((b) => b.dataset.foldBadge === 'definition')!;
      const aliasBadge = badges.find((b) => b.dataset.foldBadge === 'alias')!;
      expect(defBadge.getAttribute('aria-label')).toBe('Anchor &defaults — referenced by 1 alias');
      expect(aliasBadge.getAttribute('aria-label')).toBe('Alias of &defaults, defined on line 1');
    });

    it('never uses a `title` attribute for badge meaning (Radix Tooltip only, per the issue’s Guardrails)', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_ONE_ALIAS_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      const badges = badgeElements(container);
      expect(badges.length).toBe(2); // sanity: the loop below isn't vacuous
      for (const badge of badges) {
        expect(badge).not.toHaveAttribute('title');
      }
    });

    it('the Radix Tooltip actually surfaces the badge text on focus (not just an aria-label fallback)', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_ONE_ALIAS_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      const defBadge = badgeElements(container).find((b) => b.dataset.foldBadge === 'definition');
      expect(defBadge).toBeTruthy();

      expect(document.body.textContent).not.toContain('referenced by 1 alias');
      fireEvent.focus(defBadge!);
      await waitFor(() =>
        expect(
          screen.getAllByText('Anchor &defaults — referenced by 1 alias').length,
        ).toBeGreaterThan(0),
      );
    });

    it('every badge is independently keyboard-reachable (Tab) and visible without hovering', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_ONE_ALIAS_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      const badges = badgeElements(container);
      expect(badges.length).toBe(2); // sanity: the loop below isn't vacuous
      for (const badge of badges) {
        expect(badge).toHaveAttribute('tabIndex', '0');
        expect(badge).toBeVisible();
      }
    });

    it('badges inside a collapsed region are absent while collapsed and return on expand; an alias badge outside the region keeps working the whole time', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_INSIDE_FOLD_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });

      // Both badges present before any fold.
      expect(badgeElements(container)).toHaveLength(2);
      const aliasBefore = badgeElements(container).find((b) => b.dataset.foldBadge === 'alias')!;
      expect(aliasBefore.getAttribute('aria-label')).toBe('Alias of &defaults, defined on line 2');

      // Collapse "config"'s value, which contains the anchor DEFINITION.
      fireEvent.click(
        screen.getByRole('button', { name: 'Collapse object starting on line 2, 1 item' }),
      );

      const whileCollapsed = badgeElements(container);
      expect(whileCollapsed).toHaveLength(1); // only the alias badge remains
      expect(whileCollapsed[0].dataset.foldBadge).toBe('alias');
      // The alias's own tooltip is unaffected — it carries the definition's
      // line number, not a live DOM reference to the (now-hidden) definition.
      expect(whileCollapsed[0].getAttribute('aria-label')).toBe(
        'Alias of &defaults, defined on line 2',
      );

      // Re-expand: the definition badge reappears.
      fireEvent.click(screen.getByRole('button', { name: 'Expand object, 1 item' }));
      const afterExpand = badgeElements(container);
      expect(afterExpand).toHaveLength(2);
      expect(afterExpand.some((b) => b.dataset.foldBadge === 'definition')).toBe(true);
    });

    it('a YAML file with no anchors renders no badges and no extra DOM', async () => {
      readFile.mockResolvedValue(textOk()(SINGLE_DOC_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      expect(badgeElements(container)).toHaveLength(0);
    });

    it('badges do not corrupt the underlying source text — the round trip still holds once badge chrome is stripped', async () => {
      readFile.mockResolvedValue(textOk()(ANCHOR_TWO_ALIASES_YAML));
      const { container } = await renderReady({ filePath: 'data.yaml', format: 'yaml' });
      expect(badgeElements(container).length).toBeGreaterThan(0); // sanity: badges really are present
      expect(codeLines(container).join('\n')).toBe(ANCHOR_TWO_ALIASES_YAML);
    });
  });

  describe('badge/gutter alignment invariant (wrap off and on)', () => {
    it('a row with an anchor/alias badge keeps the gutter and fold-toggle columns aligned in both wrap modes', async () => {
      const content = [
        'short: &short 1',
        'long: "a noticeably longer value than the short one above it, for width contrast"',
        'use: *short',
      ].join('\n');
      readFile.mockResolvedValue(textOk()(content));
      const { container, rerender } = await renderReady({
        filePath: 'data.yaml',
        format: 'yaml',
        wrap: false,
      });
      expect(badgeElements(container).length).toBeGreaterThan(0);

      function assertContract(wrapExpected: boolean): void {
        const gutters = gutterButtons(container);
        expect(gutters).toHaveLength(3);
        for (const gutter of gutters) {
          expect(gutter.className).toContain('shrink-0');
          const row = gutter.parentElement as HTMLElement;
          const toggle = row.children[1] as HTMLElement;
          const codeSpan = row.children[2] as HTMLElement;
          expect(toggle.className).toContain('shrink-0');
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
        // Gutter x-alignment: first and last gutter share the same
        // bounding-box x (mirrors the .5 alignment assertion).
        const xs = gutters.map((g) => g.getBoundingClientRect().x);
        expect(new Set(xs).size).toBe(1);
      }

      assertContract(false);
      rerender(foldingEl({ filePath: 'data.yaml', format: 'yaml', wrap: true }));
      assertContract(true);
    });
  });
});
