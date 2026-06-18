import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { parsePatch } from './parsePatch';
import { resolveLanguage } from './highlight/languages';
import { tokenizeLines, type TokenLine, type TokenizeResult } from './highlight/highlighter';
import { CodeLineTokens } from './highlight/CodeTokens';
import { LineNoteThread, lineNotesByLine, useNotesStore } from '../notes';
import { pickTokenLine } from './diffTokens';
import type { ThemeId } from '@shared/settings';

interface DiffViewProps {
  patch: string;
  emptyHint?: string;
  onHunkClick?: (hunkIndex: number) => void;
  /** When provided, enables per-line Shiki highlighting by fetching full old/new content. */
  filePath?: string;
  worktreePath?: string;
  baseline?: string;
}

/** Tokenize both sides of a diff for a supported language. Returns null on any failure. */
async function tokenizeBothSides(
  filePath: string,
  baseline: string | undefined,
  theme: ThemeId,
): Promise<{ old: TokenLine[] | null; new: TokenLine[] | null } | null> {
  const lang = resolveLanguage(filePath);
  if (!lang) return null;
  // Capture in a non-null local so the nested async function can close over it.
  const resolvedLang = lang;

  const SIZE_LIMIT = 256 * 1024;

  async function readSide(opts: { ref?: string }): Promise<TokenizeResult | null> {
    try {
      const r = await window.api.provider.readFile(filePath, opts);
      if (r.content === null || r.truncated || r.isBinary || r.sizeBytes > SIZE_LIMIT) return null;
      return await tokenizeLines(r.content, resolvedLang, theme);
    } catch {
      return null;
    }
  }

  const [oldResult, newResult] = await Promise.all([
    baseline ? readSide({ ref: baseline }) : Promise.resolve(null),
    readSide({}),
  ]);

  // If we have neither side, no point highlighting.
  if (!oldResult && !newResult) return null;

  return {
    old: oldResult?.lines ?? null,
    new: newResult?.lines ?? null,
  };
}

export function DiffView({
  patch,
  emptyHint,
  onHunkClick,
  filePath,
  baseline,
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
    // Only attempt highlighting when filePath is provided and language is supported.
    if (!filePath || !resolveLanguage(filePath)) {
      setTokenSides(null);
      return;
    }
    let active = true;
    setTokenSides(null);
    void tokenizeBothSides(filePath, baseline, theme).then((result) => {
      if (active) setTokenSides(result);
    });
    return () => {
      active = false;
    };
  }, [filePath, baseline, theme]);

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
                  <div style={{ display: 'flex', background: color, whiteSpace: 'pre' }}>
                    <span
                      style={{
                        width: 50,
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
                    <span style={{ paddingLeft: 8 }}>
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
