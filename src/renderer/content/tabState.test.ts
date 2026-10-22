// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ProjectInfo } from '@shared/ipc/channels';
import {
  EMPTY_TABS,
  activateTab,
  closeTab,
  openTab,
  parseTabs,
  tabIdFor,
  type ContentTabsSlice,
} from './tabState';
import type { ContentSelection } from './selectionStore';

const project = {
  id: 'p',
  connection: { kind: 'local', rootPath: '/repo' },
} as unknown as ProjectInfo;

const file = (path: string, over: Partial<ContentSelection> = {}): ContentSelection => ({
  path,
  worktreePath: '',
  kind: 'file',
  ...over,
});

describe('tabIdFor (fully-qualified identity)', () => {
  it('is the same for a file however it was opened', () => {
    const fromExplorer = tabIdFor(file('src/a.ts'), project);
    const fromChanges = tabIdFor(file('src/a.ts', { kind: 'change', baseline: 'HEAD' }), project);
    const fromRootWorktree = tabIdFor(file('src/a.ts', { worktreePath: '/repo' }), project);
    const fromExternal = tabIdFor(file('/repo/src/a.ts', { kind: 'external-file' }), project);
    expect(fromExplorer).toBe('/repo/src/a.ts');
    expect(fromChanges).toBe(fromExplorer);
    expect(fromRootWorktree).toBe(fromExplorer);
    expect(fromExternal).toBe(fromExplorer);
  });

  it('distinguishes the same relative path in different worktrees', () => {
    expect(tabIdFor(file('a.ts', { worktreePath: '/wt/one' }), project)).toBe('/wt/one/a.ts');
    expect(tabIdFor(file('a.ts', { worktreePath: '/wt/two' }), project)).toBe('/wt/two/a.ts');
  });
});

describe('openTab / closeTab / activateTab', () => {
  it('adds a tab and activates it', () => {
    const s = openTab(EMPTY_TABS, '/repo/a', file('a'));
    expect(s.tabs.map((t) => t.id)).toEqual(['/repo/a']);
    expect(s.activeId).toBe('/repo/a');
  });

  it('reuses and activates an existing tab; the latest opener wins', () => {
    let s = openTab(EMPTY_TABS, '/repo/a', file('a'));
    s = openTab(s, '/repo/b', file('b'));
    const change = file('a', { kind: 'change', baseline: 'HEAD' });
    s = openTab(s, '/repo/a', change);
    expect(s.tabs.map((t) => t.id)).toEqual(['/repo/a', '/repo/b']);
    expect(s.activeId).toBe('/repo/a');
    expect(s.tabs[0]?.selection).toEqual(change);
  });

  it('closing the active tab activates the right neighbour, else the left', () => {
    let s: ContentTabsSlice = EMPTY_TABS;
    for (const id of ['a', 'b', 'c']) s = openTab(s, id, file(id));
    s = activateTab(s, 'b');
    s = closeTab(s, 'b');
    expect(s.activeId).toBe('c');
    s = closeTab(s, 'c');
    expect(s.activeId).toBe('a');
    s = closeTab(s, 'a');
    expect(s).toEqual({ tabs: [], activeId: null });
  });

  it('closing an inactive tab keeps the active one', () => {
    let s: ContentTabsSlice = EMPTY_TABS;
    for (const id of ['a', 'b']) s = openTab(s, id, file(id));
    s = closeTab(s, 'a');
    expect(s.activeId).toBe('b');
    expect(closeTab(s, 'missing')).toBe(s);
  });

  it('ignores activating an unknown tab', () => {
    const s = openTab(EMPTY_TABS, 'a', file('a'));
    expect(activateTab(s, 'zzz')).toBe(s);
  });
});

describe('parseTabs (persisted shape)', () => {
  it('round-trips a valid slice', () => {
    const s = openTab(
      openTab(EMPTY_TABS, '/r/a', file('a')),
      '/r/b',
      file('b', { kind: 'change', baseline: 'HEAD', oldPath: null }),
    );
    expect(parseTabs(JSON.stringify(s))).toEqual(s);
  });

  it('drops malformed and duplicate tabs and repairs a dangling active id', () => {
    const raw = JSON.stringify({
      tabs: [
        { id: '/r/a', selection: file('a') },
        { id: '/r/a', selection: file('a') },
        { id: '/r/x', selection: { path: 1 } },
        'junk',
      ],
      activeId: '/r/gone',
    });
    expect(parseTabs(raw)).toEqual({
      tabs: [{ id: '/r/a', selection: file('a') }],
      activeId: '/r/a',
    });
  });

  it('returns null for absent or unparseable input', () => {
    expect(parseTabs(null)).toBeNull();
    expect(parseTabs('not json')).toBeNull();
    expect(parseTabs(JSON.stringify({ tabs: 'nope' }))).toBeNull();
  });
});
