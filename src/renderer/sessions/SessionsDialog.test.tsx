// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// `agentCockpit` captures the preload bridge when its module is evaluated.
// Install this narrow Sessions-dialog bridge before importing the component.
const api = vi.hoisted(() => {
  const fake = {
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      kill: vi.fn().mockResolvedValue(undefined),
      killDetached: vi.fn().mockResolvedValue([]),
    },
    muxSessions: {
      list: vi.fn().mockResolvedValue([]),
      destroy: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue(undefined),
    },
  };
  (globalThis as unknown as { window: { api: typeof fake } }).window.api = fake;
  return fake;
});

import { SessionsDialog } from './SessionsDialog';

afterEach(() => {
  cleanup();
  api.sessions.list.mockResolvedValue([]);
  api.muxSessions.list.mockResolvedValue([]);
});

describe('SessionsDialog', () => {
  it('makes an incompatible mux recovery visibly require a cold restart', async () => {
    api.muxSessions.list.mockResolvedValue([
      {
        projectId: 'project-a',
        sessionId: 'session-1',
        paneId: 'pane-1',
        key: 'editor',
        exited: true,
        broadcast: false,
        pinned: false,
        attachedKind: null,
        logicalSessionId: 'session-1',
        windowId: 'window-1',
        broadcastScope: 'window',
        recoveryDiagnostic: 'incompatible mux snapshot engine',
      },
    ]);

    render(<SessionsDialog open onOpenChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('cold restart required')).toBeInTheDocument());
    expect(screen.getByTitle('incompatible mux snapshot engine')).toBeInTheDocument();
  });
});
