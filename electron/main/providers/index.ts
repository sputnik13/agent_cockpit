/**
 * Provider subsystem bootstrap: builds the registry with the Local/Remote
 * factories and a SessionManager backed by the SQLite project store. main
 * imports `sessionManager` to drive project activation and IPC routing.
 */
import { app } from 'electron';
import type { CallbackEnvironmentSource } from '@shared/callback/env';
import { getProject, setActiveProjectId } from '../store/projects';
import { CallbackBroker } from '../callback/broker';
import { createLocalCliLinker } from '../callback/cliLink';
import { localCallbackEnvironmentSource } from '../callback/localEnvironment';
import { LocalProvider } from './local';
import { RemoteProvider } from './remote';
import { helperDistDir } from './remote/helper';
import { ProviderRegistry } from './registry';
import { SessionManager } from './sessionManager';
import type { ConnectionSpec } from './types';

function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('local', ({ projectId, spec }) => {
    if (spec.kind !== 'local') throw new Error('expected local spec');
    return new LocalProvider(projectId, spec.rootPath, {
      callbackEnvironment: localCallbackEnvironment(projectId),
    });
  });
  registry.register('remote', ({ projectId, spec }) => {
    if (spec.kind !== 'remote') throw new Error('expected remote spec');
    return new RemoteProvider(projectId, spec, {
      // The project's helper serves its callback socket and forwards each request
      // here; the SAME decision function as the local listener, bound to THIS
      // project (never the ambiently active one).
      handleCallback: (request) => callbackBroker.handle(projectId, request),
    });
  });
  return registry;
}

export const providerRegistry = buildRegistry();

function loadSpec(projectId: string): ConnectionSpec | null {
  return getProject(projectId)?.connection ?? null;
}

// Annotated: the callback hooks below reach `callbackBroker`, whose deps reach
// `sessionManager`, so inference alone would be circular.
export const sessionManager: SessionManager = new SessionManager(providerRegistry, {
  loadSpec,
  persistActive: (projectId): void => setActiveProjectId(projectId),
  // A local session serves its terminal callback socket for exactly as long as
  // it is connected (the same lifecycle as its watch).
  callback: {
    start: (projectId) => callbackBroker.startLocalListener(projectId),
    stop: (projectId) => callbackBroker.stopListener(projectId),
  },
});

/** Main's side of the terminal callback socket. Reads session status and the
 *  provider through the SessionManager; never feeds the ConnectionMachine. */
export const callbackBroker = new CallbackBroker({
  statusOf: (projectId) => sessionManager.statusOf(projectId),
  providerOf: (projectId) => sessionManager.get(projectId),
  projectRootOf: (projectId) => {
    const spec = loadSpec(projectId);
    if (!spec) return null;
    return spec.kind === 'local' ? spec.rootPath : spec.remotePath;
  },
  userDataDir: () => app.getPath('userData'),
  // The local CLI is the helper's Go binary for this host, linked under userData.
  ensureCli: createLocalCliLinker(() => ({
    userDataDir: app.getPath('userData'),
    distDir: helperDistDir(),
  })),
});

/**
 * A LOCAL project's callback environment, for every terminal the app creates for
 * it: the socket its broker listener is bound to right now plus the linked CLI.
 * `undefined` while no listener is bound, so nothing is injected. Evaluated at
 * each terminal creation or control-channel attach, never cached.
 */
export function localCallbackEnvironment(projectId: string): CallbackEnvironmentSource {
  return localCallbackEnvironmentSource(projectId, {
    localSocketPath: (id) => callbackBroker.localSocketPath(id),
    userDataDir: () => app.getPath('userData'),
  });
}

export { ProviderRegistry } from './registry';
export { SessionManager } from './sessionManager';
