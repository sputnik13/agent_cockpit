import { describe, expect, it, vi } from 'vitest';
import { RemoteMuxTerminalManager } from './muxTerminal';

describe('RemoteMuxTerminalManager', () => {
  it('serializes rapid pane resizes so the final geometry wins', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-resize', pane_id: 'pane-resize' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'resize', cols: 110, rows: 45 });
    manager.resize('resize', 110, 45);
    manager.resize('resize', 54, 45);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        'pane.resize',
        expect.objectContaining({ pane_id: 'pane-resize', cols: 54, rows: 45 }),
      ),
    );
    expect(request.mock.calls.filter(([method]) => method === 'pane.resize')).toEqual([
      ['pane.resize', expect.objectContaining({ pane_id: 'pane-resize', cols: 54, rows: 45 })],
    ]);
    await manager.close('resize', { kill: true });
  });

  it('does not reattach a terminal while its initial create has no daemon identity', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-initial', pane_id: 'pane-initial' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const onAttached = new Set<(epoch: number) => void>();
    const connection = {
      open: vi.fn(async () => {
        for (const handler of onAttached) handler(1);
      }),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached,
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'initial', cols: 80, rows: 24 });
    await Promise.resolve();

    const attaches = request.mock.calls.filter(([method]) => method === 'session.attach');
    expect(attaches).toEqual([
      [
        'session.attach',
        expect.objectContaining({ session_id: 'session-initial', client_kind: 'cockpit' }),
      ],
    ]);
    await manager.close('initial', { kill: true });
  });

  it('coalesces concurrent opens for a pending key before it has daemon identity', async () => {
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-shared', pane_id: 'pane-shared' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(() => gate),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    const first = manager.open({ key: 'shared', cols: 80, rows: 24 });
    const second = manager.open({ key: 'shared', cols: 120, rows: 40 });
    releaseOpen();

    await expect(Promise.all([first, second])).resolves.toEqual([{ id: 'shared' }, { id: 'shared' }]);
    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === 'session.attach')).toEqual([
      ['session.attach', expect.objectContaining({ session_id: 'session-shared', client_kind: 'cockpit' })],
    ]);
    await manager.close('shared', { kill: true });
  });

  it('cancels a close that arrives before the connection opens without creating an orphan', async () => {
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-race', pane_id: 'pane-race' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(() => gate),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    const opening = manager.open({ key: 't1', cols: 80, rows: 24 });
    const closing = manager.close('t1', { kill: true });
    releaseOpen();

    await closing;
    await expect(opening).rejects.toThrow('closed while opening');
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
    expect(manager.has('t1')).toBe(false);
  });

  it('lets an explicit same-key create supersede a cancelled opening generation', async () => {
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create')
        return { session_id: 'session-successor', pane_id: 'pane-successor' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(() => gate),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    const former = manager.open({ key: 'same', cols: 80, rows: 24 });
    const closing = manager.close('same', { kill: true });
    const successor = manager.open({ key: 'same', cols: 80, rows: 24, createIfMissing: true });
    releaseOpen();

    await closing;
    await expect(former).rejects.toThrow('closed while opening');
    await expect(successor).resolves.toEqual({ id: 'same' });
    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    await manager.close('same', { kill: true });
    await expect(manager.open({ key: 'same', cols: 80, rows: 24 })).rejects.toThrow(
      'was closed and cannot be reattached',
    );
  });

  it('does not recreate an inventory-missing pane from an attach-only restoration', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') return { sessions: [] };
      if (method === 'session.create') return { session_id: 'unexpected', pane_id: 'unexpected' };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(
      manager.open({ key: 'previously-closed-key', cols: 80, rows: 24, createIfMissing: false }),
    ).rejects.toThrow('is absent and cannot be reattached');
    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
  });

  it('keeps the interactive terminal selection when creating the private Run tty', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') return { sessions: [] };
      if (method === 'session.topology') {
        return {
          active_session_id: 'terminal-session',
          sessions: [
            {
              session_id: 'terminal-session',
              active_window_id: 'terminal-window',
              windows: [
                {
                  window_id: 'terminal-window',
                  active_pane_id: 'terminal-pane',
                  panes: [{ pane_id: 'terminal-pane' }],
                },
              ],
            },
          ],
        };
      }
      if (method === 'session.create') return { session_id: 'run-session', pane_id: 'run-pane' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'run', kind: 'run', cols: 80, rows: 24, createIfMissing: true });
    expect(request).toHaveBeenCalledWith('pane.select', {
      session_id: 'terminal-session',
      window_id: 'terminal-window',
      pane_id: 'terminal-pane',
    });
    await manager.close('run', { kill: true });
  });

  it('maps daemon topology and forwards explicit selection and zoom mutations', async () => {
    const response = {
      sessions: [
        {
          session_id: 'session-1',
          window_order: ['window-2', 'window-1'],
          active_window_id: 'window-1',
          windows: [
            {
              window_id: 'window-1',
              active_pane_id: 'pane-2',
              panes: [
                { session_id: 'session-1', pane_id: 'pane-1', key: 'root', exited: false },
                { session_id: 'session-2', pane_id: 'pane-2', key: 'split', exited: false },
              ],
            },
            {
              window_id: 'window-2',
              active_pane_id: 'pane-3',
              panes: [{ session_id: 'session-3', pane_id: 'pane-3', key: 'other', exited: false }],
            },
          ],
        },
      ],
    };
    const request = vi.fn(async () => response);
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(manager.listMuxTopology()).resolves.toEqual({
      epoch: 'legacy',
      revision: 0,
      activeSessionId: null,
      sessions: [
        {
        sessionId: 'session-1',
        windowOrder: ['window-2', 'window-1'],
        activeWindowId: 'window-1',
        windows: [
          {
            windowId: 'window-1',
            activePaneId: 'pane-2',
            zoomedPaneId: null,
            layout: null,
            panes: [
              { sessionId: 'session-1', paneId: 'pane-1', key: 'root', exited: false },
              { sessionId: 'session-2', paneId: 'pane-2', key: 'split', exited: false },
            ],
          },
          {
            windowId: 'window-2',
            activePaneId: 'pane-3',
            zoomedPaneId: null,
            layout: null,
            panes: [{ sessionId: 'session-3', paneId: 'pane-3', key: 'other', exited: false }],
          },
        ],
        },
      ],
    });
    await manager.selectMuxWindow('session-1', 'window-1');
    await manager.selectMuxPane('session-1', 'window-1', 'pane-2');
    await manager.zoomMuxPane('session-1', 'window-1', null);
    await manager.resizeMuxSplit('session-1', 'window-1', 'pane-2', 0.7);
    await manager.destroyWindow('session-1', 'window-1');

    expect(request).toHaveBeenCalledWith('window.select', {
      session_id: 'session-1',
      window_id: 'window-1',
    });
    expect(request).toHaveBeenCalledWith('pane.select', {
      session_id: 'session-1',
      window_id: 'window-1',
      pane_id: 'pane-2',
    });
    expect(request).toHaveBeenCalledWith('pane.zoom', {
      session_id: 'session-1',
      window_id: 'window-1',
    });
    expect(request).toHaveBeenCalledWith('pane.resizeSplit', {
      session_id: 'session-1',
      window_id: 'window-1',
      pane_id: 'pane-2',
      ratio: 0.7,
    });
    expect(request).toHaveBeenCalledWith('window.destroy', {
      session_id: 'session-1',
      window_id: 'window-1',
    });
  });

  it('applies the current Cockpit persistence preference before creating a pane', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create')
        return { session_id: 'session-policy', pane_id: 'pane-policy' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace', '', () => false);

    await manager.open({ key: 'private', cols: 80, rows: 24 });
    await manager.close('private', { kill: true });

    expect(request.mock.calls.map(([method]) => method).slice(0, 3)).toEqual([
      'mux.configure',
      'session.list',
      'session.create',
    ]);
    expect(request).toHaveBeenCalledWith('mux.configure', {
      persist_scrollback: false,
      scrollback_lines: 10_000,
    });
  });

  it('creates, seeds, writes, and destroys a daemon-owned terminal session', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-4', pane_id: 'pane-4' };
      if (method === 'session.attach')
        return { seed: Buffer.from('seed-output'), resume_sequence: 8 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace', 'project-a');

    await expect(manager.open({ key: 't1', cols: 80, rows: 24 })).resolves.toEqual({ id: 't1' });
    const data = vi.fn();
    manager.onData('t1', data);
    manager.write('t1', 'echo hello\n');
    manager.write('t1', '\u001b[?1;2c', 'reply');
    await manager.setBroadcast('t1', true);
    await manager.setBroadcastScope('t1', 'session');
    await Promise.resolve();
    await manager.close('t1', { kill: true });

    expect(request).toHaveBeenCalledWith('session.create', {
      command: '/usr/bin/env',
      args: ['BYOBU_DISABLE=1', '/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}"'],
      cwd: '/workspace',
      key: 't1',
      broadcast_group: 'project-a',
    });
    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({
        session_id: 'session-4',
        client_kind: 'cockpit',
        client_id: expect.stringMatching(/^cockpit-/),
        cols: 80,
        rows: 24,
      }),
    );
    expect(data).toHaveBeenCalledWith(Buffer.from('seed-output'));
    expect(request).toHaveBeenCalledWith(
      'pane.write',
      expect.objectContaining({
        pane_id: 'pane-4',
        client_id: expect.stringMatching(/^cockpit-/),
        data: Buffer.from('echo hello\n'),
        kind: 'input',
      }),
    );
    expect(request).toHaveBeenCalledWith(
      'pane.broadcast',
      expect.objectContaining({
        pane_id: 'pane-4',
        client_id: expect.stringMatching(/^cockpit-/),
        enabled: true,
      }),
    );
    expect(request).toHaveBeenCalledWith('session.broadcastScope', {
      session_id: 'session-4',
      scope: 'session',
    });
    expect(request).toHaveBeenCalledWith(
      'pane.write',
      expect.objectContaining({
        pane_id: 'pane-4',
        client_id: expect.stringMatching(/^cockpit-/),
        data: Buffer.from('\u001b[?1;2c'),
        kind: 'reply',
      }),
    );
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-4' });
  });

  it('re-attaches a live key so a reloaded renderer receives a fresh seed', async () => {
    let attachCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-live', pane_id: 'pane-live' };
      if (method === 'session.attach') {
        attachCount += 1;
        return { seed: Buffer.from(`seed-${attachCount}`), resume_sequence: attachCount };
      }
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    const staleRenderer = vi.fn();

    await manager.open({ key: 't1', cols: 80, rows: 24 });
    const unbind = manager.onData('t1', staleRenderer);
    unbind();
    await manager.open({ key: 't1', cols: 100, rows: 30 });
    const reloadedRenderer = vi.fn();
    manager.onData('t1', reloadedRenderer);
    await manager.close('t1', { kill: true });

    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === 'session.attach')).toHaveLength(2);
    expect(request).toHaveBeenLastCalledWith('session.destroy', { session_id: 'session-live' });
    expect(staleRenderer).not.toHaveBeenCalledWith(Buffer.from('seed-2'));
    expect(reloadedRenderer).toHaveBeenCalledWith(Buffer.from('seed-2'));
    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({ cols: 100, rows: 30, session_id: 'session-live' }),
    );
  });

  it('reconciles every pane by stable pane ID after a daemon crash recovery', async () => {
    let recovered = false;
    let created = 0;
    const onAttached = new Set<(epoch: number) => void>();
    const request = vi.fn(async (method: string, payload?: Record<string, unknown>) => {
      if (method === 'session.create') {
        created += 1;
        const suffix = created === 1 ? 'root' : 'split';
        return { session_id: `session-${suffix}`, pane_id: `pane-${suffix}` };
      }
      if (method === 'pane.split') return { session_id: 'session-split', pane_id: 'pane-split' };
      if (method === 'session.list') {
        if (!recovered) return { sessions: [] };
        return {
          sessions: [
            {
              session_id: 'recovered-pane-root',
              pane_id: 'pane-root',
              key: 'root',
              exited: true,
              broadcast: false,
              pinned: false,
              logical_session_id: 'logical-session',
            },
            {
              session_id: 'recovered-pane-split',
              pane_id: 'pane-split',
              key: 'split',
              exited: true,
              broadcast: false,
              pinned: false,
              logical_session_id: 'logical-session',
            },
          ],
        };
      }
      if (method === 'session.attach')
        return { seed: Buffer.from(`seed:${String(payload?.session_id)}`), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached,
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    const rootData = vi.fn();
    const splitData = vi.fn();
    const rootExit = vi.fn();
    const splitExit = vi.fn();

    await manager.open({ key: 'root', cols: 80, rows: 24 });
    await manager.split('root', 'split', 'vertical');
    manager.onData('root', rootData);
    manager.onData('split', splitData);
    manager.onExit('root', rootExit);
    manager.onExit('split', splitExit);

    recovered = true;
    for (const handler of onAttached) handler(2);
    await vi.waitFor(() => {
      expect(rootExit).toHaveBeenCalledWith({ code: null, signal: 'daemon-crash' });
      expect(splitExit).toHaveBeenCalledWith({ code: null, signal: 'daemon-crash' });
    });

    const recoveredAttaches = request.mock.calls.filter(
      ([method, payload]) =>
        method === 'session.attach' &&
        String((payload as Record<string, unknown>).session_id).startsWith('recovered-'),
    );
    expect(
      recoveredAttaches.map(([, payload]) => (payload as Record<string, unknown>).session_id),
    ).toEqual(['recovered-pane-root', 'recovered-pane-split']);
    expect(rootData).toHaveBeenCalledWith(Buffer.from('seed:recovered-pane-root'));
    expect(splitData).toHaveBeenCalledWith(Buffer.from('seed:recovered-pane-split'));
    expect(rootData).toHaveBeenCalledWith(
      '\r\n[terminal exited while Cockpit mux recovered from a daemon crash]\r\n',
    );
    expect(splitData).toHaveBeenCalledWith(
      '\r\n[terminal exited while Cockpit mux recovered from a daemon crash]\r\n',
    );

    await manager.close('split', { kill: true });
    await manager.close('root', { kill: true });
  });

  it('hydrates daemon history before the fresh renderer seed without affecting normal attach', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create')
        return { session_id: 'session-history', pane_id: 'pane-history' };
      if (method === 'session.attach')
        return { seed: Buffer.from('active-screen'), resume_sequence: 1 };
      if (method === 'scrollback.query') {
        return { lines: [{ line: 0, runs: [{ text: 'retained-history', sgr: '1;31' }] }] };
      }
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'history', cols: 80, rows: 24, hydrateScrollback: true });
    const data = vi.fn();
    manager.onData('history', data);
    await manager.close('history', { kill: true });

    expect(request).toHaveBeenCalledWith('scrollback.query', {
      pane_id: 'pane-history',
      client_id: expect.stringMatching(/^cockpit-/),
      before: 0,
      count: 1_000,
    });
    expect(data.mock.calls.map(([chunk]) => Buffer.from(chunk).toString())).toEqual([
      '\u001b[0m\u001b[1;31mretained-history\u001b[0m\r\n',
      'active-screen',
    ]);
  });

  it('negotiates and delivers a WTerm graphics seed after the text seed', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-graphics', pane_id: 'pane-graphics' };
      if (method === 'session.attach') {
        return {
          seed: Buffer.from('text-seed'),
          graphics_seed: Buffer.from('quiet-graphics-seed'),
          resume_sequence: 1,
        };
      }
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({
      key: 'graphics',
      cols: 80,
      rows: 24,
      rendererFeatures: ['direct_graphics_v1'],
      cellWidth: 9,
      cellHeight: 18,
    });
    const data = vi.fn();
    manager.onData('graphics', data);
    await manager.close('graphics', { kill: true });

    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({
        renderer_features: ['direct_graphics_v1'],
        cell_width: 9,
        cell_height: 18,
      }),
    );
    expect(data.mock.calls.map(([chunk]) => Buffer.from(chunk).toString())).toEqual([
      'text-seed',
      'quiet-graphics-seed',
    ]);
  });

  it('creates an attached sibling pane or window from the active mux terminal', async () => {
    let created = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-root', pane_id: 'pane-root' };
      if (method === 'pane.split') return { session_id: 'session-split', pane_id: 'pane-split' };
      if (method === 'window.new') return { session_id: 'session-window', pane_id: 'pane-window' };
      if (method === 'session.attach')
        return { seed: new Uint8Array(), resume_sequence: ++created };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'root', cols: 80, rows: 24 });
    await expect(manager.split('root', 'split', 'vertical')).resolves.toEqual({ id: 'split' });
    await expect(manager.newWindow('root', 'window')).resolves.toEqual({ id: 'window' });

    expect(request).toHaveBeenCalledWith('pane.split', {
      pane_id: 'pane-root',
      command: '/usr/bin/env',
      args: ['BYOBU_DISABLE=1', '/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}"'],
      cwd: '/workspace',
      key: 'split',
      direction: 'vertical',
      ratio: 0.5,
    });
    expect(request).toHaveBeenCalledWith('window.new', {
      session_id: 'session-root',
      command: '/usr/bin/env',
      args: ['BYOBU_DISABLE=1', '/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}"'],
      cwd: '/workspace',
      key: 'window',
    });
  });

  it('retries attachment without repeating a split that already created a pane', async () => {
    let attachCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-root', pane_id: 'pane-root' };
      if (method === 'pane.split') return { session_id: 'session-split', pane_id: 'pane-split' };
      if (method === 'session.attach') {
        attachCount += 1;
        if (attachCount === 2) throw new Error('transient attach failure');
        return { seed: new Uint8Array(), resume_sequence: attachCount };
      }
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'root', cols: 80, rows: 24 });
    await expect(manager.split('root', 'split', 'vertical')).resolves.toEqual({ id: 'split' });

    expect(request.mock.calls.filter(([method]) => method === 'pane.split')).toHaveLength(1);
    expect(manager.has('split')).toBe(true);
    await manager.close('split', { kill: true });
    await manager.close('root', { kill: true });
  });

  it('does not retire a pending pane that began before window destruction', async () => {
    let releaseConfigure!: () => void;
    const configure = new Promise<void>((resolve) => {
      releaseConfigure = resolve;
    });
    let releaseDestroy!: (response: { sessions: [] }) => void;
    const destroy = new Promise<{ sessions: [] }>((resolve) => {
      releaseDestroy = resolve;
    });
    const request = vi.fn((method: string) => {
      if (method === 'mux.configure') return configure;
      if (method === 'window.destroy') return destroy;
      if (method === 'session.list') return Promise.resolve({ sessions: [] });
      if (method === 'session.create') return Promise.resolve({ session_id: 'session-new', pane_id: 'pane-new' });
      if (method === 'session.attach') return Promise.resolve({ seed: new Uint8Array(), resume_sequence: 1 });
      if (method === 'pane.output') return Promise.resolve({ outputs: [] });
      return Promise.resolve({});
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    const opening = manager.open({ key: 'unrelated-new-pane', cols: 80, rows: 24, createIfMissing: true });
    await Promise.resolve();
    const closing = manager.destroyWindow('logical-old', 'window-old');
    await Promise.resolve();
    releaseDestroy({ sessions: [] });
    await closing;
    expect(manager.has('unrelated-new-pane')).toBe(true);

    releaseConfigure();
    await expect(opening).resolves.toEqual({ id: 'unrelated-new-pane' });
    expect(manager.has('unrelated-new-pane')).toBe(true);
    await manager.close('unrelated-new-pane', { kill: true });
  });

  it('emits one exit and destroys the daemon record when a child exits normally', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-exit', pane_id: 'pane-exit' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [], exited: true };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('t1', exited);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(exited).toHaveBeenCalledOnce();
    expect(exited).toHaveBeenCalledWith({ code: null, signal: null });
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-exit' });
    expect(manager.has('t1')).toBe(false);
  });

  it('retries an exited pane catalog deletion before emitting terminal-exit', async () => {
    let destroyAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-retry-exit', pane_id: 'pane-retry-exit' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [], exited: true };
      if (method === 'session.destroy') {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error('temporary mux channel failure');
      }
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'retry-exit', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('retry-exit', exited);

    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(request.mock.calls.filter(([method]) => method === 'session.destroy')).toHaveLength(2);
    expect(manager.has('retry-exit')).toBe(false);
  });

  it('treats a missing session after a lost destroy acknowledgement as completed', async () => {
    let destroyAttempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-lost-ack', pane_id: 'pane-lost-ack' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [], exited: true };
      if (method === 'session.destroy') {
        destroyAttempts += 1;
        if (destroyAttempts === 1) throw new Error('temporary mux channel failure');
        throw new Error('mux session not found');
      }
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'lost-ack', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('lost-ack', exited);

    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(request.mock.calls.filter(([method]) => method === 'session.destroy')).toHaveLength(2);
    expect(manager.has('lost-ack')).toBe(false);
  });

  it('retires a missing pane instead of recursively restarting its output poll', async () => {
    let rejectOutput!: (error: Error) => void;
    const request = vi.fn((method: string) => {
      if (method === 'session.create') return Promise.resolve({ session_id: 'session-missing', pane_id: 'pane-missing' });
      if (method === 'session.attach') return Promise.resolve({ seed: new Uint8Array(), resume_sequence: 1 });
      if (method === 'pane.output')
        return new Promise((_, reject: (error: Error) => void) => {
          rejectOutput = reject;
        });
      return Promise.resolve({});
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'missing-pane', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('missing-pane', exited);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('pane.output', expect.anything()));
    rejectOutput(new Error('mux pane not found'));

    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(request.mock.calls.filter(([method]) => method === 'pane.output')).toHaveLength(1);
    expect(manager.has('missing-pane')).toBe(false);
  });

  it('cancels an exit-finalization retry when the provider closes all terminals', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-close-all', pane_id: 'pane-close-all' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [], exited: true };
      if (method === 'session.destroy') throw new Error('temporary mux channel failure');
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'close-all-finalizing', cols: 80, rows: 24 });
    await vi.waitFor(() =>
      expect(request.mock.calls.filter(([method]) => method === 'session.destroy')).toHaveLength(1),
    );
    const opensBeforeCloseAll = connection.open.mock.calls.length;
    manager.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(manager.has('close-all-finalizing')).toBe(false);
    expect(connection.open).toHaveBeenCalledTimes(opensBeforeCloseAll);
    expect(request.mock.calls.filter(([method]) => method === 'session.destroy')).toHaveLength(1);
  });

  it('drains and removes a pane when a post-exit resize races its output poll', async () => {
    let outputPolls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-resize-exit', pane_id: 'pane-resize-exit' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') {
        outputPolls += 1;
        return outputPolls === 1 ? { outputs: [] } : { outputs: [], exited: true };
      }
      if (method === 'pane.resize') throw new Error('mux pane is recovered and read-only');
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'resize-exit', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('resize-exit', exited);

    await expect(manager.resize('resize-exit', 100, 30)).rejects.toThrow('mux pane is recovered and read-only');
    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-resize-exit' });
    expect(manager.has('resize-exit')).toBe(false);
  });

  it('drains every exited output response before finalizing a pane', async () => {
    let poll = 0;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-drain', pane_id: 'pane-drain' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') {
        poll += 1;
        if (poll === 1) return { outputs: [{ sequence: 1, data: Buffer.from('first-exit-tail') }], exited: true };
        if (poll === 2) return { outputs: [{ sequence: 2, data: Buffer.from('second-exit-tail') }], exited: true };
        return { outputs: [], exited: true };
      }
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'drain', cols: 80, rows: 24 });
    const received: Buffer[] = [];
    const exited = vi.fn();
    manager.onData('drain', (data) => received.push(Buffer.from(data)));
    manager.onExit('drain', exited);

    await vi.waitFor(() => expect(exited).toHaveBeenCalledOnce());
    expect(Buffer.concat(received).toString()).toBe('first-exit-tailsecond-exit-tail');
    expect(request.mock.calls.filter(([method]) => method === 'pane.output')).toHaveLength(3);
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-drain' });
    expect(manager.has('drain')).toBe(false);
  });

  it('ignores an older in-flight poll after a renderer reattachment', async () => {
    const pending: Array<(value: { outputs: { sequence: number; data: Buffer }[] }) => void> = [];
    const request = vi.fn((method: string) => {
      if (method === 'session.create')
        return Promise.resolve({ session_id: 'session-poll', pane_id: 'pane-poll' });
      if (method === 'session.attach')
        return Promise.resolve({ seed: new Uint8Array(), resume_sequence: 1 });
      if (method === 'pane.output') return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve({});
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    await Promise.resolve();
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    await Promise.resolve();
    const data = vi.fn();
    manager.onData('t1', data);
    expect(pending).toHaveLength(2);
    pending[0]!({ outputs: [{ sequence: 1, data: Buffer.from('old') }] });
    pending[1]!({ outputs: [{ sequence: 1, data: Buffer.from('live') }] });
    await new Promise((resolve) => setImmediate(resolve));
    await manager.close('t1', { kill: true });

    expect(data).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalledWith(Buffer.from('live'));
  });

  it('reuses a detached daemon session when the renderer reopens the same key', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-5', pane_id: 'pane-5' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 't1', cols: 80, rows: 24 });
    await manager.close('t1');
    await manager.open({ key: 't1', cols: 100, rows: 30 });
    await manager.close('t1', { kill: true });

    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({
        session_id: 'session-5',
        client_kind: 'cockpit',
        client_id: expect.stringMatching(/^cockpit-/),
        cols: 100,
        rows: 30,
      }),
    );
    expect(request).toHaveBeenCalledWith('session.detach', {
      session_id: 'session-5',
      client_id: expect.stringMatching(/^cockpit-/),
    });
  });

  it('keeps a visible pane attachable when direct destruction is rejected', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-close-rejected', pane_id: 'pane-close-rejected' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      if (method === 'session.destroy') throw new Error('daemon rejected close');
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'live', cols: 80, rows: 24 });

    await expect(manager.close('live', { kill: true })).rejects.toThrow('daemon rejected close');
    expect(manager.has('live')).toBe(true);
    await expect(manager.open({ key: 'live', cols: 80, rows: 24 })).resolves.toEqual({ id: 'live' });
  });

  it('waits for a fresh mux epoch after a bridge request fails instead of ending the terminal', async () => {
    let rejectOutput = true;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-6', pane_id: 'pane-6' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output' && rejectOutput) {
        rejectOutput = false;
        throw new Error('mux channel is closed');
      }
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('t1', exited);
    await new Promise((resolve) => setImmediate(resolve));

    for (const handler of connection.onAttached) handler(2);
    await new Promise((resolve) => setImmediate(resolve));
    await manager.close('t1', { kill: true });

    expect(exited).toHaveBeenCalledWith({ code: 0, signal: null });
    expect(request.mock.calls.filter(([method]) => method === 'session.attach')).toHaveLength(2);
  });

  it('does not automatically steal a TTY-owned session back after a stale-client rejection', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-tty', pane_id: 'pane-tty' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') throw new Error('mux session is attached by another client');
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    const data = vi.fn();
    manager.onData('t1', data);
    await new Promise((resolve) => setImmediate(resolve));

    for (const handler of connection.onAttached) handler(2);
    await new Promise((resolve) => setImmediate(resolve));
    await manager.close('t1');

    expect(data).toHaveBeenCalledWith(expect.stringContaining('attached from another terminal'));
    expect(request.mock.calls.filter(([method]) => method === 'session.attach')).toHaveLength(1);
  });

  it('restores daemon session keys from session.list before opening tabs', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list')
        return {
          sessions: [
            { session_id: 'session-9', pane_id: 'pane-9', key: 'restored', exited: false },
          ],
        };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(manager.listSessions()).resolves.toEqual(['restored']);
    await manager.open({ key: 'restored', cols: 80, rows: 24 });
    await manager.close('restored', { kill: true });

    expect(request).not.toHaveBeenCalledWith('session.create', expect.anything());
    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({
        session_id: 'session-9',
        client_kind: 'cockpit',
        client_id: expect.stringMatching(/^cockpit-/),
        cols: 80,
        rows: 24,
      }),
    );
  });

  it('retains a Run tty for reattachment but excludes it from terminal tab inventory', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') {
        return {
          sessions: [
            { session_id: 'run-session', pane_id: 'run-pane', key: 'run', exited: false },
            { session_id: 'terminal-session', pane_id: 'terminal-pane', key: 't1', exited: false },
          ],
        };
      }
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(manager.listSessions()).resolves.toEqual(['t1']);
    await manager.open({ key: 'run', kind: 'run', cols: 80, rows: 24, createIfMissing: true });

    expect(request).toHaveBeenCalledWith(
      'session.attach',
      expect.objectContaining({ session_id: 'run-session' }),
    );
    await manager.close('run', { kill: true });
  });

  it('queries durable scrollback before a restored pane mounts in the renderer', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list') {
        return {
          sessions: [
            {
              session_id: 'session-history',
              pane_id: 'pane-history',
              key: 'restored',
              exited: false,
            },
          ],
        };
      }
      if (method === 'scrollback.query') {
        return { lines: [{ line: 9, runs: [{ text: 'durable-history', sgr: '' }] }] };
      }
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(manager.scrollback('restored', 0, 20)).resolves.toEqual([
      { line: 9, runs: [{ text: 'durable-history', sgr: '' }] },
    ]);
    expect(manager.has('restored')).toBe(false);
    expect(request).toHaveBeenCalledWith('scrollback.query', {
      pane_id: 'pane-history',
      client_id: expect.stringMatching(/^cockpit-/),
      before: 0,
      count: 20,
    });
  });

  it('does not start output polling for a recovered survivor when another window closes', async () => {
    const outputPaneIDs: string[] = [];
    const request = vi.fn(async (method: string, data?: { pane_id?: string }) => {
      if (method === 'session.list') {
        return {
          sessions: [
            { session_id: 'session-recovered', pane_id: 'pane-recovered', key: 'recovered', exited: true },
          ],
        };
      }
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'session.create') return { session_id: 'session-live', pane_id: 'pane-live' };
      if (method === 'pane.output') {
        if (data?.pane_id) outputPaneIDs.push(data.pane_id);
        return { outputs: [] };
      }
      if (method === 'window.destroy') {
        return {
          sessions: [
            {
              session_id: 'session-recovered',
              active_window_id: 'window-recovered',
              windows: [
                {
                  window_id: 'window-recovered',
                  panes: [
                    {
                      session_id: 'session-recovered',
                      pane_id: 'pane-recovered',
                      key: 'recovered',
                      exited: true,
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.open({ key: 'recovered', cols: 80, rows: 24 });
    await manager.open({ key: 'live', cols: 80, rows: 24 });
    await manager.destroyWindow('session-live', 'window-live');
    await new Promise((resolve) => setImmediate(resolve));
    await manager.close('recovered', { kill: true });

    expect(outputPaneIDs).not.toContain('pane-recovered');
  });

  it('destroys a restored pane that has not yet opened a renderer terminal', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list')
        return {
          sessions: [{ session_id: 'session-dormant', pane_id: 'pane-dormant', key: 'dormant' }],
        };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.listSessions();
    await manager.close('dormant', { kill: true });

    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-dormant' });
  });

  it('hydrates and destroys an unknown restored pane on a mux close', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list')
        return {
          sessions: [{ session_id: 'session-dormant', pane_id: 'pane-dormant', key: 'dormant' }],
        };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await manager.close('dormant', { kill: true });

    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-dormant' });
  });

  it('cancels an opening generation and destroys its matching restored pane', async () => {
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list')
        return {
          sessions: [{ session_id: 'session-restored', pane_id: 'pane-restored', key: 'restored' }],
        };
      return {};
    });
    const connection = {
      open: vi.fn(() => gate),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    const opening = manager.open({ key: 'restored', cols: 80, rows: 24 });
    const closing = manager.close('restored', { kill: true });
    releaseOpen();

    await closing;
    await expect(opening).rejects.toThrow('closed while opening');
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-restored' });
  });

  it('lists and destroys daemon sessions independently of renderer terminals', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.list')
        return {
          sessions: [
            {
              session_id: 'session-10',
              pane_id: 'pane-10',
              key: 'orphan',
              exited: false,
              broadcast: true,
              pinned: true,
              attached_kind: 'tty',
              logical_session_id: 'session-10',
              window_id: 'window-2',
              broadcast_scope: 'session',
              recovery_diagnostic: 'incompatible mux snapshot engine',
            },
          ],
        };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');

    await expect(manager.listMuxSessions()).resolves.toEqual([
      {
        sessionId: 'session-10',
        paneId: 'pane-10',
        key: 'orphan',
        exited: false,
        broadcast: true,
        pinned: true,
        attachedKind: 'tty',
        logicalSessionId: 'session-10',
        windowId: 'window-2',
        broadcastScope: 'session',
        recoveryDiagnostic: 'incompatible mux snapshot engine',
      },
    ]);
    await manager.destroySession('session-10');
    await manager.pinSession('session-10', false);
    expect(request).toHaveBeenCalledWith('session.destroy', { session_id: 'session-10' });
    expect(request).toHaveBeenCalledWith('session.pin', {
      session_id: 'session-10',
      pinned: false,
    });
  });

  it('retires and emits exit for a visible pane destroyed from the Sessions dialog path', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-visible', pane_id: 'pane-visible' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'visible', cols: 80, rows: 24 });
    const exited = vi.fn();
    manager.onExit('visible', exited);

    await manager.destroySession('session-visible');

    expect(exited).toHaveBeenCalledWith({ code: 0, signal: null });
    expect(manager.has('visible')).toBe(false);
    await expect(manager.open({ key: 'visible', cols: 80, rows: 24 })).rejects.toThrow(
      'closed and cannot be reattached',
    );
    expect(request.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1);
  });

  it('restores a visible pane when Sessions dialog destruction is rejected', async () => {
    let rejectDestroy = true;
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-rejected', pane_id: 'pane-rejected' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      if (method === 'session.destroy' && rejectDestroy) throw new Error('daemon rejected destroy');
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 'visible', cols: 80, rows: 24 });

    await expect(manager.destroySession('session-rejected')).rejects.toThrow('daemon rejected destroy');
    expect(manager.has('visible')).toBe(true);
    rejectDestroy = false;
    await manager.close('visible', { kill: true });
  });

  it('acknowledges shutdown, clears local state, and suppresses reconnects', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'session.create') return { session_id: 'session-11', pane_id: 'pane-11' };
      if (method === 'session.attach') return { seed: new Uint8Array(), resume_sequence: 1 };
      if (method === 'pane.output') return { outputs: [] };
      return {};
    });
    const connection = {
      open: vi.fn(async () => {}),
      current: () => ({ request }),
      close: vi.fn(),
      onAttached: new Set<(epoch: number) => void>(),
    };
    const manager = new RemoteMuxTerminalManager(connection, '/workspace');
    await manager.open({ key: 't1', cols: 80, rows: 24 });
    await manager.shutdown();

    expect(request).toHaveBeenCalledWith('mux.shutdown', {});
    expect(connection.close).toHaveBeenCalledOnce();
    expect(manager.has('t1')).toBe(false);
  });
});
