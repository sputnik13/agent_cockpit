/**
 * Production wiring of the provider-side callback environment: the registry's
 * LOCAL factory hands each LocalProvider a source bound to the production
 * CallbackBroker (the live socket plus the linked CLI under userData), and the
 * REMOTE factory hands each RemoteProvider the production broker's decision
 * function bound to ITS project (its environment comes from the helper handshake,
 * so no source is injected). The provider classes are replaced by recorders; the
 * broker is real.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CallbackEnvironmentSource } from '@shared/callback/env';
import { projectHash } from './socketPath';

const fakes = vi.hoisted(() => ({
  userData: '',
  created: [] as Array<{ kind: string; projectId: string; rest: unknown[] }>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? fakes.userData : '/nonexistent'),
    isPackaged: false,
  },
}));
vi.mock('../store/projects', () => ({
  getProject: () => null,
  setActiveProjectId: () => undefined,
}));
vi.mock('../providers/local', () => ({
  LocalProvider: class {
    constructor(projectId: string, ...rest: unknown[]) {
      fakes.created.push({ kind: 'local', projectId, rest });
    }
  },
}));
vi.mock('../providers/remote', () => ({
  RemoteProvider: class {
    constructor(projectId: string, ...rest: unknown[]) {
      fakes.created.push({ kind: 'remote', projectId, rest });
    }
  },
}));

import { callbackBroker, localCallbackEnvironment, providerRegistry } from '../providers';

beforeAll(() => {
  fakes.userData = mkdtempSync('/tmp/accb-ew-');
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterAll(async () => {
  await callbackBroker.stopAll();
  rmSync(fakes.userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('production wiring: provider-side callback environment', () => {
  it("hands every LocalProvider a source for exactly ITS project's socket", async () => {
    providerRegistry.create({ projectId: 'w1', spec: { kind: 'local', rootPath: '/repo/w1' } });
    const created = fakes.created.find((c) => c.kind === 'local' && c.projectId === 'w1')!;
    expect(created.rest[0]).toBe('/repo/w1');
    const deps = created.rest[1] as { callbackEnvironment?: CallbackEnvironmentSource };
    const source = deps.callbackEnvironment!;
    expect(typeof source).toBe('function');

    // No listener yet: nothing to inject (a variable-less attach would strip).
    expect(source()).toBeUndefined();

    await callbackBroker.startLocalListener('w1');
    const socket = join(fakes.userData, 'callback', `${projectHash('w1')}.sock`);
    expect(source()).toEqual({
      vars: {
        COCKPIT_CALLBACK_SOCK: socket,
        COCKPIT_CALLBACK_VERSION: '1',
        COCKPIT_CLI: join(fakes.userData, 'callback', 'bin', 'cockpit'),
      },
    });

    // Another project has its own (here: no) listener and never sees w1's socket.
    expect(localCallbackEnvironment('w2')()).toBeUndefined();

    await callbackBroker.stopListener('w1');
    expect(source()).toBeUndefined();
  });

  it('exposes the same source to the lazily created control-mode managers', async () => {
    await callbackBroker.startLocalListener('w3');
    const socket = join(fakes.userData, 'callback', `${projectHash('w3')}.sock`);
    expect(localCallbackEnvironment('w3')()?.vars.COCKPIT_CALLBACK_SOCK).toBe(socket);
    await callbackBroker.stopListener('w3');
  });

  it("hands every RemoteProvider the production broker's decision function, bound to ITS project", () => {
    const decide = vi.spyOn(callbackBroker, 'handle');
    for (const projectId of ['r1', 'r2']) {
      providerRegistry.create({
        projectId,
        spec: { kind: 'remote', host: 'h', user: 'u', port: 22, remotePath: `/srv/${projectId}` },
      });
    }
    const depsOf = (projectId: string): RemoteDeps =>
      fakes.created.find((c) => c.kind === 'remote' && c.projectId === projectId)!
        .rest[1] as RemoteDeps;
    const r1 = depsOf('r1');
    const r2 = depsOf('r2');

    // No source is injected: the values come from the helper handshake, in the provider.
    expect(r1.callbackEnvironment).toBeUndefined();
    expect(typeof r1.handleCallback).toBe('function');

    const request = { v: 1, id: 3, op: 'open', args: { path: '/srv/r1/a.md' } };
    // No live session in this wiring: the broker's status gate answers not-connected,
    // which proves the PRODUCTION broker decided, for the project that asked.
    expect(r1.handleCallback!(request)).toEqual({
      id: 3,
      ok: false,
      error: { code: 'not-connected', message: 'project is not connected' },
    });
    expect(decide).toHaveBeenLastCalledWith('r1', request);
    r2.handleCallback!(request);
    expect(decide).toHaveBeenLastCalledWith('r2', request); // never the other project, never ambient
    decide.mockRestore();
  });
});

interface RemoteDeps {
  handleCallback?: (request: unknown) => unknown;
  callbackEnvironment?: CallbackEnvironmentSource;
}
