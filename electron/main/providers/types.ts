/**
 * Main-process re-export of the shared WorkspaceProvider contract. Provider
 * implementations (LocalProvider, RemoteProvider) and the registry import from
 * here so the seam definition has a single source in @shared/providers.
 */
export type {
  ConnectionSpec,
  ConnectionState,
  ConnectionStatus,
  DiffBundle,
  DirEntry,
  FileBytesOptions,
  FileBytesResult,
  FileReadOptions,
  FileReadResult,
  LocalConnectionSpec,
  ProjectKind,
  RemoteConnectionSpec,
  ResolvedPath,
  ResolvePathOptions,
  StatResult,
  TerminalDataHandler,
  TerminalExitHandler,
  TerminalExitInfo,
  TerminalHandle,
  TerminalKind,
  TerminalOpenOptions,
  WatchEvent,
  WatchHandler,
  WatchSubscription,
  WorkspaceProvider,
} from '@shared/providers/types';
