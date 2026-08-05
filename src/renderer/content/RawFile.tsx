import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { useProjectsStore } from '../providerClient';
import { resolveLanguage } from './highlight/languages';
import { useHighlightedTokens } from './highlight/useHighlightedTokens';
import { CodeLineTokens } from './highlight/CodeTokens';
import { lineNotesByLine, useNotesStore } from '../notes';
import { BinaryPlaceholder } from './BinaryPlaceholder';
import { CodeRow } from './CodeRow';

/**
 * RawFile's classification of a path's bytes once its ONE `readFile` call
 * resolves — see the `onBinaryConfirmed` prop doc comment below. Mirrors this
 * component's own `state` kinds one-for-one (minus `'loading'`). `'text'`
 * carries `sizeBytes` too (local_repo_explorer-jp2f.4; previously no
 * payload) — its first consumer is ContentViewer's structural-fold size
 * degrade (`effectiveCls`), which needs a confirmed-text json/yaml file's
 * size to decide whether it is over the `structuredFoldMaxMb` threshold,
 * without a second read. A caller that only needs to know content IS text
 * (not its size) can still ignore the field.
 */
export type RawFileConfirmation =
  | { kind: 'text'; sizeBytes: number }
  | { kind: 'binary'; sizeBytes: number }
  | { kind: 'too-large'; sizeBytes: number }
  | { kind: 'missing' };

interface RawFileProps {
  worktreePath: string;
  filePath: string;
  /** Git ref to read the file at instead of the working tree. `ref` is a
   *  reserved React prop name, so this is exposed as `gitRef`. */
  gitRef?: string;
  /**
   * Read-cap override (bytes), forwarded verbatim as the read's
   * `FileReadOptions.maxBytes`. Only ever set by ContentViewer, and only for a
   * json/yaml-classed path (see `structuredFoldReadMaxBytes` in
   * src/shared/settings.ts) — raises this read's cap above the default so the
   * structural-fold size degrade can observe a confirmed-text file over the
   * `structuredFoldMaxMb` threshold instead of always being refused first by
   * the smaller default cap. `undefined` for every other class, leaving the
   * default cap completely unchanged.
   */
  maxBytes?: number;
  /** Soft-wrap long lines instead of scrolling horizontally. */
  wrap?: boolean;
  /**
   * Presentation switch (see the doc comment on {@link RawText}): `true`
   * (Rendered) tokenizes via Shiki when the file's language is supported;
   * `false` (Raw) always shows plain, unhighlighted text and performs NO
   * tokenization work. Defaults to `true` (this component's pre-existing
   * behavior) for any caller that predates this switch; ContentViewer always
   * passes it explicitly, derived from the active content mode.
   */
  highlight?: boolean;
  /**
   * Reports this file's {@link RawFileConfirmation} once its ONE `readFile`
   * call (below) resolves. Fires regardless of `highlight` — RawFile reads
   * unconditionally, so this is the earliest and only point the
   * classification is known at runtime. ContentViewer passes a state setter
   * directly — a stable reference across renders (React guarantees
   * `useState` setter identity), which is what lets this sit in the read
   * effect's dependency array below without ever re-triggering the read.
   *
   * Two independent consumers, both in ContentViewer.tsx:
   *  - `kind === 'binary'` upgrades the effective content class to
   *    `'generic-binary'` (drops Raw, defaults to Diff) — see
   *    ContentViewer.tsx and modeSwitcher.tsx's module doc comment.
   *    `'too-large'`/`'missing'` never reclassify: both already have a
   *    reasonable Raw-mode message (see the `state` switch below), unlike
   *    true binary content's terse, unhelpful "Binary file (N)" line.
   *  - ALL non-`'text'` kinds (including the size for binary/too-large) are
   *    threaded to DiffView as its `knownReason`/`knownSize` props, so Diff
   *    mode can show the same graceful placeholder — with the right reason —
   *    even when the diff patch text itself carries no signal at all (an
   *    unmodified or untracked file's patch is empty; see parsePatch.ts's
   *    `binary` field doc comment). This is what fixes an unmodified/
   *    untracked binary file opened from the Explorer: it lands on Raw first
   *    regardless (see modeSwitcher.tsx's `defaultModeFor`), so this callback
   *    still fires and reclassifies before the user ever sees Raw's terse
   *    one-liner.
   *
   * Never itself triggers a second read — this only ever reports the outcome
   * of the read RawFile was already going to make.
   */
  onBinaryConfirmed?: (confirmation: RawFileConfirmation) => void;
}

/**
 * Reads and displays a file's content — the single shared component behind
 * BOTH the text-like Rendered and Raw content modes (modeSwitcher.tsx's
 * VIEW_DISPATCH maps both to this component; ContentViewer distinguishes them
 * only via the `highlight` prop). The file is read exactly ONCE regardless of
 * which presentation is showing or how many times the two are toggled — the
 * effect below depends only on `worktreePath`/`filePath`/`gitRef` (plus the
 * always-stable `onBinaryConfirmed` setter — see its doc comment above),
 * never on `highlight` or `wrap`. That one read is also the sole runtime
 * source of confirmed binary-ness, reported upward via `onBinaryConfirmed`.
 *
 * Settled distinction (see RawText's doc comment for the mechanism; do not
 * re-litigate): Rendered is the nicest available presentation for this type;
 * Raw is the plainest.
 */
export function RawFile({
  worktreePath,
  filePath,
  gitRef,
  maxBytes,
  wrap = false,
  highlight = true,
  onBinaryConfirmed,
}: RawFileProps): JSX.Element {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'text'; content: string }
    | { kind: 'binary'; sizeBytes: number }
    | { kind: 'too-large'; sizeBytes: number }
    | { kind: 'missing' }
  >({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    const opts: { ref?: string; worktreePath?: string; maxBytes?: number } = { worktreePath };
    if (gitRef !== undefined) opts.ref = gitRef;
    if (maxBytes !== undefined) opts.maxBytes = maxBytes;
    void window.api.provider.readFile(filePath, opts).then((r) => {
      if (!active) return;
      // Each branch reports the SAME classification via both the local
      // `state` (this component's own rendering) and `onBinaryConfirmed`
      // (ContentViewer's copy) — identical branching to before, just
      // co-located instead of a separate trailing `onBinaryConfirmed?.(r.isBinary)`
      // call, so the two can never drift out of sync.
      if (r.content !== null) {
        setState({ kind: 'text', content: r.content });
        onBinaryConfirmed?.({ kind: 'text', sizeBytes: r.sizeBytes });
      } else if (r.truncated) {
        setState({ kind: 'too-large', sizeBytes: r.sizeBytes });
        onBinaryConfirmed?.({ kind: 'too-large', sizeBytes: r.sizeBytes });
      } else if (r.isBinary) {
        setState({ kind: 'binary', sizeBytes: r.sizeBytes });
        onBinaryConfirmed?.({ kind: 'binary', sizeBytes: r.sizeBytes });
      } else {
        setState({ kind: 'missing' });
        onBinaryConfirmed?.({ kind: 'missing' });
      }
    });
    return () => {
      active = false;
    };
    // `highlight`/`wrap` are deliberately excluded: toggling between Rendered
    // and Raw (or the Wrap setting) must never re-trigger this read.
    // `onBinaryConfirmed` IS included: ContentViewer always passes its
    // `setConfirmedBinary` state setter directly, a stable reference across
    // renders, so listing it here satisfies exhaustive-deps without ever
    // causing a spurious re-fetch. `maxBytes` IS included — deliberately
    // UNLIKE `highlight`/`wrap` above: a cap change (a live Preferences edit to
    // `structuredFoldMaxMb`) can turn a previously-refused read into a
    // successful one (or vice versa), so this must re-read rather than keep
    // serving an outcome computed under the old cap.
  }, [worktreePath, filePath, gitRef, maxBytes, onBinaryConfirmed]);

  switch (state.kind) {
    case 'loading':
      return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading…</div>;
    case 'binary':
      // Rendered (highlight=true) gets the graceful, Download-pointing
      // placeholder; Raw keeps its original terse message unchanged —
      // generic-binary has no Raw mode in its class shape (modeSwitcher.tsx),
      // so Raw's behavior here is deliberately out of this issue's scope.
      // See BinaryPlaceholder.tsx's doc comment.
      return highlight ? (
        <BinaryPlaceholder mode="rendered" reason="binary" size={state.sizeBytes} />
      ) : (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          Binary file ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'too-large':
      return highlight ? (
        <BinaryPlaceholder mode="rendered" reason="too-large" size={state.sizeBytes} />
      ) : (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>
          File too large to display inline ({fmtSize(state.sizeBytes)}).
        </div>
      );
    case 'missing':
      return highlight ? (
        <BinaryPlaceholder mode="rendered" reason="missing" />
      ) : (
        <div style={{ padding: 16, color: 'var(--fg-dim)' }}>File not found at ref.</div>
      );
    case 'text':
      return <RawText content={state.content} filePath={filePath} wrap={wrap} highlight={highlight} />;
  }
}

/**
 * Renders the text case as per-line rows (line-number gutter + code), used by
 * BOTH presentations:
 *
 *  - Rendered (`highlight=true`): the nicest available presentation — progressive
 *    Shiki tokenization when the file extension maps to a supported language
 *    (see highlight/languages.ts), with the existing plain-text fallback while
 *    tokens aren't ready yet or the language is unsupported.
 *  - Raw (`highlight=false`): the plainest presentation — always the plain-text
 *    fallback. This is not merely a display choice: passing `lang = null` into
 *    `useHighlightedTokens` when `highlight` is false takes that hook's own
 *    documented no-op branch (no `tokenizeLines` call — no Shiki, no worker
 *    post, no cache lookup), so Raw performs NO tokenization work at all. It is
 *    the same "unsupported language" code path this component already used,
 *    just entered intentionally instead of by an unresolved extension.
 *
 * Each line is a note anchor in both presentations: the gutter adds a note,
 * and existing notes render inline beneath the line as a `LineNoteThread`.
 * The actual row/gutter/note markup (and the Content-panel gutter-alignment
 * invariant in CLAUDE.md) now lives in the shared {@link CodeRow} primitive —
 * also consumed by FoldingView.tsx's `renderRow` — rather than being
 * authored here; see CodeRow.tsx for the one authoring site.
 */
function RawText({
  content,
  filePath,
  wrap,
  highlight,
}: {
  content: string;
  filePath: string;
  wrap: boolean;
  highlight: boolean;
}): JSX.Element {
  const theme = useSettingsStore((s) => s.settings.theme);
  const lang = resolveLanguage(filePath);
  // Passing `null` when `highlight` is false is the load-bearing line: it hits
  // useHighlightedTokens's own early-return branch, so Raw skips tokenization
  // entirely rather than computing and discarding it.
  const hl = useHighlightedTokens(content, highlight ? lang : null, theme);

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
  // Re-check `highlight` here too, not just via the hook's own lang===null
  // gate: if `highlight` flips true→false, `hl` can still read a stale
  // 'ready' state for one render until the hook's effect catches up. Gating
  // the render output on `highlight` directly means Raw can never flash
  // highlighted tokens from a moment ago.
  const tokenLines = highlight && lang !== null && hl.state === 'ready' ? hl.lines : null;

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
          <CodeRow
            key={i}
            line={lineNo}
            wrap={wrap}
            notes={lineNotes}
            composing={open}
            liveText={text}
            onAddNote={setComposing}
            onSubmitNote={(body) => {
              void addLineNote(filePath, lineNo, text, body);
              setComposing(null);
            }}
            onCancelNote={() => setComposing(null)}
            onDeleteNote={(id) => void removeNote(id)}
          >
            {tokenLines?.[i] ? <CodeLineTokens line={tokenLines[i]} /> : text}
          </CodeRow>
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
