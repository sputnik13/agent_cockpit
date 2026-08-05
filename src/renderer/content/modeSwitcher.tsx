import type { ContentKind } from './selectionStore';

/**
 * Content-type CLASS + mode dispatch — the single authoring site for "which
 * modes exist for a given file, what the default is, and which component
 * renders it." Replaces the old per-extension `ContentMode` values (`'image'`,
 * `'html-preview'`) and the hand-branched render blocks that used to live in
 * ContentViewer.
 *
 * Classification mechanism (generic-binary detection): `classOf` is a PURE,
 * path-only function — no IPC, no React state (see the Guardrails on
 * local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.2). An extension
 * list can enumerate markdown/html/image reliably, but it can never enumerate
 * every binary format (pdf, zip, sqlite, ...), so this classifier does NOT try:
 * anything that isn't recognized as markdown/html/image classifies as `'text'`
 * — i.e. "unknown at classification time" rather than a guessed
 * `'generic-binary'`. `classOf` itself NEVER produces `'generic-binary'` —
 * that is permanent, by design, not a gap.
 *
 * True binary-ness is instead resolved at RUNTIME, by the component that
 * actually reads the file's bytes — mirroring the existing, proven pattern in
 * RawFile (which already branches on `readFile`'s `isBinary`/`truncated`
 * result flags rather than the path). `modesFor` and `defaultModeFor` below
 * both take an optional trailing `knownBinary` flag for exactly this: their
 * caller (ContentViewer) derives it from RawFile's own `readFile` result,
 * reported upward via RawFile's `onBinaryConfirmed` prop — RawFile's
 * EXISTING read, never a new one (see RawFile.tsx's doc comment) — and
 * computes an "effective class" (`'generic-binary'` once confirmed,
 * `classOf(path)` otherwise) that it passes to `modesFor`/`defaultModeFor`
 * (via `knownBinary`) AND directly to `viewFor` (which already takes a
 * `ContentClass` value rather than a path, so it needs no change at all).
 * `classOf` and this module's tables stay pure; ContentViewer is the one
 * runtime-override site — see ContentViewer.tsx's `effectiveCls`/
 * `effectiveMode`.
 *
 * Until confirmed, an unrecognized extension behaves exactly like any other
 * `'text'` file (Diff/Rendered/Raw all offered) — e.g. a `.pdf` still opens
 * exactly like today's behavior on first paint, since binary-ness can only
 * ever be learned asynchronously. This is safe because every render target
 * reachable from the `'text'` row already tolerates a `'text'`-classified
 * path that turns out to be binary content (RawFile's binary/too-large
 * branches; DiffView's "no textual diff" empty hint / binary-patch
 * placeholder). VIEW_DISPATCH['generic-binary']'s diff/rendered cells (below)
 * reuse those SAME components (`'diff-view'`/`'raw-file'`), not new ones —
 * reclassification only changes mode AVAILABILITY/DEFAULT (drops Raw;
 * defaults to Diff), never which component renders the content.
 *
 * JSON/YAML classification (`isJsonPath`/`isYamlPath`, following the same
 * extension-set pattern as `isMarkdownPath`/`isHtmlPath`/`isImagePath`):
 * `.json` AND `.jsonc` both classify as `'json'` — jsonc-parser (the parser
 * the eventual structural folding view builds on; see
 * local_repo_explorer-jp2f.1) parses JSONC (JSON-with-comments and trailing
 * commas) natively, so there is no grammar mismatch to hide. `.json5`
 * deliberately does NOT classify as `'json'` — it is a materially different,
 * richer grammar (unquoted keys, single-quoted strings, more trailing-comma
 * positions, etc.) that jsonc-parser does not parse; a `.json5` file falls
 * through to `'text'`, unchanged from today. (Separately, and not this
 * module's concern: Shiki's `json` highlight-language entry — see
 * highlight/languages.ts — only recognizes the `.json` extension today, so a
 * `.jsonc` file's Rendered view is unhighlighted plain text, exactly as
 * before this class existed; extending that grammar mapping is a later,
 * independent change.) `.yaml`/`.yml` both classify as `'yaml'` — no
 * comparable variant-extension question there.
 */
export type ContentClass = 'markdown' | 'html' | 'image' | 'text' | 'json' | 'yaml' | 'generic-binary';

/** The three uniform modes every class projects into (availability varies by
 *  class; see {@link modesFor}). Presentation differs per class — Rendered is
 *  a formatted markdown view for markdown, a sandboxed iframe for HTML, an
 *  image comparison for images — but the MODE NAME shown to the user is
 *  always one of these three (see {@link LABELS}). */
export type ContentMode = 'diff' | 'rendered' | 'raw';

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const HTML_EXT = new Set(['.html', '.htm']);
const JSON_EXT = new Set(['.json', '.jsonc']);
const YAML_EXT = new Set(['.yaml', '.yml']);

function extOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path));
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXT.has(extOf(path));
}

export function isHtmlPath(path: string): boolean {
  return HTML_EXT.has(extOf(path));
}

/** `.json` and `.jsonc` both classify as JSON; `.json5` deliberately does
 *  not — see the module doc comment. */
export function isJsonPath(path: string): boolean {
  return JSON_EXT.has(extOf(path));
}

/** `.yaml` and `.yml` both classify as YAML. */
export function isYamlPath(path: string): boolean {
  return YAML_EXT.has(extOf(path));
}

/** Pure, path-only content-type classification. See the module doc comment
 *  for why an unrecognized extension classifies as `'text'` rather than
 *  `'generic-binary'`. */
export function classOf(path: string): ContentClass {
  if (isMarkdownPath(path)) return 'markdown';
  if (isHtmlPath(path)) return 'html';
  if (isImagePath(path)) return 'image';
  if (isJsonPath(path)) return 'json';
  if (isYamlPath(path)) return 'yaml';
  return 'text';
}

/** Which modes a class exposes, ignoring `kind` (see {@link modesFor} for the
 *  `external-file` override). Text-like classes (markdown, html, text) get
 *  all three; image and generic-binary have no meaningful Raw presentation —
 *  a comparison/preview is the only sensible view for them — so they expose
 *  Diff + Rendered only. */
const CLASS_MODES: Record<ContentClass, ContentMode[]> = {
  markdown: ['diff', 'rendered', 'raw'],
  html: ['diff', 'rendered', 'raw'],
  text: ['diff', 'rendered', 'raw'],
  // json/yaml are text-like — identical availability to `text` (see
  // VIEW_DISPATCH below for the one presentation difference: Rendered).
  json: ['diff', 'rendered', 'raw'],
  yaml: ['diff', 'rendered', 'raw'],
  image: ['diff', 'rendered'],
  'generic-binary': ['diff', 'rendered'],
};

/**
 * The modes valid for a file, given where the selection came from and
 * (optionally) runtime-confirmed binary-ness. An `external-file` selection
 * (out-of-project, no git baseline — see `ContentSelection`/`ContentKind`)
 * never offers Diff. Its image/generic-binary classes fall back to Raw only —
 * matching today's exact behavior (an external image or binary opens
 * read-only in Raw, e.g. "Binary file (N)" via RawFile). For image, this is a
 * DELIBERATE carve-out rather than a capability gap: ImageView (the image
 * Rendered view) needs no git baseline and could serve an external-file
 * selection just as well, but
 * local_repo_explorer-content-mode-uniform-diff-rendered-sx0i.4 scoped this
 * function's `external-file` branch as out-of-bounds ("leave that logic
 * exactly as is") — revisit here if external-file image Rendered support is
 * ever wanted. Text-like classes keep Rendered for external files: that
 * presentation (RenderedMarkdown / HtmlPreview / RawFile) has always read the
 * file directly, with no baseline dependency.
 *
 * `knownBinary`: pass `true` once a caller has runtime-confirmed the file is
 * actually binary (see the module doc comment) to compute availability as if
 * `classOf(path)` had returned `'generic-binary'`, regardless of what the
 * path's extension actually is. Omitted/`false` (every pre-existing caller)
 * behaves exactly as before — `classOf(path)` alone decides.
 */
export function modesFor(path: string, kind: ContentKind, knownBinary?: boolean): ContentMode[] {
  const cls = knownBinary ? 'generic-binary' : classOf(path);
  if (kind === 'external-file') {
    return cls === 'image' || cls === 'generic-binary' ? ['raw'] : ['rendered', 'raw'];
  }
  return CLASS_MODES[cls];
}

/**
 * Pick the default content mode. Markdown/HTML always default to Rendered
 * (their nicest presentation, regardless of where the selection came from —
 * matches today's unconditional `isMarkdownPath`/`isHtmlPath` defaults). An
 * out-of-project selection has no git baseline, so anything else defaults to
 * Raw. Otherwise: image/generic-binary default to Diff — the
 * "type-appropriate comparison" role (ImageCompare today; matches today's
 * unconditional image default, just under the Diff mode name now that the
 * standalone `'image'` mode is gone). Plain text-like content defaults to
 * Diff for a Changes-panel row and Raw for an Explorer file (never an empty
 * diff) — unchanged from today.
 *
 * `knownBinary`: see `modesFor`'s doc comment — same override, same default
 * (omitted/`false` behaves exactly as before). This is what actually moves a
 * runtime-confirmed binary file's default to Diff: ContentViewer re-derives
 * the mode to RENDER (not the `mode` STATE itself, which still tracks the
 * user's last explicit choice) whenever the current mode falls outside the
 * reclassified availability — see ContentViewer.tsx's `effectiveMode`.
 */
export function defaultModeFor(path: string, kind: ContentKind, knownBinary?: boolean): ContentMode {
  const cls = knownBinary ? 'generic-binary' : classOf(path);
  if (cls === 'markdown' || cls === 'html') return 'rendered';
  if (kind === 'external-file') return 'raw';
  if (cls === 'image' || cls === 'generic-binary') return 'diff';
  return kind === 'change' ? 'diff' : 'raw';
}

/**
 * Which component renders a given (class, mode) pair — the dispatch table
 * ContentViewer consumes instead of hand-branching per extension. Every cell
 * renders an EXISTING component under its new mode name — this table
 * introduces no new viewer.
 */
export type ViewKind =
  | 'diff-view' // DiffView — the real textual diff
  | 'rendered-markdown' // RenderedMarkdown
  | 'html-preview' // HtmlPreview (sandboxed iframe)
  | 'raw-file' // RawFile
  | 'image-compare' // ImageCompare (before/after)
  | 'image-view' // ImageView (single current image, fit to panel)
  | 'folding-view'; // FoldingView — the Rendered presentation for source-mapped structural folding (json/yaml); see FoldingView.tsx

const VIEW_DISPATCH: Record<ContentClass, Record<ContentMode, ViewKind>> = {
  markdown: { diff: 'diff-view', rendered: 'rendered-markdown', raw: 'raw-file' },
  html: { diff: 'diff-view', rendered: 'html-preview', raw: 'raw-file' },
  // Rendered and Raw both dispatch to RawFile BY DESIGN, not as a placeholder:
  // RawFile is the single shared authoring site for the per-line row/gutter/
  // note markup, and ContentViewer passes it a `highlight` prop (true for
  // Rendered, false for Raw) that decides whether Shiki tokenization runs at
  // all. See RawFile's doc comment for the settled Rendered/Raw distinction.
  text: { diff: 'diff-view', rendered: 'raw-file', raw: 'raw-file' },
  // json/yaml (both rows identical): Diff and Raw deliberately reuse the
  // SAME existing components as `text` above (DiffView / RawFile) —
  // unchanged from today's behavior, back when both extensions still
  // classified as `'text'`. Rendered is the ONE new cell this leaf
  // introduces: FoldingView, the settled seam for source-mapped structural
  // folding (see FoldingView.tsx's doc comment). This leaf's FoldingView
  // body is a deliberately temporary pass-through to RawFile (highlight
  // on), so Rendered's steady-state OUTPUT is unchanged too (same
  // Shiki-highlighted line view, same Wrap/find/line-note behavior) — only
  // the dispatch PATH is new. One real consequence: unlike `text` above
  // (where Rendered and Raw share this SAME 'raw-file' cell, so toggling
  // between them just flips a prop on one persistent RawFile instance),
  // json/yaml's Rendered and Raw are now DIFFERENT cells — toggling between
  // them unmounts one component and mounts the other, so RawFile
  // re-reads the file each time Rendered is (re)entered. This is accepted
  // for this temporary seam (see the issue's Guardrails); the real folding
  // view (local_repo_explorer-jp2f.5, which replaces this body) will have
  // its own state model regardless.
  json: { diff: 'diff-view', rendered: 'folding-view', raw: 'raw-file' },
  yaml: { diff: 'diff-view', rendered: 'folding-view', raw: 'raw-file' },
  // Diff is the before/after visual compare (ImageCompare — the
  // "type-appropriate comparison" for images; see the epic's settled
  // end-state mapping). Rendered is the single current-image view
  // (ImageView) — the working-tree image alone, fit to the panel; it needs no
  // git baseline, but images stay external-file Raw-only regardless (see
  // modesFor's doc comment — deliberately unchanged by this leaf). `raw` is
  // only reachable via the external-file carve-out above and renders
  // RawFile's binary fallback, same as today.
  image: { diff: 'image-compare', rendered: 'image-view', raw: 'raw-file' },
  // Reachable once ContentViewer's `effectiveCls` (see the module doc
  // comment) is `'generic-binary'` — i.e. RawFile's read has confirmed this
  // path's bytes are binary. Both cells reuse the SAME components as the
  // 'text' row above: DiffView already renders the graceful cannot-compare
  // placeholder for a binary patch (parsePatch.ts's `binary` field), and
  // RawFile already renders the graceful no-preview placeholder when
  // `highlight` (Rendered) is true. Reclassifying to this row changes
  // AVAILABILITY/DEFAULT (drops Raw; defaults to Diff — see
  // CLASS_MODES/defaultModeFor above), never which component renders.
  'generic-binary': { diff: 'diff-view', rendered: 'raw-file', raw: 'raw-file' },
};

/** Look up which component renders a (class, mode) pair. Pure table lookup —
 *  see {@link VIEW_DISPATCH}. */
export function viewFor(cls: ContentClass, mode: ContentMode): ViewKind {
  return VIEW_DISPATCH[cls][mode];
}

interface ModeSwitcherProps {
  available: ContentMode[];
  active: ContentMode;
  onChange: (m: ContentMode) => void;
}

const LABELS: Record<ContentMode, string> = {
  diff: 'Diff',
  rendered: 'Rendered',
  raw: 'Raw',
};

/** Compact segmented control for switching content render modes. */
export function ModeSwitcher({ available, active, onChange }: ModeSwitcherProps): JSX.Element {
  return (
    <div role="tablist" aria-label="Content mode" style={{ display: 'flex', gap: 4 }}>
      {available.map((m) => {
        const isActive = m === active;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(m)}
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: isActive ? 'var(--accent)' : 'var(--bg-panel)',
              color: isActive ? 'white' : 'var(--fg)',
              cursor: 'pointer',
            }}
          >
            {LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
