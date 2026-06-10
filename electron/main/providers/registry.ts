/**
 * ProviderRegistry — maps a project's connection kind to a factory that builds
 * a WorkspaceProvider. Keeps SessionManager decoupled from concrete providers
 * (and testable with fakes). main wires the Local/Remote factories at startup.
 */
import type { ConnectionSpec, ProjectKind, WorkspaceProvider } from './types';

export interface ProviderInput {
  projectId: string;
  spec: ConnectionSpec;
}

export type ProviderFactory = (input: ProviderInput) => WorkspaceProvider;

export class ProviderRegistry {
  private factories = new Map<ProjectKind, ProviderFactory>();

  register(kind: ProjectKind, factory: ProviderFactory): void {
    this.factories.set(kind, factory);
  }

  create(input: ProviderInput): WorkspaceProvider {
    const factory = this.factories.get(input.spec.kind);
    if (!factory) {
      throw new Error(`no provider factory registered for kind '${input.spec.kind}'`);
    }
    return factory(input);
  }

  has(kind: ProjectKind): boolean {
    return this.factories.has(kind);
  }
}
