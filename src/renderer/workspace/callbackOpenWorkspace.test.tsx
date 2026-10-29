// @vitest-environment jsdom
/**
 * Scenario 16 end to end inside the renderer: `evt:callback-open` -> the real
 * `initCallbackOpenSync` -> the real stores -> the real `CockpitWorkspace` on a
 * REAL Dockview with the REAL `PanelHost` (the keyboard-focus seam) and the real
 * `ContentTabs`; only the heavy panel contents are stubs.
 *
 * What it proves is the combination no unit can: with the terminal holding
 * keyboard focus, an open for the active project shows the file as a Content tab
 * and leaves DOM focus, Dockview's active group, the persisted focus memory and
 * the `focusPanel` seam exactly as they were, for every layout the Content panel
 * can be in (visible, hidden in its own group, tabbed with the Terminal, closed).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ProjectInfo } from '@shared/ipc/channels';

// Heavy panel contents -> stubs. PanelHost (panels.tsx), ContentTabs and every
// store stay real.
vi.mock('../beads', async () => {
  const h = await import('../testing/dockviewHarness');
  return { BeadsPanel: h.stubPanel('beads'), TaskDetail: h.stubPanel('taskDetail') };
});
vi.mock('../changes', async () => ({
  ChangesPanel: (await import('../testing/dockviewHarness')).stubPanel('changes'),
}));
vi.mock('../explorer', async () => ({
  ExplorerPanel: (await import('../testing/dockviewHarness')).stubPanel('explorer'),
}));
vi.mock('../run', async () => ({
  RunPanel: (await import('../testing/dockviewHarness')).stubPanel('run'),
}));
vi.mock('../notes', async () => ({
  NotesPanel: (await import('../testing/dockviewHarness')).stubPanel('notes'),
}));
vi.mock('../terminal/TerminalPanel', async () => ({
  TerminalPanel: (await import('../testing/dockviewHarness')).TerminalStub,
}));
vi.mock('../content/ContentViewer', () => ({ ContentViewer: () => null }));
vi.mock('../content', async () => ({
  ContentTabs: (
    await vi.importActual<typeof import('../content/ContentTabs')>('../content/ContentTabs')
  ).ContentTabs,
  ContentViewer: () => null,
}));
// Spy through to the real focus seam and focus memory.
vi.mock('./panelFocus', async (importActual) => {
  const actual = await importActual<typeof import('./panelFocus')>();
  return {
    ...actual,
    focusPanel: vi.fn(actual.focusPanel),
    focusPanelForce: vi.fn(actual.focusPanelForce),
  };
});
vi.mock('./focusMemory', async (importActual) => {
  const actual = await importActual<typeof import('./focusMemory')>();
  return { ...actual, writeFocus: vi.fn(actual.writeFocus) };
});

import { useContentSelection } from '../content/selectionStore';
import { useLogsStore, useProjectsStore } from '../providerClient';
import { StatusRegion } from '../shell/StatusRegion';
import { CockpitWorkspace } from './CockpitWorkspace';
import { initCallbackOpenSync } from './callbackOpen';
import {
  addStubPanel,
  inputOf,
  installFakeLocalStorage,
  mountDockview,
  removeFakeLocalStorage,
} from '../testing/dockviewHarness';
import { readFocus, writeFocus } from './focusMemory';
import { useOpenCueStore } from './openCueStore';
import { layoutKey } from './layoutKeys';
import { PanelIds } from './panelIds';
import { __resetPanelFocusForTest, focusPanel, focusPanelForce } from './panelFocus';
import type { DockviewApi } from './Workspace';

const PROJECTS = [
  { id: 'p1', connection: { kind: 'local', rootPath: '/repo/p1' } },
  { id: 'p2', connection: { kind: 'local', rootPath: '/repo/p2' } },
] as unknown as ProjectInfo[];

// ---- layouts the Content panel can be in (saved, then restored like a user's) ----

const columns = (api: DockviewApi): void => {
  addStubPanel(api, PanelIds.beads);
  addStubPanel(api, PanelIds.terminal, { referencePanel: PanelIds.beads, direction: 'right' });
  addStubPanel(api, PanelIds.changes, { referencePanel: PanelIds.terminal, direction: 'right' });
};
const LAYOUTS = {
  /** Content visible in a group of its own (the Edit view's default shape). */
  visible(api: DockviewApi) {
    columns(api);
    addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'below' });
    api.getPanel(PanelIds.terminal)!.api.setActive();
  },
  /** Content a background tab behind Changes, in a group that is not the terminal's. */
  hiddenInOwnGroup(api: DockviewApi) {
    columns(api);
    addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.changes, direction: 'within' });
    api.getPanel(PanelIds.changes)!.api.setActive();
    api.getPanel(PanelIds.terminal)!.api.setActive();
  },
  /** Content tabbed in the Terminal's own group, the terminal showing. */
  tabbedWithTerminal(api: DockviewApi) {
    columns(api);
    addStubPanel(api, PanelIds.content, { referencePanel: PanelIds.terminal, direction: 'within' });
    api.getPanel(PanelIds.terminal)!.api.setActive();
  },
  /** The user closed the Content panel. */
  closed(api: DockviewApi) {
    columns(api);
    api.getPanel(PanelIds.terminal)!.api.setActive();
  },
};

async function seedLayout(projectId: string, build: (api: DockviewApi) => void): Promise<void> {
  let json: unknown;
  await mountDockview((api) => {
    build(api);
    json = api.toJSON();
  });
  cleanup();
  localStorage.setItem(layoutKey(projectId, 'edit'), JSON.stringify(json));
}

/** Whether the saved layout of `projectId` has ONE group holding all of `views`. */
function savedHasGroupWith(projectId: string, views: string[]): boolean {
  const saved = JSON.parse(localStorage.getItem(layoutKey(projectId, 'edit'))!) as {
    grid: { root: unknown };
  };
  let found = false;
  const walk = (node: unknown): void => {
    const n = node as { type?: string; data?: unknown };
    if (!n || typeof n !== 'object') return;
    if (n.type === 'leaf') {
      const group = n.data as { views?: string[] };
      if (views.every((v) => group.views?.includes(v))) found = true;
    } else if (Array.isArray(n.data)) n.data.forEach(walk);
  };
  walk(saved.grid.root);
  return found;
}

const flush = (): Promise<void> =>
  act(async () => {
    await Promise.resolve();
  });
const nextFrame = (): Promise<void> =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });

const inDom = (id: string): boolean => document.querySelector(`[data-panel-id="${id}"]`) !== null;
const activeGroupPanels = (): string[] =>
  [...document.querySelectorAll('.dv-active-group [data-panel-id]')].map(
    (el) => el.getAttribute('data-panel-id')!,
  );
const openFiles = () => screen.queryByRole('tablist', { name: 'Open files' });
/** The visible tab of the saved layout's group that holds Content (what a restart restores). */
function savedContentGroupView(projectId = 'p1'): string | undefined {
  const saved = JSON.parse(localStorage.getItem(layoutKey(projectId, 'edit'))!) as {
    grid: { root: unknown };
  };
  let found: string | undefined;
  const walk = (node: unknown): void => {
    const n = node as { type?: string; data?: unknown };
    if (!n || typeof n !== 'object') return;
    if (n.type === 'leaf') {
      const group = n.data as { views?: string[]; activeView?: string };
      if (group.views?.includes('content')) found = group.activeView;
    } else if (Array.isArray(n.data)) n.data.forEach(walk);
  };
  walk(saved.grid.root);
  return found;
}
const tabsOf = (projectId: string): string[] =>
  useContentSelection.getState().slices[projectId]?.tabs.map((t) => t.id) ?? [];

// ---- the main-process side of the event, as the preload exposes it ----

let emit: (event: unknown) => void;
let unsubscribe: Mock<() => void>;
let off: () => void;

async function startWorkspace(layout: (api: DockviewApi) => void): Promise<HTMLElement> {
  await seedLayout('p1', layout);
  useProjectsStore.setState({ projects: PROJECTS, activeId: 'p1' });
  render(<CockpitWorkspace />);
  await flush();
  await nextFrame(); // loadLayout clears its focus suppression on the next frame
  await flush();
  // The user is typing in the terminal: DOM focus on its input, its group active.
  const input =
    inputOf(PanelIds.terminal) ??
    document.querySelector<HTMLInputElement>('[data-testid="in-terminal"]');
  expect(input, 'the terminal must be on screen').not.toBeNull();
  input!.focus();
  await flush();
  expect(document.activeElement).toBe(input);
  // Focusing it made the terminal's group the active one and remembered it, so the
  // "memory unchanged" checks below compare real values (not null === null).
  expect(readFocus('panel', 'p1')).toBe(PanelIds.terminal);
  expect(activeGroupPanels()).toContain(PanelIds.terminal);
  off = initCallbackOpenSync();
  vi.mocked(focusPanel).mockClear();
  vi.mocked(focusPanelForce).mockClear();
  vi.mocked(writeFocus).mockClear();
  return input!;
}

/** What "focus was not stolen" means, checked against the state captured before the event. */
function snapshot(input: HTMLElement) {
  return {
    focused: input,
    memory: readFocus('panel', 'p1'),
    activeGroupPanels: activeGroupPanels(),
  };
}
function expectFocusUntouched(before: ReturnType<typeof snapshot>): void {
  expect(document.activeElement, 'DOM focus moved').toBe(before.focused);
  expect(before.focused.isConnected, 'the focused element was detached').toBe(true);
  expect(readFocus('panel', 'p1'), 'the persisted focus memory changed').toBe(before.memory);
  expect(vi.mocked(writeFocus)).not.toHaveBeenCalled();
  expect(vi.mocked(focusPanel)).not.toHaveBeenCalled();
  expect(vi.mocked(focusPanelForce)).not.toHaveBeenCalled();
  expect(activeGroupPanels(), "Dockview's active group moved").toEqual(before.activeGroupPanels);
}

const open = (projectId: string, path: string, worktreePath = '/repo/p1') =>
  act(async () => {
    emit({ projectId, selection: { kind: 'file', path, worktreePath } });
    await Promise.resolve();
  });

beforeEach(() => {
  installFakeLocalStorage();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  __resetPanelFocusForTest();
  useContentSelection.getState().resetAll();
  useLogsStore.getState().clearEntries();
  useOpenCueStore.getState().clear();
  unsubscribe = vi.fn<() => void>();
  let handler: ((e: unknown) => void) | null = null;
  (window as unknown as { api: unknown }).api = {
    events: {
      onCallbackOpen: (h: (e: unknown) => void) => {
        handler = h;
        return () => {
          handler = null;
          unsubscribe();
        };
      },
    },
  };
  emit = (event) => handler?.(event);
  off = () => undefined;
});

afterEach(() => {
  off();
  cleanup();
  useOpenCueStore.getState().clear();
  useContentSelection.getState().resetAll();
  useProjectsStore.setState({ projects: [], activeId: null });
  delete (window as unknown as { api?: unknown }).api;
  removeFakeLocalStorage();
  vi.restoreAllMocks();
});

describe('evt:callback-open in the real workspace: the terminal keeps the keyboard', () => {
  it('Content visible in its own group: a new tab appears (label + full-path hover) and nothing else moves', async () => {
    const input = await startWorkspace(LAYOUTS.visible);
    expect(inDom('content')).toBe(true);
    const before = snapshot(input);

    await open('p1', 'src/a.ts');

    const tabs = within(openFiles()!).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['a.ts']);
    expect(tabs[0]).toHaveAttribute('title', '/repo/p1/src/a.ts');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expectFocusUntouched(before);
  });

  it('re-opening the same path does not duplicate the tab; a second file adds one and goes in front', async () => {
    const input = await startWorkspace(LAYOUTS.visible);
    const before = snapshot(input);

    await open('p1', 'src/a.ts');
    await open('p1', 'src/a.ts');
    expect(within(openFiles()!).getAllByRole('tab')).toHaveLength(1);

    await open('p1', 'src/b.ts');
    const tabs = within(openFiles()!).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['a.ts', 'b.ts']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expectFocusUntouched(before);
  });

  it('two rapid opens (no render between them) both land, in order, and focus never moves', async () => {
    const input = await startWorkspace(LAYOUTS.visible);
    const before = snapshot(input);
    await act(async () => {
      emit({
        projectId: 'p1',
        selection: { kind: 'file', path: 'x.md', worktreePath: '/repo/p1' },
      });
      emit({
        projectId: 'p1',
        selection: { kind: 'file', path: 'y.md', worktreePath: '/repo/p1' },
      });
      await Promise.resolve();
    });
    expect(tabsOf('p1')).toEqual(['/repo/p1/x.md', '/repo/p1/y.md']);
    expectFocusUntouched(before);
  });

  it('Content hidden behind Changes (its own group, not the active one): revealed, focus untouched', async () => {
    const input = await startWorkspace(LAYOUTS.hiddenInOwnGroup);
    expect(inDom('content')).toBe(false);
    const before = snapshot(input);

    expect(savedContentGroupView()).toBe('changes');

    await open('p1', 'src/a.ts');

    expect(inDom('content')).toBe(true);
    expect(within(openFiles()!).getAllByRole('tab')).toHaveLength(1);
    expectFocusUntouched(before);
    // The switch emitted no layout-change event, so the workspace saved it itself:
    // a restart restores Content as the group's visible tab.
    expect(savedContentGroupView()).toBe('content');
  });

  it('Content tabbed WITH the Terminal: the terminal stays on screen and focused; the tab is recorded and the reason logged', async () => {
    const input = await startWorkspace(LAYOUTS.tabbedWithTerminal);
    expect(inDom('content')).toBe(false);
    const before = snapshot(input);

    await open('p1', 'src/a.ts');

    expect(inDom('terminal')).toBe(true);
    expect(inDom('content')).toBe(false); // not shown: showing it would hide the terminal
    expect(tabsOf('p1')).toEqual(['/repo/p1/src/a.ts']); // but the open is recorded
    expectFocusUntouched(before);
    expect(
      useLogsStore
        .getState()
        .entries.some((e) => /did not show it: .*tabbed behind the Terminal/.test(e.message)),
    ).toBe(true);
  });

  it('a declined open leaves a status-bar cue; Show (a user action) then brings Content up and takes the focus', async () => {
    const input = await startWorkspace(LAYOUTS.tabbedWithTerminal);
    render(<StatusRegion />);
    const before = snapshot(input);

    await open('p1', 'src/a.ts');

    // The cue is on screen, in an announced live region, and the keyboard did not move.
    expect(screen.getByRole('status')).toHaveTextContent('Opened a.ts in Content (hidden)');
    expect(inDom('content')).toBe(false);
    expectFocusUntouched(before);

    // The user clicks Show: that IS an explicit request, so Content comes up and focuses.
    await act(async () => {
      screen.getByRole('button', { name: 'Show a.ts in Content' }).click();
      await Promise.resolve();
    });
    expect(inDom('content')).toBe(true);
    expect(
      within(openFiles()!)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['a.ts']);
    expect(document.activeElement?.closest('[data-panel-id]')?.getAttribute('data-panel-id')).toBe(
      PanelIds.content,
    );
    expect(screen.getByRole('status')).toBeEmptyDOMElement(); // the cue is gone
  });

  it('a later open that shows the panel dismisses the cue the declined one left', async () => {
    await startWorkspace(LAYOUTS.hiddenInOwnGroup);
    render(<StatusRegion />);
    // Content is behind Changes in a group that is not the active one: an open reveals it.
    act(() => {
      useOpenCueStore
        .getState()
        .show({ projectId: 'p1', name: 'old.md', path: 'old.md', reason: 'earlier decline' });
    });
    expect(screen.getByRole('status')).toHaveTextContent('Opened old.md');

    await open('p1', 'src/a.ts');

    expect(inDom('content')).toBe(true);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('Content closed (absent from the layout): re-added and shown, still without moving focus; a second open reuses it', async () => {
    const input = await startWorkspace(LAYOUTS.closed);
    expect(inDom('content')).toBe(false);
    const before = snapshot(input);

    await open('p1', 'src/a.ts');
    expect(inDom('content')).toBe(true);
    expect(within(openFiles()!).getAllByRole('tab')).toHaveLength(1);
    expectFocusUntouched(before);

    await open('p1', 'src/b.ts'); // must not try to add the panel a second time
    expect(within(openFiles()!).getAllByRole('tab')).toHaveLength(2);
    expect(document.querySelectorAll('[data-panel-id="content"]')).toHaveLength(1);
    expectFocusUntouched(before);

    // The re-added panel is part of the layout the next launch restores, as the
    // visible tab of its group (not a blank group).
    const saved = JSON.parse(localStorage.getItem(layoutKey('p1', 'edit'))!) as {
      panels: Record<string, unknown>;
    };
    expect(Object.keys(saved.panels)).toContain('content');
    expect(savedContentGroupView()).toBe('content');
  });

  it('a user focusing Content afterwards still gets the normal focus handling (the guard is not poisoned)', async () => {
    const input = await startWorkspace(LAYOUTS.hiddenInOwnGroup);
    await open('p1', 'src/a.ts');
    expect(document.activeElement).toBe(input);
    expect(vi.mocked(focusPanel)).not.toHaveBeenCalled();

    // The user clicks into Content: Dockview activates its group, and that
    // GENUINE activation is handled like any other (not swallowed as a repeat).
    const tab = within(openFiles()!).getByRole('tab');
    await act(async () => {
      tab.focus();
      await Promise.resolve();
    });
    expect(vi.mocked(focusPanel)).toHaveBeenCalledWith(PanelIds.content);
    expect(readFocus('panel', 'p1')).toBe(PanelIds.content);
  });
});

describe('evt:callback-open for a project that is not the active one', () => {
  it('records the tab in THAT project only: no project switch, no reveal, layout untouched', async () => {
    const input = await startWorkspace(LAYOUTS.closed);
    const before = snapshot(input);
    const panelsBefore = [...document.querySelectorAll('[data-panel-id]')].map((el) =>
      el.getAttribute('data-panel-id'),
    );
    const activate = vi.fn();
    useProjectsStore.setState({ activate });

    await open('p2', 'src/b.ts', '/repo/p2');

    expect(tabsOf('p2')).toEqual(['/repo/p2/src/b.ts']);
    expect(tabsOf('p1')).toEqual([]);
    expect(useProjectsStore.getState().activeId).toBe('p1');
    expect(activate).not.toHaveBeenCalled();
    expect(inDom('content')).toBe(false); // the closed Content panel was NOT re-added for it
    expect(
      [...document.querySelectorAll('[data-panel-id]')].map((el) =>
        el.getAttribute('data-panel-id'),
      ),
    ).toEqual(panelsBefore);
    expectFocusUntouched(before);
  });

  it('does not reveal a hidden Content panel for a non-active project either', async () => {
    const input = await startWorkspace(LAYOUTS.hiddenInOwnGroup);
    const before = snapshot(input);
    await open('p2', 'src/b.ts', '/repo/p2');
    expect(inDom('content')).toBe(false);
    expect(tabsOf('p2')).toHaveLength(1);
    expectFocusUntouched(before);
  });
});

describe('evt:callback-open during a project switch', () => {
  it("an open for the project being switched TO is recorded but not revealed in the previous project's layout", async () => {
    // p2 has its own saved layout, so loading it never falls back to a preset.
    await seedLayout('p2', LAYOUTS.visible);
    await startWorkspace(LAYOUTS.hiddenInOwnGroup); // p1: Content behind Changes
    expect(savedContentGroupView('p1')).toBe('changes');

    // The renderer adopts p2 as the active project and an open for p2 arrives BEFORE the
    // workbench's layout effect has rebuilt the layout: Dockview still shows p1's panels.
    await act(async () => {
      useProjectsStore.setState({ activeId: 'p2' });
      emit({
        projectId: 'p2',
        selection: { kind: 'file', path: 'src/b.ts', worktreePath: '/repo/p2' },
      });
    });

    expect(tabsOf('p2')).toEqual(['/repo/p2/src/b.ts']); // recorded, in p2's slice
    // p1's layout was not touched on p2's behalf: Content stayed behind Changes, and the
    // saved layouts were not rewritten.
    expect(savedContentGroupView('p1')).toBe('changes');
    expect(
      useLogsStore
        .getState()
        .entries.some((e) =>
          /did not show it: the project layout is still loading/.test(e.message),
        ),
    ).toBe(true);

    // Once p2's layout is loaded, an open for it is handled normally.
    await nextFrame();
    await open('p2', 'src/c.ts', '/repo/p2');
    expect(tabsOf('p2')).toEqual(['/repo/p2/src/b.ts', '/repo/p2/src/c.ts']);
    expect(within(openFiles()!).getAllByRole('tab')).toHaveLength(2); // p2's Content is on screen
  });

  it('a layout change in the switch window is saved under the project whose layout it is, never the one just made active', async () => {
    await seedLayout('p2', LAYOUTS.visible); // p2: Content in a group of its own
    await startWorkspace(LAYOUTS.hiddenInOwnGroup); // p1: Changes and Content tabbed in one group
    expect(savedHasGroupWith('p1', ['changes', 'content'])).toBe(true);
    expect(savedHasGroupWith('p2', ['changes', 'content'])).toBe(false);
    const contentTab = [...document.querySelectorAll<HTMLElement>('.dv-tab')].find((t) =>
      /Content/.test(t.textContent ?? ''),
    )!;
    expect(contentTab, "p1's Content tab (behind Changes) must be on screen").toBeDefined();

    await act(async () => {
      useProjectsStore.setState({ activeId: 'p2' }); // adopted; p2's layout is not loaded yet
      fireEvent.pointerDown(contentTab, { button: 0 }); // a tab switch in p1's still-shown layout
      await Promise.resolve();
    });

    // The switch happened in p1's layout and was saved there ...
    expect(savedContentGroupView('p1')).toBe('content');
    // ... and p1's arrangement was never written under p2's key.
    expect(savedHasGroupWith('p2', ['changes', 'content'])).toBe(false);
  });
});

describe('evt:callback-open payloads and lifetime', () => {
  it('ignores a malformed payload: no tab, no layout change, focus untouched', async () => {
    const input = await startWorkspace(LAYOUTS.closed);
    const before = snapshot(input);
    await act(async () => {
      emit({
        projectId: 'p1',
        selection: { kind: 'change', path: 'a.ts', worktreePath: '', baseline: 'HEAD' },
      });
      emit({ projectId: 'p1' });
      emit(null);
      await Promise.resolve();
    });
    expect(tabsOf('p1')).toEqual([]);
    expect(inDom('content')).toBe(false);
    expectFocusUntouched(before);
  });

  it('stops handling events once the subscription is released', async () => {
    const input = await startWorkspace(LAYOUTS.visible);
    const before = snapshot(input);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await open('p1', 'src/a.ts');
    expect(tabsOf('p1')).toEqual([]);
    expectFocusUntouched(before);
  });
});
