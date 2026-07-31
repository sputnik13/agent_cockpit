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
//   - a MODIFIED image x Diff (both panes real: the working-tree "after" pane
//     proves real pixels via naturalWidth > 0; the "before" (baseline) pane
//     shows the shipped, explicit "no baseline preview" state — see the
//     BASELINE-SIDE DECISION note below, never a real baseline image and never
//     the old catch-all "(unavailable)") and x Rendered (naturalWidth > 0).
//   - an ADDED-only image (untracked, no baseline) x Rendered/Diff, same shape.
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
//
// BASELINE-SIDE DECISION (read before changing any image assertion): `.1`
// shipped `readFileBytes` with NO git-`ref` support in v1, so `.4` made the
// image diff's "before (baseline)" pane an explicit, hardcoded
// 'no-baseline-preview' state (ImageCompare.tsx) — it NEVER attempts a byte
// read and NEVER shows a real image, regardless of whether the file was
// modified or newly added. This script asserts exactly that shipped behavior
// (the literal hint text, and that no `<img>` exists on that pane) rather than
// the epic issue's own (pre-`.4`-decision) "both panes show real pixels"
// phrasing — see local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.4's
// bead comments for the full rationale. The "after" (working-tree) pane and
// the single-image Rendered view DO fetch real bytes and must show real
// pixels; only the before/baseline pane is the documented exception.
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
import { generateFixture, FIXTURE_DIR, CONTENT_MODE_FIXTURES } from './fixture.mjs';

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
      'json: Rendered emits Shiki token-color spans (highlighted)',
      rendered.count > 0 && rendered.distinctColors > 1,
      `token spans=${rendered.count}, distinct colors=${rendered.distinctColors}`,
    );

    await selectMode(win, 'Raw');
    const scopeRaw = contentPanelRoot(win, F.json);
    const raw = await tokenSpanInfo(scopeRaw);
    record(
      'json: Raw emits zero token-color spans (plain)',
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
    const beforeImgCount = await scopeDiff.locator('img[alt="Before (baseline)"]').count();
    const noBaselineText = await scopeDiff
      .getByText('Baseline preview unavailable', { exact: false })
      .count();
    record(
      'image (modified): Diff before-pane never renders a real <img> (shipped no-baseline-preview state)',
      beforeImgCount === 0 && noBaselineText > 0,
      `before <img> count=${beforeImgCount}, "Baseline preview unavailable" count=${noBaselineText}`,
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
    const beforeImgCount = await scopeDiff.locator('img[alt="Before (baseline)"]').count();
    const noBaselineText = await scopeDiff
      .getByText('Baseline preview unavailable', { exact: false })
      .count();
    record(
      'image (added-only): Diff before-pane shows the same explicit no-baseline-preview state (never "(unavailable)")',
      beforeImgCount === 0 && noBaselineText > 0,
      `before <img> count=${beforeImgCount}, "Baseline preview unavailable" count=${noBaselineText}`,
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
