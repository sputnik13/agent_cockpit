// End-to-end verification of the full (content-type x mode) matrix introduced by
// the "uniform Diff/Rendered mode" epic (local_repo_explorer-content-mode-
// uniform-diff-rendered-sx0i, leaves .1-.6). Boots the REAL built app against a
// generated fixture (see fixture.mjs) in a fully isolated instance, drives the
// REAL UI (click a file, switch modes, toggle Wrap), and asserts on RENDERED
// EVIDENCE — real image pixels, real diff rows, real highlighted token spans,
// real placeholder text — never on component props. This is the epic's
// end-to-end gate; it is what would have caught the epic's original headline
// bug (`makeDataUrl` returning `null` so both image panes silently read
// "(unavailable)") that per-leaf unit tests around the same stub had missed.
//
// What it asserts, one PASS/FAIL line per named cell:
//   - markdown/JSON/source x Diff/Rendered/Raw: offered modes match exactly;
//     Diff shows real added/removed rows; Rendered and Raw are OBSERVABLY
//     DIFFERENT (JSON/source: Rendered emits Shiki token-color spans, Raw emits
//     none; markdown: Rendered emits real heading/list elements, Raw shows the
//     literal source text including markdown syntax characters).
//   - a MODIFIED image x Diff (BOTH panes real, as of local_repo_explorer-bn8a:
//     the working-tree "after" pane proves real pixels via naturalWidth > 0;
//     the "before" (baseline) pane ALSO proves real pixels via
//     naturalWidth > 0, fetched via a git-`ref` read — see the
//     BASELINE-SIDE DECISION note below — never the old catch-all
//     "(unavailable)" and never the retired "Baseline preview unavailable"
//     placeholder) and x Rendered (naturalWidth > 0).
//   - an ADDED-only image (untracked, no baseline) x Diff: the "before" pane
//     resolves to the 'absent' state (a git-ref read for a path that was
//     never committed fails, mapped to reason: 'missing' — not a fabricated
//     image), the "after" pane shows a real image; x Rendered, same "after"
//     shape.
//   - a generic (non-image) binary x Diff/Rendered: the graceful placeholder
//     renders (never blank), names Download, and Raw is NOT offered once the
//     runtime confirms the file is binary (negative assertion).
//   - a gutter-alignment regression check (CLAUDE.md "Content-panel code
//     views: line-number gutters stay aligned; wrap is a toggle"): a
//     short line's and an overflowing line's line-number gutter share the same
//     bounding-box x/width, in Rendered and Raw, with Wrap off and on, and
//     survive switching modes back and forth.
//   - an uncaught-renderer-error gate for the whole run (`win.on('pageerror')`)
//     — this is what catches a blank/crashed panel that a text assertion alone
//     could miss.
//   - (local_repo_explorer-jp2f.8) JSON/YAML structural folding, in the REAL
//     launched app: the folding view's dispatch + full byte-exact round trip;
//     collapsing/expanding a fold by mouse AND by keyboard (focus+Enter),
//     with correctly-counted placeholder chips and gutter line numbers that
//     stay ORIGINAL (non-renumbered) and non-contiguous while folded; a
//     single-line container is confirmed NOT foldable; gutter alignment
//     holds in the folded state under both Wrap off and Wrap on; a
//     three-document YAML stream renders three labelled document groups
//     with two separators and continuous, file-global line numbers; a YAML
//     anchor/alias fixture renders three badges whose accessible text names
//     the anchor and alias count; and, with `structuredFoldMaxMb` lowered to
//     its PINNED minimum: (local_repo_explorer-ftbq) a JSON file sized inside
//     the raised read-cap band actually DEGRADES to the plain highlighted
//     line view (no fold toggles, fixture content visible, no too-large
//     placeholder) — the real, now-reachable contract, replacing the earlier
//     "DISCOVERED GAP" workaround this block used to test (an unrelated
//     256 KiB read cap used to intercept every oversized file first, making
//     the documented degrade unreachable; see local_repo_explorer-ftbq) —
//     while a JSON file sized ABOVE that raised cap still refuses and shows
//     the too-large placeholder, and a small JSON file in the same session
//     keeps folding normally (the setting is restored afterward).
//
// BASELINE-SIDE DECISION (read before changing any image assertion; HISTORY —
// do not re-litigate either decision): `.1` shipped `readFileBytes` with NO
// git-`ref` support in v1, so `.4` made the image diff's "before (baseline)"
// pane an explicit, hardcoded 'no-baseline-preview' state (ImageCompare.tsx) —
// it never attempted a byte read, regardless of whether the file was modified
// or newly added. `local_repo_explorer-bn8a` LIFTED that constraint:
// `readFileBytes` now supports `ref` on both transports (local:
// `simpleGit.binaryCatFile`; remote: the helper's dedicated `readFileBytes`
// RPC), so the "before" pane shares `useImageBytes`/`ImagePaneBody` with the
// "after" pane exactly, passing `{ ref: baseline }` — this script now asserts
// REAL baseline pixels for a MODIFIED image (matching the epic issue's
// original "both panes show real pixels" intent) and the shared 'absent'
// state for an ADDED-only image's baseline pane (never a fabricated image).
// The 'no-baseline-preview' state no longer exists in the app at all.
//
// Run (build first — this drives the real packaged renderer, not a dev server):
//   npm run build && node scripts/screenshots/verify-content-modes.mjs
// or:
//   npm run verify:content-modes
//
// Isolation (docs/BUILD.md "Running an isolated instance"): a fresh
// `--user-data-dir` (mkdtemp) and a dedicated `--tmux-socket`, unique to this
// script, so the run never touches a normally-running app; the tmux server is
// killed on both the success and the error path.
//
// REMOTE PASS (opt-in, explicitly reported, never silently skipped). The local
// pass above is mandatory and alone gates this script's exit status. Set ALL of:
//   AC_VERIFY_REMOTE_HOST   remote hostname (or an alias resolvable via ~/.ssh/config)
//   AC_VERIFY_REMOTE_USER   SSH user
//   AC_VERIFY_REMOTE_PATH   absolute path to the fixture corpus ON THAT HOST
//   AC_VERIFY_REMOTE_PORT   optional, defaults to 22
// PRECONDITION: the fixture corpus must already exist at AC_VERIFY_REMOTE_PATH,
// laid out exactly like this script's local `generateFixture()` (same relative
// paths/content) — clone or rsync it there yourself; this script builds no
// remote provisioning. Key auth and a matching `known_hosts` entry are required
// (Ssh2Transport verifies host keys). When the env vars are unset, this script
// prints a loud, explicit SKIP line (never a silent omission) and the remote
// pass's PASS/FAIL lines (if it runs) are reported but do NOT affect exit status.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  generateFixture,
  FIXTURE_DIR,
  CONTENT_MODE_FIXTURES,
  FOLD_FIXTURE_TEXT,
  OVERSIZED_JSON_THRESHOLD_MB,
} from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const TMUX_SOCKET = 'agent-cockpit-verify-content-modes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Settle times: generous but not excessive — this drives a real Electron
// renderer (real IPC round trips, real async Shiki tokenization via a Web
// Worker on first use), not a mocked test environment.
const SETTLE_OPEN = 1200;
const SETTLE_MODE = 900;
const SETTLE_CONFIRM = 1500; // after a click that can trigger RawFile's binary confirmation
const SETTLE_WRAP = 500;

function killSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* none */
  }
}

// --- selector helpers --------------------------------------------------------
//
// SELECTOR TRAP (see the issue's Guardrails): Dockview PANEL tabs are `.dv-tab`
// with NO ARIA role -> use `locator('.dv-tab', { hasText })`. The Content
// panel's ModeSwitcher IS a real `role="tablist"`/`role="tab"` with
// `aria-selected` (src/renderer/content/modeSwitcher.tsx) -> `[role="tab"]` is
// correct THERE, scoped by `aria-label="Content mode"` since it is the only
// tablist with that label anywhere in the app.

async function activateDvTab(win, label) {
  await win.locator('.dv-tab', { hasText: label }).first().click();
  await sleep(600);
}

async function openFromChanges(win, fileName) {
  await activateDvTab(win, 'Changes');
  await win.getByText(fileName, { exact: false }).first().click();
  await sleep(SETTLE_OPEN);
}

async function openFromExplorer(win, fileName) {
  await activateDvTab(win, 'Explorer');
  await win.getByText(fileName, { exact: true }).first().click();
  await sleep(SETTLE_OPEN);
}

/**
 * Scopes queries to the ONE Content-panel instance currently showing `path` —
 * necessary because the Changes panel's own row list ALSO contains the file's
 * path as plain text, so an unscoped `getByText` search can silently match the
 * wrong panel (verified empirically while building this script: e.g. a bead's
 * body text in the Workgraph panel that happens to mention "searchNotes"
 * without this scoping). Anchored on the PanelHeader title span
 * (`ContentViewer`'s `<PanelHeader title={path}>`, class
 * "truncate font-semibold text-fg" — distinct from a Changes/Explorer row's
 * plain "truncate" span), then walks up to its Dockview `.dv-content-container`
 * ancestor, which is unique per rendered panel.
 */
function contentPanelRoot(win, path) {
  return win
    .locator('span.truncate.font-semibold.text-fg', { hasText: path })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " dv-content-container ")]',
    )
    .first();
}

const modeTabsList = (win) =>
  win.locator('[role="tablist"][aria-label="Content mode"] [role="tab"]');
const modeTab = (win, label) => modeTabsList(win).filter({ hasText: label });

async function availableModes(win) {
  return modeTabsList(win).allTextContents();
}

async function selectMode(win, label, settle = SETTLE_MODE) {
  await modeTab(win, label).click();
  await sleep(settle);
}

async function activeModeLabel(win) {
  // NOTE: `aria-selected` lives on the `[role="tab"]` element itself, not a
  // descendant — this must be ONE combined selector (not `modeTabsList(win)
  // .locator('[aria-selected="true"]')`, which searches for a CHILD matching
  // that attribute and never resolves, since the tab button has no children).
  return win
    .locator('[role="tablist"][aria-label="Content mode"] [role="tab"][aria-selected="true"]')
    .textContent();
}

async function diffRowCounts(scope) {
  const add = await scope.locator('[style*="127, 201, 122"]').count();
  const del = await scope.locator('[style*="255, 122, 122"]').count();
  return { add, del };
}

/** Shiki per-token color spans (`CodeLineTokens`) — present only when Rendered
 *  highlighting actually tokenized; RawText's Raw path never emits them (see
 *  RawFile.tsx's doc comment). Returns the count and the number of DISTINCT
 *  colors seen (a stronger signal than a bare count: real syntax highlighting
 *  uses more than one color). */
async function tokenSpanInfo(scope) {
  const spans = scope.locator('span[style*="color:"]');
  const count = await spans.count();
  if (count === 0) return { count, distinctColors: 0 };
  const colors = await spans.evaluateAll((els) => [...new Set(els.map((e) => e.style.color))]);
  return { count, distinctColors: colors.length };
}

async function imgNaturalWidth(locator) {
  if ((await locator.count()) === 0) return null;
  return locator.first().evaluate((el) => el.naturalWidth);
}

/** Bounding box of the line-number gutter button for 1-based `lineNo`, scrolled
 *  into view first (line-number gutters can be off-screen for a longer file,
 *  and an unmeasured/unlaid-out element yields a meaningless box). */
async function gutterBox(scope, lineNo) {
  const gutter = scope.locator(`button[title="Add a note on line ${lineNo}"]`);
  await gutter.scrollIntoViewIfNeeded();
  return gutter.boundingBox();
}

function closeEnough(a, b, eps = 1) {
  return a != null && b != null && Math.abs(a - b) <= eps;
}

// --- local_repo_explorer-jp2f.8 helpers (JSON/YAML structural folding) -----
//
// None of the helpers above fit: `tokenSpanInfo` counts Shiki color spans,
// not fold state; nothing else reads gutter line-NUMBERS (only `gutterBox`,
// which reads one gutter's bounding box by an exact line number) or a fold
// toggle's `aria-expanded` state. `attrOrNull`/`textOrNull`/`clickIfPresent`/
// `pressIfPresent` all guard on `.count()` first (mirroring `imgNaturalWidth`
// above) so an unexpected DOM shape — e.g. one of this file's own hand-
// derived aria-label strings turning out wrong — becomes a clean, reported
// FAIL instead of a script-aborting Playwright timeout that would silently
// drop every assertion after it (including the pre-existing ones).

/** Fold-toggle chevrons in `scope` — `button[aria-expanded]` is specific to
 *  FoldToggleCell (FoldingView.tsx); a folded row's OWN placeholder chip
 *  button carries no `aria-expanded` at all, so this never double-counts a
 *  folded region's two clickable affordances as one. */
const foldToggles = (scope) => scope.locator('button[aria-expanded]');

/** The rendered CODE portion of every currently-visible fold row, in DOM
 *  order — mirrors foldingView.test.tsx's `codeLines` helper exactly (the
 *  code span is the only element with an inline `padding-left` style;
 *  anchor/alias badges are stripped from a clone first so a round-trip text
 *  comparison sees only real source characters, never a badge's own glyph
 *  text). */
async function foldedCodeLines(scope) {
  return scope.locator('span[style*="padding-left"]').evaluateAll((els) =>
    els.map((el) => {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[data-fold-badge]').forEach((b) => b.remove());
      return clone.textContent ?? '';
    }),
  );
}

/** Every gutter's visible line-number text, in DOM order — mirrors
 *  foldingView.test.tsx's `gutterButtons(...).map(...)` (the number lives in
 *  the button's FIRST `<span>`; LineNoteGutter.tsx renders it before the
 *  hover "+" span). */
async function gutterLineNumbers(scope) {
  return scope
    .locator('button[title^="Add a note on line"]')
    .evaluateAll((buttons) => buttons.map((b) => b.querySelector('span')?.textContent ?? ''));
}

/** All original 1-based line numbers a fixture's content would render as
 *  ordinary gutter rows before any fold — INCLUDING the one extra empty
 *  trailing row a trailing `\n` produces (RawText/FoldingView both render
 *  `content.split('\n')`'s final empty element as its own line — the same
 *  phenomenon the gutter-alignment check above navigates for src/notes.ts's
 *  OVERFLOW_MARKER). Deriving this from the fixture's OWN text length,
 *  rather than a hand-counted literal, is what keeps a folded-state
 *  expectation correct without re-deriving it by hand. */
function allLineNumbers(text) {
  return Array.from({ length: text.split('\n').length }, (_, i) => String(i + 1));
}

/** `locator.getAttribute(name)`, but `null` (never throws) when zero
 *  elements match. */
async function attrOrNull(locator, name) {
  return (await locator.count()) === 0 ? null : locator.first().getAttribute(name);
}

/** `locator.textContent()`, but `null` (never throws) when zero elements
 *  match. */
async function textOrNull(locator) {
  return (await locator.count()) === 0 ? null : locator.first().textContent();
}

/** Clicks the first match of `locator` if present; returns whether it
 *  clicked (never throws when absent). */
async function clickIfPresent(locator) {
  if ((await locator.count()) !== 1) return false;
  await locator.click();
  return true;
}

/** Focuses then presses `key` on the first match of `locator` if present;
 *  returns whether it did (never throws when absent). */
async function pressIfPresent(locator, key) {
  if ((await locator.count()) !== 1) return false;
  await locator.focus();
  await locator.press(key);
  return true;
}

/** Settings-store round trip via the SAME `window.api` surface
 *  `addAndActivateProject` already uses — no Preferences-dialog UI needed
 *  for a headless harness (the issue's own Behavior list allows either). */
async function getSettings(win) {
  return win.evaluate(() => window.api.settings.get());
}
async function setSettings(win, patch) {
  return win.evaluate((p) => window.api.settings.set(p), patch);
}

/**
 * Clears the persisted "last-picked content mode" preference
 * (`AppSettings.contentMode`, the remembered-mode feature). Without this, a
 * block asserting a file's TRUE per-class default mode on first paint
 * (nothing clicked yet in THIS block) can instead observe a different,
 * also-valid mode carried over from whatever the PREVIOUS block's own last
 * click happened to leave behind — ContentViewer's mode seed deliberately
 * prefers the remembered mode over the per-class default whenever it is
 * valid for the new selection (settings.ts's own doc comment on
 * `contentMode`), which is by design, not a bug. Every block below that
 * checks an on-open default mode resets first, so it exercises
 * `defaultModeFor` in isolation. (This also fixes 3 pre-existing failures —
 * see this leaf's bead comment for detail.)
 */
async function resetContentModePreference(win) {
  await setSettings(win, { contentMode: null });
}

// --- the matrix ---------------------------------------------------------

/**
 * Drives the full content-type x mode matrix against WHATEVER project is
 * currently active in `win` (local or remote — this function is transport-
 * agnostic; it only interacts with the rendered UI). `record` is the
 * caller's PASS/FAIL sink so the local and remote passes can be tallied
 * (and gate exit status) independently.
 */
async function runMatrix(win, record) {
  const F = CONTENT_MODE_FIXTURES;

  // === markdown (README.md, modified) — via Changes ========================
  await openFromChanges(win, F.markdown);
  {
    const modes = await availableModes(win);
    record(
      'markdown: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.markdown);
    const { add, del } = await diffRowCounts(scopeDiff);
    record(
      'markdown: Diff shows real added AND removed rows',
      add > 0 && del > 0,
      `add=${add}, del=${del}`,
    );

    await selectMode(win, 'Rendered');
    const scopeRendered = contentPanelRoot(win, F.markdown);
    const headingCount = await scopeRendered.locator('.agent-cockpit-markdown h1').count();
    const rawSyntaxLeaked = await scopeRendered.getByText('# Demo Notes', { exact: false }).count();
    record(
      'markdown: Rendered shows a formatted heading element, not raw syntax',
      headingCount > 0 && rawSyntaxLeaked === 0,
      `h1 count=${headingCount}, literal "# Demo Notes" leaked=${rawSyntaxLeaked}`,
    );

    await selectMode(win, 'Raw');
    const scopeRaw = contentPanelRoot(win, F.markdown);
    const rawText = await scopeRaw.getByText('# Demo Notes', { exact: false }).count();
    const noHeadingInRaw = await scopeRaw.locator('.agent-cockpit-markdown h1').count();
    record(
      'markdown: Raw shows the source text including markdown syntax characters',
      rawText > 0 && noHeadingInRaw === 0,
      `literal "# Demo Notes" count=${rawText}, stray heading count=${noHeadingInRaw}`,
    );
  }

  // === JSON (package.json, modified) — via Changes =========================
  // local_repo_explorer-jp2f.2 gave JSON its own ContentClass with its own
  // VIEW_DISPATCH row: Diff/Raw still resolve to the SAME components as
  // before (DiffView/RawFile, when JSON was still classified as `'text'`),
  // but Rendered now resolves to FoldingView — a temporary pass-through that
  // still delegates to RawFile with highlighting on (see FoldingView.tsx and
  // modeSwitcher.tsx's VIEW_DISPATCH comment). So the three assertions below
  // stay truthful UNCHANGED: offered modes are the same three, and Rendered
  // still emits real Shiki token-color spans (now reached through
  // FoldingView's wrapper `<div data-testid="folding-view">`, which is just
  // an extra DOM ancestor — `contentPanelRoot`'s scope already covers it, so
  // the same `tokenSpanInfo` query still finds them).
  await openFromChanges(win, F.json);
  {
    const modes = await availableModes(win);
    record(
      'json: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.json);
    const { add, del } = await diffRowCounts(scopeDiff);
    record(
      'json: Diff shows real added AND removed rows',
      add > 0 && del > 0,
      `add=${add}, del=${del}`,
    );

    await selectMode(win, 'Rendered');
    const scopeRendered = contentPanelRoot(win, F.json);
    const rendered = await tokenSpanInfo(scopeRendered);
    record(
      "json: Rendered (now dispatched via FoldingView's temporary RawFile pass-through) emits Shiki token-color spans (highlighted)",
      rendered.count > 0 && rendered.distinctColors > 1,
      `token spans=${rendered.count}, distinct colors=${rendered.distinctColors}`,
    );

    await selectMode(win, 'Raw');
    const scopeRaw = contentPanelRoot(win, F.json);
    const raw = await tokenSpanInfo(scopeRaw);
    record(
      'json: Raw (still dispatched directly to RawFile, unchanged) emits zero token-color spans (plain)',
      raw.count === 0,
      `token spans=${raw.count}`,
    );
  }

  // === source (src/notes.ts, modified) — via Changes =======================
  await openFromChanges(win, F.source);
  {
    const modes = await availableModes(win);
    record(
      'source: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.source);
    const { add, del } = await diffRowCounts(scopeDiff);
    record(
      'source: Diff shows real added AND removed rows',
      add > 0 && del > 0,
      `add=${add}, del=${del}`,
    );

    await selectMode(win, 'Rendered');
    const scopeRendered = contentPanelRoot(win, F.source);
    const rendered = await tokenSpanInfo(scopeRendered);
    record(
      'source: Rendered emits Shiki token-color spans (highlighted)',
      rendered.count > 0 && rendered.distinctColors > 1,
      `token spans=${rendered.count}, distinct colors=${rendered.distinctColors}`,
    );

    await selectMode(win, 'Raw');
    const scopeRawFirst = contentPanelRoot(win, F.source);
    const rawFirst = await tokenSpanInfo(scopeRawFirst);
    record(
      'source: Raw emits zero token-color spans (plain)',
      rawFirst.count === 0,
      `token spans=${rawFirst.count}`,
    );

    // --- gutter-alignment regression check (reuses this same open file) ---
    // The fixture appends one deliberately overlong line as the LAST content
    // line of src/notes.ts. The file ends with a trailing newline, so
    // `content.split('\n')` (RawFile's line splitter) renders one extra,
    // empty trailing line after it — the overflow marker is therefore the
    // SECOND-TO-LAST rendered gutter, not the last. Located dynamically (by
    // counting rendered gutters) rather than a hardcoded line number, so this
    // check does not silently stop testing the right line if the fixture
    // prose above it ever changes length.
    await selectMode(win, 'Rendered');
    const scopeGutter = contentPanelRoot(win, F.source);
    const totalGutters = await scopeGutter.locator('button[title^="Add a note on line"]').count();
    const shortLine = 1;
    const longLine = totalGutters - 1;

    async function assertGutterAligned(label) {
      const scope = contentPanelRoot(win, F.source);
      const shortBox = await gutterBox(scope, shortLine);
      const longBox = await gutterBox(scope, longLine);
      record(
        `gutter (${label}): short-line and long-line gutters share the same left offset`,
        closeEnough(shortBox?.x, longBox?.x),
        `short.x=${shortBox?.x}, long.x=${longBox?.x}`,
      );
      record(
        `gutter (${label}): short-line and long-line gutters share the same width`,
        closeEnough(shortBox?.width, longBox?.width),
        `short.width=${shortBox?.width}, long.width=${longBox?.width}`,
      );
      return longBox;
    }

    const wrapBtn = win.getByRole('button', { name: 'Wrap' });

    const renderedOffBox = await assertGutterAligned('Rendered, Wrap off');
    await wrapBtn.click();
    await sleep(SETTLE_WRAP);
    const renderedOnBox = await assertGutterAligned('Rendered, Wrap on');
    record(
      'gutter: Wrap on actually wraps the overflowing line (row grows taller)',
      renderedOnBox != null &&
        renderedOffBox != null &&
        renderedOnBox.height > renderedOffBox.height,
      `off.height=${renderedOffBox?.height}, on.height=${renderedOnBox?.height}`,
    );

    await selectMode(win, 'Raw');
    await assertGutterAligned('Raw, Wrap on');
    await wrapBtn.click();
    await sleep(SETTLE_WRAP);
    await assertGutterAligned('Raw, Wrap off');

    // Switch modes back and forth once more — proves the alignment survives
    // repeated mode switching, not just a single transition.
    await selectMode(win, 'Rendered');
    await assertGutterAligned('back to Rendered, Wrap off (round trip)');
  }

  // === MODIFIED image (assets/photo.png, baseline + different bytes) ======
  await openFromChanges(win, F.imageModified);
  {
    const modes = await availableModes(win);
    record(
      'image (modified): offered modes are exactly Diff/Rendered (no Raw)',
      [...modes].sort().join(',') === ['Diff', 'Rendered'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.imageModified);
    // Before (baseline) pane: local_repo_explorer-bn8a gave this pane a real
    // git-ref byte source, sharing useImageBytes/ImagePaneBody with the after
    // pane exactly — it must now show real pixels too, never the retired
    // no-baseline-preview placeholder.
    const beforeNW = await imgNaturalWidth(scopeDiff.locator('img[alt="Before (baseline)"]'));
    record(
      'image (modified): Diff before-pane shows the REAL baseline image (naturalWidth > 0) — git-ref read (bn8a)',
      beforeNW != null && beforeNW > 0,
      `before naturalWidth=${beforeNW}`,
    );
    const noBaselineText = await scopeDiff
      .getByText('Baseline preview unavailable', { exact: false })
      .count();
    record(
      'image (modified): the retired "Baseline preview unavailable" placeholder never appears',
      noBaselineText === 0,
      `count=${noBaselineText}`,
    );
    const afterNW = await imgNaturalWidth(scopeDiff.locator('img[alt="After (working tree)"]'));
    record(
      'image (modified): Diff after-pane shows a real image (naturalWidth > 0)',
      afterNW != null && afterNW > 0,
      `after naturalWidth=${afterNW}`,
    );
    const unavailableLeak = await win.getByText('(unavailable)', { exact: false }).count();
    record(
      'image (modified): the literal "(unavailable)" never appears',
      unavailableLeak === 0,
      `count=${unavailableLeak}`,
    );

    await selectMode(win, 'Rendered');
    const scopeRendered = contentPanelRoot(win, F.imageModified);
    const renderedNW = await imgNaturalWidth(
      scopeRendered.locator(`img[alt="${F.imageModified}"]`),
    );
    record(
      'image (modified): Rendered shows the working-tree image (naturalWidth > 0)',
      renderedNW != null && renderedNW > 0,
      `naturalWidth=${renderedNW}`,
    );
  }

  // === ADDED-only image (assets/added.png, untracked, no baseline) ========
  await openFromChanges(win, F.imageAdded);
  {
    const modes = await availableModes(win);
    record(
      'image (added-only): offered modes are exactly Diff/Rendered (no Raw)',
      [...modes].sort().join(',') === ['Diff', 'Rendered'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.imageAdded);
    // Before (baseline) pane: no baseline version exists (untracked/added), so
    // the git-ref read fails (reason: 'missing') and this pane resolves to the
    // SAME 'absent' state a deleted working-tree file already used — never a
    // fabricated image, and never the retired no-baseline-preview placeholder.
    const beforeImgCount = await scopeDiff.locator('img[alt="Before (baseline)"]').count();
    const absentText = await scopeDiff
      .getByText('Not present in the working tree.', { exact: false })
      .count();
    record(
      'image (added-only): Diff before-pane resolves to absent (no fabricated image; git-ref read fails for a never-committed path)',
      beforeImgCount === 0 && absentText > 0,
      `before <img> count=${beforeImgCount}, "Not present in the working tree." count=${absentText}`,
    );
    const noBaselineText = await scopeDiff
      .getByText('Baseline preview unavailable', { exact: false })
      .count();
    record(
      'image (added-only): the retired "Baseline preview unavailable" placeholder never appears',
      noBaselineText === 0,
      `count=${noBaselineText}`,
    );
    const afterNW = await imgNaturalWidth(scopeDiff.locator('img[alt="After (working tree)"]'));
    record(
      'image (added-only): Diff after-pane shows a real image (naturalWidth > 0)',
      afterNW != null && afterNW > 0,
      `after naturalWidth=${afterNW}`,
    );

    await selectMode(win, 'Rendered');
    const scopeRendered = contentPanelRoot(win, F.imageAdded);
    const renderedNW = await imgNaturalWidth(scopeRendered.locator(`img[alt="${F.imageAdded}"]`));
    record(
      'image (added-only): Rendered shows the working-tree image (naturalWidth > 0)',
      renderedNW != null && renderedNW > 0,
      `naturalWidth=${renderedNW}`,
    );
  }

  // === generic binary (assets/archive.bin, baseline + modified) ===========
  // Reset first: this block's very first assertion (below) depends on the
  // TRUE per-class default mode on first paint, which the remembered-mode
  // feature (contentMode) would otherwise override with whatever the
  // PREVIOUS block's last click left behind — see
  // resetContentModePreference's doc comment.
  await resetContentModePreference(win);
  await openFromChanges(win, F.genericBinary);
  {
    // Default mode for a Changes-panel ('change') selection is Diff, and git's
    // own "Binary files ... differ" signal (parsePatch.ts) is already present
    // for a genuinely-modified binary file — so the graceful placeholder must
    // render on FIRST PAINT, before any mode click and before RawFile has ever
    // mounted (i.e. before the runtime binary-confirmation/reclassification
    // this same cell also exercises below has had a chance to fire).
    const scopeInitial = contentPanelRoot(win, F.genericBinary);
    const initialTitle = await scopeInitial
      .getByText("can't be compared line-by-line", { exact: false })
      .count();
    record(
      'generic-binary: Diff shows the graceful placeholder on first paint (not blank)',
      initialTitle > 0,
      `title match count=${initialTitle}`,
    );
    const initialChanged = await scopeInitial
      .getByText('changed between the baseline', { exact: false })
      .count();
    const initialDownload = await scopeInitial
      .getByText('choose Download', { exact: false })
      .count();
    record(
      'generic-binary: Diff placeholder states the file changed AND mentions Download',
      initialChanged > 0 && initialDownload > 0,
      `changed-text=${initialChanged}, download-text=${initialDownload}`,
    );

    // Visiting Rendered mounts RawFile, whose OWN read confirms binary-ness at
    // runtime and reclassifies this file to generic-binary in ContentViewer
    // (modeSwitcher.tsx's module doc comment) — this is what drops Raw below.
    await selectMode(win, 'Rendered', SETTLE_CONFIRM);
    const scopeRendered = contentPanelRoot(win, F.genericBinary);
    const renderedTitle = await scopeRendered
      .getByText('No preview available for this file type', { exact: false })
      .count();
    const renderedDownload = await scopeRendered
      .getByText('choose Download', { exact: false })
      .count();
    record(
      'generic-binary: Rendered shows the graceful placeholder (not blank) and mentions Download',
      renderedTitle > 0 && renderedDownload > 0,
      `title match=${renderedTitle}, download-text=${renderedDownload}`,
    );

    const modesAfterConfirm = await availableModes(win);
    record(
      'generic-binary: Raw is NOT offered once the runtime confirms the file is binary (negative)',
      [...modesAfterConfirm].sort().join(',') === ['Diff', 'Rendered'].sort().join(','),
      `modes=[${modesAfterConfirm.join(', ')}]`,
    );

    // Revisit Diff post-reclassification — proves no regression.
    await selectMode(win, 'Diff');
    const scopeDiffAgain = contentPanelRoot(win, F.genericBinary);
    const diffAgainTitle = await scopeDiffAgain
      .getByText("can't be compared line-by-line", { exact: false })
      .count();
    record(
      'generic-binary: Diff still shows the graceful placeholder after reclassification (no regression)',
      diffAgainTitle > 0,
      `title match count=${diffAgainTitle}`,
    );
  }

  // === Explorer: an unchanged file (LICENSE, committed once, never modified) ==
  // Fulfils the "opening files from ... the Explorer (unchanged files)" half of
  // the matrix's stated interaction style. Not itself one of the named binary/
  // image/text matrix cells above — a read-only, no-diff sanity check on the
  // Explorer file-open path (baseline='HEAD', kind='file' — see
  // ExplorerPanel.tsx) alongside everything else being opened via Changes.
  // Reset first — same reason as the generic-binary block above: this
  // block's own "defaults to Raw" assertion needs a clean (no
  // remembered-mode) slate rather than whatever the previous block's last
  // click left behind.
  await resetContentModePreference(win);
  await openFromExplorer(win, F.unchangedExplorerFile);
  {
    const modes = await availableModes(win);
    record(
      'explorer (unchanged file): offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );
    const active = await activeModeLabel(win);
    const scopeRaw = contentPanelRoot(win, F.unchangedExplorerFile);
    const textVisible = await scopeRaw.getByText('MIT License', { exact: false }).count();
    record(
      'explorer (unchanged file): defaults to Raw and shows real content',
      active === 'Raw' && textVisible > 0,
      `active mode=${active}, "MIT License" visible=${textVisible}`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.unchangedExplorerFile);
    const emptyHint = await scopeDiff
      .getByText('No textual diff for this file.', { exact: false })
      .count();
    record(
      'explorer (unchanged file): Diff shows the honest empty-diff message for a genuinely unchanged file',
      emptyHint > 0,
      `count=${emptyHint}`,
    );
  }

  // === jsonFold (fold-demo.json, committed then modified) — via Changes ===
  // local_repo_explorer-jp2f.8: proves the REAL folding renderer (.5/.6) in
  // the launched app — fold/unfold, keyboard operability, original
  // (non-renumbered) line numbers, single-line-container exclusion, and
  // folded-state gutter alignment in both wrap modes. Exact line numbers/
  // aria-labels below are verified against the REAL fold-model algorithm
  // (jsonFold.ts/foldingRows.ts run standalone against this exact fixture
  // text while developing this script), not hand-guessed.
  await resetContentModePreference(win);
  await openFromChanges(win, F.jsonFold);
  {
    const modes = await availableModes(win);
    record(
      'jsonFold: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );
    const activeOnOpen = await activeModeLabel(win);
    record(
      'jsonFold: defaults to Diff from a Changes row (same per-class default as text)',
      activeOnOpen === 'Diff',
      `active mode=${activeOnOpen}`,
    );

    await selectMode(win, 'Diff');
    const scopeDiff = contentPanelRoot(win, F.jsonFold);
    const { add, del } = await diffRowCounts(scopeDiff);
    record(
      'jsonFold: Diff shows real added AND removed rows',
      add > 0 && del > 0,
      `add=${add}, del=${del}`,
    );

    await selectMode(win, 'Rendered');
    const fixtureText = FOLD_FIXTURE_TEXT.jsonFold;
    const scopeRendered = contentPanelRoot(win, F.jsonFold);

    const foldingViewCount = await scopeRendered
      .locator('[data-testid="folding-view"][data-format="json"]')
      .count();
    record(
      'jsonFold: Rendered dispatches to the real FoldingView (data-testid + data-format="json")',
      foldingViewCount === 1,
      `count=${foldingViewCount}`,
    );

    const toggles = foldToggles(scopeRendered);
    const toggleCount = await toggles.count();
    const allExpanded =
      toggleCount > 0 &&
      (await toggles.evaluateAll((els) =>
        els.every((el) => el.getAttribute('aria-expanded') === 'true'),
      ));
    record(
      'jsonFold: 6 multi-line containers are foldable, all expanded by default (aria-expanded="true")',
      toggleCount === 6 && allExpanded,
      `toggle count=${toggleCount}, all expanded=${allExpanded}`,
    );

    const singleLinePoint = await scopeRendered
      .getByRole('button', { name: /starting on line 3,/ })
      .count();
    const singleLineItems = await scopeRendered
      .getByRole('button', { name: /starting on line 9,/ })
      .count();
    record(
      'jsonFold: single-line containers ("point" on line 3, "items" on line 9) are NOT foldable (jsonFold.ts exclusion rule)',
      singleLinePoint === 0 && singleLineItems === 0,
      `line3 toggle count=${singleLinePoint}, line9 toggle count=${singleLineItems}`,
    );

    const deepToggleCount = await scopeRendered
      .getByRole('button', { name: 'Collapse object starting on line 7, 2 items' })
      .count();
    record(
      'jsonFold: the deeply nested region (config > level1 > level2 > level3, line 7, depth 4) is independently foldable',
      deepToggleCount === 1,
      `count=${deepToggleCount}`,
    );

    const fullText = (await foldedCodeLines(scopeRendered)).join('\n');
    record(
      'jsonFold: fully expanded, the rendered text equals the fixture source exactly (byte-exact round trip)',
      fullText === fixtureText,
      `rendered length=${fullText.length}, fixture length=${fixtureText.length}`,
    );

    // --- collapse "config" (header line 4, closes line 13, 1 item) --------
    const configExpandedToggle = scopeRendered.getByRole('button', {
      name: 'Collapse object starting on line 4, 1 item',
    });
    const configClicked = await clickIfPresent(configExpandedToggle);
    await sleep(SETTLE_MODE);
    const configCollapsedToggle = scopeRendered.getByRole('button', {
      name: 'Expand object starting on line 4, 1 item',
    });
    record(
      'jsonFold: clicking the toggle flips aria-expanded to "false"',
      configClicked && (await attrOrNull(configCollapsedToggle, 'aria-expanded')) === 'false',
      `clicked=${configClicked}`,
    );
    const configChip = scopeRendered.getByRole('button', { name: 'Expand object, 1 item' });
    const configChipText = await textOrNull(configChip);
    record(
      'jsonFold: collapsing shows a placeholder chip with the correct item count',
      (await configChip.count()) === 1 && (configChipText ?? '').includes('{…} 1 item'),
      `chip text=${configChipText}`,
    );

    const expectedFolded = allLineNumbers(fixtureText).filter((n) => {
      const line = Number(n);
      return line <= 4 || line > 13; // config: header line 4, closing line 13
    });
    const actualFolded = await gutterLineNumbers(scopeRendered);
    record(
      'jsonFold: collapsed gutter line numbers are non-contiguous but ORIGINAL (jump from 4 straight to 14, never renumbered)',
      actualFolded.join(',') === expectedFolded.join(','),
      `expected=[${expectedFolded.join(',')}], actual=[${actualFolded.join(',')}]`,
    );

    // --- folded-state gutter alignment, Wrap off AND on ---------------------
    async function assertFoldedAlignment(label) {
      const scope = contentPanelRoot(win, F.jsonFold);
      const shortBox = await gutterBox(scope, 1);
      const longBox = await gutterBox(scope, 19); // the "note" line — still visible, unaffected by the fold
      record(
        `jsonFold gutter (${label}): short-line and long-line gutters share the same left offset while folded`,
        closeEnough(shortBox?.x, longBox?.x),
        `short.x=${shortBox?.x}, long.x=${longBox?.x}`,
      );
      record(
        `jsonFold gutter (${label}): short-line and long-line gutters share the same width while folded`,
        closeEnough(shortBox?.width, longBox?.width),
        `short.width=${shortBox?.width}, long.width=${longBox?.width}`,
      );
    }
    const wrapBtn = win.getByRole('button', { name: 'Wrap' });
    await assertFoldedAlignment('Wrap off');
    await wrapBtn.click();
    await sleep(SETTLE_WRAP);
    await assertFoldedAlignment('Wrap on');
    await wrapBtn.click(); // restore Wrap off, matching every other block's end state
    await sleep(SETTLE_WRAP);

    // --- re-expand: restores the exact original text ------------------------
    const reexpandClicked = await clickIfPresent(configCollapsedToggle);
    await sleep(SETTLE_MODE);
    const configReexpandedToggle = scopeRendered.getByRole('button', {
      name: 'Collapse object starting on line 4, 1 item',
    });
    const restoredText = (await foldedCodeLines(scopeRendered)).join('\n');
    record(
      'jsonFold: clicking the toggle again flips aria-expanded back to "true" and restores the exact original text',
      reexpandClicked &&
        (await attrOrNull(configReexpandedToggle, 'aria-expanded')) === 'true' &&
        restoredText === fixtureText,
      `clicked=${reexpandClicked}, text restored=${restoredText === fixtureText}`,
    );

    // --- keyboard toggle (focus + Enter) on a different region ("list") ----
    const listExpandedToggle = scopeRendered.getByRole('button', {
      name: 'Collapse array starting on line 14, 3 items',
    });
    const kbCollapseOk = await pressIfPresent(listExpandedToggle, 'Enter');
    await sleep(SETTLE_MODE);
    const listCollapsedToggle = scopeRendered.getByRole('button', {
      name: 'Expand array starting on line 14, 3 items',
    });
    const listChip = scopeRendered.getByRole('button', { name: 'Expand array, 3 items' });
    record(
      'jsonFold: keyboard (focus + Enter) collapses the toggle and shows its chip',
      kbCollapseOk &&
        (await attrOrNull(listCollapsedToggle, 'aria-expanded')) === 'false' &&
        (await listChip.count()) === 1,
      `pressed=${kbCollapseOk}`,
    );

    const kbExpandOk = await pressIfPresent(listCollapsedToggle, 'Enter');
    await sleep(SETTLE_MODE);
    const listReexpandedToggle = scopeRendered.getByRole('button', {
      name: 'Collapse array starting on line 14, 3 items',
    });
    const finalText = (await foldedCodeLines(scopeRendered)).join('\n');
    record(
      'jsonFold: keyboard (focus + Enter) expands it again, restoring the exact original text',
      kbExpandOk &&
        (await attrOrNull(listReexpandedToggle, 'aria-expanded')) === 'true' &&
        finalText === fixtureText,
      `pressed=${kbExpandOk}, text restored=${finalText === fixtureText}`,
    );

    // --- Raw: unaffected by folding, same as every other class --------------
    await selectMode(win, 'Raw');
    const scopeRaw = contentPanelRoot(win, F.jsonFold);
    const rawTokens = await tokenSpanInfo(scopeRaw);
    const rawToggleCount = await foldToggles(scopeRaw).count();
    record(
      'jsonFold: Raw emits zero token-color spans and no fold toggles',
      rawTokens.count === 0 && rawToggleCount === 0,
      `token spans=${rawTokens.count}, fold toggles=${rawToggleCount}`,
    );
  }

  // === jsonFold — via Explorer (default-mode parity check) ================
  await resetContentModePreference(win);
  await openFromExplorer(win, F.jsonFold);
  {
    const modes = await availableModes(win);
    const active = await activeModeLabel(win);
    record(
      'jsonFold (Explorer): offered modes are exactly Diff/Rendered/Raw, defaults to Raw (same per-class default as text)',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(',') &&
        active === 'Raw',
      `modes=[${modes.join(', ')}], active=${active}`,
    );
  }

  // === yamlMultiDoc (multi-doc.yaml, added/untracked) — via Changes =======
  await resetContentModePreference(win);
  await openFromChanges(win, F.yamlMultiDoc);
  {
    const modes = await availableModes(win);
    record(
      'yamlMultiDoc: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );
    const activeOnOpen = await activeModeLabel(win);
    record(
      'yamlMultiDoc: defaults to Diff from a Changes row (same per-class default as text)',
      activeOnOpen === 'Diff',
      `active mode=${activeOnOpen}`,
    );

    await selectMode(win, 'Rendered');
    const fixtureText = FOLD_FIXTURE_TEXT.yamlMultiDoc;
    const scope = contentPanelRoot(win, F.yamlMultiDoc);

    const foldingViewCount = await scope
      .locator('[data-testid="folding-view"][data-format="yaml"]')
      .count();
    record(
      'yamlMultiDoc: Rendered dispatches to the real FoldingView (data-testid + data-format="yaml")',
      foldingViewCount === 1,
      `count=${foldingViewCount}`,
    );

    const regionLabels = await scope
      .locator('[role="region"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    record(
      'yamlMultiDoc: renders three document groups with correct per-document accessible labels',
      regionLabels.join('|') ===
        ['Document 1 of 3', 'Document 2 of 3', 'Document 3 of 3'].join('|'),
      `labels=[${regionLabels.join(', ')}]`,
    );

    const separatorCount = await scope.locator('[data-fold-separator]').count();
    record(
      'yamlMultiDoc: exactly two separator bands between the three documents',
      separatorCount === 2,
      `count=${separatorCount}`,
    );

    const expectedLines = allLineNumbers(fixtureText);
    const actualLines = await gutterLineNumbers(scope);
    record(
      'yamlMultiDoc: line numbers are continuous and file-global (document 2 does not restart at line 1)',
      actualLines.join(',') === expectedLines.join(','),
      `expected=[${expectedLines.join(',')}], actual=[${actualLines.join(',')}]`,
    );

    const fullText = (await foldedCodeLines(scope)).join('\n');
    record(
      'yamlMultiDoc: fully expanded, the rendered text equals the fixture source exactly (separators are chrome, not text)',
      fullText === fixtureText,
      `rendered length=${fullText.length}, fixture length=${fixtureText.length}`,
    );

    const tokens = await tokenSpanInfo(scope);
    record(
      'yamlMultiDoc: Rendered emits Shiki token-color spans (YAML grammar registered)',
      tokens.count > 0 && tokens.distinctColors > 1,
      `token spans=${tokens.count}, distinct colors=${tokens.distinctColors}`,
    );
  }

  // === yamlAnchors (anchors.yaml, added/untracked) — via Changes ==========
  await resetContentModePreference(win);
  await openFromChanges(win, F.yamlAnchors);
  {
    const modes = await availableModes(win);
    record(
      'yamlAnchors: offered modes are exactly Diff/Rendered/Raw',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(','),
      `modes=[${modes.join(', ')}]`,
    );

    await selectMode(win, 'Rendered');
    const fixtureText = FOLD_FIXTURE_TEXT.yamlAnchors;
    const scope = contentPanelRoot(win, F.yamlAnchors);

    const badgeCount = await scope.locator('[data-fold-badge]').count();
    record(
      'yamlAnchors: renders three badges (one definition + two aliases)',
      badgeCount === 3,
      `count=${badgeCount}`,
    );

    const defBadge = scope.locator('[data-fold-badge="definition"]');
    const defLabel = await attrOrNull(defBadge, 'aria-label');
    record(
      "yamlAnchors: the definition badge's accessible/tooltip text names the anchor and the alias count",
      defLabel === 'Anchor &defaults — referenced by 2 aliases',
      `aria-label=${defLabel}`,
    );

    const aliasLabels = await scope
      .locator('[data-fold-badge="alias"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    record(
      "yamlAnchors: both alias badges' accessible text name the anchor and its definition line",
      aliasLabels.length === 2 &&
        aliasLabels.every((l) => l === 'Alias of &defaults, defined on line 1'),
      `aria-labels=[${aliasLabels.join(', ')}]`,
    );

    const beforeFocus = await win
      .getByText('Anchor &defaults — referenced by 2 aliases', { exact: false })
      .count();
    if ((await defBadge.count()) > 0) await defBadge.first().focus();
    await sleep(SETTLE_WRAP);
    const afterFocus = await win
      .getByText('Anchor &defaults — referenced by 2 aliases', { exact: false })
      .count();
    record(
      "yamlAnchors: the definition badge's Radix tooltip actually surfaces its text on focus (not just an aria-label fallback)",
      beforeFocus === 0 && afterFocus > 0,
      `before=${beforeFocus}, after=${afterFocus}`,
    );

    const fullText = (await foldedCodeLines(scope)).join('\n');
    record(
      'yamlAnchors: badges do not corrupt the underlying source text — the round trip still holds once badge chrome is stripped',
      fullText === fixtureText,
      `rendered length=${fullText.length}, fixture length=${fixtureText.length}`,
    );
  }

  // === yamlAnchors — via Explorer (default-mode parity check) =============
  await resetContentModePreference(win);
  await openFromExplorer(win, F.yamlAnchors);
  {
    const modes = await availableModes(win);
    const active = await activeModeLabel(win);
    record(
      'yamlAnchors (Explorer): offered modes are exactly Diff/Rendered/Raw, defaults to Raw (same per-class default as text)',
      [...modes].sort().join(',') === ['Diff', 'Rendered', 'Raw'].sort().join(',') &&
        active === 'Raw',
      `modes=[${modes.join(', ')}], active=${active}`,
    );
  }

  // === jsonOversized (oversized.json, committed once) — threshold degrade =
  // local_repo_explorer-jp2f.8: structuredFoldMaxMb set to its PINNED
  // minimum for this one check only, inside try/finally so the setting is
  // restored even if an assertion-supporting call throws — no later block
  // (nor the remote phase's own run of this SAME runMatrix, since settings
  // persist in the main process across a renderer reload) depends on the
  // mutated value.
  //
  // FIXED (local_repo_explorer-ftbq): the underlying text-read cap
  // (electron/main/git/files.ts's DEFAULT_MAX_BYTES, 256 KiB) used to
  // intercept every file large enough to exceed structuredFoldMaxMb's 1 MB
  // minimum, so `oversizedStructured` (ContentViewer.tsx) could never
  // observe a SUCCESSFUL over-threshold text read and the documented "plain
  // highlighted view" degrade was UNREACHABLE for any legal setting value —
  // see git history for the earlier "DISCOVERED GAP" version of this
  // comment/assertion, verified interactively before this fix landed.
  // RawFile.tsx and FoldingView.tsx now pass a per-read `maxBytes` override
  // (`structuredFoldReadMaxBytes` in src/shared/settings.ts, 2x the
  // threshold) for json/yaml paths only, so a file strictly between the
  // threshold (T) and the raised cap (R = 2T) reads successfully and
  // degrades for real. `oversized.json` (~1.3 MiB, built from
  // OVERSIZED_JSON_THRESHOLD_MB=1) falls inside that band at the pinned
  // minimum (T=1 MiB, R=2 MiB), so the block below asserts the REAL degrade:
  // the plain highlighted view (no fold toggles, folding-view not
  // dispatched), the fixture's OWN content actually visible, and no
  // too-large placeholder. `oversized-huge.json` (jsonWayOversized,
  // ~5.2 MiB, comfortably above R — see WAY_OVERSIZED_JSON_TARGET_MB's doc
  // comment in fixture.mjs) confirms the boundary's other side: a file
  // genuinely too large even for the raised cap still refuses — the too-large
  // placeholder renders and effectiveCls stays json/yaml (folding-view stays
  // dispatched, never degrading for a refused, non-'text' confirmation) —
  // structurally the SAME assertion shape the pre-fix block used for
  // oversized.json, now correctly scoped to only the truly-over-cap case.
  {
    const originalSettings = await getSettings(win);
    const originalMaxMb = originalSettings.structuredFoldMaxMb;
    try {
      await setSettings(win, { structuredFoldMaxMb: OVERSIZED_JSON_THRESHOLD_MB });

      await openFromExplorer(win, F.jsonOversized);
      await selectMode(win, 'Rendered', SETTLE_CONFIRM);
      const scopeOversized = contentPanelRoot(win, F.jsonOversized);
      const oversizedToggleCount = await foldToggles(scopeOversized).count();
      const oversizedFoldingViewCount = await scopeOversized
        .locator('[data-testid="folding-view"]')
        .count();
      const tooLargeVisible = await scopeOversized
        .getByText('too large to preview inline', { exact: false })
        .count();
      const markerVisible = await scopeOversized
        .getByText('oversized-fixture', { exact: false })
        .count();
      record(
        "jsonOversized: inside the raised read cap (T, R], the file DEGRADES to the plain highlighted view (local_repo_explorer-ftbq: the real, now-reachable degrade) — no fold toggles, folding-view not dispatched, the fixture's own content is visible, no too-large placeholder",
        oversizedToggleCount === 0 &&
          oversizedFoldingViewCount === 0 &&
          tooLargeVisible === 0 &&
          markerVisible > 0,
        `fold toggles=${oversizedToggleCount}, folding-view count=${oversizedFoldingViewCount}, too-large placeholder visible=${tooLargeVisible}, fixture content visible=${markerVisible}`,
      );

      // === jsonWayOversized (oversized-huge.json) — genuinely ABOVE the
      // raised cap (R): must still refuse, exactly like the pre-fix
      // assertion above used to check for oversized.json. The too-large
      // placeholder renders and folding-view stays dispatched — effectiveCls
      // never degrades to text for a refused (kind: 'too-large', not 'text')
      // confirmation, so this also proves the boundary the "key the read cap
      // on cls, not effectiveCls" fix is meant to keep stable never flip-flops
      // at this extreme either.
      await openFromExplorer(win, F.jsonWayOversized);
      await selectMode(win, 'Rendered', SETTLE_CONFIRM);
      const scopeWayOversized = contentPanelRoot(win, F.jsonWayOversized);
      const wayOversizedToggleCount = await foldToggles(scopeWayOversized).count();
      const wayOversizedFoldingViewCount = await scopeWayOversized
        .locator('[data-testid="folding-view"]')
        .count();
      const wayTooLargeVisible = await scopeWayOversized
        .getByText('too large to preview inline', { exact: false })
        .count();
      const wayMarkerLeaked = await scopeWayOversized
        .getByText('oversized-fixture', { exact: false })
        .count();
      record(
        'jsonWayOversized: genuinely above the raised cap, the read still REFUSES — too-large placeholder renders, folding-view stays dispatched (effectiveCls does not degrade), no fold toggles, no fixture content leaked',
        wayOversizedToggleCount === 0 &&
          wayOversizedFoldingViewCount === 1 &&
          wayTooLargeVisible > 0 &&
          wayMarkerLeaked === 0,
        `fold toggles=${wayOversizedToggleCount}, folding-view count=${wayOversizedFoldingViewCount}, too-large placeholder visible=${wayTooLargeVisible}, fixture content leaked=${wayMarkerLeaked}`,
      );

      // Opened via CHANGES (not Explorer): Explorer selections read at
      // `ref: 'HEAD'` (ExplorerPanel.tsx's `baseline: 'HEAD'`), i.e. the
      // last COMMITTED content — jsonFold's baseline has only 1 foldable
      // region (see FOLD_JSON_BASELINE in fixture.mjs), not the 6 the
      // working-tree version has. Changes reads the live working tree, the
      // same fixture this leaf's earlier jsonFold-via-Changes block already
      // verified byte-exact and 6-region.
      await openFromChanges(win, F.jsonFold);
      await selectMode(win, 'Rendered', SETTLE_CONFIRM);
      const scopeSmall = contentPanelRoot(win, F.jsonFold);
      const smallFoldingViewCount = await scopeSmall
        .locator('[data-testid="folding-view"]')
        .count();
      const smallToggleCount = await foldToggles(scopeSmall).count();
      record(
        'jsonFold: a small JSON file in the SAME session still folds with the threshold lowered (only size-vs-threshold matters, not a global disable)',
        smallFoldingViewCount === 1 && smallToggleCount === 6,
        `folding-view count=${smallFoldingViewCount}, fold toggles=${smallToggleCount}`,
      );
    } finally {
      await setSettings(win, { structuredFoldMaxMb: originalMaxMb });
    }
    const restoredSettings = await getSettings(win);
    record(
      'jsonOversized: structuredFoldMaxMb is restored to its prior value after the threshold-degrade check',
      restoredSettings.structuredFoldMaxMb === originalMaxMb,
      `expected=${originalMaxMb}, actual=${restoredSettings.structuredFoldMaxMb}`,
    );
  }
}

// --- project bootstrap helpers ----------------------------------------------

async function addAndActivateProject(win, connection, label) {
  await win.evaluate(
    async ({ connection, label }) => {
      const p = await window.api.projects.add({ label, connection });
      await window.api.projects.activate(p.id);
    },
    { connection, label },
  );
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(5000);
}

async function main() {
  generateFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-verify-content-modes-'));

  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');

  // Deterministic window size — stable panel widths, so line wrapping/overflow
  // in the gutter-alignment check is reproducible run to run (capture.mjs's
  // same trick).
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1480, 920);
  });

  // Uncaught-renderer-error gate for the whole run. Segmented by phase so the
  // (mandatory, exit-status-gating) local pass and the (opt-in, advisory-only)
  // remote pass are reported — and gate — independently.
  let phase = 'local';
  const pageErrors = { local: [], remote: [] };
  win.on('pageerror', (err) => {
    pageErrors[phase].push(String(err?.message ?? err));
  });

  const localResults = [];
  const recordLocal = (name, pass, detail = '') => {
    localResults.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  [local] ${name}${detail ? ` — ${detail}` : ''}`);
  };

  await addAndActivateProject(win, { kind: 'local', rootPath: FIXTURE_DIR }, 'Content Modes Demo');
  await runMatrix(win, recordLocal);
  recordLocal(
    'no uncaught renderer errors during the local pass',
    pageErrors.local.length === 0,
    pageErrors.local.length ? `errors=${JSON.stringify(pageErrors.local)}` : '',
  );

  // --- REMOTE PASS (opt-in) -------------------------------------------------
  const remoteHost = process.env.AC_VERIFY_REMOTE_HOST;
  const remoteUser = process.env.AC_VERIFY_REMOTE_USER;
  const remotePath = process.env.AC_VERIFY_REMOTE_PATH;
  const remotePort = Number(process.env.AC_VERIFY_REMOTE_PORT ?? 22);

  const remoteResults = [];
  let remoteRan = false;
  if (!remoteHost || !remoteUser || !remotePath) {
    console.log(
      'SKIP  remote pass — set AC_VERIFY_REMOTE_HOST/AC_VERIFY_REMOTE_USER/AC_VERIFY_REMOTE_PATH ' +
        "(AC_VERIFY_REMOTE_PORT optional, default 22; see this script's header) to exercise the " +
        "remote transport. The local pass above alone determines this run's exit status.",
    );
  } else {
    remoteRan = true;
    phase = 'remote';
    const recordRemote = (name, pass, detail = '') => {
      remoteResults.push({ name, pass });
      console.log(`${pass ? 'PASS' : 'FAIL'}  [remote] ${name}${detail ? ` — ${detail}` : ''}`);
    };
    console.log(
      `Running the same matrix against remote ${remoteUser}@${remoteHost}:${remotePath} ...`,
    );
    await addAndActivateProject(
      win,
      { kind: 'remote', host: remoteHost, user: remoteUser, port: remotePort, remotePath },
      'Content Modes Demo (remote)',
    );
    await runMatrix(win, recordRemote);
    recordRemote(
      'no uncaught renderer errors during the remote pass',
      pageErrors.remote.length === 0,
      pageErrors.remote.length ? `errors=${JSON.stringify(pageErrors.remote)}` : '',
    );
  }

  await Promise.race([app.close().catch(() => {}), sleep(3000)]);
  killSessions();

  const localAllPass = localResults.every((r) => r.pass);
  const remoteAllPass = remoteResults.every((r) => r.pass);
  console.log(
    `\nLocal pass:  ${localResults.filter((r) => r.pass).length}/${localResults.length} passed` +
      `${localAllPass ? '' : ' — FAILURES ABOVE'}`,
  );
  if (remoteRan) {
    console.log(
      `Remote pass: ${remoteResults.filter((r) => r.pass).length}/${remoteResults.length} passed` +
        `${remoteAllPass ? '' : ' — FAILURES ABOVE (advisory only; does not affect exit status)'}`,
    );
  } else {
    console.log('Remote pass: SKIPPED (see SKIP line above)');
  }
  console.log(localAllPass ? '\n✅ ALL PASS (local)' : '\n❌ FAILURES (local)');
  process.exit(localAllPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  killSessions();
  process.exit(1);
});
