// @vitest-environment jsdom
/**
 * The status bar's cue for a terminal's `cockpit open` whose Content panel was
 * deliberately not shown: an always-mounted live region (role=status) with the file
 * name, a tooltip carrying the path and the reason, and a Show action.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ProjectInfo } from '@shared/ipc/channels';
import { useProjectsStore } from '../providerClient';
import { OPEN_CUE_MS, useOpenCueStore } from '../workspace/openCueStore';
import { PanelIds } from '../workspace/panelIds';
import { useWorkspaceControlsStore } from '../workspace/workspaceControlsStore';
import { StatusRegion } from './StatusRegion';

const project = (id: string, label: string): ProjectInfo =>
  ({
    id,
    label,
    kind: 'local',
    connection: { kind: 'local', rootPath: `/repo/${id}` },
  }) as unknown as ProjectInfo;

const raise = (name: string, projectId = 'p1', reason = 'it would hide the terminal'): void =>
  act(() => {
    useOpenCueStore
      .getState()
      .show({ projectId, name, path: `/repo/${projectId}/${name}`, reason });
  });

let openPanel: ReturnType<typeof vi.fn<(id: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  openPanel = vi.fn<(id: string) => void>();
  useProjectsStore.setState({
    projects: [project('p1', 'Project A'), project('p2', 'Project B')],
    activeId: 'p1',
  });
  useWorkspaceControlsStore.setState({ openPanel });
  useOpenCueStore.getState().clear();
});

afterEach(() => {
  cleanup();
  useOpenCueStore.getState().clear();
  useProjectsStore.setState({ projects: [], activeId: null });
  useWorkspaceControlsStore.setState({ openPanel: () => undefined });
  vi.useRealTimers();
});

const live = (): HTMLElement => screen.getByRole('status');

describe('StatusRegion: the open cue', () => {
  it('always has the live region, empty until a cue is raised (so a screen reader announces the text)', () => {
    render(<StatusRegion />);
    expect(live()).toBeEmptyDOMElement();
    raise('README.md');
    expect(live()).toHaveTextContent('Opened README.md in Content (hidden)');
  });

  it('offers a Show action named for the file, and the tooltip carries the path and the reason', () => {
    render(<StatusRegion />);
    raise('README.md', 'p1', 'the Content panel is tabbed behind the Terminal');
    expect(screen.getByRole('button', { name: 'Show README.md in Content' })).toHaveTextContent(
      'Show',
    );
    expect(screen.getByText('Opened README.md in Content (hidden)')).toHaveAttribute(
      'title',
      '/repo/p1/README.md: the Content panel is tabbed behind the Terminal',
    );
  });

  it('Show opens the Content panel through the workbench controls and dismisses the cue', () => {
    render(<StatusRegion />);
    raise('README.md');
    act(() => screen.getByRole('button', { name: /^Show / }).click());
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledWith(PanelIds.content);
    expect(live()).toBeEmptyDOMElement();
    expect(useOpenCueStore.getState().cue).toBeNull();
  });

  it("is shown only while the cue's own project is the active one", () => {
    render(<StatusRegion />);
    raise('b.md', 'p2');
    expect(live()).toBeEmptyDOMElement(); // p1 is active
    act(() => useProjectsStore.setState({ activeId: 'p2' }));
    expect(live()).toHaveTextContent('Opened b.md in Content (hidden)');
  });

  it('a newer cue replaces the older one', () => {
    render(<StatusRegion />);
    raise('a.md');
    raise('b.md');
    expect(live()).toHaveTextContent('Opened b.md in Content (hidden)');
    expect(live()).not.toHaveTextContent('a.md');
  });

  it('dismisses itself after the timeout', () => {
    render(<StatusRegion />);
    raise('a.md');
    act(() => {
      vi.advanceTimersByTime(OPEN_CUE_MS);
    });
    expect(live()).toBeEmptyDOMElement();
  });

  it('shows no cue and still renders with no active project', () => {
    act(() => useProjectsStore.setState({ activeId: null }));
    render(<StatusRegion />);
    raise('a.md');
    expect(screen.getByText('No active project')).toBeInTheDocument();
    expect(live()).toBeEmptyDOMElement();
  });

  it('exposes the active project id on the bar (a stable hook for tests and DevTools)', () => {
    const { container } = render(<StatusRegion />);
    expect(container.firstElementChild).toHaveAttribute('data-active-project', 'p1');
    act(() => useProjectsStore.setState({ activeId: 'p2' }));
    expect(container.firstElementChild).toHaveAttribute('data-active-project', 'p2');
  });
});
