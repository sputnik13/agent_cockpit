/**
 * Renderer leg of a terminal's `cockpit open` (`evt:callback-open`,
 * docs/ARCHITECTURE.md, "Renderer: `evt:callback-open` and the no-focus reveal").
 *
 * Main has already classified the path and tagged the event with the project
 * whose socket carried the request. This module:
 *  1. validates the payload at the boundary and builds the Content selection from
 *     the validated fields only (never a `baseline`: a plain file open must not
 *     force a git-ref read, which falsely reports an untracked file as missing);
 *  2. records the tab in THAT project's slice (`select`: an existing tab for the
 *     same fully-qualified path is activated, not duplicated);
 *  3. only when that project is the active one, shows the Content panel WITHOUT
 *     moving keyboard focus (`panelReveal.ts`). A non-active project only records
 *     the tab: the active project is never switched and the panel is never
 *     revealed on its behalf.
 *
 * The tab is recorded first and unconditionally, so a reveal that is declined or
 * throws never loses the open. A declined reveal also raises a status-bar cue
 * (`openCueStore`, shown by `StatusRegion`) so the open is not silent.
 */
import { logDiagnostic, useProjectsStore } from '../providerClient';
import { useContentSelection, type ContentSelection } from '../content/selectionStore';
import { cueFileName, useOpenCueStore } from './openCueStore';
import { isDeclinedReveal, revealDeclinedReason, type RevealOutcome } from './panelReveal';
import { useWorkspaceControlsStore } from './workspaceControlsStore';

const LOG_CONTEXT = 'callback';

/** A validated `evt:callback-open` payload. */
export interface CallbackOpenRequest {
  projectId: string;
  selection: ContentSelection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `..` path segment (`a..b` is a file name, not a hop). */
const hasParentHop = (path: string): boolean => path.split('/').includes('..');

/**
 * Validate an `evt:callback-open` payload. The selection is rebuilt from the
 * three validated fields, so nothing else the payload carries (a `baseline`, an
 * `oldPath`, …) can reach the Content store; a `change` kind is refused because
 * it means a diff and carries a baseline. Returns null for anything malformed.
 *
 * Main's classification already produces only two shapes, and each is checked here
 * as defense in depth (a path the renderer would resolve against a worktree must not
 * be able to climb out of it, and an outside-the-project file has no worktree):
 *  - `file`: a path RELATIVE to its worktree (or to the project root when
 *    `worktreePath` is ''), with no `..` segment; `worktreePath` is '' or absolute;
 *  - `external-file`: an ABSOLUTE logical path with no `..` segment, and
 *    `worktreePath` ''.
 */
export function parseCallbackOpenEvent(raw: unknown): CallbackOpenRequest | null {
  if (!isRecord(raw)) return null;
  const { projectId, selection } = raw;
  if (typeof projectId !== 'string' || projectId === '') return null;
  if (!isRecord(selection)) return null;
  const { path, worktreePath, kind } = selection;
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return null;
  if (typeof worktreePath !== 'string' || worktreePath.includes('\0')) return null;
  if (hasParentHop(path)) return null;
  if (kind === 'external-file') {
    if (!path.startsWith('/') || worktreePath !== '') return null;
  } else if (kind === 'file') {
    if (path.startsWith('/')) return null;
    if (worktreePath !== '' && !worktreePath.startsWith('/')) return null;
  } else {
    return null;
  }
  return { projectId, selection: { path, worktreePath, kind } };
}

/** Handle one `evt:callback-open` payload. */
export function handleCallbackOpen(raw: unknown): void {
  const request = parseCallbackOpenEvent(raw);
  if (!request) {
    logDiagnostic('warn', LOG_CONTEXT, 'ignored a malformed callback open event');
    return;
  }
  const { projectId, selection } = request;

  useContentSelection.getState().select(projectId, selection);

  // A non-active project only records the tab in its own slice.
  if (projectId !== useProjectsStore.getState().activeId) return;

  let outcome: RevealOutcome;
  try {
    const controls = useWorkspaceControlsStore.getState();
    outcome = controls.available ? controls.revealContent(projectId) : 'unavailable';
  } catch (err) {
    logDiagnostic(
      'warn',
      LOG_CONTEXT,
      `could not show the Content panel: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  const reason = revealDeclinedReason(outcome);
  if (reason) {
    logDiagnostic(
      'info',
      LOG_CONTEXT,
      `opened ${selection.path} in the Content panel but did not show it: ${reason}`,
    );
  }
  // The log line is for developers; the user gets a visible cue (status bar, with a
  // Show action) whenever Content was deliberately left hidden, and the cue of an
  // earlier open is replaced by this open's outcome when it DID show the panel.
  if (isDeclinedReveal(outcome) && reason) {
    useOpenCueStore
      .getState()
      .show({ projectId, name: cueFileName(selection.path), path: selection.path, reason });
  } else if (outcome === 'already-visible' || outcome === 'revealed' || outcome === 'added') {
    useOpenCueStore.getState().clear();
  }
}

/**
 * Subscribe to main's `evt:callback-open`. Call once at app start (AppShell);
 * returns the unsubscribe.
 */
export function initCallbackOpenSync(): () => void {
  return window.api.events.onCallbackOpen(handleCallbackOpen);
}
