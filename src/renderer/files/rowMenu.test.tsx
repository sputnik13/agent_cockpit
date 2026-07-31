// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import type { ProjectInfo } from '@shared/ipc/channels';
import { ContextMenu, Row } from '../ui';

const mockSaveAs = vi.fn<(path: string, opts?: unknown) => Promise<string | null>>();
const mockLogDiagnostic = vi.fn();

vi.mock('@renderer/providerClient', () => ({
  agentCockpit: { files: { saveAs: (...args: [string, unknown?]) => mockSaveAs(...args) } },
  logDiagnostic: (...args: [string, string, string]) => mockLogDiagnostic(...args),
}));

import {
  absoluteUnder,
  resolveAbsolutePath,
  buildFileRowMenuItems,
  copyToClipboard,
  downloadRow,
  useRowMenuFeedback,
  COPY_ABSOLUTE_LABEL,
  COPY_RELATIVE_LABEL,
  COPY_RELATIVE_UNAVAILABLE_TITLE,
  DOWNLOAD_LABEL,
  DOWNLOAD_DIR_TITLE,
  DOWNLOAD_UNAVAILABLE_TITLE,
  type FileRowDescriptor,
} from './rowMenu';

function localProject(rootPath: string, id = 'p-local'): ProjectInfo {
  return {
    id,
    label: 'Local',
    kind: 'local',
    connection: { kind: 'local', rootPath },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: null,
    runCommand: null,
  };
}

function remoteProject(remotePath: string, id = 'p-remote'): ProjectInfo {
  return {
    id,
    label: 'Remote',
    kind: 'remote',
    connection: { kind: 'remote', host: 'example.com', user: 'me', port: 22, remotePath },
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: null,
    runCommand: null,
  };
}

function descriptor(over: Partial<FileRowDescriptor> = {}): FileRowDescriptor {
  return { relPath: 'src/foo.ts', worktreePath: null, isDir: false, downloadable: true, ...over };
}

/** Flush every pending microtask (the copy/download `.then()` chains). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('absoluteUnder', () => {
  it('joins a base and relative path, trimming a trailing slash on base', () => {
    expect(absoluteUnder('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
    expect(absoluteUnder('/repo/', 'src/a.ts')).toBe('/repo/src/a.ts');
  });
});

describe('resolveAbsolutePath', () => {
  it('resolves against the active worktree when one is selected', () => {
    const project = localProject('/repo/main');
    expect(resolveAbsolutePath('src/a.ts', '/repo/worktrees/feature', project)).toBe(
      '/repo/worktrees/feature/src/a.ts',
    );
  });

  it('falls back to the local project root when activeWorktree is null', () => {
    const project = localProject('/repo/main');
    expect(resolveAbsolutePath('src/a.ts', null, project)).toBe('/repo/main/src/a.ts');
  });

  it('resolves a remote project from RemoteConnectionSpec.remotePath (remote host path, not local)', () => {
    const project = remoteProject('/home/user/project');
    expect(resolveAbsolutePath('src/a.ts', null, project)).toBe('/home/user/project/src/a.ts');
  });

  it('joins a nested subdirectory relPath correctly', () => {
    expect(resolveAbsolutePath('a/b/c/d.ts', '/repo', null)).toBe('/repo/a/b/c/d.ts');
  });

  it('passes an already-absolute relPath through unchanged (Explorer root-browse shape)', () => {
    const project = localProject('/repo/main');
    expect(resolveAbsolutePath('/etc/hosts', '/repo/worktrees/feature', project)).toBe('/etc/hosts');
  });
});

describe('buildFileRowMenuItems', () => {
  it('returns exactly the three items with their exact labels, in order', () => {
    const items = buildFileRowMenuItems(descriptor(), { activeProject: null });
    expect(items.map((i) => i.label)).toEqual([COPY_ABSOLUTE_LABEL, COPY_RELATIVE_LABEL, DOWNLOAD_LABEL]);
  });

  it('D2: disables Download for a directory row, with the directory reason as the title', () => {
    const items = buildFileRowMenuItems(descriptor({ isDir: true, downloadable: true }), {
      activeProject: null,
    });
    const download = items[2]!;
    expect(download.disabled).toBe(true);
    expect(download.title).toBe(DOWNLOAD_DIR_TITLE);
  });

  it('disables Download when the row reports non-downloadable content (e.g. a deleted file)', () => {
    const items = buildFileRowMenuItems(descriptor({ isDir: false, downloadable: false }), {
      activeProject: null,
    });
    const download = items[2]!;
    expect(download.disabled).toBe(true);
    expect(download.title).toBe(DOWNLOAD_UNAVAILABLE_TITLE);
  });

  it('enables Download (no title) for a plain downloadable file', () => {
    const items = buildFileRowMenuItems(descriptor({ isDir: false, downloadable: true }), {
      activeProject: null,
    });
    const download = items[2]!;
    expect(download.disabled).toBe(false);
    expect(download.title).toBeUndefined();
  });

  it('D1 (ynz8.5): enables Copy path (relative) by default when relativeAvailable is omitted', () => {
    const items = buildFileRowMenuItems(descriptor(), { activeProject: null });
    const relative = items[1]!;
    expect(relative.disabled).toBeFalsy();
    expect(relative.title).toBeUndefined();
  });

  it('D1 (ynz8.5): enables Copy path (relative) when relativeAvailable is explicitly true', () => {
    const items = buildFileRowMenuItems(descriptor({ relativeAvailable: true }), { activeProject: null });
    const relative = items[1]!;
    expect(relative.disabled).toBeFalsy();
    expect(relative.title).toBeUndefined();
  });

  it('D1 (ynz8.5): disables Copy path (relative) with an explanatory title when relativeAvailable is false', () => {
    const items = buildFileRowMenuItems(descriptor({ relativeAvailable: false }), { activeProject: null });
    const relative = items[1]!;
    expect(relative.disabled).toBe(true);
    expect(relative.title).toBe(COPY_RELATIVE_UNAVAILABLE_TITLE);
  });

  it('D1 (ynz8.5): a disabled Copy path (relative) does not affect Copy path (fully qualified)', () => {
    const items = buildFileRowMenuItems(
      descriptor({ relPath: '/etc/hosts', relativeAvailable: false }),
      { activeProject: null },
    );
    const absolute = items[0]!;
    expect(absolute.disabled).toBeFalsy();
    expect(absolute.title).toBeUndefined();
  });
});

describe('copyToClipboard', () => {
  it('calls navigator.clipboard.writeText with the exact text and resolves true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await expect(copyToClipboard('/repo/src/a.ts')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('/repo/src/a.ts');
  });

  it('does not throw when the clipboard is unavailable, resolving false', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await expect(copyToClipboard('/repo/src/a.ts')).resolves.toBe(false);
  });
});

describe('buildFileRowMenuItems copy actions (wired onSelect)', () => {
  it('Copy path (fully qualified) writes the resolved absolute path and reports completion', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onActionComplete = vi.fn();

    const items = buildFileRowMenuItems(descriptor({ relPath: 'src/a.ts', worktreePath: '/repo/wt' }), {
      activeProject: null,
      onActionComplete,
    });
    items[0]!.onSelect();
    await flush();

    expect(writeText).toHaveBeenCalledWith('/repo/wt/src/a.ts');
    expect(onActionComplete).toHaveBeenCalledWith('Copied fully-qualified path');
  });

  it('Copy path (relative) writes the raw relPath and reports completion', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onActionComplete = vi.fn();

    const items = buildFileRowMenuItems(descriptor({ relPath: 'src/a.ts', worktreePath: '/repo/wt' }), {
      activeProject: null,
      onActionComplete,
    });
    items[1]!.onSelect();
    await flush();

    expect(writeText).toHaveBeenCalledWith('src/a.ts');
    expect(onActionComplete).toHaveBeenCalledWith('Copied relative path');
  });

  it('does not call onActionComplete when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onActionComplete = vi.fn();

    const items = buildFileRowMenuItems(descriptor(), { activeProject: null, onActionComplete });
    items[0]!.onSelect();
    await flush();

    expect(onActionComplete).not.toHaveBeenCalled();
  });
});

describe('downloadRow', () => {
  it('calls the saveAs bridge with the row path (relative) and the active worktree', async () => {
    mockSaveAs.mockResolvedValue('/Users/me/Downloads/foo.ts');
    const project = localProject('/repo/main', 'proj-1');

    const saved = await downloadRow(
      descriptor({ relPath: 'src/foo.ts', worktreePath: '/repo/wt' }),
      project,
    );

    expect(saved).toBe('/Users/me/Downloads/foo.ts');
    expect(mockSaveAs).toHaveBeenCalledWith('src/foo.ts', {
      worktreePath: '/repo/wt',
      projectId: 'proj-1',
      suggestedName: 'foo.ts',
    });
  });

  it('passes worktreePath as undefined (project-root fallback) when the descriptor has none', async () => {
    mockSaveAs.mockResolvedValue(null);
    await downloadRow(descriptor({ relPath: 'a.ts', worktreePath: null }), null);
    expect(mockSaveAs).toHaveBeenCalledWith(
      'a.ts',
      expect.objectContaining({ worktreePath: undefined, projectId: undefined }),
    );
  });
});

describe('buildFileRowMenuItems download action (wired onSelect)', () => {
  it('calls the bridge with the row path + worktree and reports completion on a saved path', async () => {
    mockSaveAs.mockResolvedValue('/Users/me/Downloads/foo.ts');
    const onActionComplete = vi.fn();
    const project = localProject('/repo/main', 'proj-1');

    const items = buildFileRowMenuItems(
      descriptor({ relPath: 'src/foo.ts', worktreePath: '/repo/wt', downloadable: true }),
      { activeProject: project, onActionComplete },
    );
    items[2]!.onSelect();
    await flush();

    expect(mockSaveAs).toHaveBeenCalledWith('src/foo.ts', {
      worktreePath: '/repo/wt',
      projectId: 'proj-1',
      suggestedName: 'foo.ts',
    });
    expect(onActionComplete).toHaveBeenCalledWith('Downloaded');
  });

  it('does not report completion when the user cancels the save dialog (null)', async () => {
    mockSaveAs.mockResolvedValue(null);
    const onActionComplete = vi.fn();

    const items = buildFileRowMenuItems(descriptor({ downloadable: true }), {
      activeProject: null,
      onActionComplete,
    });
    items[2]!.onSelect();
    await flush();

    expect(onActionComplete).not.toHaveBeenCalled();
  });

  it('logs a diagnostic (does not throw) when the bridge rejects', async () => {
    mockSaveAs.mockRejectedValue(new Error('disconnected'));
    const onActionComplete = vi.fn();

    const items = buildFileRowMenuItems(descriptor({ relPath: 'src/foo.ts', downloadable: true }), {
      activeProject: null,
      onActionComplete,
    });
    expect(() => items[2]!.onSelect()).not.toThrow();
    await flush();

    expect(onActionComplete).not.toHaveBeenCalled();
    expect(mockLogDiagnostic).toHaveBeenCalledWith(
      'error',
      'rowMenu',
      expect.stringContaining('src/foo.ts'),
    );
  });
});

describe('useRowMenuFeedback (D3)', () => {
  it('sets a transient message via notify() and clears it after the timeout', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRowMenuFeedback(1000));
    expect(result.current.message).toBeNull();

    act(() => {
      result.current.notify('Downloaded');
    });
    expect(result.current.message).toBe('Downloaded');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.message).toBeNull();
  });
});

describe('Row as a ContextMenu trigger (D1 + the shared menu items)', () => {
  it('renders with no React ref warning and shows the three items with exact labels', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const items = buildFileRowMenuItems(descriptor({ relPath: 'src/foo.ts', downloadable: true }), {
      activeProject: null,
    });

    render(
      <ContextMenu items={items}>
        <Row data-testid="file-row">foo.ts</Row>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByTestId('file-row'));

    expect(screen.getByText(COPY_ABSOLUTE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(COPY_RELATIVE_LABEL)).toBeInTheDocument();
    expect(screen.getByText(DOWNLOAD_LABEL)).toBeInTheDocument();
    // The regression this substrate leaf exists to fix: Row must forward its
    // ref so Radix's `Trigger asChild` (Slot) can attach to it without React
    // logging "Function components cannot be given refs.".
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
