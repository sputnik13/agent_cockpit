import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelHeader, PanelBody, EmptyState, Spinner, IconButton, StatusDot } from '../ui';
import { agentCockpit, useProjectsStore } from '../providerClient';
import { useSettingsStore } from '@renderer/settings/settingsStore';
import { structuredFoldReadMaxBytes } from '@shared/settings';
import { subscribeWatch } from '../watch/hub';
import { normalizeWatchPath } from '@shared/watch/policy';
import { FindBar } from './FindBar';
import { useFindInContent } from './findInContent';
import { parsePatch } from './parsePatch';
import { changedLinesFromPatch } from './hunkMap';
import { DiffView } from './DiffView';
import { RawFile, type RawFileConfirmation } from './RawFile';
import { FoldingView } from './FoldingView';
import { ImageCompare } from './ImageCompare';
import { ImageView } from './ImageView';
import { HtmlPreview } from './HtmlPreview';
import { RenderedMarkdown } from './markdown';
import {
  ModeSwitcher,
  classOf,
  defaultModeFor,
  modesFor,
  viewFor,
  type ContentClass,
  type ContentMode,
} from './modeSwitcher';
import type { ContentSelection } from './selectionStore';

export function ContentViewer({ selection }: { selection: ContentSelection | null }): JSX.Element {
  if (selection == null) {
    return (
      <Panel>
        <PanelBody>
          <EmptyState title="No file selected" hint="Select a file in Changes or Explorer to view it." />
        </PanelBody>
      </Panel>
    );
  }
  return <FileContent key={`${selection.kind}:${selection.path}:${selection.baseline ?? ''}`} selection={selection} />;
}

function FileContent({ selection }: { selection: ContentSelection }): JSX.Element {
  const { path, worktreePath, baseline, kind } = selection;
  // An out-of-project file has no git baseline: skip the diff load entirely
  // (the provider resolves its absolute path directly). `modesFor`/
  // `defaultModeFor` fold this restriction into the one pure availability/
  // default computation below (see modeSwitcher.tsx) instead of a per-mode
  // filter living here.
  const external = kind === 'external-file';
  // Pure, path-only content-type class (markdown/html/image/text/
  // generic-binary). `classOf` never itself produces 'generic-binary' — see
  // modeSwitcher.tsx's module doc comment. `effectiveCls` below is the
  // runtime-aware value the render dispatch, wrappable, and findable all
  // actually key off; `cls` stays the pure baseline.
  const cls = classOf(path);
  const activeId = useProjectsStore((s) => s.activeId);
  // RawFile's own `readFile` result (its EXISTING read, never a new one —
  // see RawFile's `onBinaryConfirmed` doc comment), once known: text (now
  // carrying `sizeBytes` too — see RawFileConfirmation's doc comment), or one
  // of the three non-text outcomes RawFile already distinguishes for its own
  // rendering (binary/too-large/missing), carrying whatever size RawFile
  // already has. Three independent uses below:
  //  - `confirmedBinary` (kind === 'binary' only) upgrades `cls` to
  //    'generic-binary' for the rest of this file's lifetime — the ONLY
  //    binary reclassification signal, and what lets an Explorer-opened PDF
  //    (etc.) land on the graceful placeholder instead of staying on Raw's
  //    terse "Binary file (N)" line.
  //  - `oversizedStructured` (kind === 'text' on a json/yaml path, size over
  //    the `structuredFoldMaxMb` setting) downgrades `cls` to 'text' — see
  //    the `effectiveCls` comment below (local_repo_explorer-jp2f.4).
  //  - ALL non-'text' kinds feed DiffView's placeholder too (see
  //    `diffKnownReason`/`rawFileSize` below), so an unmodified/untracked
  //    binary file — whose diff patch carries no signal at all (parsePatch.ts's
  //    `binary` field doc comment) — still gets the graceful Diff placeholder
  //    instead of "No textual diff for this file.".
  const [rawConfirmation, setRawConfirmation] = useState<RawFileConfirmation | null>(null);
  const confirmedBinary = rawConfirmation?.kind === 'binary';
  // Structural-fold size threshold (MB), read live so a Preferences change
  // takes effect on the very next confirmation — no remount needed.
  const structuredFoldMaxMb = useSettingsStore((s) => s.settings.structuredFoldMaxMb);
  // Read cap (bytes) for json/yaml text reads — keyed on the PURE path class
  // `cls`, NEVER `effectiveCls`. This is load-bearing, not a style choice: once
  // the degrade below fires, `view` switches from 'folding-view' to 'raw-file'.
  // If that RawFile mount read with the DEFAULT (smaller) cap instead of this
  // raised one, it would report 'too-large', which un-sets `oversizedStructured`
  // (it requires `kind === 'text'`) — flipping `effectiveCls` back to json/yaml,
  // remounting FoldingView, which reports 'text' again, degrading again: an
  // infinite mount loop. Keying on `cls` gives the SAME file the SAME cap in
  // every mode (folding, degraded-rendered, and Raw), so the state machine is
  // stable. See `structuredFoldReadMaxBytes`'s doc comment (src/shared/
  // settings.ts) for the cap formula. `undefined` for every non-json/yaml
  // class, leaving the default read cap completely unchanged for them.
  // Live-read: a Preferences change takes effect on the next read, same
  // discipline as `structuredFoldMaxMb` above.
  const structuredReadMaxBytes =
    cls === 'json' || cls === 'yaml' ? structuredFoldReadMaxBytes(structuredFoldMaxMb) : undefined;
  // An over-threshold json/yaml file whose bytes are CONFIRMED text degrades
  // to 'text'. This mirrors `confirmedBinary` above and is why it lives HERE
  // rather than in `classOf` (modeSwitcher.tsx): `classOf` is pure and
  // path-only by design (see its module doc comment — "True binary-ness is
  // instead resolved at RUNTIME, by the component that actually reads the
  // file's bytes"), and a size threshold is exactly as unknowable from the
  // path alone as binary-ness is — it can only be decided once RawFile's read
  // reports a real `sizeBytes`. Guarding on `rawConfirmation?.kind ===
  // 'text'` (rather than e.g. `!== 'binary'`) is deliberate: it is the ONLY
  // confirmation kind whose size means "this really is parseable json/yaml
  // text" — 'missing' carries no size at all, and an as-yet-unconfirmed
  // `null` must not degrade either. Both are "unknown", and unknown is never
  // treated as over-threshold.
  const oversizedStructured =
    (cls === 'json' || cls === 'yaml') &&
    rawConfirmation?.kind === 'text' &&
    rawConfirmation.sizeBytes > structuredFoldMaxMb * 1024 * 1024;
  // `effectiveCls` is the runtime-aware value the render dispatch,
  // wrappable, and findable all actually key off; `cls` stays the pure
  // baseline. Ordered so `confirmedBinary` wins outright over the size
  // degrade: a json/yaml-PATH file whose bytes turn out to be binary must
  // still land on the binary placeholder, never the size-degraded text view.
  // Neither reclassification perturbs `available`/`effectiveMode` below:
  // CLASS_MODES (modeSwitcher.tsx) gives 'json'/'yaml'/'text' the identical
  // 3-mode array, so the mode switcher never visibly changes across this
  // degrade — only `view` (and therefore which component renders) does.
  const effectiveCls: ContentClass = confirmedBinary
    ? 'generic-binary'
    : oversizedStructured
      ? 'text'
      : cls;
  // Resolve relative links in the viewed file against the file's own directory.
  const linkBase = useMemo(() => {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash) : '';
  }, [path]);
  const available = useMemo(
    () => modesFor(path, kind, confirmedBinary),
    [path, kind, confirmedBinary],
  );
  // Global last-picked mode (persisted setting; `null` when none has ever
  // been explicitly chosen). Consulted ONLY at mount, in the `useState`
  // seed below.
  const rememberedMode = useSettingsStore((s) => s.settings.contentMode);
  const [mode, setMode] = useState<ContentMode>(() =>
    // Seed from the remembered global preference when it's a valid mode for
    // THIS selection's class — the SAME `available.includes(...)` membership
    // check `effectiveMode` performs below, not a duplicated check. Otherwise
    // fall back to today's per-class default exactly as before. This
    // initializer runs once per mount, and `FileContent` remounts per
    // selection (see ContentViewer's `key={kind:path:baseline}`), so a new
    // file/selection always re-evaluates the seed fresh.
    rememberedMode != null && available.includes(rememberedMode)
      ? rememberedMode
      : defaultModeFor(path, kind),
  );
  // `mode` tracks the user's last explicit tab choice (or the seed above).
  // Reclassification can drop that choice from `available` (e.g. an
  // Explorer-opened file defaults to 'raw', and generic-binary drops raw
  // entirely) — `effectiveMode` corrects for that WITHIN THE SAME RENDER (a
  // synchronous derivation, not a follow-up effect), so the very first paint
  // after confirmation already shows the graceful placeholder instead of
  // flashing Raw's terse one-liner first. This is a DISPLAY correction only —
  // it never calls `setMode` and is therefore never persisted as if it were a
  // user choice. `setMode` (via ModeSwitcher's onChange below, wired through
  // `handleModeChange` which also persists the choice) still writes the real
  // preference, so a later manual switch is unaffected.
  const effectiveMode = available.includes(mode) ? mode : defaultModeFor(path, kind, confirmedBinary);
  const [diff, setDiff] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; patch: string; oldContent: string | null; newContent: string | null }
  >({ kind: 'loading' });

  // Manual-refresh support (local_repo_explorer-r97u): the panel never
  // auto-reloads a displayed file on a disk change (deliberate — see the
  // issue body), but a Refresh click must force a REAL re-read everywhere,
  // not just a re-render. `refreshToken` is included in this effect's and
  // the markdown-source effect's own deps below (so THEY refetch), and is
  // also used to key-remount whichever child view owns its OWN internal
  // fetch (RawFile/FoldingView/ImageCompare/ImageView/HtmlPreview) so each
  // independently re-reads too. `stale` is a passive indicator only — it
  // never triggers a reload by itself.
  const [refreshToken, setRefreshToken] = useState(0);
  const [stale, setStale] = useState(false);
  const refresh = (): void => {
    setStale(false);
    setRefreshToken((t) => t + 1);
  };
  // Reset staleness when the selection itself changes underneath an
  // otherwise-stable FileContent instance is not needed here: ContentViewer
  // remounts FileContent per selection (its own `key` above), so a fresh
  // mount always starts with `stale=false`.
  useEffect(() => {
    // An external (out-of-project) file has no git tree membership, so a
    // working-tree watch path can never match it — no subscription needed.
    if (external) return;
    const targetPath = normalizeWatchPath(path);
    return subscribeWatch({
      interest: ['working-tree'],
      onEvent: (event) => {
        // Mirrors FoldingView.tsx's invalidateForWatchPaths matching: an
        // untagged event is root-relative (this selection's own worktree is
        // ''/root), a worktreePath-tagged event must match this selection's
        // OWN worktree exactly. No projectId gating — worktree paths are
        // globally unique across projects (same rationale as that
        // precedent), and this selection carries no projectId of its own.
        const matchesWorktree =
          worktreePath === '' ? event.worktreePath === undefined : event.worktreePath === worktreePath;
        if (!matchesWorktree) return;
        if (event.paths.some((p) => normalizeWatchPath(p) === targetPath)) setStale(true);
      },
    });
  }, [external, worktreePath, path]);

  // Load the diff BUNDLE once per file: the patch plus both sides' content for
  // highlighting, in ONE provider round trip (was getFileDiff + 2× readFile —
  // three serialized SSH round trips on remote). Skipped for out-of-project
  // files, which have no git baseline. Also re-runs on a manual refresh
  // (`refreshToken`).
  useEffect(() => {
    if (external) {
      setDiff({ kind: 'ready', patch: '', oldContent: null, newContent: null });
      return;
    }
    let active = true;
    setDiff({ kind: 'loading' });
    void agentCockpit.provider.getDiffBundle(worktreePath, path, baseline).then((b) => {
      if (active) setDiff({ kind: 'ready', patch: b.patch, oldContent: b.oldContent, newContent: b.newContent });
    });
    return () => {
      active = false;
    };
  }, [external, worktreePath, path, baseline, refreshToken]);

  // Parsed once, for `changedLineSet` below. (DiffView separately parses the
  // raw `patch` string prop itself — see its own doc comment — so this is a
  // ContentViewer-only parse, not a dedupe across components.)
  const parsedDiff = useMemo(
    () => (diff.kind === 'ready' ? parsePatch(diff.patch) : null),
    [diff],
  );
  const changedLineSet = useMemo(() => {
    if (!parsedDiff) return undefined;
    return changedLinesFromPatch(parsedDiff);
  }, [parsedDiff]);

  // Diff mode's placeholder REASON, independent of size: git's own
  // "Binary files … differ" signal (parsed.binary, DiffView's own concern —
  // unchanged) is one source; this is the ADDITIONAL one, for when the patch
  // text carries no signal at all but RawFile has independently confirmed
  // (via `rawConfirmation` above) that this path isn't plain text. Never
  // derived for 'text' — nothing to show a placeholder for.
  const diffKnownReason =
    rawConfirmation && rawConfirmation.kind !== 'text' ? rawConfirmation.kind : undefined;

  // Diff mode's placeholder SIZE. Sourced SOLELY from RawFile's OWN
  // already-fetched `readFile` result, whenever it has mounted
  // (`rawFileSize`) — the dominant case: RawFile mounts BEFORE Diff for
  // every Explorer (kind:'file') selection (see modeSwitcher.tsx's
  // `defaultModeFor` — 'file' defaults to Raw, only reclassifying to Diff
  // once confirmed; see `effectiveMode` below), which covers the real-world
  // case this issue exists to fix — an untracked/unmodified binary file
  // opened from the Explorer, where the diff bundle carries no size field on
  // either transport (getDiffBundle computes `sizeBytes` internally then
  // discards it — see electron/main/providers/local/index.ts).
  //
  // There is ONE remaining gap: a `kind: 'change'` selection where the patch
  // ALREADY signals `parsedDiff.binary` (a real, git-confirmed change) but
  // Diff is the FIRST (and, for that kind, only ever shown) mode (see
  // `defaultModeFor` — 'change' defaults straight to Diff), so RawFile never
  // mounts and `rawConfirmation` stays null. `knownSize` is simply undefined
  // in that case — BinaryPlaceholder already renders gracefully with no
  // size (it still shows the changed-statement and the Download pointer).
  //
  // This is deliberate, not an oversight: an earlier version filled that gap
  // with one extra `provider.readFile` call, gated on `parsedDiff.binary`.
  // Two review passes found real, unfixed-by-narrowing problems with it:
  //  - it fired even on REMOTE, where `readFile` has no metadata-only path
  //    (electron/main/providers/remote/index.ts + remote-helper/commands.go
  //    always read up to a 2 MiB cap and ship it over SSH) — a real, if
  //    capped, byte transfer purely to render a placeholder, which is
  //    exactly what this issue's own guardrail ("do not read whole bytes
  //    just to render a placeholder") and AC5 ("rendering a placeholder does
  //    not trigger a full-file read on remote") rule out — regardless of
  //    whether the resulting number was then trusted or discarded by a
  //    later "is this a genuine metadata signal" check;
  //  - it had no gate on which VIEW was actually rendering — only on
  //    `parsedDiff.binary` — so a CHANGED IMAGE viewed in Changes (git also
  //    emits "Binary files … differ" for a changed image, but `image`'s Diff
  //    mode dispatches to ImageCompare, never DiffView — see `viewFor` in
  //    modeSwitcher.tsx) fired an extra `readFile` call whose result was
  //    NEVER consumed by anything, on top of `getDiffBundle`'s own reads and
  //    ImageCompare's `readFileBytes` call — for the single most common
  //    binary-diff workflow in a real repo.
  // Correctly gating a fallback on both transport AND actual rendered view
  // is ongoing surface area to keep right for a number the issue's own
  // Acceptance Criteria never requires (only a graceful placeholder is
  // required, not a size), so this leaf removes the fallback outright
  // instead of narrowing its gate further.
  const rawFileSize =
    rawConfirmation?.kind === 'binary' || rawConfirmation?.kind === 'too-large'
      ? rawConfirmation.sizeBytes
      : undefined;

  const [source, setSource] = useState<{ kind: 'loading' } | { kind: 'ready'; text: string }>({
    kind: 'loading',
  });

  useEffect(() => {
    // Only markdown's Rendered view (RenderedMarkdown) consumes this hoisted
    // `source` state — HtmlPreview and RawFile (the Rendered view for html and
    // text-like classes, respectively) already read the file themselves.
    // Gating on `cls` too avoids a redundant readFile round trip for those
    // classes now that they share the 'rendered' mode name with markdown.
    if (mode !== 'rendered' || cls !== 'markdown') return;
    let active = true;
    setSource({ kind: 'loading' });
    void agentCockpit.provider.readFile(path, { worktreePath }).then((r) => {
      if (active) setSource({ kind: 'ready', text: r.content ?? '' });
    });
    return () => {
      active = false;
    };
  }, [mode, cls, path, worktreePath, refreshToken]);

  // Which component actually renders the current (class, mode) pair — the
  // single value wrappable/findable/the render block all key off, so they
  // stay correct as classes/modes evolve instead of re-deriving per mode name.
  // Keyed on the EFFECTIVE class/mode (see above), not the raw `cls`/`mode`,
  // so a just-confirmed generic-binary file dispatches correctly immediately.
  const view = viewFor(effectiveCls, effectiveMode);

  // Find-in-file: Cmd/Ctrl+F opens a find bar over the rendered content. The
  // search root (contentRef) excludes the find bar itself; panelRef scopes the
  // shortcut to this panel (hover or focus within).
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  // Soft-wrap toggle (persisted, global) — applies to the code views only
  // (DiffView, RawFile), regardless of which mode name currently hosts them.
  const wrapLines = useSettingsStore((s) => s.settings.wrapLines);
  // Rendered-markdown diff-highlighting toggle (persisted, global) — gates
  // whether RenderedMarkdown gets the diff inputs it needs to decorate
  // changed content at all. See the `renderedDiffHighlighting` doc comment
  // (src/shared/settings.ts) and docs/design/ui-rendered-markdown-diff.md.
  const renderedDiffHighlighting = useSettingsStore((s) => s.settings.renderedDiffHighlighting);
  const setSettings = useSettingsStore((s) => s.set);
  // Persist an explicit mode change as the new global "last picked" value —
  // ONLY here, on a genuine user click via ModeSwitcher. This must never be
  // called from the `effectiveMode` reclassification-safety derivation above,
  // which corrects DISPLAY only and does not represent a user choice.
  const handleModeChange = (m: ContentMode): void => {
    setMode(m);
    void setSettings({ contentMode: m });
  };
  const wrappable = view === 'diff-view' || view === 'raw-file' || view === 'folding-view';
  // ImageCompare, ImageView, and the sandboxed HTML iframe have no searchable
  // text in the main DOM — none of them support find-in-file. folding-view
  // (FoldingView) DOES support find — this leaf's pass-through body renders
  // the same full RawFile text as raw-file — but once the real folding view
  // ships (local_repo_explorer-jp2f.5), find will only search
  // currently-unfolded/rendered text: a folded (collapsed) region is not in
  // the DOM, so a match inside it will not be found until that region is
  // expanded. This is an accepted v1 limitation, documented here rather
  // than silently surprising a future reader.
  const findable =
    view === 'diff-view' ||
    view === 'rendered-markdown' ||
    view === 'raw-file' ||
    view === 'folding-view';
  const revision = `${effectiveMode}|${path}|${diff.kind}|${source.kind}`;
  const find = useFindInContent(contentRef, findOpen && findable ? findQuery : '', revision);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (!((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F'))) return;
      const ae = document.activeElement;
      const inEditable =
        ae instanceof HTMLInputElement ||
        ae instanceof HTMLTextAreaElement ||
        ae?.closest('.ac-term') != null;
      const root = panelRef.current;
      const scoped = !!root && (root.matches(':hover') || root.contains(ae));
      if (inEditable || !findable || !scoped) return;
      e.preventDefault();
      setFindOpen(true);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findable]);

  return (
    <Panel>
      <PanelHeader
        title={path}
        actions={
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {stale && <StatusDot tone="warn" title="Changed on disk — click Refresh to reload" />}
              <IconButton
                label={stale ? 'File changed on disk — click to refresh' : 'Refresh from disk'}
                size="sm"
                onClick={refresh}
              >
                ⟳
              </IconButton>
            </div>
            {view === 'rendered-markdown' && (
              <HeaderCheckbox
                checked={renderedDiffHighlighting}
                onChange={(checked) => void setSettings({ renderedDiffHighlighting: checked })}
                label="Diff"
                title={
                  renderedDiffHighlighting
                    ? 'Highlighting changes — uncheck to hide diff highlighting'
                    : 'Diff highlighting hidden — check to highlight changes'
                }
              />
            )}
            {wrappable && (
              <HeaderCheckbox
                checked={wrapLines}
                onChange={(checked) => void setSettings({ wrapLines: checked })}
                label="Wrap"
                title={
                  wrapLines
                    ? 'Wrapping long lines — uncheck to scroll instead'
                    : 'Scrolling long lines — check to wrap'
                }
              />
            )}
            <ModeSwitcher available={available} active={effectiveMode} onChange={handleModeChange} />
          </div>
        }
      />
      <PanelBody>
        <div ref={panelRef} className="relative h-full">
          {findOpen && findable && (
            <FindBar
              query={findQuery}
              onQueryChange={setFindQuery}
              count={find.count}
              active={find.active}
              onNext={find.next}
              onPrev={find.prev}
              onClose={() => setFindOpen(false)}
            />
          )}
          {/* Dispatch on `view` (the (class, mode) lookup from modeSwitcher's
              VIEW_DISPATCH table), not on `mode`/extension directly — this is
              the one per-(class,mode) render site ContentViewer owns instead
              of hand-branching per extension. */}
          <div ref={contentRef} className="h-full">
            {view === 'diff-view' &&
              (diff.kind === 'loading' ? (
                <Centered>
                  <Spinner />
                </Centered>
              ) : (
                <DiffView
                  patch={diff.patch}
                  emptyHint="No textual diff for this file."
                  filePath={path}
                  worktreePath={worktreePath}
                  baseline={baseline}
                  wrap={wrapLines}
                  oldContent={diff.oldContent}
                  newContent={diff.newContent}
                  knownReason={diffKnownReason}
                  knownSize={rawFileSize}
                />
              ))}

            {view === 'rendered-markdown' &&
              (source.kind === 'loading' ? (
                <Centered>
                  <Spinner />
                </Centered>
              ) : (
                <RenderedMarkdown
                  source={source.text}
                  // Withholding BOTH inputs when the toggle is off reuses
                  // RenderedMarkdown's own existing "nothing to classify
                  // against" degrade path (see markdown.tsx's `oldSource` doc
                  // comment) — no separate on/off branch needed there.
                  changedLineSet={renderedDiffHighlighting ? changedLineSet : undefined}
                  linkContext={{ projectId: activeId, base: linkBase }}
                  filePath={path}
                  oldSource={renderedDiffHighlighting && diff.kind === 'ready' ? diff.oldContent : null}
                />
              ))}

            {view === 'html-preview' && (
              <HtmlPreview key={refreshToken} worktreePath={worktreePath} filePath={path} />
            )}

            {view === 'raw-file' && (
              <RawFile
                // RawFile owns its own `readFile` call — a manual refresh
                // must force a real re-read, so it is key-remounted on
                // `refreshToken` (see the `refresh()`/`refreshToken` doc
                // comment above). DiffView/RenderedMarkdown need no such key:
                // their data is ContentViewer's OWN `diff`/`source` state,
                // which already refetches via `refreshToken` in those
                // effects' deps.
                key={refreshToken}
                worktreePath={worktreePath}
                filePath={path}
                wrap={wrapLines}
                // Rendered (highlighted) vs Raw (plain) is a runtime flag on
                // the SAME component/read, not a separate view — switching
                // between them never re-fetches. See RawFile's doc comment
                // for the settled Rendered/Raw distinction.
                highlight={effectiveMode === 'rendered'}
                // The sole runtime classification signal — see the
                // `rawConfirmation` doc comment above and RawFile's
                // `onBinaryConfirmed` prop.
                onBinaryConfirmed={setRawConfirmation}
                {...(baseline !== undefined ? { gitRef: baseline } : {})}
                {...(structuredReadMaxBytes !== undefined ? { maxBytes: structuredReadMaxBytes } : {})}
              />
            )}

            {view === 'folding-view' && (
              <FoldingView
                key={refreshToken}
                worktreePath={worktreePath}
                filePath={path}
                // Reachable only via json/yaml's Rendered cell
                // (VIEW_DISPATCH in modeSwitcher.tsx), so effectiveCls is
                // always 'json' or 'yaml' here; computed inline (not a
                // hoisted const) so it is only ever evaluated on this
                // branch.
                format={effectiveCls === 'yaml' ? 'yaml' : 'json'}
                wrap={wrapLines}
                // The same sole runtime classification signal the
                // `raw-file` branch above reports through — see the
                // `rawConfirmation` doc comment above and RawFile's
                // `onBinaryConfirmed` prop. FoldingView's temporary body
                // forwards this straight to its inner RawFile.
                onBinaryConfirmed={setRawConfirmation}
                {...(baseline !== undefined ? { gitRef: baseline } : {})}
                {...(structuredReadMaxBytes !== undefined ? { maxBytes: structuredReadMaxBytes } : {})}
              />
            )}

            {view === 'image-compare' && (
              <ImageCompare
                key={refreshToken}
                worktreePath={worktreePath}
                baseline={baseline ?? 'HEAD'}
                filePath={path}
                oldPath={selection.oldPath ?? null}
              />
            )}

            {view === 'image-view' && (
              <ImageView key={refreshToken} worktreePath={worktreePath} filePath={path} />
            )}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

/** Panel-header toggle for a persisted boolean setting (Wrap, Diff, …) — a
 *  native checkbox + label rather than a colored button, matching the
 *  Preferences dialog's own `<input type="checkbox">` convention. */
function HeaderCheckbox({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title: string;
}): JSX.Element {
  return (
    <label
      title={title}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        color: 'var(--fg)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Centered({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}
