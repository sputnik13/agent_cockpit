interface LineNoteGutterProps {
  /** 1-based line number shown in the gutter. */
  line: number;
  /** Whether this line already has one or more notes (shows a marker dot). */
  hasNotes: boolean;
  /** Open the composer for this line. */
  onAdd: (line: number) => void;
  /** Gutter width in px (default 48). */
  width?: number;
}

/**
 * A code-line gutter cell for the Content panel: shows the line number, a marker
 * dot when the line has notes, and — on hover — a "+" to add a note. Used by the
 * Raw view; the Diff view embeds the same affordance in its own number column.
 */
export function LineNoteGutter({ line, hasNotes, onAdd, width = 48 }: LineNoteGutterProps): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onAdd(line)}
      title={`Add a note on line ${line}`}
      className="group/gutter relative shrink-0 select-none border-r border-edge pr-2 text-right text-dim hover:text-fg"
      style={{ width }}
    >
      <span className="group-hover/gutter:opacity-0">{line}</span>
      <span className="absolute inset-0 flex items-center justify-center text-accent opacity-0 group-hover/gutter:opacity-100">
        +
      </span>
      {hasNotes && (
        <span className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-accent" />
      )}
    </button>
  );
}
