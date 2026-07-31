import { EmptyState } from '../ui';

/**
 * The two content modes this placeholder covers. Raw is deliberately absent:
 * generic-binary content has no Raw presentation in `CLASS_MODES` (see
 * modeSwitcher.tsx — that class offers Diff + Rendered only), and RawFile's
 * original terse Raw messages stay unchanged whenever `highlight` is false
 * (Raw's presentation, for any class — see RawFile.tsx). Both Diff and
 * Rendered get this component's richer, Download-pointing treatment; only
 * Raw does not.
 */
export type BinaryPlaceholderMode = 'diff' | 'rendered';

/** The three states a generic-binary selection can be in. Kept as distinct,
 *  never-conflated messages per the issue's guardrail (binary vs too-large
 *  especially must never collapse into one message). */
export type BinaryPlaceholderReason = 'binary' | 'too-large' | 'missing';

export interface BinaryPlaceholderProps {
  mode: BinaryPlaceholderMode;
  reason: BinaryPlaceholderReason;
  /**
   * File size in bytes, when known. Sourced differently per caller, but
   * NEVER from a read added just to learn it:
   *  - RawFile (Rendered) already has it on its existing `readFile` result.
   *  - ContentViewer (Diff) sources it SOLELY from RawFile's OWN
   *    already-fetched `readFile` result, whenever RawFile has mounted (the
   *    dominant case — see RawFile.tsx's `onBinaryConfirmed` doc comment),
   *    since the diff bundle itself carries no size field on either
   *    transport (local's `getDiffBundle` computes `sizeBytes` via
   *    `localReadFile` but discards it before returning — see
   *    electron/main/providers/local/index.ts). There is ONE remaining gap —
   *    a `kind: 'change'` selection where the patch already signals a binary
   *    change but Diff is the first/only mode ever shown, so RawFile never
   *    mounts — and ContentViewer deliberately does NOT fill it with a
   *    separate provider call: an earlier version tried a single fallback
   *    `provider.readFile`, but that fired even on remote (a real, if
   *    capped, byte transfer purely to render a placeholder — this issue's
   *    own guardrail and AC5 rule that out) and had no gate on which view
   *    was actually rendering, so a changed IMAGE's binary-diff patch (Diff
   *    mode for images dispatches to ImageCompare, never this component)
   *    triggered an extra, unconsumed read too. See ContentViewer.tsx's
   *    `rawFileSize` doc comment for the full history.
   * Omitted (gracefully) whenever the size genuinely isn't available — e.g.
   * a binary file deleted from the working tree, a remote project, or the
   * `kind: 'change'`-with-Diff-as-first-mode gap above.
   */
  size?: number;
  /**
   * Whether the file changed between the baseline and the working tree, when
   * derivable from the existing diff bundle's patch text (git's "Binary
   * files … differ" summary line — see parsePatch.ts's `binary` field).
   * Diff-mode only; Rendered has no baseline to compare against, so callers
   * never pass this for `mode="rendered"`. Omitted when the patch carries no
   * signal either way (an unmodified file's diff is empty and never emits
   * that line).
   */
  changed?: boolean;
}

/** Exact escape-hatch wording for the shipped row-context-menu Download
 *  capability (see docs/ARCHITECTURE.md "Bounded File Export (Download) & Row
 *  Context Menus"). This component only ever POINTS at Download — it never
 *  adds a new Download affordance of its own. */
const DOWNLOAD_HINT =
  'Right-click this file in Changes or Explorer and choose Download to open it in an external application.';

/**
 * Byte-size formatter — duplicated (not imported) from RawFile.tsx's/
 * useImageBytes.ts's identical five-line helper, following this directory's
 * established precedent (see useImageBytes.ts's `fmtImageSize` doc comment)
 * of keeping each leaf's touch set narrow rather than sharing a trivial pure
 * formatter across files.
 */
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Shared Diff/Rendered placeholder for generic-binary content (PDF, zip,
 * archives, compiled artifacts, anything unreadable as text) — the graceful
 * alternative to an empty diff pane or a raw byte dump. ONE component
 * parameterized by (mode, reason, size?, changed?) rather than two ad hoc
 * message blocks (see the issue's Contract), built on `EmptyState` so it
 * matches the panel's existing quiet/informative empty-state tone rather
 * than inventing a new visual language.
 *
 * Both callers detect binary-ness at RUNTIME, without any new read/call:
 *  - DiffView passes `mode="diff"` when EITHER the diff bundle's
 *    already-fetched patch text carries git's "Binary files … differ"
 *    summary line (`parsed.binary` — `changed` is then always `true`), OR
 *    ContentViewer's `knownReason` prop says so — RawFile's own confirmed
 *    classification, threaded through for the case the patch text alone
 *    cannot detect at all: an unmodified or untracked binary file, whose
 *    diff is empty (`changed` is then omitted, since there is no git signal
 *    either way — see DiffView.tsx's `knownReason`/`knownSize` prop doc
 *    comments).
 *  - RawFile passes `mode="rendered"` from its own pre-existing `readFile`
 *    result flags (`isBinary` / `truncated` / `content === null`) — the same
 *    flags it has always branched on for its `binary`/`too-large`/`missing`
 *    states, just redirected to this shared view instead of its own inline
 *    text, and ONLY when `highlight` (Rendered) is true. Those SAME flags are
 *    also reported to ContentViewer (via RawFile's `onBinaryConfirmed`) to
 *    upgrade the effective content class to `'generic-binary'`, which is what
 *    fixes a binary file's DEFAULT mode too — see ContentViewer.tsx and
 *    modeSwitcher.tsx's module doc comment. Raw keeps its original terse
 *    messages unchanged — out of this issue's scope (see modeSwitcher.tsx:
 *    generic-binary has no Raw mode in its class shape at all).
 *
 * Download is mentioned for both Diff's and Rendered's binary/too-large
 * reasons — the issue's own title and Goal name Download as the escape hatch
 * for BOTH modes, and a changed binary file viewed from Changes defaults to
 * Diff, making it the state most in need of the pointer. Never mentioned for
 * `missing` in either mode (nothing exists to download).
 */
export function BinaryPlaceholder({ mode, reason, size, changed }: BinaryPlaceholderProps): JSX.Element {
  const sizeSuffix = size != null ? ` (${fmtSize(size)})` : '';
  // Nothing to download for a file that isn't present at this ref, in
  // either mode.
  const downloadHint = reason === 'missing' ? null : DOWNLOAD_HINT;

  if (mode === 'rendered') {
    const title =
      reason === 'binary'
        ? `No preview available for this file type${sizeSuffix}.`
        : reason === 'too-large'
          ? `This file is too large to preview inline${sizeSuffix}.`
          : 'File not found at ref.';
    return <EmptyState title={title} hint={downloadHint ?? undefined} />;
  }

  const title =
    reason === 'binary'
      ? `This file type can't be compared line-by-line${sizeSuffix}.`
      : reason === 'too-large'
        ? `This file is too large to compare line-by-line${sizeSuffix}.`
        : 'File not found at ref — nothing to compare.';
  const changedHint =
    changed == null
      ? null
      : changed
        ? 'It changed between the baseline and the working tree.'
        : 'It has not changed since the baseline.';
  // Diff mode can't show a comparison for a generic-binary file either way,
  // but Download still applies (see the module doc comment) — folded into
  // one hint alongside the changed/not-changed signal when both are known.
  const hintParts: string[] = [];
  if (changedHint != null) hintParts.push(changedHint);
  if (downloadHint != null) hintParts.push(downloadHint);
  const hint = hintParts.length > 0 ? hintParts.join(' ') : undefined;
  return <EmptyState title={title} hint={hint} />;
}
