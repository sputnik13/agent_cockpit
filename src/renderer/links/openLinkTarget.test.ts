// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ResolvedPath } from '@shared/providers/types';

// `agentCockpit` captures `window.api` at import time, so install the fake
// bridge before the modules under test import it.
const api = vi.hoisted(() => {
  const provider = { resolvePath: vi.fn() };
  (globalThis as unknown as { window: { api: unknown } }).window.api = { provider };
  return { provider };
});

import { openLinkTarget } from './openLinkTarget';
import { useContentSelection } from '../content';
import { useExplorerStore } from '../explorer/explorerStore';

const PID = 'p1';

function resolveTo(r: Partial<ResolvedPath>): void {
  api.provider.resolvePath.mockResolvedValue({
    exists: true,
    isDir: false,
    insideProject: false,
    relPath: null,
    absPath: '/abs/x',
    ...r,
  });
}

beforeEach(() => {
  useContentSelection.setState({ selections: {} });
  useExplorerStore.setState({ expanded: {}, revealTarget: {} });
  api.provider.resolvePath.mockReset();
  vi.spyOn(window, 'open').mockReturnValue(null);
});

describe('openLinkTarget', () => {
  it('routes a web URL to the OS browser via window.open', async () => {
    await openLinkTarget('https://example.com', { projectId: PID });
    expect(window.open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(api.provider.resolvePath).not.toHaveBeenCalled();
  });

  it('opens an in-project file in the content panel and reveals it in the Explorer', async () => {
    resolveTo({ insideProject: true, relPath: 'src/a.ts', absPath: '/repo/src/a.ts' });
    await openLinkTarget('src/a.ts', { projectId: PID });
    const sel = useContentSelection.getState().selections[PID];
    expect(sel).toMatchObject({ path: 'src/a.ts', kind: 'file' });
    expect(useExplorerStore.getState().revealTarget[PID]).toBe('src/a.ts');
    // ancestor dir expanded
    expect(useExplorerStore.getState().expanded[PID]?.has('src')).toBe(true);
  });

  it('opens an out-of-project file in the content panel only (no reveal)', async () => {
    resolveTo({ insideProject: false, relPath: null, absPath: '/etc/hosts' });
    await openLinkTarget('/etc/hosts', { projectId: PID });
    const sel = useContentSelection.getState().selections[PID];
    expect(sel).toMatchObject({ path: '/etc/hosts', kind: 'external-file' });
    expect(useExplorerStore.getState().revealTarget[PID] ?? null).toBeNull();
  });

  it('reveals a directory inside the project without a content selection', async () => {
    resolveTo({ exists: true, isDir: true, insideProject: true, relPath: 'src/sub', absPath: '/repo/src/sub' });
    await openLinkTarget('src/sub', { projectId: PID });
    expect(useExplorerStore.getState().revealTarget[PID]).toBe('src/sub');
    expect(useContentSelection.getState().selections[PID] ?? null).toBeNull();
  });

  it('is a no-op for a non-existent local path', async () => {
    resolveTo({ exists: false });
    await openLinkTarget('./ghost.txt', { projectId: PID });
    expect(useContentSelection.getState().selections[PID] ?? null).toBeNull();
    expect(useExplorerStore.getState().revealTarget[PID] ?? null).toBeNull();
  });

  it('is a no-op for a local path when there is no active project', async () => {
    await openLinkTarget('/etc/hosts', { projectId: null });
    expect(api.provider.resolvePath).not.toHaveBeenCalled();
  });
});
