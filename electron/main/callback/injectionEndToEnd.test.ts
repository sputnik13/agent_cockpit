/**
 * Local injection end to end, short of the Go CLI: the PRODUCTION wiring
 * (SessionManager -> CallbackBroker listener -> `localCallbackEnvironment`) feeds a
 * real control-mode manager on a private tmux server; the variables a pane
 * receives name the socket its project's listener is serving right now; and a
 * request sent to that socket the way the CLI will (pane identity read from the
 * pane's own environment) is dispatched for exactly that project, with that pane
 * as attribution. Real tmux on a private `-L` socket, a private config, a private
 * userData; nothing persistent is touched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { paneFromEnv } from '@shared/callback/protocol';
import { FakeProvider } from '@shared/providers/fakeProvider';
import type { ConnectionSpec } from '@shared/providers/types';
import { createLocalControlManager } from '../providers/local/controlManager';
import { createTmuxSandbox, tmuxInstalled, type TmuxSandbox } from '../providers/local/tmuxTestKit';
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

import {
  callbackBroker,
  localCallbackEnvironment,
  providerRegistry,
  sessionManager,
} from '../providers';

let box: TmuxSandbox | null = null;
const managers: Array<{ close(): void }> = [];

beforeAll(() => {
  fakes.userData = mkdtempSync('/tmp/accb-e2e-');
  fakes.specs['e1'] = { kind: 'local', rootPath: '/repo/e1' };
  fakes.specs['e2'] = { kind: 'local', rootPath: '/repo/e2' };
  // The session lifecycle is the production one; only the provider is a fake.
  providerRegistry.register('local', ({ projectId }) => new FakeProvider(projectId, 'local'));
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  for (const mgr of managers.splice(0)) mgr.close();
  box?.dispose();
  box = null;
});

afterAll(async () => {
  await sessionManager.closeAll();
  rmSync(fakes.userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function attach(projectId: string): Promise<{ session: string; firstPane: string }> {
  const mgr = createLocalControlManager({
    projectId,
    rootPath: box!.dir,
    deterministicSessionNames: false,
    callbackEnvironment: localCallbackEnvironment(projectId),
    socket: box!.socket,
    configPath: box!.conf,
  });
  managers.push(mgr);
  mgr.open({ cols: 80, rows: 24 });
  await mgr.command("display-message -p '#{session_name}'"); // resolves once attached
  const session = mgr.sessionName();
  const firstPane = box!
    .tmux('list-panes', '-s', '-t', `=${session}`, '-F', '#{pane_id}')
    .split('\n')
    .filter(Boolean)[0]!;
  return { session, firstPane };
}

describe.skipIf(!tmuxInstalled)('local injection end to end (production wiring, real tmux)', () => {
  it("a pane's variables name the socket its project's listener serves, and that socket answers for exactly that project and pane", async () => {
    box = createTmuxSandbox('e2e');
    const events: unknown[] = [];
    const off = callbackBroker.onOpen((e) => events.push(e));
    await sessionManager.open('e1'); // returns only once the listener is bound
    const served = join(fakes.userData, 'callback', `${projectHash('e1')}.sock`);
    expect(callbackBroker.localSocketPath('e1')).toBe(served);

    const { firstPane } = await attach('e1');
    const env = await box.paneEnv(firstPane);
    expect(env.get('COCKPIT_CALLBACK_SOCK')).toBe(served);
    expect(env.get('COCKPIT_CALLBACK_VERSION')).toBe('1');
    expect(env.get('COCKPIT_CLI')).toBe(join(fakes.userData, 'callback', 'bin', 'cockpit'));

    // What the CLI does: identity from the pane's own environment, then one request.
    const pane = paneFromEnv(Object.fromEntries(env));
    expect(pane).toEqual({ kind: 'tmux', id: firstPane });
    expect(
      await callbackRequest(
        env.get('COCKPIT_CALLBACK_SOCK')!,
        openRequest('/repo/e1/src/a.ts', { id: 7, ...(pane ? { pane } : {}) }),
      ),
    ).toEqual({ id: 7, ok: true, result: { status: 'dispatched' } });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      projectId: 'e1',
      selection: { kind: 'file', path: 'src/a.ts', worktreePath: '' },
      pane: { kind: 'tmux', id: firstPane },
    });
    off();
  });

  it('keeps two projects on one tmux server apart: each pane holds its own project socket', async () => {
    box = createTmuxSandbox('e2e');
    await sessionManager.open('e1');
    await sessionManager.open('e2');
    const one = await attach('e1');
    const two = await attach('e2');
    const envOne = await box.paneEnv(one.firstPane);
    const envTwo = await box.paneEnv(two.firstPane);
    expect(envOne.get('COCKPIT_CALLBACK_SOCK')).toBe(
      join(fakes.userData, 'callback', `${projectHash('e1')}.sock`),
    );
    expect(envTwo.get('COCKPIT_CALLBACK_SOCK')).toBe(
      join(fakes.userData, 'callback', `${projectHash('e2')}.sock`),
    );
    expect(envOne.get('COCKPIT_CALLBACK_SOCK')).not.toBe(envTwo.get('COCKPIT_CALLBACK_SOCK'));
    expect(box.globalEnv().filter((l) => /COCKPIT_/.test(l))).toEqual([]);
  });

  // The renderer reacts to `connected`, which is reported BEFORE the bind completes,
  // and its attach IPC addresses the provider directly. The IPC handlers therefore
  // wait on sessionManager.callbackReady() before they build and open a manager.
  describe('an attach made the moment the session reports connected', () => {
    it('carries the socket once it waits for the pending bind (what the IPC handlers do)', async () => {
      box = createTmuxSandbox('e2e');
      await sessionManager.close('e1').catch(() => undefined);
      const opening = sessionManager.open('e1'); // not awaited: the status event is already out
      // The bind is still in flight, so reading the source NOW would see no socket.
      expect(callbackBroker.localSocketPath('e1')).toBeNull();
      expect(localCallbackEnvironment('e1')()).toBeUndefined();

      await sessionManager.callbackReady('e1');
      const served = join(fakes.userData, 'callback', `${projectHash('e1')}.sock`);
      expect(callbackBroker.localSocketPath('e1')).toBe(served);

      const { firstPane } = await attach('e1');
      expect((await box.paneEnv(firstPane)).get('COCKPIT_CALLBACK_SOCK')).toBe(served);
      await opening;
    });

    it('would carry nothing, and strip what its session already held, without that wait', async () => {
      box = createTmuxSandbox('e2e');
      await sessionManager.close('e1').catch(() => undefined);
      await sessionManager.open('e1');
      const served = join(fakes.userData, 'callback', `${projectHash('e1')}.sock`);
      const held = await attach('e1');
      expect(box.sessionEnv(held.session)).toContain(`COCKPIT_CALLBACK_SOCK=${served}`);
      managers.splice(0).forEach((m) => m.close());

      // The session restarts (a flap or a re-activation) and a terminal is made at once.
      await sessionManager.close('e1');
      const reopening = sessionManager.open('e1'); // the bind is pending again
      expect(callbackBroker.localSocketPath('e1')).toBeNull();
      await attach('e1'); // NO wait: this is the race the handlers close
      const stripped = box.sessionEnv(held.session);
      expect(stripped).toContain('-COCKPIT_CALLBACK_SOCK');
      expect(stripped.filter((l) => /^COCKPIT_.*=/.test(l))).toEqual([]);
      managers.splice(0).forEach((m) => m.close());

      // With the wait the same attach restores the values.
      await sessionManager.callbackReady('e1');
      await attach('e1');
      expect(box.sessionEnv(held.session)).toContain(`COCKPIT_CALLBACK_SOCK=${served}`);
      await reopening;
    });
  });

  it('injects nothing for a project whose listener is not bound, and a variable-less attach strips stale values', async () => {
    box = createTmuxSandbox('e2e');
    await sessionManager.open('e1');
    const bound = await attach('e1');
    expect((await box.paneEnv(bound.firstPane)).get('COCKPIT_CALLBACK_SOCK')).toBeTruthy();
    managers.splice(0).forEach((m) => m.close());

    await sessionManager.close('e1'); // the listener goes away
    expect(callbackBroker.localSocketPath('e1')).toBeNull();
    const rebound = await attach('e1'); // same session, re-attached with no values
    const lines = box.sessionEnv(rebound.session);
    expect(lines).toContain('-COCKPIT_CALLBACK_SOCK');
    expect(lines.filter((l) => /^COCKPIT_.*=/.test(l))).toEqual([]);
  });
});
