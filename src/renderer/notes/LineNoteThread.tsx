import { useEffect, useRef, useState } from 'react';
import type { NoteRecord } from '@shared/ipc/channels';
import { Badge, Button, IconButton } from '../ui';
import { isOutdated } from './anchor';

interface LineNoteThreadProps {
  /** Notes anchored to this line (may be empty when only composing). */
  notes: NoteRecord[];
  /** Current text of the anchored line, for outdated detection. */
  liveText: string | null;
  /** Whether the new-note composer is open. */
  composing: boolean;
  /** Persist a new note body for this line. */
  onSubmit: (body: string) => void;
  /** Close the composer without saving. */
  onCancel: () => void;
  /** Delete an existing note by id. */
  onDelete: (id: number) => void;
}

/**
 * Inline, full-width review thread shown beneath a code line in the Content
 * panel (Raw + Diff). Renders existing notes — body, timestamp, an "outdated"
 * badge when the line text has drifted from the note's snapshot, and a delete
 * affordance — plus an optional composer for adding a new note. Presentational:
 * the host view supplies the notes, live text, and handlers.
 */
export function LineNoteThread({
  notes,
  liveText,
  composing,
  onSubmit,
  onCancel,
  onDelete,
}: LineNoteThreadProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (composing) taRef.current?.focus();
  }, [composing]);

  function submit(): void {
    const body = draft.trim();
    if (!body) return;
    onSubmit(body);
    setDraft('');
  }

  return (
    <div className="border-l-2 border-accent bg-elev px-3 py-1.5 text-[13px]">
      {notes.map((n) => (
        <div key={n.id} className="border-b border-edge py-1 last:border-b-0">
          <div className="flex items-center gap-2">
            <Badge tone="accent">note</Badge>
            {isOutdated(n.anchorText, liveText) && (
              <Badge tone="warn" title="The line this note anchored to has changed">
                outdated
              </Badge>
            )}
            <span className="flex-1 truncate text-[10px] text-dim">{n.updatedAt}</span>
            <IconButton label="Delete note" size="sm" onClick={() => onDelete(n.id)}>
              ×
            </IconButton>
          </div>
          <div className="mt-0.5 whitespace-pre-wrap text-fg">{n.body}</div>
        </div>
      ))}

      {composing && (
        <div className="flex flex-col gap-1 py-1">
          <textarea
            ref={taRef}
            className="w-full resize-y rounded border border-edge bg-bg px-2 py-1 text-[13px] text-fg outline-none focus-visible:border-accent"
            rows={2}
            placeholder="Add a note for this line…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraft('');
                onCancel();
              } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              onClick={() => {
                setDraft('');
                onCancel();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={!draft.trim()} onClick={submit}>
              Add note
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
