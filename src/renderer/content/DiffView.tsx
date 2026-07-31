import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { parsePatch } from './parsePatch';
import { resolveLanguage } from './highlight/languages';
import { tokenizeLines, type TokenLine } from './highlight/highlighter';
import { CodeLineTokens } from './highlight/CodeTokens';
import { LineNoteThread, lineNotesByLine, useNotesStore } from '../notes';
import { pickTokenLine } from './diffTokens';
import { BinaryPlaceholder, type BinaryPlaceholderReason } from './BinaryPlaceholder';

/** Above this content length a side is left un-highlighted (rendered plain). */
const SIZE_LIMIT = 256 * 1024;

/**
 * Per-row rendering containment for large files. `content-visibility: auto` lets
 * the browser SKIP layout/paint of off-screen rows (the real cost for a big
 * file's thousands of token spans) while KEEPING every row in the DOM — so
 * find-in-file (a DOM TreeWalker), the wrap toggle, and note anchors all keep
 * working. `contain-intrinsic-size` gives skipped rows a placeholder height so
 * the scrollbar is right; `auto` remembers each row's real height once measured.
 * This is the deliberate alternative to node-removing windowing, which would
 * break the DOM-based find. Harmless on small files.
 */
const ROW_CONTAINMENT = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 1.2em',
} as const;

interface DiffViewProps {
  patch: string;
  emptyHint?: string;
  onHunkClick?: (hunkIndex: number) => void;
  /** When provided, enables per-line Shiki highlighting of the supplied content. */
  filePath?: string;
  worktreePath?: string;
  baseline?: string;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /** New (working-tree) side content for highlighting; null = don't highlight. */
  newContent?: string | null;
  /** Old (baseline-ref) side content for highlighting; null = don't highlight.
   *  Both come from the provider's one-call diff bundle, so DiffView no longer
   *  issues its own readFile round trips. */
  oldContent?: string | null;
  /**
   * ContentViewer/RawFile's independently-confirmed classification of this
   * same path (see RawFile's `onBinaryConfirmed` doc comment), supplied when
   * the patch text itself (`parsed.binary`, below) carries NO signal at all —
   * e.g. an unmodified or untracked binary file, whose diff is empty (see
   * parsePatch.ts's `binary` field doc comment). Lets that empty-diff case
   * show the SAME graceful placeholder as a git-confirmed binary change,
   * instead of the uninformative `emptyHint`. DiffView makes no provider
   * calls of its own either way — this is purely a prop.
   */
  knownReason?: BinaryPlaceholderReason;
  /**
   * File size in bytes for the generic-binary Diff placeholder (see
   * BinaryPlaceholder's `size` prop doc comment), for EITHER the
   * `parsed.binary` branch or the `knownReason` branch below. Sourced SOLELY
   * from RawFile's own already-fetched `readFile` result, whenever RawFile
   * has independently mounted and confirmed this path (the dominant case —
   * see RawFile's `onBinaryConfirmed` doc comment and ContentViewer.tsx's
   * `rawFileSize`). `knownSize` is undefined whenever RawFile hasn't
   * mounted — e.g. a `kind: 'change'` selection where Diff is the first/only
   * mode ever shown, so RawFile never mounts at all. ContentViewer
   * deliberately does NOT fall back to a separate provider call to fill that
   * gap (see `rawFileSize`'s doc comment in ContentViewer.tsx for why — an
   * earlier version's fallback fired a real, if capped, read on remote just
   * to render a placeholder, and had no gate on which view was actually
   * rendering, so an unrelated changed-image diff triggered an extra,
   * unconsumed read too); DiffView/BinaryPlaceholder simply render without a
   * size in that case, which they already do gracefully.
   */
  knownSize?: number;
}

export function DiffView({
  patch,
  emptyHint,
  onHunkClick,
  filePath,
  wrap = false,
  newContent = null,
  oldContent = null,
  knownReason,
  knownSize,
}: DiffViewProps): JSX.Element {
  const parsed = useMemo(() => parsePatch(patch), [patch]);
  const theme = useSettingsStore((s) => s.settings.theme);

  // Line notes are anchored to the NEW-file line number. Commentable rows are
  // those with a newLine (added/context); deleted lines have none.
  const notes = useNotesStore((s) => s.notes);
  const loadNotes = useNotesStore((s) => s.load);
  const addLineNote = useNotesStore((s) => s.addLineNote);
  const removeNote = useNotesStore((s) => s.remove);
  const activeId = useProjectsStore((s) => s.activeId);
  const [composing, setComposing] = useState<number | null>(null);
  useEffect(() => {
    void loadNotes();
  }, [activeId, loadNotes]);
  const notesByLine = useMemo(
    () => (filePath ? lineNotesByLine(notes, filePath) : new Map<number, typeof notes>()),
    [notes, filePath],
  );

  const [tokenSides, setTokenSides] = useState<{
    old: TokenLine[] | null;
    new: TokenLine[] | null;
  } | null>(null);

  useEffect(() => {
    // Tokenize the content supplied by the diff bundle (no readFile here). Only
    // for a supported language; oversized/absent sides render plain.
    const lang = filePath ? resolveLanguage(filePath) : null;
    if (!lang) {
      setTokenSides(null);
      return;
    }
    let active = true;
    setTokenSides(null);
    const tokSide = async (content: string | null): Promise<TokenLine[] | null> => {
      if (content == null || content.length > SIZE_LIMIT) return null;
      try {
        return (await tokenizeLines(content, lang, theme)).lines;
      } catch {
        return null;
      }
    };
    void Promise.all([tokSide(oldContent), tokSide(newContent)]).then(([old, nw]) => {
      if (active) setTokenSides(old || nw ? { old, new: nw } : null);
    });
    return () => {
      active = false;
    };
  }, [filePath, theme, oldContent, newContent]);

  if (parsed.binary) {
    // git reported its binary-diff summary line — no hunks were ever
    // possible for this file. `changed` is always true here: this branch
    // only runs when parsePatch found the "Binary files … differ" line,
    // which only appears when git detected an actual change (see
    // parsePatch.ts's `binary` field doc comment). `knownSize` (see this
    // component's prop doc comment above) is undefined whenever RawFile
    // hasn't independently mounted and confirmed this path's size —
    // BinaryPlaceholder renders gracefully either way.
    return <BinaryPlaceholder mode="diff" reason="binary" changed size={knownSize} />;
  }

  if (parsed.hunks.length === 0) {
    if (knownReason) {
      // The patch itself carries no signal at all — this file is unmodified,
      // untracked, or otherwise has an empty diff (see parsePatch.ts's
      // `binary` field doc comment) — but ContentViewer/RawFile has
      // independently confirmed (from RawFile's own `readFile` result — see
      // this component's `knownReason` prop doc comment above) that this
      // path isn't plain text. Surface THAT instead of the uninformative
      // `emptyHint` below: this is what fixes an unmodified/untracked binary
      // file opened from the Explorer, previously the dominant real-world
      // case this issue's placeholder work never reached (reclassification
      // alone makes Diff the DEFAULT for such a file — see
      // ContentViewer.tsx's `effectiveMode` — so this path is not merely an
      // edge case reachable by manual navigation). `changed` is deliberately
      // OMITTED here (never asserted true or false): unlike the
      // `parsed.binary` branch above, there is no git signal that this file
      // actually differs from the baseline — see BinaryPlaceholder's
      // `changed` prop doc comment.
      return <BinaryPlaceholder mode="diff" reason={knownReason} size={knownSize} />;
    }
    return (
      <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
        {emptyHint ?? 'No textual diff.'}
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--mono-size)',
        background: 'var(--bg)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      {parsed.hunks.map((h, idx) => (
        <div key={idx} style={{ borderTop: '1px solid var(--border)' }}>
          <div
            style={{
              padding: '4px 8px',
              color: 'var(--fg-dim)',
              background: 'var(--bg-panel)',
              cursor: onHunkClick ? 'pointer' : 'default',
            }}
            onClick={() => onHunkClick?.(idx)}
          >
            {h.header}
          </div>
          <div>
            {h.lines.map((ln, j) => {
              const color =
                ln.kind === 'add'
                  ? 'rgba(127, 201, 122, 0.15)'
                  : ln.kind === 'del'
                    ? 'rgba(255, 122, 122, 0.15)'
                    : 'transparent';
              const prefix = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ln.kind === 'meta' ? '\\' : ' ';

              // Pick the token line from the correct side:
              //   del / context-old  → old side (oldLine number)
              //   add / context-new  → new side (newLine number)
              const tokenLine =
                tokenSides !== null
                  ? ln.kind === 'del'
                    ? pickTokenLine(ln.oldLine, tokenSides.old)
                    : ln.kind === 'context'
                      ? pickTokenLine(ln.newLine, tokenSides.new) ??
                        pickTokenLine(ln.oldLine, tokenSides.old)
                      : pickTokenLine(ln.newLine, tokenSides.new)
                  : null;

              const newLine = ln.newLine;
              const commentable = filePath != null && newLine != null;
              const lineNotes = newLine != null ? (notesByLine.get(newLine) ?? []) : [];
              const open = newLine != null && composing === newLine;

              return (
                <Fragment key={j}>
                  {/* No-wrap: `minWidth: max-content` makes the row size to its
                      content so a long line extends the row (and its background)
                      and the outer overflow:auto container scrolls horizontally;
                      combined with `flexShrink: 0` on the gutters this stops flex
                      from squeezing the fixed-width line-number columns on
                      overflowing rows (which misaligned them against short rows).
                      Wrap: the row stays at container width (no max-content), the
                      code span wraps (see below), and the gutters — still
                      flexShrink:0 and top-aligned — keep the number at the first
                      visual row of the wrapped line. */}
                  <div
                    style={{
                      display: 'flex',
                      background: color,
                      whiteSpace: wrap ? 'pre-wrap' : 'pre',
                      ...(wrap ? {} : { minWidth: 'max-content' }),
                      ...ROW_CONTAINMENT,
                    }}
                  >
                    <span
                      style={{
                        width: 50,
                        flexShrink: 0,
                        textAlign: 'right',
                        paddingRight: 8,
                        color: 'var(--fg-dim)',
                        borderRight: '1px solid var(--border)',
                        userSelect: 'none',
                      }}
                    >
                      {ln.oldLine ?? ''}
                    </span>
                    <span
                      className={commentable ? 'group/ng relative cursor-pointer' : 'relative'}
                      onClick={commentable ? () => setComposing(newLine) : undefined}
                      title={commentable ? `Add a note on line ${newLine}` : undefined}
                      style={{
                        width: 50,
                        flexShrink: 0,
                        textAlign: 'right',
                        paddingRight: 8,
                        color: 'var(--fg-dim)',
                        borderRight: '1px solid var(--border)',
                        userSelect: 'none',
                      }}
                    >
                      {lineNotes.length > 0 && (
                        <span
                          style={{
                            position: 'absolute',
                            left: 2,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            width: 6,
                            height: 6,
                            borderRadius: 9999,
                            background: 'var(--accent)',
                          }}
                        />
                      )}
                      <span className={commentable ? 'group-hover/ng:opacity-0' : undefined}>
                        {newLine ?? ''}
                      </span>
                      {commentable && (
                        <span
                          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/ng:opacity-100"
                          style={{ color: 'var(--accent)' }}
                        >
                          +
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        paddingLeft: 8,
                        // When wrapping, the code must be able to shrink below its
                        // content width (minWidth:0) and break long unbroken tokens
                        // (overflowWrap:anywhere) so it wraps within the panel.
                        ...(wrap
                          ? { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' as const }
                          : {}),
                      }}
                    >
                      {prefix}
                      {tokenLine ? <CodeLineTokens line={tokenLine} /> : ln.text}
                    </span>
                  </div>
                  {newLine != null && (lineNotes.length > 0 || open) && (
                    <LineNoteThread
                      notes={lineNotes}
                      liveText={ln.text}
                      composing={open}
                      onSubmit={(body) => {
                        if (filePath) void addLineNote(filePath, newLine, ln.text, body);
                        setComposing(null);
                      }}
                      onCancel={() => setComposing(null)}
                      onDelete={(id) => void removeNote(id)}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
