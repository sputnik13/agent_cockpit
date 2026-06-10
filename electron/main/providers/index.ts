/**
 * Provider subsystem bootstrap: builds the registry with the Local/Remote
 * factories and a SessionManager backed by the SQLite project store. main
 * imports `sessionManager` to drive project activation and IPC routing.
 */
import { getProject, setActiveProjectId } from '../store/projects';
import { LocalProvider } from './local';
import { RemoteProvider } from './remote';
import { ProviderRegistry } from './registry';
import { SessionManager } from './sessionManager';
import type { ConnectionSpec } from './types';

function buildRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register('local', ({ projectId, spec }) => {
    if (spec.kind !== 'local') throw new Error('expected local spec');
    return new LocalProvider(projectId, spec.rootPath);
  });
  registry.register('remote', ({ projectId, spec }) => {
    if (spec.kind !== 'remote') throw new Error('expected remote spec');
    return new RemoteProvider(projectId, spec);
  });
  return registry;
}

export const providerRegistry = buildRegistry();

export const sessionManager = new SessionManager(providerRegistry, {
  loadSpec: (projectId): ConnectionSpec | null => getProject(projectId)?.connection ?? null,
  persistActive: (projectId): void => setActiveProjectId(projectId),
});

export { ProviderRegistry } from './registry';
export { SessionManager } from './sessionManager';
