import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { parsePatch } from './parsePatch';
import { resolveLanguage } from './highlight/languages';
import { tokenizeLines, type TokenLine } from './highlight/highlighter';
import { CodeLineTokens } from './highlight/CodeTokens';
import { LineNoteThread, lineNotesByLine, useNotesStore } from '../notes';
import { pickTokenLine } from './diffTokens';

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
}

export function DiffView({
  patch,
  emptyHint,
  onHunkClick,
  filePath,
  wrap = false,
  newContent = null,
  oldContent = null,
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

  if (parsed.hunks.length === 0) {
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
