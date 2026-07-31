/**
 * Shared file-row context-menu substrate, consumed by the Changes and
 * Explorer panels (each dependent leaf wires this in; this module renders
 * nothing itself and is not wired into either panel here). Resolves a row's
 * absolute/relative paths, builds the three-item `MenuItemDef[]` (copy
 * absolute, copy relative, download), and implements the copy/download
 * actions.
 *
 * REMOTE PROJECTS: "fully qualified" / "absolute" here means the absolute
 * path ON THE REMOTE HOST (derived from `RemoteConnectionSpec.remotePath` or
 * the selected worktree's remote path) — never a local path. A remote
 * project has no local file at that path; do NOT "fix" this into a local
 * path later.
 *
 * POSIX JOINING: every join in this module assumes `/` separators. This is
 * deliberate for BOTH transports: a remote host is always POSIX (the
 * SSH/SFTP target), and local project roots in this app are POSIX paths
 * (macOS/Linux). See `absoluteUnder` — moved here from ExplorerPanel's
 * root-browse helper; this module is now its single home.
 *
 * Module home: this lives in `renderer/files/`, a sibling of `renderer/ui/`,
 * rather than inside `ui/` itself. Every existing `ui/*` primitive (Row,
 * Menu, Panel, …) imports only React + Radix + the local `cn` helper — zero
 * store/provider/domain imports — and this module needs `ProjectInfo` and
 * the `files.saveAs` bridge, so putting it in `ui/` would be the first
 * domain-aware file in an otherwise presentation-only package. `worktree/`
 * (`worktreeStore.ts` + `worktreeOptions.ts`, the latter already "shared by
 * the Explorer and Changes panels") is the closest existing precedent for a
 * cross-panel, domain-aware helper getting its own directory instead of
 * living under `ui/`.
 */
import { useCallback, useState } from 'react';
import type { ProjectInfo } from '@shared/ipc/channels';
import type { MenuItemDef } from '../ui';
import { agentCockpit, logDiagnostic } from '../providerClient';

// ---- Path resolution --------------------------------------------------------

/**
 * Join a base directory and a base-relative path into one absolute POSIX
 * path. Single home for this join (moved from
 * `ExplorerPanel.tsx`'s `absoluteUnder` root-browse helper) — do not
 * re-derive a copy elsewhere.
 */
export function absoluteUnder(base: string, relPath: string): string {
  return `${base.replace(/\/+$/, '')}/${relPath}`;
}

/** The project's root path per transport: local `rootPath`, remote `remotePath`. */
function projectRootPath(activeProject: ProjectInfo | null): string {
  if (!activeProject) return '';
  return activeProject.connection.kind === 'local'
    ? activeProject.connection.rootPath
    : activeProject.connection.remotePath;
}

/**
 * Resolve a row's `relPath` to a fully-qualified absolute path on the
 * project's host.
 *
 * Base = `activeWorktree || project root` (project root = the LOCAL
 * `rootPath` for a local project, or the REMOTE `remotePath` for a remote
 * project — see the module doc comment: for a remote project the returned
 * path is on the remote host, not local).
 *
 * `relPath` that is already absolute (starts with `/`) is returned
 * unchanged rather than re-joined under the base — this is the Explorer
 * root-browse shape, where the row's path has already been resolved to an
 * absolute path by the caller (see `ExplorerPanel.tsx`'s `external`/
 * `targetPath` handling, which stores `worktreePath: ''` alongside an
 * already-absolute `path`).
 */
export function resolveAbsolutePath(
  relPath: string,
  activeWorktree: string | null | undefined,
  activeProject: ProjectInfo | null,
): string {
  if (relPath.startsWith('/')) return relPath;
  const base = activeWorktree || projectRootPath(activeProject);
  return absoluteUnder(base, relPath);
}

// ---- Menu item building ------------------------------------------------------

export const COPY_ABSOLUTE_LABEL = 'Copy path (fully qualified)';
export const COPY_RELATIVE_LABEL = 'Copy path (relative)';
export const DOWNLOAD_LABEL = 'Download';

export const DOWNLOAD_DIR_TITLE = 'Directories cannot be downloaded';
export const DOWNLOAD_UNAVAILABLE_TITLE = 'This file cannot be downloaded';
export const COPY_RELATIVE_UNAVAILABLE_TITLE = 'This path is outside the project';

/**
 * Minimum row shape the menu needs. The two dependent leaves (Changes,
 * Explorer) build this from what they already have in hand per row:
 * - `relPath`: the row's path, relative to `worktreePath || project root`
 *   (Changes: `file.newPath`; Explorer: `entry.path`) — OR an
 *   already-absolute path for an Explorer root-browsed (external) row (see
 *   `resolveAbsolutePath`'s doc comment).
 * - `worktreePath`: the worktree this row was read from (both panels
 *   already thread this per-row/per-subtree); null/undefined = project root.
 * - `isDir`: directories never download (D2) — the item is disabled, not
 *   omitted, to keep the menu's shape — and the capability's
 *   discoverability — stable across row types.
 * - `downloadable`: caller-owned signal for whether THIS row's content can
 *   be fetched at all, irrespective of `isDir` (e.g. a Changes row for a
 *   deleted file has no working-tree bytes to read) — ANDed with `!isDir`.
 * - `relativeAvailable` (D1, ynz8.5): whether `relPath` is meaningful as a
 *   path relative to the project. Defaults to true (every existing caller —
 *   Changes, Explorer in-project rows — is unaffected). Explorer root-browse
 *   rows set this to false: `relPath` there has already been resolved to an
 *   absolute filesystem path with no project to be relative to, so "Copy
 *   path (relative)" is disabled (with `COPY_RELATIVE_UNAVAILABLE_TITLE`)
 *   instead of silently copying a `/`-relative string under a label that
 *   means "project-relative" everywhere else.
 */
export interface FileRowDescriptor {
  relPath: string;
  worktreePath?: string | null;
  isDir: boolean;
  downloadable: boolean;
  relativeAvailable?: boolean;
}

/** Context the builder needs beyond the row itself. */
export interface FileRowMenuContext {
  /** The active project — supplies the project-root fallback in
   *  `resolveAbsolutePath` and the local-vs-remote distinction. Null when no
   *  project is active. */
  activeProject: ProjectInfo | null;
  /** D3 feedback: called with a short human-readable message after a copy or
   *  download action completes successfully. Optional — a caller with no
   *  rendering slot for feedback may omit it (see `useRowMenuFeedback`). */
  onActionComplete?: (message: string) => void;
}

/**
 * Build the three-item context/dropdown menu for a file row. Renders
 * nothing itself — pass the result straight to `<ContextMenu items={...}>`
 * (or `<DropdownMenu items={...}>`).
 */
export function buildFileRowMenuItems(
  descriptor: FileRowDescriptor,
  ctx: FileRowMenuContext,
): MenuItemDef[] {
  const absPath = resolveAbsolutePath(descriptor.relPath, descriptor.worktreePath, ctx.activeProject);
  const canDownload = !descriptor.isDir && descriptor.downloadable;
  const canCopyRelative = descriptor.relativeAvailable !== false;

  return [
    {
      label: COPY_ABSOLUTE_LABEL,
      onSelect: () => {
        void copyToClipboard(absPath).then((ok) => {
          if (ok) ctx.onActionComplete?.('Copied fully-qualified path');
        });
      },
    },
    {
      label: COPY_RELATIVE_LABEL,
      disabled: !canCopyRelative,
      title: canCopyRelative ? undefined : COPY_RELATIVE_UNAVAILABLE_TITLE,
      onSelect: () => {
        void copyToClipboard(descriptor.relPath).then((ok) => {
          if (ok) ctx.onActionComplete?.('Copied relative path');
        });
      },
    },
    {
      label: DOWNLOAD_LABEL,
      disabled: !canDownload,
      title: canDownload ? undefined : descriptor.isDir ? DOWNLOAD_DIR_TITLE : DOWNLOAD_UNAVAILABLE_TITLE,
      onSelect: () => {
        void downloadRow(descriptor, ctx.activeProject)
          .then((saved) => {
            if (saved) ctx.onActionComplete?.('Downloaded');
          })
          .catch((err: unknown) => {
            // No toast system (D3) to surface this through; log it so it is
            // at least discoverable in the diagnostics/log viewer instead of
            // vanishing as an unhandled rejection.
            logDiagnostic('error', 'rowMenu', `Download failed for ${descriptor.relPath}: ${String(err)}`);
          });
      },
    },
  ];
}

// ---- Actions -----------------------------------------------------------------

/**
 * `navigator.clipboard.writeText` in a try/catch — mirrors the established
 * pattern in `NotesPanel.tsx:30-39`. Never throws; a clipboard-unavailable
 * environment (no permission, non-secure context, headless test) is a
 * silent no-op — there is no toast system to surface a failure through (D3).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Last path segment; tolerant of a trailing slash. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * Stream `descriptor`'s bytes to a user-chosen local destination via the
 * Download bridge (`agentCockpit.files.saveAs`, delivered by the blocking
 * issue `local_repo_explorer-row-context-menu-copy-download-ynz8.1`).
 * `descriptor.relPath` is passed through AS-IS (relative OR already-absolute)
 * — the main-process provider resolves it against `worktreePath || project
 * root` exactly like every other provider read (`localReadFile`/
 * `localListDir` already handle an absolute `path` passthrough the same
 * way, via `isAbsolute(rel) ? rel : join(base, rel)`). Resolves the saved
 * absolute path, or `null` on user cancel (nothing written in that case).
 * Rejects on failure (missing source, disconnected transport, unwritable
 * destination, …) — matching the bridge's own throw-on-failure contract
 * (ynz8.1 D4); `buildFileRowMenuItems` is the caller that decides how a
 * rejection is surfaced for the menu-driven path.
 */
export async function downloadRow(
  descriptor: FileRowDescriptor,
  activeProject: ProjectInfo | null,
): Promise<string | null> {
  return agentCockpit.files.saveAs(descriptor.relPath, {
    worktreePath: descriptor.worktreePath ?? undefined,
    projectId: activeProject?.id,
    suggestedName: basename(descriptor.relPath),
  });
}

// ---- D3: transient action feedback ------------------------------------------

const FEEDBACK_CLEAR_MS = 1500;

/**
 * D3 (copy/download feedback): these are dense list rows with no obvious
 * home for NotesPanel's inline "Copied" label, and there is no toast
 * primitive in `src/renderer/ui` (only `EmptyState`/`Spinner` in
 * feedback.tsx). The smallest thing that still satisfies ui-standards'
 * action-feedback expectation is a transient message string a caller renders
 * wherever it has room (e.g. the panel's toolbar/header) — this generalizes
 * NotesPanel's `copied` boolean + `setTimeout` clear to an arbitrary
 * message instead of one fixed label. Wiring this into a panel is out of
 * scope for this leaf; a caller passes `notify` as
 * `FileRowMenuContext.onActionComplete`.
 */
export function useRowMenuFeedback(clearAfterMs: number = FEEDBACK_CLEAR_MS): {
  message: string | null;
  notify: (message: string) => void;
} {
  const [message, setMessage] = useState<string | null>(null);
  const notify = useCallback(
    (msg: string) => {
      setMessage(msg);
      setTimeout(() => setMessage((cur) => (cur === msg ? null : cur)), clearAfterMs);
    },
    [clearAfterMs],
  );
  return { message, notify };
}
