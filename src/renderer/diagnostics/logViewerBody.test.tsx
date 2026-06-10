// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { LogEntry } from '@shared/ipc/channels';

// jsdom does not implement scrollIntoView — stub it globally.
Element.prototype.scrollIntoView = vi.fn();

function makeEntry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: new Date().toISOString(),
    level: 'info',
    message: 'hello',
    ...over,
  };
}

// Install a minimal window.api stub before the store is imported.
function installApi(entries: LogEntry[] = []) {
  const offMock = vi.fn();
  Object.defineProperty(globalThis, 'window', { value: globalThis, writable: true });
  (globalThis as unknown as Record<string, unknown>)['api'] = {
    logs: { get: vi.fn().mockResolvedValue(entries) },
    events: { onLog: vi.fn().mockReturnValue(offMock) },
  };
  return offMock;
}

describe('LogViewerBody', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.resetModules();
  });

  it('shows empty-state text when there are no entries', async () => {
    installApi();
    // Import after installApi so the store module sees window.api.
    const { useLogsStore } = await import('../providerClient/logsStore');
    useLogsStore.getState().clearEntries();
    const { LogViewerBody } = await import('./LogViewerBody');

    render(<LogViewerBody />);
    expect(screen.getByText(/No log entries yet/)).toBeInTheDocument();
  });

  it('renders one row per entry with level and message', async () => {
    installApi();
    const { useLogsStore } = await import('../providerClient/logsStore');
    useLogsStore.getState().clearEntries();
    useLogsStore.getState().addEntry(makeEntry({ level: 'info', message: 'info-msg' }));
    useLogsStore.getState().addEntry(makeEntry({ level: 'error', message: 'err-msg' }));
    const { LogViewerBody } = await import('./LogViewerBody');

    render(<LogViewerBody />);
    expect(screen.getByText('info-msg')).toBeInTheDocument();
    expect(screen.getByText('err-msg')).toBeInTheDocument();
    // Level labels are rendered in a span with the CSS uppercase class; jsdom
    // does not apply CSS transforms so check the raw text content.
    expect(screen.getAllByText('info')).toHaveLength(1);
    expect(screen.getAllByText('error')).toHaveLength(1);
  });

  it('renders context bracket when present', async () => {
    installApi();
    const { useLogsStore } = await import('../providerClient/logsStore');
    useLogsStore.getState().clearEntries();
    useLogsStore.getState().addEntry(makeEntry({ context: 'ipc', message: 'ctx-msg' }));
    const { LogViewerBody } = await import('./LogViewerBody');

    render(<LogViewerBody />);
    expect(screen.getByText('[ipc]')).toBeInTheDocument();
    expect(screen.getByText('ctx-msg')).toBeInTheDocument();
  });

  it('renders Copy all and Clear buttons', async () => {
    installApi();
    const { useLogsStore } = await import('../providerClient/logsStore');
    useLogsStore.getState().clearEntries();
    const { LogViewerBody } = await import('./LogViewerBody');

    render(<LogViewerBody />);
    expect(screen.getByRole('button', { name: /Copy all/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clear/i })).toBeInTheDocument();
  });
});
