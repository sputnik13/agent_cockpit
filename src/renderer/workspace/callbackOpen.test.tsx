// @vitest-environment jsdom
/**
 * The renderer leg of `evt:callback-open` (scenario 16): payload validation at
 * the boundary, which project's slice records the tab, when the Content panel is
 * revealed (only for the ACTIVE project), and the subscription's lifetime.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ProjectInfo } from '@shared/ipc/channels';
import { useContentSelection } from '../content/selectionStore';
import { useLogsStore, useProjectsStore } from '../providerClient';
import { handleCallbackOpen, initCallbackOpenSync, parseCallbackOpenEvent } from './callbackOpen';
import { installFakeLocalStorage, removeFakeLocalStorage } from '../testing/dockviewHarness';
import { useOpenCueStore } from './openCueStore';
import { revealDeclinedReason, type RevealOutcome } from './panelReveal';
import { useWorkspaceControlsStore } from './workspaceControlsStore';

const PROJECTS = [
  { id: 'p1', connection: { kind: 'local', rootPath: '/repo/p1' } },
  { id: 'p2', connection: { kind: 'local', rootPath: '/repo/p2' } },
] as unknown as ProjectInfo[];

const openEvent = (projectId: string, path: string, worktreePath = '/repo/p1') => ({
  projectId,
  selection: { kind: 'file', path, worktreePath },
});

const tabsOf = (projectId: string): string[] =>
  useContentSelection.getState().slices[projectId]?.tabs.map((t) => t.id) ?? [];
const activeTabOf = (projectId: string): string | null =>
  useContentSelection.getState().slices[projectId]?.activeId ?? null;

const logMessages = (): string[] => useLogsStore.getState().entries.map((e) => e.message);

let revealContent: Mock<() => RevealOutcome>;
let activate: Mock<(id: string) => Promise<void>>;

beforeEach(() => {
  installFakeLocalStorage();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  useContentSelection.getState().resetAll();
  useLogsStore.getState().clearEntries();
  useOpenCueStore.getState().clear();
  revealContent = vi.fn<() => RevealOutcome>(() => 'already-visible');
  activate = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  useProjectsStore.setState({ projects: PROJECTS, activeId: 'p1', activate });
  useWorkspaceControlsStore.setState({ available: true, revealContent });
});

afterEach(() => {
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ projects: [], activeId: null });
  useWorkspaceControlsStore.setState({ available: false, revealContent: () => 'unavailable' });
  removeFakeLocalStorage();
  useOpenCueStore.getState().clear();
  vi.restoreAllMocks();
});

describe('parseCallbackOpenEvent (the renderer boundary)', () => {
  it('accepts a file selection and an external-file selection', () => {
    expect(parseCallbackOpenEvent(openEvent('p1', 'src/a.ts'))).toEqual({
      projectId: 'p1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '/repo/p1' },
    });
    expect(
      parseCallbackOpenEvent({
        projectId: 'p1',
        selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
      }),
    ).toEqual({
      projectId: 'p1',
      selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
    });
  });

  it('rebuilds the selection from the three validated fields: a baseline (or anything else) never survives', () => {
    const parsed = parseCallbackOpenEvent({
      projectId: 'p1',
      pane: { kind: 'tmux', id: '%1' },
      selection: {
        kind: 'file',
        path: 'a.md',
        worktreePath: '',
        baseline: 'HEAD',
        oldPath: 'b.md',
        extra: 1,
      },
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!.selection).sort()).toEqual(['kind', 'path', 'worktreePath']);
    expect(parsed!.selection).not.toHaveProperty('baseline');
    expect(Object.keys(parsed!).sort()).toEqual(['projectId', 'selection']);
  });

  const sel = (over: Record<string, unknown>) => ({
    projectId: 'p1',
    selection: { kind: 'file', path: 'a.ts', worktreePath: '', ...over },
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'open'],
    ['a number', 7],
    ['an array', [openEvent('p1', 'a.ts')]],
    ['an empty object', {}],
    ['no projectId', { selection: { kind: 'file', path: 'a.ts', worktreePath: '' } }],
    ['an empty projectId', { ...sel({}), projectId: '' }],
    ['a numeric projectId', { ...sel({}), projectId: 3 }],
    ['no selection', { projectId: 'p1' }],
    ['a null selection', { projectId: 'p1', selection: null }],
    ['an array selection', { projectId: 'p1', selection: ['a.ts'] }],
    ['a string selection', { projectId: 'p1', selection: 'a.ts' }],
    ['kind "change" (a diff, which carries a baseline)', sel({ kind: 'change' })],
    ['an unknown kind', sel({ kind: 'dir' })],
    ['no kind', sel({ kind: undefined })],
    ['an empty path', sel({ path: '' })],
    ['a non-string path', sel({ path: 42 })],
    ['a path with a NUL', sel({ path: 'a\0b' })],
    ['a non-string worktreePath', sel({ worktreePath: null })],
    ['a worktreePath with a NUL', sel({ worktreePath: '/r\0' })],
    // Shape rules per kind (defense in depth on top of main's classification).
    ['a file with an absolute path', sel({ path: '/etc/hosts' })],
    [
      'a file that climbs out of its worktree',
      sel({ path: '../secret.md', worktreePath: '/repo' }),
    ],
    [
      'a file with a ".." segment in the middle',
      sel({ path: 'docs/../../x.md', worktreePath: '/repo' }),
    ],
    ['a file with a relative worktreePath', sel({ worktreePath: 'repo' })],
    ['an external file with a relative path', sel({ kind: 'external-file', path: 'etc/hosts' })],
    [
      'an external file with a ".." segment',
      sel({ kind: 'external-file', path: '/etc/../root/x' }),
    ],
    [
      'an external file that names a worktree',
      sel({ kind: 'external-file', path: '/etc/hosts', worktreePath: '/repo' }),
    ],
  ])('rejects %s', (_label, payload) => {
    expect(parseCallbackOpenEvent(payload)).toBeNull();
  });

  it.each([
    [
      'a nested relative file under the project root',
      { kind: 'file', path: 'docs/a.md', worktreePath: '' },
    ],
    ['a file under a worktree', { kind: 'file', path: 'src/a.ts', worktreePath: '/wt/feat' }],
    [
      'a file name that merely contains two dots',
      { kind: 'file', path: 'notes/a..b.md', worktreePath: '' },
    ],
    ['a dot-directory file', { kind: 'file', path: '.beads/issues.jsonl', worktreePath: '/repo' }],
    ['an external absolute file', { kind: 'external-file', path: '/etc/hosts', worktreePath: '' }],
  ])('accepts %s', (_label, selection) => {
    expect(parseCallbackOpenEvent({ projectId: 'p1', selection })).toEqual({
      projectId: 'p1',
      selection,
    });
  });
});

describe('handleCallbackOpen: which project records the tab', () => {
  it("records the tab in the ADDRESSED project's slice and leaves every other slice alone", () => {
    handleCallbackOpen(openEvent('p2', 'src/b.ts', '/repo/p2'));
    expect(tabsOf('p2')).toEqual(['/repo/p2/src/b.ts']);
    expect(activeTabOf('p2')).toBe('/repo/p2/src/b.ts');
    expect(tabsOf('p1')).toEqual([]);
  });

  it('builds the same tab id the Explorer builds for the same file (worktree path + relative path)', () => {
    handleCallbackOpen(openEvent('p1', 'docs/x.md', '/wt/feat'));
    expect(tabsOf('p1')).toEqual(['/wt/feat/docs/x.md']);
  });

  it('keeps an external file under its absolute path', () => {
    handleCallbackOpen({
      projectId: 'p1',
      selection: { kind: 'external-file', path: '/etc/hosts', worktreePath: '' },
    });
    expect(tabsOf('p1')).toEqual(['/etc/hosts']);
    expect(useContentSelection.getState().selectionFor('p1')).toEqual({
      kind: 'external-file',
      path: '/etc/hosts',
      worktreePath: '',
    });
  });

  it('never stores a baseline, even when the payload carries one', () => {
    handleCallbackOpen({
      projectId: 'p1',
      selection: { kind: 'file', path: 'a.md', worktreePath: '/repo/p1', baseline: 'HEAD' },
    });
    const stored = useContentSelection.getState().selectionFor('p1');
    expect(stored).toEqual({ kind: 'file', path: 'a.md', worktreePath: '/repo/p1' });
    expect(stored).not.toHaveProperty('baseline');
  });
});

describe('handleCallbackOpen: the active project vs the rest (the load-bearing guard)', () => {
  it('reveals the Content panel for the ACTIVE project, after recording the tab', () => {
    revealContent.mockImplementation(() => {
      // The tab is already recorded when the panel is shown.
      expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
      return 'revealed';
    });
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(revealContent).toHaveBeenCalledTimes(1);
    // The workbench is told WHICH project the open is for, so it can refuse while it
    // still shows another project's layout.
    expect(revealContent).toHaveBeenCalledWith('p1');
  });

  it('for a NON-active project only records the tab: no reveal, no project switch', () => {
    handleCallbackOpen(openEvent('p2', 'src/b.ts', '/repo/p2'));
    expect(tabsOf('p2')).toEqual(['/repo/p2/src/b.ts']);
    expect(revealContent).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(useProjectsStore.getState().activeId).toBe('p1');
  });

  it('with no active project at all, still only records the tab', () => {
    useProjectsStore.setState({ activeId: null });
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(revealContent).not.toHaveBeenCalled();
  });

  it('records the tab but does not reach for a workbench that is not mounted', () => {
    useWorkspaceControlsStore.setState({ available: false });
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(revealContent).not.toHaveBeenCalled();
    expect(logMessages().some((m) => /did not show it.*not available/.test(m))).toBe(true);
  });

  it('a throwing reveal never loses the open: the tab is recorded and the failure is logged', () => {
    revealContent.mockImplementation(() => {
      throw new Error('dockview exploded');
    });
    expect(() => handleCallbackOpen(openEvent('p1', 'src/a.ts'))).not.toThrow();
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(logMessages()).toHaveLength(1); // the failure, once; not also a "did not show it" note
    expect(logMessages()[0]).toMatch(/could not show the Content panel: dockview exploded/);
  });

  it('logs why Content was not shown when the reveal declines (the open is still recorded)', () => {
    revealContent.mockReturnValue('withheld-terminal');
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(
      logMessages().some((m) =>
        /opened src\/a\.ts .* did not show it: .*tabbed behind the Terminal/.test(m),
      ),
    ).toBe(true);
  });

  it('while the workbench still shows another project (a switch in flight) the open is recorded and the reason logged', () => {
    revealContent.mockReturnValue('not-loaded');
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(
      logMessages().some((m) => /did not show it: the project layout is still loading/.test(m)),
    ).toBe(true);
  });

  it('logs nothing when the panel is shown', () => {
    for (const outcome of ['already-visible', 'revealed', 'added'] as const) {
      revealContent.mockReturnValue(outcome);
      handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    }
    expect(logMessages()).toEqual([]);
  });
});

describe('handleCallbackOpen: the visible cue for a declined reveal', () => {
  const declined = [
    'withheld-terminal',
    'withheld-active-group',
    'withheld-maximized',
    'withheld-no-room',
  ] as const;

  it.each(declined)('%s raises a cue for that open (file name, path and the reason)', (outcome) => {
    revealContent.mockReturnValue(outcome);
    handleCallbackOpen(openEvent('p1', 'docs/plan.md'));
    expect(useOpenCueStore.getState().cue).toMatchObject({
      projectId: 'p1',
      name: 'plan.md',
      path: 'docs/plan.md',
      reason: revealDeclinedReason(outcome),
    });
  });

  it('a newer decline replaces the older cue', () => {
    revealContent.mockReturnValue('withheld-terminal');
    handleCallbackOpen(openEvent('p1', 'a.md'));
    handleCallbackOpen(openEvent('p1', 'b.md'));
    expect(useOpenCueStore.getState().cue).toMatchObject({ name: 'b.md' });
  });

  it.each(['already-visible', 'revealed', 'added'] as const)(
    'an open that DID show the panel (%s) dismisses the cue an earlier open left',
    (outcome) => {
      revealContent.mockReturnValue('withheld-maximized');
      handleCallbackOpen(openEvent('p1', 'a.md'));
      expect(useOpenCueStore.getState().cue).not.toBeNull();
      revealContent.mockReturnValue(outcome);
      handleCallbackOpen(openEvent('p1', 'b.md'));
      expect(useOpenCueStore.getState().cue).toBeNull();
    },
  );

  it.each(['unavailable', 'not-loaded'] as const)(
    '%s raises no cue (log only) and leaves an existing cue alone',
    (outcome) => {
      revealContent.mockReturnValue('withheld-terminal');
      handleCallbackOpen(openEvent('p1', 'a.md'));
      const before = useOpenCueStore.getState().cue;
      revealContent.mockReturnValue(outcome);
      handleCallbackOpen(openEvent('p1', 'b.md'));
      expect(useOpenCueStore.getState().cue).toBe(before);
    },
  );

  it('an open for a project that is not the active one never touches the cue', () => {
    revealContent.mockReturnValue('withheld-terminal');
    handleCallbackOpen(openEvent('p1', 'a.md'));
    const before = useOpenCueStore.getState().cue;
    handleCallbackOpen(openEvent('p2', 'b.md', '/repo/p2'));
    expect(useOpenCueStore.getState().cue).toBe(before);
    expect(revealContent).toHaveBeenCalledTimes(1);
  });

  it('a malformed payload raises none', () => {
    handleCallbackOpen({ projectId: 'p1' });
    expect(useOpenCueStore.getState().cue).toBeNull();
  });

  it('a throwing reveal raises none (the failure is logged instead)', () => {
    revealContent.mockImplementation(() => {
      throw new Error('boom');
    });
    handleCallbackOpen(openEvent('p1', 'a.md'));
    expect(useOpenCueStore.getState().cue).toBeNull();
  });
});

describe('handleCallbackOpen: malformed payloads', () => {
  it.each([
    null,
    'open',
    {},
    { projectId: 'p1' },
    { projectId: 'p1', selection: { kind: 'change', path: 'a', worktreePath: '' } },
  ])('ignores %j: nothing is recorded, nothing is revealed, a warning is logged', (payload) => {
    expect(() => handleCallbackOpen(payload)).not.toThrow();
    expect(tabsOf('p1')).toEqual([]);
    expect(Object.keys(useContentSelection.getState().slices)).toEqual([]);
    expect(revealContent).not.toHaveBeenCalled();
    expect(logMessages().some((m) => /malformed callback open event/.test(m))).toBe(true);
  });
});

describe('handleCallbackOpen: rapid and repeated opens', () => {
  it('re-opening the same path activates its tab instead of adding one', () => {
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    handleCallbackOpen(openEvent('p1', 'src/b.ts'));
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts', '/repo/p1/src/b.ts']);
    expect(activeTabOf('p1')).toBe('/repo/p1/src/a.ts');
  });

  it('two rapid opens of different files keep both tabs, in order, with the last one in front', () => {
    handleCallbackOpen(openEvent('p1', 'src/a.ts'));
    handleCallbackOpen(openEvent('p1', 'src/b.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts', '/repo/p1/src/b.ts']);
    expect(activeTabOf('p1')).toBe('/repo/p1/src/b.ts');
    expect(revealContent).toHaveBeenCalledTimes(2);
  });

  it('interleaved opens for two projects each land in their own slice', () => {
    handleCallbackOpen(openEvent('p1', 'a.ts'));
    handleCallbackOpen(openEvent('p2', 'a.ts', '/repo/p2'));
    handleCallbackOpen(openEvent('p1', 'b.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/a.ts', '/repo/p1/b.ts']);
    expect(tabsOf('p2')).toEqual(['/repo/p2/a.ts']);
    expect(revealContent).toHaveBeenCalledTimes(2); // p1 twice; p2 never
  });
});

describe('initCallbackOpenSync (subscription lifetime)', () => {
  function fakeApi() {
    let handler: ((e: unknown) => void) | null = null;
    const unsubscribe = vi.fn(() => {
      handler = null;
    });
    const onCallbackOpen = vi.fn((h: (e: unknown) => void) => {
      handler = h;
      return unsubscribe;
    });
    (window as unknown as { api: unknown }).api = { events: { onCallbackOpen } };
    return {
      onCallbackOpen,
      unsubscribe,
      emit: (e: unknown) => handler?.(e),
      live: () => handler !== null,
    };
  }

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api;
  });

  it('subscribes once, routes events to the handler, and returns the API unsubscribe', () => {
    const api = fakeApi();
    const off = initCallbackOpenSync();
    expect(api.onCallbackOpen).toHaveBeenCalledTimes(1);
    api.emit(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']);
    expect(api.unsubscribe).not.toHaveBeenCalled();
    off();
    expect(api.unsubscribe).toHaveBeenCalledTimes(1);
    expect(api.live()).toBe(false);
  });

  it('after the unsubscribe, events no longer reach the stores', () => {
    const api = fakeApi();
    const off = initCallbackOpenSync();
    off();
    api.emit(openEvent('p1', 'src/a.ts'));
    expect(tabsOf('p1')).toEqual([]);
  });
});
