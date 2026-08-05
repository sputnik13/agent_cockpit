import type { ReactNode } from 'react';
import type { NoteRecord } from '@shared/ipc/channels';
import { LineNoteGutter, LineNoteThread } from '../notes';

export interface CodeRowProps {
  /**
   * 1-based original source line number. Forwarded to {@link LineNoteGutter}
   * (its label) and used as the note-anchor line — matches
   * `LineNoteGutter`/`lineNotesByLine`'s existing 1-based convention.
   */
  line: number;
  /**
   * Soft-wrap mode. Drives the CLAUDE.md gutter-alignment invariant:
   * no-wrap rows get `minWidth:'max-content'` (the row sizes to its
   * content; the outer container scrolls horizontally); wrap rows switch to
   * `white-space:'pre-wrap'` and let the code span shrink/break
   * (`minWidth:0`, `overflowWrap:'anywhere'`). The gutter (and any
   * {@link beforeCode} segment) stay `flexShrink:0` regardless — via their
   * own `shrink-0` styling, unaffected by this component — and the row
   * keeps the default `align-items:stretch` so a fixed-width column spans
   * the full wrapped-row height. See that CLAUDE.md entry before changing
   * any style value here — this is its one authoring site.
   */
  wrap: boolean;
  /** Notes anchored to this line (may be empty). Drives the gutter's marker
   *  dot and whether {@link LineNoteThread} renders below the row. */
  notes: NoteRecord[];
  /** Whether the note composer is open for this line. */
  composing: boolean;
  /** This row's live text — {@link LineNoteThread}'s outdated-note
   *  detection input, and typically the anchor snapshot a caller passes to
   *  its own note-creation call inside {@link onSubmitNote}. */
  liveText: string;
  /** Opens the composer for this line — forwarded to `LineNoteGutter.onAdd`. */
  onAddNote: (line: number) => void;
  /** Persists a new note body for this line — forwarded to
   *  `LineNoteThread.onSubmit`. */
  onSubmitNote: (body: string) => void;
  /** Closes the composer without saving — forwarded to
   *  `LineNoteThread.onCancel`. */
  onCancelNote: () => void;
  /** Deletes an existing note by id — forwarded to `LineNoteThread.onDelete`. */
  onDeleteNote: (id: number) => void;
  /**
   * An extra flex segment rendered as an ADDITIONAL direct child between
   * the gutter and the code span — e.g. FoldingView's fold-toggle chevron
   * cell. Omitted entirely (no wrapper element, not even an empty one) when
   * not given, so a caller with no such segment (RawText) keeps the row's
   * original two-child shape (`[gutter, code span]`) — both consumers' own
   * gutter-alignment tests index `row.children[N]` positionally, so this
   * must stay a true omission, not a rendered-but-empty node.
   */
  beforeCode?: ReactNode;
  /**
   * The code span's content: plain text, highlighted tokens
   * (`CodeLineTokens`), or badge-spliced nodes. This primitive supplies
   * only the span's wrap-mode wrapper styling (`flex`, `paddingLeft`, and
   * the wrap-mode `minWidth`/`overflowWrap`) — never the content itself,
   * which differs per consumer (and, for FoldingView, per row kind).
   */
  children: ReactNode;
}

/**
 * Shared plain-line row shell for the Content panel's per-line code views —
 * the single authoring site for the row/gutter/note markup covered by the
 * CLAUDE.md "Content-panel code views: line-number gutters stay aligned;
 * wrap is a toggle" invariant (see {@link CodeRowProps.wrap}). Consumed by
 * RawFile.tsx's `RawText` and FoldingView.tsx's `renderRow`, which
 * previously duplicated this markup byte-for-byte — a deliberate, disclosed
 * trade-off when FoldingView was first built (see its module doc comment /
 * local_repo_explorer-jp2f.5's guardrail), with this extraction as the
 * promised follow-up (local_repo_explorer-ggog).
 *
 * Covers exactly: the `contentVisibility` wrapper, the flex row with
 * wrap-mode `whiteSpace`/`minWidth` handling, `LineNoteGutter`, the code
 * span's wrap-mode `flex`/`minWidth`/`overflowWrap` handling, and
 * `LineNoteThread` rendered beneath the row when there are notes or the
 * composer is open. Deliberately does NOT cover fold-specific chrome
 * (FoldingView's fold-toggle cell, folded-row placeholder/prefix/suffix
 * logic) — that is real behavioral divergence, composed in via
 * {@link CodeRowProps.beforeCode} and `children` rather than absorbed here.
 *
 * A caller supplies `key` at its own call site (this is mapped over rows,
 * so `key` is never a prop of the row itself).
 */
export function CodeRow({
  line,
  wrap,
  notes,
  composing,
  liveText,
  onAddNote,
  onSubmitNote,
  onCancelNote,
  onDeleteNote,
  beforeCode,
  children,
}: CodeRowProps): JSX.Element {
  return (
    // content-visibility:auto skips layout/paint of off-screen rows (a big
    // file's dominant cost) while keeping them in the DOM, so find-in-file,
    // wrap, and note anchors keep working. See DiffView ROW_CONTAINMENT.
    <div style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 1.2em' }}>
      {/* No-wrap: minWidth:max-content extends the row so long lines scroll
          in the outer container while the shrink-0 gutter (and any
          beforeCode segment) stay aligned. Wrap: pre-wrap + the code span
          breaking long tokens (minWidth:0, overflowWrap:anywhere) so lines
          wrap within the panel; fixed-width columns stay aligned with the
          first visual row (default align-items:stretch — see the
          gutter-alignment invariant in CLAUDE.md). */}
      <div
        style={{
          display: 'flex',
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          ...(wrap ? {} : { minWidth: 'max-content' }),
        }}
      >
        <LineNoteGutter line={line} hasNotes={notes.length > 0} onAdd={onAddNote} />
        {beforeCode}
        <span
          style={{
            flex: '1 1 auto',
            paddingLeft: 8,
            ...(wrap ? { minWidth: 0, overflowWrap: 'anywhere' as const } : {}),
          }}
        >
          {children}
        </span>
      </div>
      {(notes.length > 0 || composing) && (
        <LineNoteThread
          notes={notes}
          liveText={liveText}
          composing={composing}
          onSubmit={onSubmitNote}
          onCancel={onCancelNote}
          onDelete={onDeleteNote}
        />
      )}
    </div>
  );
}
