/**
 * CallbackBroker — main's side of the terminal callback socket
 * (docs/design/terminal-callback-socket.md, "CallbackBroker").
 *
 * It owns the per-project LOCAL listener and the single decision function,
 * `handle`, that the local listener (and, later, the remote helper's `callback`
 * event path) feeds. `handle` applies the cheap checks in order (envelope,
 * operation allowlist, per-project rate limit, connection status, argument
 * bounds), answers `dispatched` immediately, and only THEN classifies the path
 * asynchronously: classification may queue behind slow provider RPCs
 * (`listWorktrees`), so it must not sit on the reply path. A classification
 * failure is logged and opens nothing.
 *
 * Trust model: the project is the one that owns the socket a request arrived on
 * (the listener is created per project and closes over its id); a request can
 * never name another. `pane` is attribution metadata main cannot verify.
 * Callback traffic never feeds the ConnectionMachine; the broker only READS the
 * session's status.
 */
import { realpath as fsRealpath } from 'node:fs/promises';
import {
  CALLBACK_RATE_LIMIT_PER_SECOND,
  errorReply,
  isCallbackOp,
  okReply,
  parseCallbackEnvelope,
  parseOpenArgs,
  type CallbackOp,
  type CallbackOpenSelection,
  type CallbackPane,
  type CallbackReply,
  type OpenArgs,
  type OpenResult,
} from '@shared/callback/protocol';
import { logger } from '../logger';
import type { ConnectionStatus, WorkspaceProvider } from '../providers/types';
import { resolveOpenSelection } from './classify';
import { CallbackListener, type CallbackListenerOptions } from './listener';
import { TokenBucket } from './limiter';
import { CallbackPathError, resolveSocketLocation } from './socketPath';

const LOG_CONTEXT = 'callback';

export interface CallbackBrokerDeps {
  /** A project's connection status: the ConnectionMachine-backed truth (`SessionManager.statusOf`). */
  statusOf: (projectId: string) => ConnectionStatus | undefined;
  /** A project's live provider (`SessionManager.get`); undefined once the session is gone. */
  providerOf: (projectId: string) => Pick<WorkspaceProvider, 'kind' | 'listWorktrees'> | undefined;
  /** A project's configured root (local `rootPath` / remote `remotePath`), or null when unknown. */
  projectRootOf: (projectId: string) => string | null;
  /** Electron's userData directory. Read when a listener starts, never earlier. */
  userDataDir: () => string;
  now?: () => number;
  realpath?: (path: string) => Promise<string>;
  /** Parent of the /tmp socket fallback directory (tests inject a private one). */
  tmpRoot?: string;
  /** Listener limits (tests shrink the deadline). */
  listenerLimits?: Pick<CallbackListenerOptions, 'maxConnections' | 'readDeadlineMs'>;
  /**
   * Make sure the local `cockpit` CLI link exists (cliLink.ts). Called before each
   * local listener binds, so the `COCKPIT_CLI` that terminals receive once the bind
   * completes resolves. Best-effort and idempotent by contract; a throw is swallowed.
   */
  ensureCli?: () => void;
}

/** What the broker emits for an accepted `open`, after classification. */
export interface CallbackOpenEvent {
  projectId: string;
  selection: CallbackOpenSelection;
  /** Attribution only; absent when the client sent no pane. */
  pane?: CallbackPane;
}

interface OpContext {
  projectId: string;
  id: number;
  pane: CallbackPane | undefined;
  args: unknown;
}

export class CallbackBroker {
  private readonly listeners = new Map<string, CallbackListener>();
  /** Per-project tail of the start/stop operations still running or queued. */
  private readonly pending = new Map<string, Promise<void>>();
  private readonly limiters = new Map<string, TokenBucket>();
  private readonly openListeners = new Set<(event: CallbackOpenEvent) => void>();
  private readonly now: () => number;
  private readonly realpath: (path: string) => Promise<string>;

  /** The allowlist, as data: adding an operation means adding a handler here (the
   *  compiler enforces one per `CallbackOp`). */
  private readonly ops: Record<CallbackOp, (ctx: OpContext) => CallbackReply> = {
    open: (ctx) => this.handleOpen(ctx),
  };

  constructor(private readonly deps: CallbackBrokerDeps) {
    this.now = deps.now ?? Date.now;
    this.realpath = deps.realpath ?? ((path) => fsRealpath(path));
  }

  // ---- Decision function ------------------------------------------------------

  /**
   * Decide one request that arrived on `projectId`'s socket. Synchronous: the
   * returned reply is written before anything slow happens.
   */
  handle(projectId: string, raw: unknown): CallbackReply {
    const envelope = parseCallbackEnvelope(raw);
    if (!envelope.ok) return errorReply(envelope.id, 'bad-request', envelope.message);
    const { id, op, pane, args } = envelope;
    if (!isCallbackOp(op)) return errorReply(id, 'unsupported-op', 'unsupported operation');
    if (!this.limiterFor(projectId).tryTake()) {
      return errorReply(id, 'rate-limited', 'too many requests');
    }
    if (this.deps.statusOf(projectId)?.state !== 'connected') {
      return errorReply(id, 'not-connected', 'project is not connected');
    }
    return this.ops[op]({ projectId, id, pane, args });
  }

  private handleOpen(ctx: OpContext): CallbackReply {
    const parsed = parseOpenArgs(ctx.args);
    if (!parsed.ok) return errorReply(ctx.id, 'bad-request', parsed.message);
    void this.dispatchOpen(ctx.projectId, parsed.args, ctx.pane);
    return okReply<OpenResult>(ctx.id, { status: 'dispatched' });
  }

  private async dispatchOpen(
    projectId: string,
    args: OpenArgs,
    pane: CallbackPane | undefined,
  ): Promise<void> {
    try {
      const provider = this.deps.providerOf(projectId);
      const projectRoot = this.deps.projectRootOf(projectId);
      if (!provider || projectRoot === null) {
        throw new Error('the session ended before the path could be classified');
      }
      const selection = await resolveOpenSelection(
        { provider, projectRoot, realpath: this.realpath },
        args,
      );
      // Classification awaited provider RPCs: the session may have disconnected, or
      // been replaced by a reconnect, meanwhile. Deliver only for the very session
      // that was asked, and only while it is still connected.
      if (
        this.deps.providerOf(projectId) !== provider ||
        this.deps.statusOf(projectId)?.state !== 'connected'
      ) {
        throw new Error('the session ended while the path was being classified');
      }
      this.emitOpen({ projectId, selection, ...(pane ? { pane } : {}) });
    } catch (err) {
      logger.warn(
        `callback open dropped project=${projectId} path=${JSON.stringify(args.path)} reason=${JSON.stringify(
          err instanceof Error ? err.message : String(err),
        )}`,
        LOG_CONTEXT,
      );
    }
  }

  private limiterFor(projectId: string): TokenBucket {
    let bucket = this.limiters.get(projectId);
    if (!bucket) {
      bucket = new TokenBucket(
        CALLBACK_RATE_LIMIT_PER_SECOND,
        CALLBACK_RATE_LIMIT_PER_SECOND,
        this.now,
      );
      this.limiters.set(projectId, bucket);
    }
    return bucket;
  }

  // ---- Events -------------------------------------------------------------------

  /** Subscribe to accepted, classified opens. Returns an unsubscribe function. */
  onOpen(listener: (event: CallbackOpenEvent) => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  private emitOpen(event: CallbackOpenEvent): void {
    for (const listener of this.openListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error(
          `callback open listener threw: ${err instanceof Error ? err.message : String(err)}`,
          LOG_CONTEXT,
        );
      }
    }
  }

  // ---- Local listener lifecycle (driven by SessionManager) -----------------------

  /**
   * Serve `projectId`'s callback socket. The NEWEST listener wins the path: the
   * new one binds and renames into place first, then the previous one (if any)
   * is retired, so the endpoint is never unavailable. Failing to bind disables
   * callback for this project with one log line; it never throws, because it
   * must never fail the session.
   */
  startLocalListener(projectId: string): Promise<void> {
    if (process.platform === 'win32') return Promise.resolve(); // named pipes are out of scope
    return this.serialized(projectId, () => this.bindListener(projectId));
  }

  /** Stop serving `projectId`'s socket. Idempotent; ordered after any start still in flight. */
  stopListener(projectId: string): Promise<void> {
    return this.serialized(projectId, async () => {
      this.limiters.delete(projectId);
      const listener = this.listeners.get(projectId);
      this.listeners.delete(projectId);
      await listener?.close();
    });
  }

  /** Stop every listener, including starts still in flight (app shutdown). */
  async stopAll(): Promise<void> {
    const projectIds = new Set([...this.listeners.keys(), ...this.pending.keys()]);
    await Promise.all([...projectIds].map((projectId) => this.stopListener(projectId)));
  }

  /** The project's live local socket path, or null when no listener is bound (disabled or never started). */
  localSocketPath(projectId: string): string | null {
    return this.listeners.get(projectId)?.socketPath ?? null;
  }

  /**
   * Run start/stop operations for one project strictly in call order. Without
   * this, overlapping starts could rename in a different order than they were
   * called (so the NEWER start's socket could be overwritten by the older one's
   * rename), and a stop could not reliably undo a start still binding. An idle
   * project runs its operation synchronously, so a stop at quit unlinks at once.
   */
  private serialized(projectId: string, operation: () => Promise<void>): Promise<void> {
    const tail = this.pending.get(projectId);
    const run = tail ? tail.then(operation, operation) : operation();
    this.pending.set(projectId, run);
    const settled = (): void => {
      if (this.pending.get(projectId) === run) this.pending.delete(projectId);
    };
    void run.then(settled, settled);
    return run;
  }

  private async bindListener(projectId: string): Promise<void> {
    try {
      this.deps.ensureCli?.();
    } catch {
      /* the linker reports its own failures; the CLI link never gates the listener */
    }
    let listener: CallbackListener;
    try {
      const location = resolveSocketLocation({
        userDataDir: this.deps.userDataDir(),
        projectId,
        ...(this.deps.tmpRoot !== undefined ? { tmpRoot: this.deps.tmpRoot } : {}),
      });
      listener = await CallbackListener.start({
        socketPath: location.socketPath,
        handle: (request) => this.handle(projectId, request),
        ...this.deps.listenerLimits,
        onError: (err) =>
          logger.warn(
            `callback listener error project=${projectId} detail=${JSON.stringify(err.message)}`,
            LOG_CONTEXT,
          ),
      });
    } catch (err) {
      const code =
        err instanceof CallbackPathError
          ? err.code
          : ((err as NodeJS.ErrnoException).code ?? 'bind-failed');
      logger.warn(
        `callback disabled project=${projectId} reason=${code} detail=${JSON.stringify(
          err instanceof Error ? err.message : String(err),
        )}`,
        LOG_CONTEXT,
      );
      return;
    }
    const previous = this.listeners.get(projectId);
    this.listeners.set(projectId, listener);
    logger.info(
      `callback listening project=${projectId} path=${JSON.stringify(listener.socketPath)}`,
      LOG_CONTEXT,
    );
    await previous?.close();
  }
}
