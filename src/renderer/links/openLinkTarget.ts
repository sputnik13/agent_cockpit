import { agentCockpit } from '../providerClient';
import { useContentSelection } from '../content/selectionStore';
import { useExplorerStore } from '../explorer/explorerStore';

export interface LinkContext {
  /** Active project the link belongs to; null disables local-path routing. */
  projectId: string | null;
  /** Directory a relative link is resolved against (the viewed file's dir for
   *  markdown, the pane cwd for a terminal). Omitted → project root. */
  base?: string;
}

/** True for web schemes routed straight to the OS browser. */
function isWebUrl(input: string): boolean {
  return /^(https?:|mailto:)/i.test(input);
}

/**
 * The single renderer authority for what a clicked link does — shared by
 * markdown anchors (TaskDetail + content view) and terminal OSC 8 links.
 *
 *  - web URL (http/https/mailto) → OS browser via `window.open` (Electron's
 *    setWindowOpenHandler forwards it to shell.openExternal);
 *  - in-project file → select it in the content panel AND reveal it in the
 *    Explorer;
 *  - out-of-project file → show it in the content panel only (no Explorer);
 *  - directory inside the project → reveal/expand it in the Explorer;
 *  - non-existent local path → no-op (terminal output may print stale paths).
 *
 * The renderer never stats the filesystem itself: the provider's `resolvePath`
 * resolves + validates + classifies on the correct host (local or remote).
 */
export async function openLinkTarget(input: string, ctx: LinkContext): Promise<void> {
  const target = input.trim();
  if (target === '') return;

  if (isWebUrl(target)) {
    window.open(target, '_blank', 'noopener,noreferrer');
    return;
  }

  const { projectId } = ctx;
  if (projectId == null) return;

  let resolved;
  try {
    resolved = await agentCockpit.provider.resolvePath(
      target,
      ctx.base !== undefined ? { base: ctx.base } : undefined,
      projectId,
    );
  } catch {
    // Provider unavailable (e.g. session disconnected) — nothing to open.
    return;
  }

  if (!resolved.exists) return; // validated: a printed-but-missing path is a no-op

  if (resolved.isDir) {
    if (resolved.insideProject && resolved.relPath) {
      useExplorerStore.getState().reveal(projectId, resolved.relPath);
    }
    return;
  }

  if (resolved.insideProject && resolved.relPath) {
    useContentSelection.getState().select(projectId, {
      path: resolved.relPath,
      worktreePath: '',
      baseline: 'HEAD',
      kind: 'file',
    });
    useExplorerStore.getState().reveal(projectId, resolved.relPath);
  } else {
    useContentSelection.getState().select(projectId, {
      path: resolved.absPath,
      worktreePath: '',
      kind: 'external-file',
    });
  }
}
