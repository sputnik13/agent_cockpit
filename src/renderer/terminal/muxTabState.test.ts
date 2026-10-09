import { describe, expect, it } from 'vitest';
import { muxTabState } from './muxTabState';

describe('muxTabState', () => {
  it('hydrates per-tab broadcast state only from the active project inventory', () => {
    expect(
      muxTabState(
        [
          {
            projectId: 'project-a',
            sessionId: 'session-1',
            paneId: 'pane-1',
            key: 't1',
            exited: false,
            broadcast: true,
            pinned: false,
            attachedKind: 'cockpit',
            logicalSessionId: 'session-1',
            windowId: 'window-1',
            broadcastScope: 'session',
          },
          {
            projectId: 'project-b',
            sessionId: 'session-2',
            paneId: 'pane-2',
            key: 't1',
            exited: false,
            broadcast: false,
            pinned: false,
            attachedKind: 'cockpit',
            logicalSessionId: 'session-2',
            windowId: 'window-2',
            broadcastScope: 'window',
          },
        ],
        'project-a',
      ),
    ).toEqual({ broadcast: { t1: true }, scope: { t1: 'session' } });
  });
});
