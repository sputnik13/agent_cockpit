/**
 * The production singletons (`providers/index.ts`) wire SessionManager to the
 * CallbackBroker: this exercises that glue, with the electron `app`, the project
 * store and the local provider factory replaced by in-memory fakes.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeProvider } from '@shared/providers/fakeProvider';
import type { ConnectionSpec } from '@shared/providers/types';
import { projectHash } from './socketPath';
import { callbackRequest, openRequest } from './testClient';

const fakes = vi.hoisted(() => ({
  userData: '',
  specs: {} as Record<string, ConnectionSpec>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? fakes.userData : '/nonexistent'),
    isPackaged: false,
  },
}));
vi.mock('../store/projects', () => ({
  getProject: (id: string) => (fakes.specs[id] ? { id, connection: fakes.specs[id] } : null),
  setActiveProjectId: () => undefined,
}));

import { callbackBroker, providerRegistry, sessionManager } from '../providers';

beforeAll(() => {
  fakes.userData = mkdtempSync('/tmp/accb-w-');
  fakes.specs['w1'] = { kind: 'local', rootPath: '/repo/w1' };
  fakes.specs['w2'] = { kind: 'remote', host: 'h', user: 'u', port: 22, remotePath: '/srv/w2' };
  providerRegistry.register('local', ({ projectId }) => new FakeProvider(projectId, 'local'));
  providerRegistry.register('remote', ({ projectId }) => new FakeProvider(projectId, 'remote'));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterAll(async () => {
  await sessionManager.closeAll();
  rmSync(fakes.userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('production wiring: SessionManager -> CallbackBroker', () => {
  it('serves a local session under userData/callback and delivers an open for exactly that project', async () => {
    const events: unknown[] = [];
    const off = callbackBroker.onOpen((e) => events.push(e));
    await sessionManager.open('w1');
    const expected = join(fakes.userData, 'callback', `${projectHash('w1')}.sock`);
    await vi.waitFor(() => expect(callbackBroker.localSocketPath('w1')).toBe(expected));

    expect(await callbackRequest(expected, openRequest('/repo/w1/src/a.ts', { id: 2 }))).toEqual({
      id: 2,
      ok: true,
      result: { status: 'dispatched' },
    });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      projectId: 'w1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '' }, // FakeProvider has no worktrees: root-relative
    });
    off();
  });

  it('starts nothing for a remote session', async () => {
    await sessionManager.open('w2');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callbackBroker.localSocketPath('w2')).toBeNull();
  });

  it('tears the socket down when the session is closed', async () => {
    const path = callbackBroker.localSocketPath('w1')!;
    expect(existsSync(path)).toBe(true);
    await sessionManager.close('w1');
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));
    expect(callbackBroker.localSocketPath('w1')).toBeNull();
  });
});
