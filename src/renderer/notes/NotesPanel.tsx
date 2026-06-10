import { useEffect, useState } from 'react';
import { useNotesStore } from './notesStore';
import { useProjectsStore } from '../providerClient';
import { Badge, Button, EmptyState, IconButton, Panel, PanelBody, PanelHeader, Toolbar, ToolbarSpacer } from '../ui';

/** Local review notes for the active project, exportable as Markdown. */
export function NotesPanel(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const notes = useNotesStore((s) => s.notes);
  const load = useNotesStore((s) => s.load);
  const add = useNotesStore((s) => s.add);
  const remove = useNotesStore((s) => s.remove);
  const exportMarkdown = useNotesStore((s) => s.exportMarkdown);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void load();
  }, [activeId, load]);

  if (!activeId) {
    return (
      <Panel>
        <PanelHeader title="Notes" />
        <EmptyState title="No active project" hint="Notes attach to the active project." />
      </Panel>
    );
  }

  async function onExport(): Promise<void> {
    const md = await exportMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Panel>
      <PanelHeader
        title="Notes"
        actions={
          <Button size="sm" onClick={() => void onExport()}>
            {copied ? 'Copied ✓' : 'Export MD'}
          </Button>
        }
      />
      <Toolbar className="flex-col items-stretch gap-1">
        <textarea
          className="w-full resize-y rounded border border-edge bg-bg px-2 py-1 text-[13px] text-fg outline-none focus-visible:border-accent"
          rows={2}
          placeholder="Add a review note for this project…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="flex">
          <ToolbarSpacer />
          <Button
            size="sm"
            variant="primary"
            disabled={!draft.trim()}
            onClick={() => {
              void add(draft);
              setDraft('');
            }}
          >
            Add note
          </Button>
        </div>
      </Toolbar>
      <PanelBody>
        {notes.length === 0 ? (
          <EmptyState title="No notes yet" hint="Capture findings to hand back to the agent." />
        ) : (
          notes.map((n) => (
            <div key={n.id} className="border-b border-edge px-2 py-1.5">
              <div className="flex items-center gap-2">
                <Badge tone="accent">{n.targetKind}</Badge>
                <span className="flex-1 text-[10px] text-dim">{n.updatedAt}</span>
                <IconButton label="Delete note" size="sm" onClick={() => void remove(n.id)}>
                  ×
                </IconButton>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-[13px] text-fg">{n.body}</div>
            </div>
          ))
        )}
      </PanelBody>
    </Panel>
  );
}
