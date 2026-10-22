// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ProjectInfo } from '@shared/ipc/channels';
import { storageKey } from './tabState';

vi.mock('../providerClient', () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [
        { id: 'p', connection: { kind: 'local', rootPath: '/repo' } },
      ] as unknown as ProjectInfo[],
    }),
  },
}));

async function freshStore() {
  vi.resetModules(); // a new module instance == an app restart (empty in-memory cache)
  return (await import('./selectionStore')).useContentSelection;
}

describe('content tabs persistence', () => {
  // jsdom here has no localStorage; install a Map-backed fake (see focusMemory.test.ts).
  let backing: Map<string, string>;
  beforeEach(() => {
    backing = new Map();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it('persists opens, and a fresh app instance restores the tabs and active tab', async () => {
    const first = await freshStore();
    first.getState().select('p', { path: 'a.ts', worktreePath: '', kind: 'file' });
    first
      .getState()
      .select('p', { path: 'b.ts', worktreePath: '', kind: 'change', baseline: 'HEAD' });
    first.getState().activate('p', '/repo/a.ts');

    const restarted = await freshStore();
    const sel = restarted.getState().selectionFor('p');
    expect(sel).toMatchObject({ path: 'a.ts', kind: 'file' });
    // Reopening a restored file reuses its tab instead of duplicating it.
    restarted.getState().select('p', { path: 'b.ts', worktreePath: '', kind: 'file' });
    const raw = JSON.parse(localStorage.getItem(storageKey('p')) ?? '{}') as { tabs: unknown[] };
    expect(raw.tabs).toHaveLength(2);
  });

  it('keeps projects independent', async () => {
    const store = await freshStore();
    store.getState().select('p', { path: 'a.ts', worktreePath: '', kind: 'file' });
    expect(store.getState().selectionFor('other')).toBeNull();
  });

  it('removes the persisted entry when the last tab closes', async () => {
    const store = await freshStore();
    store.getState().select('p', { path: 'a.ts', worktreePath: '', kind: 'file' });
    store.getState().close('p', '/repo/a.ts');
    expect(localStorage.getItem(storageKey('p'))).toBeNull();
    expect(store.getState().selectionFor('p')).toBeNull();
  });

  it('degrades to no tabs when the stored value is corrupt', async () => {
    localStorage.setItem(storageKey('p'), '{corrupt');
    const store = await freshStore();
    expect(store.getState().selectionFor('p')).toBeNull();
  });
});
