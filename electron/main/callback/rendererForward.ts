/**
 * Main's leg of `evt:callback-open`: turn each classified `open` the
 * CallbackBroker emits into a push to the renderer
 * (docs/design/terminal-callback-socket.md, "Renderer").
 *
 * The payload is `{projectId, selection}` and nothing else. The project is the
 * one whose socket the request arrived on (the broker's event carries it; it is
 * never ambient), so the renderer can record the tab in THAT project's slice
 * whichever project is active. `pane` is unverified attribution metadata that
 * stays in main. The selection is copied field by field so nothing a future
 * classification adds (above all a `baseline`) can reach the renderer by
 * accident: a plain file open must never force a git-ref read.
 *
 * Delivery is the caller's: ipc/index.ts hands in a function that sends to the
 * MAIN window only (never a broadcast, so the diagnostics window cannot open
 * tabs). A request was already answered `dispatched` before this point, so a
 * push nobody can receive is logged rather than dropped silently.
 */
import type { CallbackOpenPushEvent } from '@shared/ipc/channels';
import { logger } from '../logger';
import type { CallbackBroker } from './broker';

const LOG_CONTEXT = 'callback';

/**
 * Subscribe to the broker's classified opens and push each to the renderer via
 * `deliver`, which returns whether the push reached a live window. Returns the
 * unsubscribe function.
 */
export function forwardCallbackOpens(
  broker: Pick<CallbackBroker, 'onOpen'>,
  deliver: (payload: CallbackOpenPushEvent) => boolean,
): () => void {
  return broker.onOpen(({ projectId, selection }) => {
    const payload: CallbackOpenPushEvent = {
      projectId,
      selection: {
        kind: selection.kind,
        path: selection.path,
        worktreePath: selection.worktreePath,
      },
    };
    if (!deliver(payload)) {
      logger.warn(
        `callback open dropped project=${projectId} path=${JSON.stringify(selection.path)} reason="no main window to deliver to"`,
        LOG_CONTEXT,
      );
    }
  });
}
