/**
 * The remote half of the callback reply path (requirement 8 of
 * docs/requirements/terminal-callback-socket.md).
 *
 * A remote project's callback socket is served by its per-project helper, which
 * forwards every request that passes its own socket-level and allowlist checks as
 * a `callback` event on the helper RPC stream. This bridge turns each such event
 * into the SAME decision the local listener makes (`CallbackBroker.handle`: bounds,
 * rate limit, connection status, then `dispatched` replied before the path is
 * classified asynchronously) and answers with the `callback.reply` RPC, which the
 * helper relays to the waiting CLI.
 *
 * Addressing is explicit by construction: the project is the one whose helper
 * stream delivered the event (the closure carries it), never whichever project is
 * ambiently active. Callback traffic never feeds the ConnectionMachine; the
 * broker's `handle` only READS the session's status.
 */
import { errorReply, type CallbackReply } from '@shared/callback/protocol';
import { logger } from '../logger';

const LOG_CONTEXT = 'callback';

/** The slice of `HelperRpcClient` the bridge needs (a fake in tests). */
export interface RemoteCallbackClient {
  onEvent(event: string, handler: (data: unknown) => void): () => void;
  callbackReply(connId: number, reply: CallbackReply): Promise<unknown>;
}

export interface RemoteCallbackBridgeOptions {
  client: RemoteCallbackClient;
  projectId: string;
  /** The broker's decision function for a request that arrived on this project's socket. */
  handle: (request: unknown) => CallbackReply;
}

interface ForwardedRequest {
  connId: number;
  request: unknown;
}

/** The helper's correlation id is a positive integer; anything else is not ours to answer. */
function parseForwarded(data: unknown): ForwardedRequest | null {
  if (typeof data !== 'object' || data === null) return null;
  const { connId, request } = data as { connId?: unknown; request?: unknown };
  if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) return null;
  return { connId, request };
}

/**
 * Start answering `projectId`'s forwarded callback requests. Returns a function
 * that stops (idempotent); the provider calls it on disconnect so a retired
 * helper stream is never answered through.
 */
export function bridgeRemoteCallbacks(options: RemoteCallbackBridgeOptions): () => void {
  const { client, projectId, handle } = options;
  return client.onEvent('callback', (data) => {
    const forwarded = parseForwarded(data);
    if (!forwarded) {
      logger.warn(
        `callback event dropped project=${projectId} reason=malformed detail="no usable connId"`,
        LOG_CONTEXT,
      );
      return;
    }
    let reply: CallbackReply;
    try {
      reply = handle(forwarded.request);
    } catch (err) {
      logger.error(
        `callback request failed project=${projectId}: ${err instanceof Error ? err.message : String(err)}`,
        LOG_CONTEXT,
      );
      reply = errorReply(0, 'internal', 'internal error');
    }
    client.callbackReply(forwarded.connId, reply).catch((err: unknown) => {
      // The stream is gone or the helper rejected the reply; the CLI is (or will be)
      // answered by the helper's own timeout / shutdown path.
      logger.warn(
        `callback reply not delivered project=${projectId} connId=${forwarded.connId} detail=${JSON.stringify(
          err instanceof Error ? err.message : String(err),
        )}`,
        LOG_CONTEXT,
      );
    });
  });
}
