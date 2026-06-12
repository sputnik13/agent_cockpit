import { useEffect, useMemo, useRef, useState } from 'react';
import { Panel, PanelHeader, PanelBody, EmptyState, Spinner } from '../ui';
import { agentCockpit, useProjectsStore } from '../providerClient';
import { FindBar } from './FindBar';
import { useFindInContent } from './findInContent';
import { parsePatch } from './parsePatch';
import { changedLinesFromPatch } from './hunkMap';
import { DiffView } from './DiffView';
import { RawFile } from './RawFile';
import { ImageCompare } from './ImageCompare';
import { RenderedMarkdown } from './markdown';
import { ModeSwitcher, defaultModeFor, isMarkdownPath, modesFor, type ContentMode } from './modeSwitcher';
import type { ContentSelection } from './selectionStore';

export function ContentViewer({ selection }: { selection: ContentSelection | null }): JSX.Element {
  if (selection == null) {
    return (
      <Panel>
        <PanelHeader title="Content" />
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
  // An out-of-project file has no git baseline: restrict to text modes and skip
  // the diff load entirely (the provider resolves its absolute path directly).
  const external = kind === 'external-file';
  const activeId = useProjectsStore((s) => s.activeId);
  // Resolve relative links in the viewed file against the file's own directory.
  const linkBase = useMemo(() => {
    const slash = path.lastIndexOf('/');
    return slash >= 0 ? path.slice(0, slash) : '';
  }, [path]);
  const available = useMemo(
    () => (external ? modesFor(path).filter((m) => m === 'rendered' || m === 'raw') : modesFor(path)),
    [external, path],
  );
  const [mode, setMode] = useState<ContentMode>(() =>
    external ? (isMarkdownPath(path) ? 'rendered' : 'raw') : defaultModeFor(path, kind),
  );
  const [diff, setDiff] = useState<{ kind: 'loading' } | { kind: 'ready'; patch: string }>({
    kind: 'loading',
  });

  // Load the unified diff once per file (drives diff mode + markdown callouts).
  // Skipped for out-of-project files, which have no git baseline.
  useEffect(() => {
    if (external) {
      setDiff({ kind: 'ready', patch: '' });
      return;
    }
    let active = true;
    setDiff({ kind: 'loading' });
    void agentCockpit.provider.getFileDiff(worktreePath, path, baseline).then((patch) => {
      if (active) setDiff({ kind: 'ready', patch });
    });
    return () => {
      active = false;
    };
  }, [external, worktreePath, path, baseline]);

  const changedLineSet = useMemo(() => {
    if (diff.kind !== 'ready') return undefined;
    return changedLinesFromPatch(parsePatch(diff.patch));
  }, [diff]);

  const [source, setSource] = useState<{ kind: 'loading' } | { kind: 'ready'; text: string }>({
    kind: 'loading',
  });

  useEffect(() => {
    if (mode !== 'rendered') return;
    let active = true;
    setSource({ kind: 'loading' });
    void agentCockpit.provider.readFile(path).then((r) => {
      if (active) setSource({ kind: 'ready', text: r.content ?? '' });
    });
    return () => {
      active = false;
    };
  }, [mode, path]);

  // Find-in-file: Cmd/Ctrl+F opens a find bar over the rendered content. Image
  // mode has no searchable text, so find is unavailable there. The search root
  // (contentRef) excludes the find bar itself; panelRef scopes the shortcut to
  // this panel (hover or focus within).
  const panelRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findable = mode !== 'image';
  const revision = `${mode}|${path}|${diff.kind}|${source.kind}`;
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
        actions={<ModeSwitcher available={available} active={mode} onChange={setMode} />}
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
          <div ref={contentRef} className="h-full">
            {mode === 'diff' &&
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
                />
              ))}

            {mode === 'rendered' &&
              (source.kind === 'loading' ? (
                <Centered>
                  <Spinner />
                </Centered>
              ) : (
                <RenderedMarkdown
                  source={source.text}
                  changedLineSet={changedLineSet}
                  linkContext={{ projectId: activeId, base: linkBase }}
                />
              ))}

            {mode === 'raw' && (
              <RawFile
                worktreePath={worktreePath}
                filePath={path}
                {...(baseline !== undefined ? { gitRef: baseline } : {})}
              />
            )}

            {mode === 'image' && (
              <ImageCompare
                worktreePath={worktreePath}
                baseline={baseline ?? 'HEAD'}
                filePath={path}
                oldPath={selection.oldPath ?? null}
              />
            )}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

function Centered({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}
