import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { resolveLanguage } from './highlight/languages';
import { useHighlightedTokens } from './highlight/useHighlightedTokens';
import { CodeLineTokens } from './highlight/CodeTokens';
import { LineNoteGutter, LineNoteThread, lineNotesByLine, useNotesStore } from '../notes';

interface RawFileProps {
  worktreePath: string;
  filePath: string;
  /** Git ref to read the file at instead of the working tree. `ref` is a
   *  reserved React prop name, so this is exposed as `gitRef`. */
  gitRef?: string;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
}

export function RawFile({ worktreePath, filePath, gitRef, wrap = false }: RawFileProps): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'text'; content: string }
    | { kind: 'binary'; sizeBytes: number }
    | { kind: 'too-large'; sizeBytes: number }
    | { kind: 'missing' }
  >({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    const opts: { ref?: string } = {};
    if (gitRef !== undefined) opts.ref = gitRef;
    void window.api.provider.readFile(filePath, opts).then((r) => {
      if (!active) return;
      if (r.content !== null) setState({ kind: 'text', content: r.content });
      else if (r.truncated) setState({ kind: 'too-large', sizeBytes: r.sizeBytes });
      else if (r.isBinary) setState({ kind: 'binary', sizeBytes: r.sizeBytes });
      else setState({ kind: 'missing' });
    });
    return () => {
      active = false;
    };
  }, [worktreePath, filePath, gitRef]);

  switch (state.kind) {
    case 'loading':
      return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>;
    case 'binary':
      return (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          Binary file ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'too-large':
      return (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          File too large to display inline ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'missing':
      return <div style={{ padding: 16, color: 'var(--fg-dim)' }}>File not found at ref.</div>;
    case 'text':
      return <RawText content={state.content} filePath={filePath} wrap={wrap} />;
  }
}

/** Renders the text case as per-line rows (line-number gutter + code) with
 *  progressive Shiki highlighting when the file extension maps to a supported
 *  language, falling back to plain text per line otherwise. Each line is a note
 *  anchor: the gutter adds a note, and existing notes render inline beneath the
 *  line as a {@link LineNoteThread}. */
function RawText({
  content,
  filePath,
  wrap,
}: {
  content: string;
  filePath: string;
  wrap: boolean;
}): JSX.Element {
  const theme = useSettingsStore((s) => s.settings.theme);
  const lang = resolveLanguage(filePath);
  const hl = useHighlightedTokens(content, lang, theme);

  const notes = useNotesStore((s) => s.notes);
  const load = useNotesStore((s) => s.load);
  const addLineNote = useNotesStore((s) => s.addLineNote);
  const removeNote = useNotesStore((s) => s.remove);
  const activeId = useProjectsStore((s) => s.activeId);
  const [composing, setComposing] = useState<number | null>(null);

  // Load the active project's notes so this file's anchors render even when the
  // Notes panel is closed (idempotent; the store holds one slice per project).
  useEffect(() => {
    void load();
  }, [activeId, load]);

  const textLines = useMemo(() => content.split('\n'), [content]);
  const notesByLine = useMemo(() => lineNotesByLine(notes, filePath), [notes, filePath]);
  const tokenLines = lang !== null && hl.state === 'ready' ? hl.lines : null;

  const containerStyle = {
    margin: 0,
    paddingTop: 8,
    paddingBottom: 8,
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--mono-size)',
    background: (tokenLines && hl.state === 'ready' && hl.bg) || 'var(--bg)',
    color: (tokenLines && hl.state === 'ready' && hl.fg) || 'var(--fg)',
    overflow: 'auto',
    height: '100%',
  };

  return (
    <div style={containerStyle}>
      {textLines.map((text, i) => {
        const lineNo = i + 1;
        const lineNotes = notesByLine.get(lineNo) ?? [];
        const open = composing === lineNo;
        return (
          <div key={i}>
            {/* No-wrap: minWidth:max-content extends the row so long lines scroll
                in the outer container while the shrink-0 gutter stays aligned.
                Wrap: pre-wrap + the code span breaking long tokens (minWidth:0,
                overflowWrap:anywhere) so lines wrap within the panel; the gutter
                stays aligned with the first visual row. */}
            <div
              style={{
                display: 'flex',
                whiteSpace: wrap ? 'pre-wrap' : 'pre',
                ...(wrap ? {} : { minWidth: 'max-content' }),
              }}
            >
              <LineNoteGutter line={lineNo} hasNotes={lineNotes.length > 0} onAdd={setComposing} />
              <span
                style={{
                  flex: '1 1 auto',
                  paddingLeft: 8,
                  ...(wrap ? { minWidth: 0, overflowWrap: 'anywhere' as const } : {}),
                }}
              >
                {tokenLines?.[i] ? <CodeLineTokens line={tokenLines[i]} /> : text}
              </span>
            </div>
            {(lineNotes.length > 0 || open) && (
              <LineNoteThread
                notes={lineNotes}
                liveText={text}
                composing={open}
                onSubmit={(body) => {
                  void addLineNote(filePath, lineNo, text, body);
                  setComposing(null);
                }}
                onCancel={() => setComposing(null)}
                onDelete={(id) => void removeNote(id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
