import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, EmptyState, Panel, PanelBody, PanelHeader, Row, cn } from '../ui';
import { useActiveBeads, useBeadsStore } from './beadsStore';
import {
  childrenOf,
  deriveState,
  edgesFor,
  isTerminal,
  openChildCount,
  priorityLabel,
  STATE_TONE,
  type IssueEdges,
} from './graphSelectors';
import type { BeadsComment, BeadsIssue } from '@shared/ipc/channels';
import { RenderedMarkdown } from '../content';
import { useProjectsStore } from '../providerClient';

/** Shared inline error line (D-2: br's message shown verbatim next to the
 *  control that failed). */
function InlineError({ message }: { message: string }): JSX.Element {
  return <p className="whitespace-pre-wrap break-words text-[11px] text-removed">{message}</p>;
}

const INPUT_CLASS = cn(
  'w-full rounded border border-edge bg-bg px-2 py-1 text-[13px] text-fg',
  'outline-none placeholder:text-dim hover:border-accent focus-visible:ring-2 focus-visible:ring-accent/60',
);

/** Detail view for the issue selected in the workgraph panel. */
export function TaskDetail(): JSX.Element {
  const { graph, selectedId } = useActiveBeads();
  const selectAction = useBeadsStore((s) => s.select);
  const activeId = useProjectsStore((s) => s.activeId);
  const select = (id: string): void => {
    if (activeId) selectAction(activeId, id);
  };

  const issue =
    graph != null && selectedId != null
      ? graph.issues.find((i) => i.id === selectedId) ?? null
      : null;

  if (issue == null) {
    return (
      <Panel>
        <PanelHeader title="Task" />
        <PanelBody>
          <EmptyState title="No task selected" hint="Select an issue from the workgraph." />
        </PanelBody>
      </Panel>
    );
  }

  const edges = graph != null ? edgesFor(graph, issue.id) : { blocks: [], blockedBy: [], parents: [] };
  const children = graph != null ? childrenOf(graph, issue.id) : [];
  const openChildren = graph != null ? openChildCount(graph, issue) : 0;
  const statusTone = graph != null ? STATE_TONE[deriveState(graph, issue)] : 'accent';

  return (
    <Panel>
      <PanelHeader title={issue.id} />
      <PanelBody className="flex flex-col gap-3 p-2">
        <header className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-fg">{issue.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone}>{issue.status}</Badge>
            <Badge>{priorityLabel(issue.priority)}</Badge>
            <Badge>{issue.issueType}</Badge>
          </div>
        </header>

        {issue.labels.length > 0 && (
          <section aria-label="Labels" className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <Badge key={label}>{label}</Badge>
            ))}
          </section>
        )}

        {issue.body.trim().length > 0 && (
          <section aria-label="Description">
            <RenderedMarkdown source={issue.body} compact linkContext={{ projectId: activeId }} />
          </section>
        )}

        <EdgeList title="Blocked by" issues={edges.blockedBy} onSelect={select} markComplete />
        <EdgeList title="Blocks" issues={edges.blocks} onSelect={select} />
        <EdgeList title="Parent" issues={edges.parents} onSelect={select} />
        <EdgeList
          title={openChildren > 0 ? `Children (${openChildren} open)` : 'Children'}
          issues={children}
          onSelect={select}
        />

        <LifecycleSection issue={issue} />
        <CommentsSection issueId={issue.id} />
        <AddChildSection parentId={issue.id} />
      </PanelBody>
    </Panel>
  );
}

/** Section heading used by the write sections. */
function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return <div className="text-[11px] uppercase tracking-wide text-dim">{children}</div>;
}

/** Close (with optional reason) or Reopen the bead, depending on status. */
function LifecycleSection({ issue }: { issue: BeadsIssue }): JSX.Element | null {
  const activeId = useProjectsStore((s) => s.activeId);
  const beadsClose = useBeadsStore((s) => s.beadsClose);
  const beadsReopen = useBeadsStore((s) => s.beadsReopen);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activeId) return null;
  const closed = isTerminal(issue.status);

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setPending(true);
    setError(null);
    const err = await fn();
    setPending(false);
    if (err) setError(err);
    else setReason('');
  };

  return (
    <section aria-label="Lifecycle" className="flex flex-col gap-1.5 border-t border-edge pt-2">
      <SectionTitle>Lifecycle</SectionTitle>
      {closed ? (
        <Button
          size="sm"
          disabled={pending}
          onClick={() => void run(() => beadsReopen(activeId, issue.id))}
        >
          {pending ? 'Reopening…' : 'Reopen bead'}
        </Button>
      ) : (
        <>
          <input
            aria-label="Close reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className={INPUT_CLASS}
          />
          <Button
            size="sm"
            variant="primary"
            disabled={pending}
            onClick={() => void run(() => beadsClose(activeId, issue.id, reason.trim() || undefined))}
          >
            {pending ? 'Closing…' : 'Close bead'}
          </Button>
        </>
      )}
      {error && <InlineError message={error} />}
    </section>
  );
}

/** Lists comments and offers an inline add form. */
function CommentsSection({ issueId }: { issueId: string }): JSX.Element | null {
  const activeId = useProjectsStore((s) => s.activeId);
  const beadsComment = useBeadsStore((s) => s.beadsComment);
  const beadsListComments = useBeadsStore((s) => s.beadsListComments);
  const [comments, setComments] = useState<BeadsComment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!activeId) return;
    const res = await beadsListComments(activeId, issueId);
    setComments(res.comments);
    setLoadError(res.error);
  }, [activeId, issueId, beadsListComments]);

  // Reload comments whenever the selected issue changes.
  useEffect(() => {
    setText('');
    setError(null);
    void reload();
  }, [reload]);

  if (!activeId) return null;

  const submit = async (): Promise<void> => {
    const message = text.trim();
    if (!message) return;
    setPending(true);
    setError(null);
    const err = await beadsComment(activeId, issueId, message);
    setPending(false);
    if (err) setError(err);
    else {
      setText('');
      void reload();
    }
  };

  return (
    <section aria-label="Comments" className="flex flex-col gap-1.5 border-t border-edge pt-2">
      <SectionTitle>Comments</SectionTitle>
      {loadError && <InlineError message={loadError} />}
      {comments.length === 0 && !loadError ? (
        <p className="text-[12px] text-dim">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {comments.map((c) => (
            <li key={c.id} className="rounded border border-edge bg-panel px-2 py-1">
              <div className="flex items-center gap-2 text-[11px] text-dim">
                <span className="font-medium text-fg">{c.author || 'unknown'}</span>
                {c.createdAt && <span>{c.createdAt}</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-[12px] text-fg">{c.text}</p>
            </li>
          ))}
        </ul>
      )}
      <textarea
        aria-label="Add comment"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Add a comment…"
        rows={2}
        className={cn(INPUT_CLASS, 'resize-y')}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={pending || text.trim() === ''} onClick={() => void submit()}>
          {pending ? 'Adding…' : 'Add comment'}
        </Button>
        {error && <InlineError message={error} />}
      </div>
    </section>
  );
}

/** Inline form to create a child bead under the selected issue. */
function AddChildSection({ parentId }: { parentId: string }): JSX.Element | null {
  const activeId = useProjectsStore((s) => s.activeId);
  const beadsCreate = useBeadsStore((s) => s.beadsCreate);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Collapse the form when switching to a different parent issue.
  useEffect(() => {
    setOpen(false);
    setTitle('');
    setDescription('');
    setError(null);
  }, [parentId]);

  if (!activeId) return null;

  const submit = async (): Promise<void> => {
    const t = title.trim();
    if (!t) return;
    setPending(true);
    setError(null);
    const err = await beadsCreate(activeId, {
      title: t,
      parent: parentId,
      priority,
      description: description.trim() || undefined,
    });
    setPending(false);
    if (err) {
      setError(err);
      return;
    }
    setTitle('');
    setDescription('');
    setOpen(false);
  };

  return (
    <section aria-label="Add child bead" className="flex flex-col gap-1.5 border-t border-edge pt-2">
      <SectionTitle>Add child bead</SectionTitle>
      {!open ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          + Add child
        </Button>
      ) : (
        <>
          <input
            aria-label="Child title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title (required)"
            className={INPUT_CLASS}
          />
          <label className="flex items-center gap-2 text-[12px] text-dim">
            Priority
            <select
              aria-label="Child priority"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className={cn(INPUT_CLASS, 'w-auto')}
            >
              {[0, 1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </label>
          <textarea
            aria-label="Child description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className={cn(INPUT_CLASS, 'resize-y')}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={pending || title.trim() === ''} onClick={() => void submit()}>
              {pending ? 'Creating…' : 'Create'}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {error && <InlineError message={error} />}
          </div>
        </>
      )}
    </section>
  );
}

interface EdgeListProps {
  title: string;
  issues: IssueEdges['blocks'];
  onSelect: (id: string) => void;
  /** Strike through + dim items whose status is terminal (a completed blocker no
   *  longer blocks). Used by the "Blocked by" list. */
  markComplete?: boolean;
}

function EdgeList({ title, issues, onSelect, markComplete = false }: EdgeListProps): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-dim">{title}</div>
      <div role="list">
        {issues.map((dep: BeadsIssue) => {
          const done = markComplete && isTerminal(dep.status);
          return (
            <Row
              key={dep.id}
              role="listitem"
              onClick={() => onSelect(dep.id)}
              className={cn(done && 'opacity-60')}
              prefix={<Badge>{dep.id}</Badge>}
            >
              <span className={cn(done && 'line-through')}>{dep.title}</span>
            </Row>
          );
        })}
      </div>
    </section>
  );
}
