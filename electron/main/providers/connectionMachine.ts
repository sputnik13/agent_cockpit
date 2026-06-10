/**
 * ConnectionMachine — per-project authoritative connection state machine.
 *
 * Owns the canonical `ConnectionState` for one project. All state changes flow
 * through this module; no ad hoc `setStatus` from scattered call sites.
 *
 * Transition table (legal only):
 *   disconnected  -> connecting    (connect/activate)
 *   connecting    -> connected     (helper RPC ready — see RemoteProvider.connect)
 *   connecting    -> failed        (ssh/helper error — thrown connect/launch)
 *   connecting    -> disconnected  (clean drop mid-provision, no thrown error)
 *   connected     -> disconnected  (user disconnect / socket close)
 *   connected     -> reconnecting  (control-channel drop — auto)
 *   reconnecting  -> connected     (reattach ok)
 *   reconnecting  -> failed        (reattach gave up)
 *   failed        -> connecting    (user reconnect)
 *
 * Illegal transitions are rejected: logged at warn, no-op — never thrown.
 *
 * Coalescing: a `toConnecting` or `toReconnecting` request while the machine is
 * already in `connecting` or `reconnecting` returns the in-flight transition
 * promise rather than starting a second, preventing duplicate providers/channels.
 *
 * LocalProvider semantics: call `machine.shortCircuitConnected()` to bypass
 * all remote transitions and hard-set `connected`. Local projects are never
 * disconnected by the machine.
 */
import type { ConnectionState, ConnectionStatus } from './types';
import { logger } from '../logger';

type StatusHandler = (status: ConnectionStatus) => void;

/**
 * Legal transition edges. Each entry is [from, to]. The set is used for O(1)
 * guard checks via the legality helper below.
 */
const LEGAL: ReadonlySet<string> = new Set([
  'disconnected->connecting',
  'connecting->connected',
  'connecting->failed',
  // A drop while provisioning (socket up but helper not yet launched) resolves
  // cleanly to disconnected instead of stranding the machine in connecting.
  'connecting->disconnected',
  'connected->disconnected',
  'connected->reconnecting',
  'reconnecting->connected',
  'reconnecting->failed',
  'failed->connecting',
]);

function edgeKey(from: ConnectionState, to: ConnectionState): string {
  return `${from}->${to}`;
}

function isLegal(from: ConnectionState, to: ConnectionState): boolean {
  return LEGAL.has(edgeKey(from, to));
}

function now(): string {
  return new Date().toISOString();
}

export class ConnectionMachine {
  private state: ConnectionState;
  private detail: string | undefined;
  private readonly handlers = new Set<StatusHandler>();
  /** A single in-flight "connecting-family" promise (connecting or reconnecting)
   *  for coalescing concurrent requests. */
  private inFlight: Promise<void> | null = null;
  private readonly context: string;

  constructor(projectId: string, initialState: ConnectionState = 'disconnected') {
    this.state = initialState;
    this.context = `conn-machine[${projectId}]`;
  }

  // ---- Public read API -------------------------------------------------------

  current(): ConnectionStatus {
    return { state: this.state, detail: this.detail, since: now() };
  }

  /** Subscribe to every accepted transition. Returns an unsubscribe function. */
  subscribe(handler: StatusHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ---- Transition intents ---------------------------------------------------

  /**
   * Request transition to `connecting`. Returns the existing in-flight promise
   * when already connecting (coalescing). Illegal transitions are no-ops.
   */
  toConnecting(detail?: string): void {
    if (this.state === 'connecting') {
      logger.info(`${this.context}: already connecting — coalescing`, this.context);
      return;
    }
    this.apply('connecting', detail);
  }

  toConnected(detail?: string): void {
    this.apply('connected', detail);
  }

  toFailed(detail?: string): void {
    this.apply('failed', detail);
  }

  toDisconnected(detail?: string): void {
    this.apply('disconnected', detail);
  }

  /**
   * Request transition to `reconnecting`. Returns without changing state when
   * already reconnecting (coalescing).
   */
  toReconnecting(detail?: string): void {
    if (this.state === 'reconnecting') {
      logger.info(`${this.context}: already reconnecting — coalescing`, this.context);
      return;
    }
    this.apply('reconnecting', detail);
  }

  /**
   * Hard-set `connected` bypassing the normal guard — for LocalProvider, which
   * has no transport lifecycle and is always connected when instantiated.
   * Not callable after construction with initialState='connected'; this is
   * provided so callers that start in `disconnected` (the default) can
   * short-circuit without faking a `disconnected->connecting->connected` path.
   */
  shortCircuitConnected(): void {
    this.state = 'connected';
    this.detail = undefined;
    const status: ConnectionStatus = { state: 'connected', since: now() };
    for (const h of this.handlers) h(status);
    logger.info(`${this.context}: short-circuit → connected (local)`, this.context);
  }

  // ---- In-flight coalescing (promise-level) ---------------------------------

  /**
   * Wrap an async connecting/reconnecting operation with coalescing: if a call
   * is already in flight, return the same promise. Otherwise execute `fn` and
   * store the promise for the duration. Callers use this to prevent duplicate
   * providers/channels under rapid reconnect.
   */
  coalesce(fn: () => Promise<void>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = fn().finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  /** Whether a connect/reconnect is currently in flight. */
  isInFlight(): boolean {
    return this.inFlight !== null;
  }

  // ---- Internal helpers ------------------------------------------------------

  private apply(to: ConnectionState, detail?: string): void {
    const from = this.state;
    if (!isLegal(from, to)) {
      logger.warn(
        `${this.context}: illegal transition ${from}->${to} rejected`,
        this.context,
      );
      return;
    }
    this.state = to;
    this.detail = detail;
    const status: ConnectionStatus = { state: to, detail, since: now() };
    logger.info(
      `${this.context}: ${from} → ${to}${detail ? ` (${detail})` : ''}`,
      this.context,
    );
    for (const h of this.handlers) h(status);
  }
}

/**
 * Factory: create a machine in the initial state for a project.
 * Separated so callers can inject a starting state in tests.
 */
export function createConnectionMachine(
  projectId: string,
  initialState: ConnectionState = 'disconnected',
): ConnectionMachine {
  return new ConnectionMachine(projectId, initialState);
}
