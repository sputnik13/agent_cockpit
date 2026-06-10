// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProjectInfo } from '@shared/ipc/channels';
import { useProjectsStore } from './projectsStore';

const projA: ProjectInfo = {
  id: 'a',
  label: 'Alpha',
  kind: 'local',
  connection: { kind: 'local', rootPath: '/a' },
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: null,
};

function mockApi(over: Partial<Record<string, unknown>> = {}) {
  const projects = {
    list: vi.fn().mockResolvedValue([projA]),
    getActive: vi.fn().mockResolvedValue('a'),
    add: vi.fn().mockResolvedValue(projA),
    remove: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue(undefined),
    openDialog: vi.fn(),
  };
  (window as unknown as { api: unknown }).api = {
    projects,
    events: { onProjectsChanged: vi.fn(() => () => {}) },
    ...over,
  };
  return projects;
}

describe('useProjectsStore', () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [], activeId: null, loading: false, error: null });
  });

  it('refresh loads projects and active id', async () => {
    mockApi();
    await useProjectsStore.getState().refresh();
    const s = useProjectsStore.getState();
    expect(s.projects).toHaveLength(1);
    expect(s.activeId).toBe('a');
    expect(s.loading).toBe(false);
  });

  it('activate calls the bridge and sets activeId', async () => {
    const api = mockApi();
    await useProjectsStore.getState().activate('a');
    expect(api.activate).toHaveBeenCalledWith('a');
    expect(useProjectsStore.getState().activeId).toBe('a');
  });

  it('add and remove proxy to the bridge and refresh', async () => {
    const api = mockApi();
    await useProjectsStore.getState().add({ label: 'Alpha', connection: { kind: 'local', rootPath: '/a' } });
    expect(api.add).toHaveBeenCalled();
    await useProjectsStore.getState().remove('a');
    expect(api.remove).toHaveBeenCalledWith('a');
  });

  it('refresh records an error when the bridge throws', async () => {
    mockApi({ });
    (window as unknown as { api: { projects: { list: ReturnType<typeof vi.fn> } } }).api.projects.list =
      vi.fn().mockRejectedValue(new Error('boom'));
    await useProjectsStore.getState().refresh();
    expect(useProjectsStore.getState().error).toMatch(/boom/);
  });

  it('activate re-throws and does NOT set activeId on failure (3j0f: errors not swallowed)', async () => {
    const api = mockApi();
    api.activate.mockRejectedValue(new Error('[auth] SSH auth failed'));
    // activeId was null before the failed activate
    await expect(useProjectsStore.getState().activate('a')).rejects.toThrow('SSH auth failed');
    // activeId must remain null — no project switch on activation failure
    expect(useProjectsStore.getState().activeId).toBeNull();
  });
});
