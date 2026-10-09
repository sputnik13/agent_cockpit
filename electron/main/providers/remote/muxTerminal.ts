import { randomUUID } from 'node:crypto';
import type {
  TerminalDataHandler,
  TerminalData,
  TerminalExitHandler,
  TerminalExitInfo,
  TerminalHandle,
  TerminalOpenOptions,
  TerminalScrollbackLine,
  MuxSessionInfo,
  MuxTopologySnapshot,
  MuxTopologyLayoutNode,
  TerminalWriteKind,
} from '../types';
import type { MuxClient } from './muxClient';
import type { RemoteMuxConnectionManager } from './muxConnection';

const OUTPUT_POLL_MS = 20;
const EXIT_FINALIZE_RETRY_MS = 50;
const HYDRATED_SCROLLBACK_ROWS = 1_000;
// Match the legacy remote tmux path: Cockpit terminals use the remote account's
// default interactive shell with Byobu explicitly disabled. The tiny /bin/sh
// trampoline expands the daemon's $SHELL then execs it, so it is never the
// pane's lasting process. A login shell sourced host profile hooks and could
// start a nested Byobu/tmux inside the daemon-owned mux pane.
const COCKPIT_SHELL = '/usr/bin/env';
const COCKPIT_SHELL_ARGS = ['BYOBU_DISABLE=1', '/bin/sh', '-c', 'exec "${SHELL:-/bin/sh}"'];

type MuxTerminalClient = Pick<MuxClient, 'request'>;

interface MuxConnection {
  open(): Promise<void>;
  current(): MuxTerminalClient;
  close(): void;
  readonly onAttached: Set<(epoch: number) => void>;
  readonly onStolen?: Set<(sessionId: string, byKind?: 'cockpit' | 'tty') => void>;
}

interface CreateSessionResponse {
  session_id: string;
  pane_id: string;
}

interface AttachSessionResponse {
  seed?: Uint8Array;
  graphics_seed?: Uint8Array;
  resume_sequence?: number;
}

interface OutputChunk {
  sequence: number;
  data: Uint8Array;
}

interface OutputResponse {
  outputs: OutputChunk[];
  exited?: boolean;
}

interface ScrollbackResponse {
  lines: TerminalScrollbackLine[];
}

/** Encode daemon history as a terminal prelude without leaking prior SGR state. */
function encodeScrollback(lines: TerminalScrollbackLine[]): Uint8Array {
  const output: string[] = [];
  for (const line of lines) {
    for (const run of line.runs) {
      output.push('\u001b[0m');
      if (run.sgr) output.push(`\u001b[${run.sgr}m`);
      output.push(run.text);
    }
    output.push('\u001b[0m\r\n');
  }
  return Buffer.from(output.join(''));
}

interface ListedSession {
  session_id: string;
  pane_id: string;
  key: string;
  exited: boolean;
  broadcast: boolean;
  pinned: boolean;
  attached_kind?: 'cockpit' | 'tty';
  logical_session_id?: string;
  window_id?: string;
  broadcast_scope?: 'window' | 'session';
  recovery_diagnostic?: string;
}

interface TopologyPane {
  session_id: string;
  pane_id: string;
  key: string;
  exited: boolean;
	cols: number;
	rows: number;
	actual_cols?: number;
	actual_rows?: number;
}

interface TopologyWindow {
  window_id: string;
  panes: TopologyPane[];
  active_pane_id?: string;
  zoomed_pane_id?: string;
  layout?: RawTopologyLayoutNode;
}

interface RawTopologyLayoutNode {
  pane_id?: string;
  direction?: 'horizontal' | 'vertical';
  ratio?: number;
  first?: RawTopologyLayoutNode;
  second?: RawTopologyLayoutNode;
}

interface TopologySession {
  session_id: string;
  window_order?: string[];
  windows: TopologyWindow[];
  active_window_id?: string;
}

interface TopologyResponse {
	// keeps response ordering meaningful across asynchronous IPC/SSH reads
  epoch?: string;
  revision: number;
  active_session_id?: string;
  sessions: TopologySession[];
}

type MuxSelection = { sessionId: string; windowId: string; paneId: string };

interface MuxTerminal {
  id: string;
  sessionId: string;
  paneId: string;
  cwd: string;
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  /** Ordered, last-write-wins PTY resize lane for a rapidly settling flex leaf. */
  resizeChain: Promise<void>;
  resizeGeneration: number;
  nextSequence: number;
  dataHandlers: Set<TerminalDataHandler>;
  exitHandlers: Set<TerminalExitHandler>;
  buffered: TerminalData[];
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** A child exit was observed; its daemon catalog deletion is retrying. */
  finalizingExit: boolean;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  /** Invalidates an in-flight output request when a new attachment supersedes it. */
  pollGeneration: number;
  closed: boolean;
  /** Persisted recovery panes have a seed but no live PTY/output stream. */
  recovered: boolean;
  waitingForReconnect: boolean;
  /** Another client owns the pane; do not automatically steal it back. */
  stolen: boolean;
  rendererFeatures: string[];
  /** Completes when the initial create/recovery attach has acquired a stable
   * daemon identity. Concurrent renderer mounts join it instead of attaching
   * with the deliberately provisional empty session and pane IDs. */
  opening: Promise<boolean>;
}

/**
 * Adapts the cockpit-mux request protocol to Cockpit's established terminal
 * contract. It keeps one daemon-owned session per terminal key and re-attaches
 * each live terminal after the raw SSH bridge receives a fresh epoch.
 */
export class RemoteMuxTerminalManager {
  private readonly clientId = `cockpit-${randomUUID()}`;
  private readonly terminals = new Map<string, MuxTerminal>();
  private readonly detached = new Map<
    string,
    Pick<MuxTerminal, 'sessionId' | 'paneId' | 'nextSequence' | 'recovered'>
  >();
  /** Stable keys deliberately destroyed in this manager lifetime. */
  private readonly retired = new Set<string>();

  constructor(
    private readonly connection: MuxConnection,
    private readonly defaultCwd: string,
    private readonly broadcastGroup = '',
    private readonly persistScrollback: () => boolean = () => true,
    private readonly scrollbackLines: () => number = () => 10_000,
  ) {
    connection.onAttached.add(() => {
      void this.reconfigureAndReattach();
    });
    connection.onStolen?.add((sessionId, byKind) => {
      for (const term of this.terminals.values()) {
        if (term.sessionId !== sessionId || term.closed) continue;
        term.stolen = true;
        term.waitingForReconnect = true;
        this.stopPolling(term);
        this.emitData(
          term,
          `\r\n[session attached from ${byKind === 'tty' ? 'a terminal' : 'another Cockpit client'}; close and reopen this tab to take it back]\r\n`,
        );
      }
    });
  }

  // The UI preference belongs to Cockpit, while the daemon owns durability.
  // Apply it before every create/list and before reattaching after an SSH bridge
  // reconnect, so a host never receives terminal bytes under a stale policy.
  private async configurePersistence(): Promise<void> {
    await this.connection
      .current()
      .request('mux.configure', {
        persist_scrollback: this.persistScrollback(),
        scrollback_lines: this.scrollbackLines(),
      });
  }

  /** Rebuild key-to-pane identity after an app restart before creating anything.
   *  Daemon topology is durable; this process-local map is not. */
  private async hydrateDetached(): Promise<void> {
    const listed = await this.connection
      .current()
      .request<{ sessions: ListedSession[] }>('session.list', {});
    for (const session of listed.sessions ?? []) {
      if (!session.key) continue;
      this.detached.set(session.key, {
        sessionId: session.session_id,
        paneId: session.pane_id,
        nextSequence: 1,
        recovered: session.exited,
      });
    }
  }

  private async reconfigureAndReattach(): Promise<void> {
    // `onAttached` also fires for the first channel. An opening terminal is
    // deliberately published before session.create so a close can cancel it;
    // it has no daemon identity yet and must not receive a competing attach.
    // Snapshot established panes before the first await so this initial-channel
    // handler cannot race a create that completes while mux.configure is in
    // flight and attach that new pane twice.
    const established = [...this.terminals.values()].filter(
      (term) => !term.closed && term.sessionId !== '',
    );
    if (established.length === 0) return;
    try {
      await this.configurePersistence();
    } catch {
      // The connection manager will retry and emit another attached epoch. Do
      // not reattach panes under a policy we could not establish.
      return;
    }
    let sessions: ListedSession[] | null = null;
    try {
      const inventory = await this.connection
        .current()
        .request<{ sessions: ListedSession[] }>('session.list', {});
      sessions = inventory.sessions ?? [];
    } catch {
      // Retain the previous session IDs as a safe fallback if inventory alone
      // is unavailable; the attach request still has its normal error path.
    }
    const sessionsByPane = new Map((sessions ?? []).map((session) => [session.pane_id, session]));
    for (const term of established) {
      const previousSessionId = term.sessionId;
      const recovered = sessionsByPane.get(term.paneId);
      if (recovered) {
        term.sessionId = recovered.session_id;
        term.paneId = recovered.pane_id;
        term.recovered = recovered.exited;
        this.detached.set(term.id, {
          sessionId: term.sessionId,
          paneId: term.paneId,
          nextSequence: term.nextSequence,
          recovered: term.recovered,
        });
      }
      void this.reattach(
        term,
        Boolean(recovered?.exited && recovered.session_id !== previousSessionId),
      );
    }
  }

  async open(opts: TerminalOpenOptions): Promise<TerminalHandle> {
    const id = opts.key ?? randomUUID();
    if (this.retired.has(id)) {
      if (!opts.createIfMissing)
        throw new Error(`mux terminal ${id} was closed and cannot be reattached`);
      this.retired.delete(id);
    }
    const existing = this.terminals.get(id);
    if (existing) {
      // The child already ended and its catalog deletion is in flight. A
      // transient React remount must not attach this dead pane or turn it into
      // a new root before the authoritative destroy completes.
      if (existing.finalizingExit) return { id };
      if (existing.sessionId === '') {
        const opened = await existing.opening;
        if (!opened || existing.closed || this.terminals.get(id) !== existing)
          throw new Error(`mux terminal ${id} failed while opening`);
        return { id };
      }
      // A renderer reload creates a new terminal view while the main-process
      // manager deliberately keeps this live daemon pane. Re-attach so that
      // the new renderer receives a full seed instead of mounting blank.
      existing.cols = opts.cols;
      existing.rows = opts.rows;
      existing.cellWidth = opts.cellWidth ?? 0;
      existing.cellHeight = opts.cellHeight ?? 0;
      existing.rendererFeatures = [...(opts.rendererFeatures ?? [])];
      await this.connection.open();
      await this.configurePersistence();
      await this.attach(existing, opts.hydrateScrollback === true);
      return { id };
    }

    // Publish the opening generation before any asynchronous connection or
    // inventory work. A close/reopen can otherwise race the three awaits below
    // and leave a newly created daemon pane with no renderer owner.
    let settleOpening!: (opened: boolean) => void;
    const opening = new Promise<boolean>((resolve) => {
      settleOpening = resolve;
    });
    const term: MuxTerminal = {
      id,
      sessionId: '',
      paneId: '',
      cwd: opts.cwd ?? this.defaultCwd,
      cols: opts.cols,
      rows: opts.rows,
      cellWidth: opts.cellWidth ?? 0,
      cellHeight: opts.cellHeight ?? 0,
      resizeChain: Promise.resolve(),
      resizeGeneration: 0,
      nextSequence: 1,
      dataHandlers: new Set(),
      exitHandlers: new Set(),
      buffered: [],
      pollTimer: null,
      finalizingExit: false,
      finalizeTimer: null,
      pollGeneration: 0,
      closed: false,
      recovered: false,
      waitingForReconnect: false,
      stolen: false,
      rendererFeatures: [...(opts.rendererFeatures ?? [])],
      opening,
    };
    this.terminals.set(id, term);
    try {
      await this.connection.open();
      this.requireOpening(term);
      await this.configurePersistence();
      this.requireOpening(term);
      // A new renderer process has no in-memory detached map. Resolve a durable
      // daemon pane by its stable key before deciding to create a new session.
      await this.hydrateDetached();
      this.requireOpening(term);
      const detached = this.detached.get(id);
      if (detached) {
        term.sessionId = detached.sessionId;
        term.paneId = detached.paneId;
        term.nextSequence = detached.nextSequence;
        term.recovered = detached.recovered;
      }
      if (!detached) {
        // Run's private TTY uses the mux transport but is not part of the
        // project's interactive terminal workspace. Preserve the daemon-owned
        // terminal selection before creating it, then restore that selection
        // once its independent pane exists. Without this, opening Run makes
        // its one-pane logical session active and the Terminal panel appears
        // to lose all of the user's windows.
        const priorSelection = opts.kind === 'run' ? await this.activeMuxSelection() : null;
        // Rehydration is attach-only. A main-process restart does not retain
        // the local `retired` set, so inventory absence is the only durable
        // evidence that a pane was deliberately closed. Never turn that stale
        // restoration request into a new shell with the retired identity.
        if (opts.createIfMissing === false)
          throw new Error(`mux terminal ${id} is absent and cannot be reattached`);
        const created = await this.connection
          .current()
          .request<CreateSessionResponse>('session.create', {
            command: COCKPIT_SHELL,
            args: COCKPIT_SHELL_ARGS,
            cwd: term.cwd,
            key: id,
            ...(this.broadcastGroup ? { broadcast_group: this.broadcastGroup } : {}),
          });
        term.sessionId = created.session_id;
        term.paneId = created.pane_id;
        if (priorSelection) {
          await this.connection.current().request('pane.select', {
            session_id: priorSelection.sessionId,
            window_id: priorSelection.windowId,
            pane_id: priorSelection.paneId,
          });
        }
      }
      this.requireOpening(term);
      await this.attach(term, opts.hydrateScrollback === true);
      this.requireOpening(term);
      settleOpening(true);
      return { id };
    } catch (error) {
      settleOpening(false);
      // Do not remove a successor that reused the same stable renderer key.
      if (this.terminals.get(id) === term) this.terminals.delete(id);
      throw error;
    }
  }

  async split(
    sourceId: string,
    id: string,
    direction: 'horizontal' | 'vertical' = 'horizontal',
  ): Promise<TerminalHandle> {
    const source = this.require(sourceId);
    if (this.terminals.has(id)) throw new Error(`mux terminal ${id} already exists`);
    await this.connection.open();
    await this.configurePersistence();
    const created = await this.connection.current().request<CreateSessionResponse>('pane.split', {
      pane_id: source.paneId,
      command: COCKPIT_SHELL,
      args: COCKPIT_SHELL_ARGS,
      cwd: source.cwd,
      key: id,
      direction,
      ratio: 0.5,
    });
    return this.attachCreated(id, created, source);
  }

  async newWindow(sourceId: string, id: string): Promise<TerminalHandle> {
    const source = this.require(sourceId);
    if (this.terminals.has(id)) throw new Error(`mux terminal ${id} already exists`);
    await this.connection.open();
    await this.configurePersistence();
    const created = await this.connection.current().request<CreateSessionResponse>('window.new', {
      session_id: source.sessionId,
      command: COCKPIT_SHELL,
      args: COCKPIT_SHELL_ARGS,
      cwd: source.cwd,
      key: id,
    });
    return this.attachCreated(id, created, source);
  }

  async write(id: string, data: string, kind: TerminalWriteKind = 'input'): Promise<void> {
    const term = this.require(id);
    try {
      await this.connection.current().request('pane.write', {
        pane_id: term.paneId,
        client_id: this.clientId,
        data: Buffer.from(data),
        kind,
      });
    } catch (error) {
      this.handleRequestFailure(term, error);
      throw error;
    }
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const term = this.require(id);
    term.cols = cols;
    term.rows = rows;
    const generation = ++term.resizeGeneration;
    // Flex layout and WTerm's own grid reconciliation can report several
    // measurements in one event turn. Request ordering is not guaranteed by
    // every transport, so a stale width must never arrive after the final one
    // and leave a full-screen application (notably Neovim) at its old columns.
    term.resizeChain = term.resizeChain
      .catch(() => {
        // A failed old resize must not strand the latest geometry behind it.
      })
      .then(async () => {
        if (term.closed || generation !== term.resizeGeneration) return;
        try {
          await this.connection
            .current()
            .request('pane.resize', { pane_id: term.paneId, client_id: this.clientId, cols, rows });
        } catch (error) {
          this.handleRequestFailure(term, error);
          throw error;
        }
      });
    await term.resizeChain;
  }

  async setBroadcast(id: string, enabled: boolean): Promise<void> {
    const term = this.require(id);
    await this.connection
      .current()
      .request('pane.broadcast', { pane_id: term.paneId, client_id: this.clientId, enabled });
  }

  async setBroadcastScope(id: string, scope: 'window' | 'session'): Promise<void> {
    const term = this.require(id);
    await this.connection
      .current()
      .request('session.broadcastScope', { session_id: term.sessionId, scope });
  }

  async scrollback(id: string, before: number, count: number): Promise<TerminalScrollbackLine[]> {
    // Scrollback is durable daemon state, not renderer-attachment state. In a
    // freshly relaunched app the topology may be visible before React has
    // mounted and attached every pane, so only a not-yet-mounted pane needs a
    // persisted inventory lookup. A live pane already has authoritative daemon
    // identity; re-listing beside its 20ms output poll adds unrelated RPCs to
    // the same single mux channel at the exact point a user reads history.
    let term: Pick<MuxTerminal, 'sessionId' | 'paneId' | 'nextSequence' | 'recovered'> | undefined =
      this.terminals.get(id);
    await this.connection.open();
    if (!term) {
      await this.configurePersistence();
      await this.hydrateDetached();
      term = this.detached.get(id);
    }
    if (!term) return [];
    const response = await this.connection
      .current()
      .request<ScrollbackResponse>('scrollback.query', {
        pane_id: term.paneId,
        client_id: this.clientId,
        before,
        count,
      });
    return response.lines ?? [];
  }

  onData(id: string, handler: TerminalDataHandler): () => void {
    const term = this.require(id);
    term.dataHandlers.add(handler);
    for (const data of term.buffered.splice(0)) handler(data);
    return () => term.dataHandlers.delete(handler);
  }

  onExit(id: string, handler: TerminalExitHandler): () => void {
    const term = this.require(id);
    term.exitHandlers.add(handler);
    return () => term.exitHandlers.delete(handler);
  }

  async close(id: string, opts?: { kill?: boolean }): Promise<void> {
    const term = this.terminals.get(id);
    // A natural child exit owns the destructive lifecycle until the daemon
    // confirms catalog deletion. Detaching it here would cancel the retry and
    // leave the exited pane visible in a later topology snapshot.
    if (term?.finalizingExit) return;
    if (term && !term.sessionId && opts?.kill) {
      // Cancel the opening generation first, then resolve any durable pane
      // carrying this stable key. A renderer can begin opening while a
      // recovered inventory exists; returning here would orphan that pane.
      term.closed = true;
      this.retired.add(id);
      this.stopPolling(term);
      this.terminals.delete(id);
      return this.close(id, opts);
    }
    if (!term) {
      // A window may be closed before any of its restored panes have mounted
      // in this main-process lifetime. Rebuild durable identity on demand so
      // that lifecycle routing never falls through as an unknown legacy tab.
      if (!this.detached.has(id)) {
        await this.connection.open();
        await this.hydrateDetached();
      }
      const detached = this.detached.get(id);
      // A restored but not-yet-visible pane has daemon identity in the
      // detached inventory, not in terminals. Closing its window must still
      // destroy it; otherwise the renderer removes the tab while the dormant
      // daemon pane survives as an orphan.
      if (detached && opts?.kill) {
        await this.connection
          .current()
          .request('session.destroy', { session_id: detached.sessionId });
        this.retired.add(id);
        this.detached.delete(id);
      }
      return;
    }
    // `open()` publishes a pending terminal before it knows a daemon session
    // identity. Closing in that interval cancels the generation; open observes
    // it before create/attach and leaves no empty-ID RPC behind.
    if (!term.sessionId) {
      term.closed = true;
      this.stopPolling(term);
      this.terminals.delete(id);
      return;
    }
    if (!opts?.kill) {
      term.closed = true;
      this.stopPolling(term);
      this.terminals.delete(id);
      this.detached.set(id, {
        sessionId: term.sessionId,
        paneId: term.paneId,
        nextSequence: term.nextSequence,
        recovered: term.recovered,
      });

      // A normal Cockpit tab close is an explicit detach, not a dead channel.
      // Retaining the daemon session identity still lets a later reopen reattach
      // without spawning another shell.
      await this.connection
        .current()
        .request('session.detach', { session_id: term.sessionId, client_id: this.clientId })
        .catch(() => {});
      return;
    }
    const resumePolling = this.canPoll(term);
    this.stopPolling(term);
    try {
      await this.connection.current().request('session.destroy', { session_id: term.sessionId });
    } catch (error) {
      if (resumePolling && this.terminals.get(id) === term && !term.closed) this.startPolling(term);
      throw error;
    }
    this.retired.add(id);
    term.closed = true;
    this.terminals.delete(id);
    this.detached.delete(id);
    this.emitExit(term, { code: 0, signal: null });
  }

  async listSessions(): Promise<string[]> {
    await this.connection.open();
    await this.configurePersistence();
    const listed = await this.connection
      .current()
      .request<{ sessions: ListedSession[] }>('session.list', {});
    for (const session of listed.sessions ?? []) {
      if (!session.key) continue;
      this.detached.set(session.key, {
        sessionId: session.session_id,
        paneId: session.pane_id,
        nextSequence: 1,
        recovered: session.exited,
      });
    }
    // Run has a retained mux tty for process output, but it is never an
    // interactive Terminal workspace tab. Keep its detached identity so a
    // Run panel can reattach after reload, while withholding it from the
    // renderer's terminal inventory (which otherwise selects keys[0]).
    return [...new Set([...this.detached.keys(), ...this.terminals.keys()])].filter(
      (key) => key !== 'run',
    );
  }

  async listMuxSessions(): Promise<MuxSessionInfo[]> {
    await this.connection.open();
    await this.configurePersistence();
    const listed = await this.connection
      .current()
      .request<{ sessions: ListedSession[] }>('session.list', {});
    return (listed.sessions ?? []).map((session) => ({
      sessionId: session.session_id,
      paneId: session.pane_id,
      key: session.key,
      exited: session.exited,
      broadcast: session.broadcast,
      pinned: session.pinned === true,
      attachedKind: session.attached_kind ?? null,
      logicalSessionId: session.logical_session_id ?? session.session_id,
      windowId: session.window_id ?? session.session_id,
      broadcastScope: session.broadcast_scope === 'session' ? 'session' : 'window',
      recoveryDiagnostic: session.recovery_diagnostic ?? null,
    }));
  }

  async listMuxTopology(): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    await this.configurePersistence();
    const response = await this.connection
      .current()
      .request<TopologyResponse>('session.topology', {});
    return topologySnapshot(response);
  }

  /** Return the selected interactive mux leaf before creating a Run TTY. */
  private async activeMuxSelection(): Promise<MuxSelection | null> {
    const response = await this.connection.current().request<TopologyResponse>('session.topology', {});
    const session = response.sessions.find((candidate) => candidate.session_id === response.active_session_id);
    const window = session?.windows.find((candidate) => candidate.window_id === session?.active_window_id);
    const pane = window?.panes.find((candidate) => candidate.pane_id === window.active_pane_id);
    return session && window && pane
      ? { sessionId: session.session_id, windowId: window.window_id, paneId: pane.pane_id }
      : null;
  }

  async selectMuxWindow(sessionId: string, windowId: string): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    const response = await this.connection
      .current()
      .request<TopologyResponse>('window.select', { session_id: sessionId, window_id: windowId });
    return topologySnapshot(response);
  }

  async selectMuxPane(
    sessionId: string,
    windowId: string,
    paneId: string,
  ): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    const response = await this.connection.current().request<TopologyResponse>('pane.select', {
      session_id: sessionId,
      window_id: windowId,
      pane_id: paneId,
    });
    return topologySnapshot(response);
  }

  async zoomMuxPane(
    sessionId: string,
    windowId: string,
    paneId: string | null,
  ): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    const response = await this.connection.current().request<TopologyResponse>('pane.zoom', {
      session_id: sessionId,
      window_id: windowId,
      ...(paneId ? { pane_id: paneId } : {}),
    });
    return topologySnapshot(response);
  }

  async resizeMuxSplit(
    sessionId: string,
    windowId: string,
    paneId: string,
    ratio: number,
  ): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    const response = await this.connection.current().request<TopologyResponse>('pane.resizeSplit', {
      session_id: sessionId,
      window_id: windowId,
      pane_id: paneId,
      ratio,
    });
    return topologySnapshot(response);
  }

  async destroyWindow(sessionId: string, windowId: string): Promise<MuxTopologySnapshot> {
    await this.connection.open();
    // The mux connection handles requests serially. Quiesce all local output
    // polls before sending the lifecycle RPC: consulting topology first can
    // otherwise wait behind a poll that was itself queued before the close.
    // The atomic response is the authoritative survivor set, so reconcile
    // local handles only after that response arrives.
    const paused = [...this.terminals.values()].filter((term) => !term.closed);
    // The response is a catalog captured by window.destroy. It cannot describe
    // a pane that started opening after this call, nor can an empty opening
    // generation prove which daemon window it belongs to. Reconcile only the
    // exact, already-established handles that preceded the RPC.
    const establishedAtDestroy = new Map(
      [...this.terminals].filter(([, term]) => !term.closed && term.sessionId !== ''),
    );
    const detachedAtDestroy = new Map(this.detached);
    // `window.destroy` pauses every local stream so its mutation cannot sit
    // behind an obsolete output request. Only live, owned panes were polling
    // beforehand, though: recovered snapshots are read-only and stolen or
    // reconnecting panes intentionally remain quiescent. Remember that
    // eligibility before stopping timers; otherwise a close in one window can
    // turn a recovered survivor into an exited pane and erase its history.
    const resumePolling = new Set(paused.filter((term) => this.canPoll(term)));
    for (const term of paused) this.stopPolling(term);
    let response: TopologyResponse;
    try {
      response = await this.connection.current().request<TopologyResponse>('window.destroy', {
        session_id: sessionId,
        window_id: windowId,
      });
    } catch (error) {
      // A failed structural RPC must not freeze every surviving pane merely
      // because their polls were quiesced ahead of the request.
      for (const term of resumePolling) {
        if (!term.closed && this.terminals.get(term.id) === term) this.startPolling(term);
      }
      throw error;
    }
    const topology = topologySnapshot(response);
    const survivingSessionIDs = new Set(
      topology.sessions.flatMap((session) =>
        session.windows.flatMap((window) => window.panes.map((pane) => pane.sessionId)),
      ),
    );
    for (const [key, term] of establishedAtDestroy) {
      if (this.terminals.get(key) !== term) continue;
      if (survivingSessionIDs.has(term.sessionId)) {
        if (!resumePolling.has(term)) continue;
        this.startPolling(term);
      } else {
        this.retired.add(key);
        term.closed = true;
        this.stopPolling(term);
        this.terminals.delete(key);
        this.detached.delete(key);
      }
    }
    for (const [key, detached] of detachedAtDestroy) {
      if (this.detached.get(key) !== detached) continue;
      if (!survivingSessionIDs.has(detached.sessionId)) {
        this.retired.add(key);
        this.detached.delete(key);
      }
    }
    return topology;
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.connection.open();
    // Quiesce a matching live attachment before sending destruction. A pending
    // pane.output poll on that same client can otherwise keep the destructive
    // request behind an obsolete renderer-owned stream. This method is also
    // the authoritative path for recovered panes that exist only in topology.
    const live = [...this.terminals.values()].filter((term) => term.sessionId === sessionId);
    const detached = [...this.detached].filter(([, term]) => term.sessionId === sessionId);
    const resumePolling = new Set(live.filter((term) => this.canPoll(term)));
    for (const term of live) this.stopPolling(term);
    try {
      await this.connection.current().request('session.destroy', { session_id: sessionId });
    } catch (error) {
      // A rejected destructive RPC leaves the daemon pane alive. Restore its
      // exact former polling eligibility instead of stranding a visible
      // renderer or silently dropping its stable key.
      for (const term of resumePolling) {
        if (this.terminals.get(term.id) === term && !term.closed) this.startPolling(term);
      }
      throw error;
    }
    for (const term of live) {
      if (this.terminals.get(term.id) !== term) continue;
      this.retired.add(term.id);
      term.closed = true;
      this.stopPolling(term);
      this.terminals.delete(term.id);
      this.detached.delete(term.id);
      this.emitExit(term, { code: 0, signal: null });
    }
    for (const [key] of detached) {
      this.retired.add(key);
      this.detached.delete(key);
    }
  }

  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    await this.connection.current().request('session.pin', { session_id: sessionId, pinned });
  }

  /** Stop the daemon without allowing the reconnect manager to resurrect it. */
  async shutdown(): Promise<void> {
    await this.connection.open();
    await this.connection.current().request('mux.shutdown', {});
    this.closeAll();
    this.detached.clear();
    this.connection.close();
  }

  has(id: string): boolean {
    return this.terminals.has(id);
  }

  /** Whether a durable recovered/off-screen pane can still be closed via mux. */
  hasDetached(id: string): boolean {
    return this.detached.has(id);
  }

  closeAll(): void {
    for (const term of [...this.terminals.values()]) {
      // Shutdown is the one lifecycle that must cancel an automatic exit
      // finalization. Leaving its retry timer alive can reopen a connection
      // after the provider deliberately shut it down.
      if (term.finalizingExit) this.abandonExitFinalization(term);
      else void this.close(term.id);
    }
  }

  private async reattach(term: MuxTerminal, recoveredFromDaemonCrash = false): Promise<void> {
    if (term.closed || term.stolen) return;
    try {
      await this.attach(term);
      if (recoveredFromDaemonCrash && !term.closed) this.reportRecoveredDaemonExit(term);
    } catch (error) {
      if (isRecoveredExitedPane(error)) {
        this.reportRecoveredDaemonExit(term);
        return;
      }
      // The connection manager owns bounded retry and will invoke onAttached
      // with a fresh client. A request rejected by the dead bridge is not a
      // terminal-process exit, so retain the daemon-owned session identity.
      this.handleRequestFailure(term, error);
    }
  }

  private reportRecoveredDaemonExit(term: MuxTerminal): void {
    term.waitingForReconnect = false;
    this.stopPolling(term);
    this.emitData(
      term,
      '\r\n[terminal exited while Cockpit mux recovered from a daemon crash]\r\n',
    );
    this.emitExit(term, { code: null, signal: 'daemon-crash' });
  }

  /** Throw when a close or same-key successor superseded this open generation. */
  private requireOpening(term: MuxTerminal): void {
    if (term.closed || this.terminals.get(term.id) !== term)
      throw new Error(`mux terminal ${term.id} was closed while opening`);
  }

  private async attachCreated(
    id: string,
    created: CreateSessionResponse,
    source: Pick<MuxTerminal, 'cwd' | 'cols' | 'rows' | 'cellWidth' | 'cellHeight' | 'rendererFeatures'>,
  ): Promise<TerminalHandle> {
    const term: MuxTerminal = {
      id,
      sessionId: created.session_id,
      paneId: created.pane_id,
      cwd: source.cwd,
      cols: source.cols,
      rows: source.rows,
      cellWidth: source.cellWidth,
      cellHeight: source.cellHeight,
      resizeChain: Promise.resolve(),
      resizeGeneration: 0,
      nextSequence: 1,
      dataHandlers: new Set(),
      exitHandlers: new Set(),
      buffered: [],
      pollTimer: null,
      finalizingExit: false,
      finalizeTimer: null,
      pollGeneration: 0,
      closed: false,
      recovered: false,
      waitingForReconnect: false,
      stolen: false,
      rendererFeatures: [...source.rendererFeatures],
      opening: Promise.resolve(true),
    };
    this.terminals.set(id, term);
    try {
      await this.attach(term);
      return { id };
    } catch (error) {
      // pane.split/window.new committed before the attachment. Keep that
      // identity instead of retrying the structural RPC with the same key;
      // retrying attachment is safe, creating a second pane is not.
      if (this.terminals.get(id) !== term || term.closed) throw error;
      this.pauseForReconnect(term);
      await this.reattach(term);
      return { id };
    }
  }

  private async attach(term: MuxTerminal, hydrateScrollback = false): Promise<void> {
    // Invalidate an old output request before waiting on session.attach. Its
    // rejection belongs to the previous bridge epoch and must not pause the
    // stream that this attachment is about to establish.
    this.stopPolling(term);
    const attached = await this.connection
      .current()
      .request<AttachSessionResponse>('session.attach', {
        session_id: term.sessionId,
        client_id: this.clientId,
        client_kind: 'cockpit',
        renderer_features: term.rendererFeatures,
        cols: term.cols,
        rows: term.rows,
        cell_width: term.cellWidth,
        cell_height: term.cellHeight,
      });
    term.waitingForReconnect = false;
    term.nextSequence = attached.resume_sequence ?? term.nextSequence;
    if (hydrateScrollback) await this.hydrateScrollback(term);
    if (attached.seed?.byteLength) this.emitData(term, attached.seed);
    if (attached.graphics_seed?.byteLength) this.emitData(term, attached.graphics_seed);
    if (!term.recovered) this.startPolling(term);
  }

  /**
   * A newly created WTerm core has no retained history. Restore bounded daemon
   * history before its active-screen seed; failures leave normal attachment
   * intact because the active screen is still authoritative for live input.
   */
  private async hydrateScrollback(term: MuxTerminal): Promise<void> {
    try {
      const response = await this.connection
        .current()
        .request<ScrollbackResponse>('scrollback.query', {
          pane_id: term.paneId,
          client_id: this.clientId,
          before: 0,
          count: HYDRATED_SCROLLBACK_ROWS,
        });
      const history = encodeScrollback(response.lines ?? []);
      if (history.byteLength) this.emitData(term, history);
    } catch {
      // History is an enhancement of a valid attach, not a reason to strand a
      // terminal when a pre-history daemon is encountered during recovery.
    }
  }

  private startPolling(term: MuxTerminal): void {
    if (!this.canPoll(term)) return;
    this.stopPolling(term);
    const generation = term.pollGeneration;
    const poll = (): void => {
      if (term.closed || term.pollGeneration !== generation) return;
      // current() intentionally throws while a dead bridge is between epochs.
      // Start the request in a promise turn so that race is handled exactly like
      // an asynchronous channel failure instead of escaping the poll timer.
      void Promise.resolve()
        .then(() =>
          this.connection.current().request<OutputResponse>('pane.output', {
            pane_id: term.paneId,
            client_id: this.clientId,
            from_sequence: term.nextSequence,
          }),
        )
        .then((response) => {
          if (term.closed || term.pollGeneration !== generation) return;
          for (const output of response.outputs ?? []) {
            term.nextSequence = Math.max(term.nextSequence, output.sequence + 1);
            this.emitData(term, output.data);
          }
          // A daemon response is capped at 8 MiB. An exited pane can therefore
          // still have later chunks after this response; keep polling until an
          // exited response is empty, which is the existing protocol's drain
          // boundary. Finalizing on the first exited response would discard a
          // large process's tail before it reached the renderer.
          if (response.exited && (response.outputs?.length ?? 0) === 0) this.finalizeExited(term);
        })
        .catch((error: unknown) => {
          if (!term.closed && term.pollGeneration === generation)
            this.handleRequestFailure(term, error);
        })
        .finally(() => {
          if (!term.closed && !term.finalizingExit && !term.waitingForReconnect && term.pollGeneration === generation)
            term.pollTimer = setTimeout(poll, OUTPUT_POLL_MS);
        });
    };
    poll();
  }

  private stopPolling(term: MuxTerminal): void {
    if (term.pollTimer) clearTimeout(term.pollTimer);
    term.pollTimer = null;
    term.pollGeneration += 1;
  }

  /** Whether this attachment was eligible to consume the live PTY stream. */
  private canPoll(term: MuxTerminal): boolean {
    return (
      term.sessionId !== '' &&
      term.paneId !== '' &&
      !term.closed &&
      !term.recovered &&
      !term.waitingForReconnect &&
      !term.stolen
    );
  }

  /**
   * Remove an exited daemon pane, then let Cockpit collapse its layout.
   *
   * The PTY exit and its catalog mutation are separate daemon operations. Do
   * not emit terminal-exit (which makes React discard the pane) until the
   * catalog deletion succeeds: a transient RPC failure used to leave an
   * invisible, orphaned window that reappeared on a later topology refresh.
   */
  private finalizeExited(term: MuxTerminal): void {
    if (term.closed || term.finalizingExit) return;
    term.finalizingExit = true;
    this.stopPolling(term);
    const destroyExited = async (): Promise<void> => {
      try {
        await this.connection.open();
        await this.connection.current().request('session.destroy', { session_id: term.sessionId });
      } catch (error) {
        // The daemon's exact runtime-session destroy is idempotent: a lost
        // successful response comes back as not-found on retry, which proves
        // this pane is already absent without ever addressing a sibling.
        if (isSessionNotFoundError(error)) {
          this.completeExited(term);
          return;
        }
        // Keep the pane's identity until its catalog deletion is confirmed.
        // The regular connection manager can recover between attempts; polling
        // remains stopped because the child itself has already exited.
        if (!term.closed && this.terminals.get(term.id) === term)
          term.finalizeTimer = setTimeout(() => void destroyExited(), EXIT_FINALIZE_RETRY_MS);
        return;
      }
      this.completeExited(term);
    };
    void destroyExited();
  }

  /** Retire a pane once the daemon has confirmed it is no longer addressable. */
  private completeExited(term: MuxTerminal): void {
    if (term.closed || this.terminals.get(term.id) !== term) return;
    if (term.finalizeTimer) clearTimeout(term.finalizeTimer);
    term.finalizeTimer = null;
    term.finalizingExit = false;
    term.closed = true;
    this.stopPolling(term);
    this.retired.add(term.id);
    this.terminals.delete(term.id);
    this.detached.delete(term.id);
    this.emitExit(term, { code: null, signal: null });
  }

  /** Cancel a pending exit retry during provider teardown without reopening it. */
  private abandonExitFinalization(term: MuxTerminal): void {
    if (term.finalizeTimer) clearTimeout(term.finalizeTimer);
    term.finalizeTimer = null;
    term.finalizingExit = false;
    term.closed = true;
    this.stopPolling(term);
    this.retired.add(term.id);
    this.terminals.delete(term.id);
    this.detached.delete(term.id);
  }

  /** A bridge error leaves the remote PTY alive; onAttached() will re-seed it. */
  private pauseForReconnect(term: MuxTerminal): void {
    if (term.closed) return;
    term.waitingForReconnect = true;
    this.stopPolling(term);
  }

  private handleRequestFailure(term: MuxTerminal, error: unknown): void {
    // A missing runtime pane is definitive, unlike a connection failure. Do
    // not restart its output poll: that would recurse immediately through the
    // same error and leave the renderer waiting forever for terminal-exit.
    if (isMissingMuxPaneError(error)) {
      this.completeExited(term);
      return;
    }
    // A visible-pane resize can legitimately arrive immediately after its
    // shell exits (for example, the rAF fit scheduled while switching mux
    // windows). This is terminal state, not a lost bridge. Keep polling so
    // pane.output can drain the final bytes and perform the authoritative
    // session.destroy; pausing here stranded the exited pane in topology.
    if (isRecoveredExitedPane(error) && !term.recovered) {
      this.startPolling(term);
      return;
    }
    if (error instanceof Error && /attached by another client/i.test(error.message)) {
      term.stolen = true;
      term.waitingForReconnect = true;
      this.stopPolling(term);
      this.emitData(
        term,
        '\r\n[session attached from another terminal; close and reopen this tab to take it back]\r\n',
      );
      return;
    }
    this.pauseForReconnect(term);
  }

  private emitData(term: MuxTerminal, data: TerminalData): void {
    if (term.dataHandlers.size === 0) {
      term.buffered.push(data);
      return;
    }
    for (const handler of term.dataHandlers) handler(data);
  }

  private emitExit(term: MuxTerminal, info: TerminalExitInfo): void {
    for (const handler of term.exitHandlers) handler(info);
  }

  private require(id: string): MuxTerminal {
    const term = this.terminals.get(id);
    if (!term) throw new Error(`RemoteProvider: unknown terminal id "${id}"`);
    return term;
  }
}

function isRecoveredExitedPane(error: unknown): boolean {
  return error instanceof Error && /mux pane is recovered and read-only/i.test(error.message);
}

function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && /mux session not found/i.test(error.message);
}

function isMissingMuxPaneError(error: unknown): boolean {
  return error instanceof Error && /mux (pane|session) not found/i.test(error.message);
}

function topologySnapshot(response: TopologyResponse): MuxTopologySnapshot {
  return { epoch: response.epoch ?? 'legacy', revision: response.revision ?? 0, activeSessionId: response.active_session_id ?? null, sessions: (response.sessions ?? []).map((session) => ({
    sessionId: session.session_id,
    windowOrder: session.window_order ?? (session.windows ?? []).map((window) => window.window_id),
    activeWindowId: session.active_window_id ?? null,
    windows: (session.windows ?? []).map((window) => ({
      windowId: window.window_id,
      activePaneId: window.active_pane_id ?? null,
      zoomedPaneId: window.zoomed_pane_id ?? null,
      layout: topologyLayout(window.layout),
      panes: (window.panes ?? []).map((pane) => ({
        sessionId: pane.session_id,
        paneId: pane.pane_id,
        key: pane.key,
        exited: pane.exited,
		cols: pane.cols,
		rows: pane.rows,
		actualCols: pane.actual_cols ?? pane.cols,
		actualRows: pane.actual_rows ?? pane.rows,
      })),
    })),
  })) };
}

function topologyLayout(node: RawTopologyLayoutNode | undefined): MuxTopologyLayoutNode | null {
  if (!node) return null;
  return {
    paneId: node.pane_id ?? null,
    direction: node.direction ?? null,
    ratio: node.ratio ?? null,
    first: topologyLayout(node.first),
    second: topologyLayout(node.second),
  };
}

export type RemoteMuxConnection = Pick<
  RemoteMuxConnectionManager,
  'open' | 'current' | 'onAttached'
>;
