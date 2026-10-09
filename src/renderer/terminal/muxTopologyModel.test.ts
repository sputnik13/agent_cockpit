import { describe, expect, it } from 'vitest';
import {
  adjacentMuxPane,
  EMPTY_MUX_TOPOLOGY,
  reconcileMuxTopology,
} from './muxTopologyModel';

describe('reconcileMuxTopology', () => {
  it('does not let an older topology read resurrect a closed window', () => {
    const afterClose = {
      epoch: 'daemon-a',
      revision: 12,
      sessions: [
        {
          sessionId: 'logical-1',
          windowOrder: ['window-3'],
          activeWindowId: 'window-3',
          windows: [
            {
              windowId: 'window-3',
              activePaneId: 'pane-3',
              zoomedPaneId: null,
              layout: null,
              panes: [{ sessionId: 'pane-session-3', paneId: 'pane-3', key: 't3', exited: false }],
            },
          ],
        },
      ],
    };
    const staleRead = {
      epoch: 'daemon-a',
      revision: 11,
      sessions: [
        {
          sessionId: 'logical-1',
          windowOrder: [],
          activeWindowId: 'window-2',
          windows: [],
        },
      ],
    };

    expect(reconcileMuxTopology(afterClose, staleRead)).toBe(afterClose);
    expect(reconcileMuxTopology(EMPTY_MUX_TOPOLOGY, afterClose)).toBe(afterClose);
  });

  it('advances the idle-poll watermark while retaining session identity', () => {
    const current = {
      epoch: 'daemon-a',
      revision: 12,
      sessions: [
        {
          sessionId: 'logical-1',
          windowOrder: ['window-1'],
          activeWindowId: 'window-1',
          windows: [
            {
              windowId: 'window-1',
              activePaneId: 'pane-1',
              zoomedPaneId: null,
              layout: { paneId: 'pane-1' },
              panes: [{ sessionId: 'pane-session-1', paneId: 'pane-1', key: 't1', exited: false }],
            },
          ],
        },
      ],
    };
    const idlePoll = { ...current, revision: 13, sessions: structuredClone(current.sessions) };

    const reconciled = reconcileMuxTopology(current, idlePoll);
    expect(reconciled).toMatchObject({ revision: 13 });
    expect(reconciled.sessions).toBe(current.sessions);
  });

  it('does not let a delayed topology mutation replace a newer equivalent poll', () => {
    const current = {
      epoch: 'daemon-a',
      revision: 20,
      activeSessionId: 'logical-1',
      sessions: [{ sessionId: 'logical-1', windowOrder: [], activeWindowId: null, windows: [] }],
    };
    const delayedMutation = {
      epoch: 'daemon-a',
      revision: 15,
      activeSessionId: 'logical-1',
      sessions: [{ sessionId: 'logical-1', windowOrder: ['resurrected'], activeWindowId: 'resurrected', windows: [] }],
    };

    expect(reconcileMuxTopology(current, delayedMutation)).toBe(current);
  });

  it('accepts a selection-only mutation even when its window catalog is unchanged', () => {
    const sessions = [{ sessionId: 'logical-1', windowOrder: [], activeWindowId: null, windows: [] }];
    const current = { epoch: 'daemon-a', revision: 20, activeSessionId: 'logical-1', sessions };
    const selected = { epoch: 'daemon-a', revision: 21, activeSessionId: 'logical-2', sessions: structuredClone(sessions) };

    expect(reconcileMuxTopology(current, selected)).toBe(selected);
  });

  it('accepts a recovered daemon catalog even when its revision restarts', () => {
    const beforeRecovery = { epoch: 'daemon-a', revision: 82, sessions: [] };
    const afterRecovery = { epoch: 'daemon-b', revision: 1, sessions: [] };

    expect(reconcileMuxTopology(beforeRecovery, afterRecovery)).toBe(afterRecovery);
  });

  it('does not accept a late catalog from a daemon epoch that recovery retired', () => {
    const beforeRecovery = { epoch: 'daemon-a', revision: 82, sessions: [] };
    const afterRecovery = { epoch: 'daemon-b', revision: 1, sessions: [] };
    const lateBeforeRecovery = { epoch: 'daemon-a', revision: 83, sessions: [] };

    expect(reconcileMuxTopology(afterRecovery, lateBeforeRecovery, new Set([beforeRecovery.epoch]))).toBe(
      afterRecovery,
    );
  });
});

describe('adjacentMuxPane', () => {
  const panes = ['pane-left', 'pane-top', 'pane-bottom'].map((paneId) => ({
    sessionId: `session-${paneId}`,
    paneId,
    key: paneId,
    exited: false,
  }));
  const horizontalThenVertical = {
    direction: 'horizontal' as const,
    ratio: 0.5,
    first: { paneId: 'pane-left' },
    second: {
      direction: 'vertical' as const,
      ratio: 0.5,
      first: { paneId: 'pane-top' },
      second: { paneId: 'pane-bottom' },
    },
  };

  it('uses only physical shared edges so every directional edge is reversible', () => {
    const target = (paneId: string, direction: 'left' | 'right' | 'up' | 'down') =>
      adjacentMuxPane(horizontalThenVertical, panes, paneId, direction)?.paneId ?? null;

    expect(target('pane-left', 'right')).toBe('pane-top');
    expect(target('pane-top', 'left')).toBe('pane-left');
    expect(target('pane-top', 'down')).toBe('pane-bottom');
    expect(target('pane-bottom', 'up')).toBe('pane-top');
    expect(target('pane-bottom', 'left')).toBe('pane-left');
    expect(target('pane-left', 'down')).toBeNull();
    expect(target('pane-left', 'up')).toBeNull();
  });
});
