/**
 * Renderer state model for the tmux control-mode (`-CC`) subsystem.
 *
 * The store is a pure reducer over the typed control notifications, namespaced
 * **per project**: `byProject[projectId]` is that project's windows/panes/layout
 * view, and `activeProjectId` selects the one the UI renders. Switching projects
 * only moves `activeProjectId` — it never resets state — so a previously visited
 * project's windows (and the live xterms bound to them) are preserved and shown
 * instantly on return (see the lifecycle-decoupling invariant in
 * docs/ARCHITECTURE.md). IPC lives behind the action methods, so the pure
 * reducer is trivially unit-testable under jsdom with a faked `window.api`.
 *
 * Authoritative state is tmux; this store is a derived live view that the
 * reducer keeps idempotent so duplicate notifications (e.g. on reconnect resync)
 * do not corrupt it.
 */
import { create } from 'zustand';
import {
  fromWireNotification,
  parseMouseFlagsValue,
  parseSubscriptionName,
  refreshClientContinue,
  toHex,
} from '@shared/tmux';
import type { LayoutNode, TmuxNotification, TmuxWireNotification } from '@shared/tmux';
import { agentCockpit } from '../providerClient';

/** A pane in the live view, with its decoded output buffered for an xterm. */
export interface PaneState {
  paneId: string;
  windowId: string | null;
  /** Paused by tmux pause-mode flow control (gated; see `tmuxPauseMode`). The
   *  renderer resumes + re-seeds a paused pane when it becomes active/visible. */
  paused?: boolean;
  /** Mouse-tracking flags from a format subscription (gated; see
   *  `tmuxFormatSubscriptions`). Absent ⇒ no subscription value yet, fall back to
   *  the per-gesture `display-message` poll. */
  mouseAny?: boolean;
  mouseSgr?: boolean;
}

/** A window (UI tab) and its current pane-layout tree. `name` is the
 *  tmux-owned window name (set via new-window -n / rename-window — this is
 *  what reserved-window matching keys off). `displayName` is the latest
 *  SCREEN-style title from the active pane (`\ek <title> \e\`), which
 *  zsh/p10k usually sets to the running command or working directory; the
 *  tab strip prefers it when present so the tab labels track the active
 *  command without losing the underlying window name. */
export interface WindowState {
  windowId: string;
  name: string;
  displayName?: string;
  layout: LayoutNode | null;
  /** True when the window has a zoomed pane (tmux window flag `Z`). Derived
   *  from the `%layout-change` flags field, so a zoom toggled outside the app
   *  (a tmux keybinding or another client) is reflected. */
  isZoomed: boolean;
  /** The zoomed-aware visible layout tmux reports alongside the full layout:
   *  when a pane is zoomed this is the single visible pane, else it mirrors
   *  `layout`. The renderer draws `visibleLayout ?? layout`. */
  visibleLayout: LayoutNode | null;
}

/**
 * @deprecated ControlSessionStatus is removed in favor of deriving terminal
 * readiness from the canonical ConnectionStatus (NFR4). Use `isOpen` and
 * `openError` on TmuxViewState instead. This type alias is kept temporarily
 * for test compatibility and will be removed after tests are updated.
 * @internal
 */
export type ControlSessionStatus = 'connecting' | 'open' | 'failed';

export interface TmuxViewState {
  /** Whether the control session is open. */
  isOpen: boolean;
  /**
   * Terminal-local "panes initialized" error: set when tmuxControl.open() IPC
   * call rejects; cleared on the next open() attempt. The "connecting" phase is
   * derived from `!isOpen && openError === null`. This replaces the prior
   * `connectStatus` three-value enum (NFR4: remove the parallel connection
   * truth; only terminal-local state lives here).
   */
  openError: string | null;
  sessionName: string | null;
  /**
   * This project's own tmux session id (`$N`), learned from `%session-changed`
   * at attach. `null` until then. Used to reject notifications that name a
   * DIFFERENT session's id (`%session-window-changed`) — see the reduce()
   * case below and CLAUDE.md "tmux control-mode notifications are broadcast
   * to every client on the server, not just the session they concern"
   * (local_repo_explorer-0255).
   */
  sessionId: string | null;
  /** Ordered window ids (tab order = arrival order). */
  windowOrder: string[];
  windows: Record<string, WindowState>;
  panes: Record<string, PaneState>;
  /** Active window/pane as last reported by tmux (%window-pane-changed). */
  activeWindowId: string | null;
  activePaneId: string | null;
}

/** Initial empty view. */
export function emptyView(): TmuxViewState {
  return {
    isOpen: false,
    openError: null,
    sessionName: null,
    sessionId: null,
    windowOrder: [],
    windows: {},
    panes: {},
    activeWindowId: null,
    activePaneId: null,
  };
}

/** Collect every leaf pane id in a layout tree (depth-first, left to right). */
export function collectPaneIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.paneId];
  return node.children.flatMap(collectPaneIds);
}

/**
 * Pure reducer: fold one parsed notification into the view. Returns a new state
 * object (never mutates the input). Idempotent for repeated structural
 * notifications so reconnect resync is safe.
 */
export function reduce(state: TmuxViewState, n: TmuxNotification): TmuxViewState {
  switch (n.type) {
    case 'unlinked-window-add': {
      // tmux control mode broadcasts to EVERY client on the shared server, not
      // just the one attached to the concerned session — %unlinked-window-add
      // means "a window exists that is NOT linked to any session this client
      // is attached to" (i.e. it belongs to a DIFFERENT project's session on
      // the same tmux server). Folding it in as if it were our own %window-add
      // (the pre-fix behavior) added another project's real window into this
      // project's tab strip on every window create/select in that OTHER
      // project (local_repo_explorer-0255) — always a no-op, never adopted.
      return state;
    }
    case 'window-add': {
      if (state.windows[n.windowId]) return state; // idempotent
      return {
        ...state,
        windowOrder: [...state.windowOrder, n.windowId],
        windows: {
          ...state.windows,
          [n.windowId]: {
            windowId: n.windowId,
            name: n.windowId,
            layout: null,
            isZoomed: false,
            visibleLayout: null,
          },
        },
      };
    }
    case 'window-close': {
      if (!state.windows[n.windowId]) return state;
      const windows = { ...state.windows };
      const closed = windows[n.windowId];
      delete windows[n.windowId];
      // Drop panes that belonged to the closed window.
      const panes = { ...state.panes };
      for (const pid of collectPaneIds(closed?.layout ?? null)) delete panes[pid];
      const windowOrder = state.windowOrder.filter((w) => w !== n.windowId);
      const activeWindowId =
        state.activeWindowId === n.windowId ? (windowOrder[windowOrder.length - 1] ?? null) : state.activeWindowId;
      return { ...state, windows, panes, windowOrder, activeWindowId };
    }
    case 'window-renamed': {
      const w = state.windows[n.windowId];
      if (!w) return state;
      return { ...state, windows: { ...state.windows, [n.windowId]: { ...w, name: n.name } } };
    }
    case 'layout-change': {
      // Ensure the window exists (layout can arrive for a window we have not
      // seen an explicit add for yet), then attach the parsed tree and index
      // its panes.
      const existing = state.windows[n.windowId];
      const name = existing?.name ?? n.windowId;
      const windowOrder = existing ? state.windowOrder : [...state.windowOrder, n.windowId];
      const root = n.layout.root;
      // tmux reports the zoom state in the window-flags field (`Z`) and the
      // visible (zoomed) layout as a separate string. Mirror both so the view
      // follows zoom even when it was toggled outside the app (FR1.2). Index
      // panes from the FULL layout so every pane stays tracked while zoomed.
      const isZoomed = n.flags?.includes('Z') ?? false;
      const visibleLayout = n.visibleLayout?.root ?? null;
      const panes = { ...state.panes };
      for (const pid of collectPaneIds(root)) {
        // Preserve per-pane subscription/pause flags across re-index (a
        // layout-change must not wipe paused/mouse state).
        panes[pid] = { ...state.panes[pid], paneId: pid, windowId: n.windowId };
      }
      return {
        ...state,
        windowOrder,
        windows: {
          ...state.windows,
          [n.windowId]: { windowId: n.windowId, name, layout: root, isZoomed, visibleLayout },
        },
        panes,
      };
    }
    case 'window-pane-changed': {
      // tmux emits this when the ACTIVE PANE OF A WINDOW changes
      // (split-window, select-pane, mouse click into pane). For pure
      // window switches (new-window, select-window) tmux emits
      // %session-window-changed instead — see that case below.
      //
      // LIVE-PROBE-CONFIRMED (local_repo_explorer-0255): this notification is
      // broadcast to EVERY control client on the shared tmux server, not just
      // the one attached to the session the window/pane actually belongs to —
      // and unlike %session-window-changed, its wire payload carries no
      // session id to filter on at all. A `select-pane`/split/click in a
      // DIFFERENT project's window (on the same local server, or the same
      // remote host) reaches this project's channel too. Window/pane ids are
      // unique per tmux SERVER (never reused across sessions while both are
      // open — verified live), so requiring the windowId to already be a
      // window WE track is a complete, not-just-best-effort guard: a foreign
      // window can never coincidentally collide with one of ours.
      if (!state.windows[n.windowId]) return state;
      return { ...state, activeWindowId: n.windowId, activePaneId: n.paneId };
    }
    case 'session-window-changed': {
      // tmux 3.5+ control-mode notification when a session's active window
      // changes. new-window fires this (followed by window-add + layout-
      // change for the new window), NOT %window-pane-changed. Mirror the
      // new active window into state; activePaneId is intentionally
      // cleared so the renderer's layout effect picks the first pane of
      // the new window (which may not have its layout yet at this
      // moment — that's why we don't try to derive the pane here).
      //
      // LIVE-PROBE-CONFIRMED (local_repo_explorer-0255): broadcast to EVERY
      // control client on the shared tmux server — a `new-window`/
      // `select-window`/`kill-window` in a DIFFERENT project's session fires
      // this on OUR channel too, with THAT session's id, not ours. Unlike
      // %window-pane-changed this payload DOES carry the session id, so
      // reject it outright when we know our own session id and it doesn't
      // match — this is what actually corrupted activeWindowId/activePaneId
      // on every window create/switch in an unrelated project. `state.
      // sessionId == null` (not yet learned from our own %session-changed,
      // which always arrives first on attach) falls through to apply
      // optimistically rather than risk dropping a legitimate early event.
      if (state.sessionId != null && n.sessionId !== state.sessionId) return state;
      return { ...state, activeWindowId: n.windowId, activePaneId: null };
    }
    case 'session-changed': {
      return { ...state, sessionName: n.name, sessionId: n.sessionId };
    }
    case 'exit': {
      return { ...emptyView() };
    }
    case 'pause':
    case 'continue': {
      // tmux pause-mode flow control (gated). Track the per-pane paused flag so
      // the renderer can resume + re-seed the pane when it becomes visible.
      const paused = n.type === 'pause';
      const p = state.panes[n.paneId];
      if (!p) {
        return {
          ...state,
          panes: { ...state.panes, [n.paneId]: { paneId: n.paneId, windowId: null, paused } },
        };
      }
      if ((p.paused ?? false) === paused) return state;
      return { ...state, panes: { ...state.panes, [n.paneId]: { ...p, paused } } };
    }
    case 'subscription-changed': {
      // Format subscriptions (gated). Route the pushed value to the window title
      // (displayName) or the pane mouse flags by the subscription name.
      const parsed = parseSubscriptionName(n.name);
      if (!parsed) return state;
      if (parsed.kind === 'title') {
        const w = state.windows[parsed.windowId];
        const displayName = n.value.trim();
        if (!w || !displayName || w.displayName === displayName) return state;
        return {
          ...state,
          windows: { ...state.windows, [parsed.windowId]: { ...w, displayName } },
        };
      }
      const { any, sgr } = parseMouseFlagsValue(n.value);
      const p = state.panes[parsed.paneId];
      if (p && p.mouseAny === any && p.mouseSgr === sgr) return state;
      const base = p ?? { paneId: parsed.paneId, windowId: null };
      return {
        ...state,
        panes: { ...state.panes, [parsed.paneId]: { ...base, mouseAny: any, mouseSgr: sgr } },
      };
    }
    default:
      return state;
  }
}

/** Stable empty view for selectors so an absent project never churns renders. */
const EMPTY_VIEW: TmuxViewState = emptyView();

/** Output sinks are keyed by (projectId, paneId): the tmux pane id (`%0`) repeats
 *  across projects' sessions, so the project must be part of the key or one
 *  project's output would bleed into another's xterm. */
const SEP = '\x1f'; // unit separator: never appears in project or pane ids, and is not NUL (NUL breaks git diffs)
const sinkKey = (projectId: string, paneId: string): string => `${projectId}${SEP}${paneId}`;

export interface TmuxStore {
  /** Per-project derived views. The active project's view drives the UI. */
  byProject: Record<string, TmuxViewState>;
  /** Project whose view the UI currently renders. */
  activeProjectId: string | null;

  /** Select which project's view is active (no reset of any slice). */
  setActiveProject: (projectId: string) => void;
  /** Apply a wire notification for a project: route %output to its pane sink,
   *  else reduce into that project's slice. */
  applyNotification: (projectId: string, wire: TmuxWireNotification) => void;
  bindPaneSink: (projectId: string, paneId: string, sink: (bytes: Uint8Array) => void) => () => void;
  /** Set the display name of a window (the SCREEN-style title captured
   *  from `\ek...\e\` in the pane's byte stream). Independent of the
   *  tmux-owned `name` field — both coexist. No-op when the window or
   *  project slice doesn't exist. */
  setWindowDisplayName: (projectId: string, windowId: string, displayName: string) => void;

  /**
   * Set the terminal-local open error for a project's slice.
   * Pass null to clear (reset to "connecting" phase).
   */
  setOpenError: (projectId: string, error: string | null) => void;

  // Actions (IPC behind them). Every one of these accepts an optional
  // trailing `projectId` that EXPLICITLY addresses a specific live session on
  // main, instead of implicitly targeting whichever project main considers
  // active right now (local_repo_explorer-0255). Required for any call tied
  // to one particular project — including CapturePane/Input/Resize, which
  // paint captured bytes/keystrokes/geometry into a specific pane or client
  // and can otherwise cross-wire content between DIFFERENT tmux servers
  // (pane ids are only unique per-server). Omit only when "whatever's active
  // right now" is the genuinely intended target (a direct user keystroke/
  // click while looking at the active project).
  open: (projectId: string, opts?: { cols?: number; rows?: number }) => Promise<void>;
  close: (kill?: boolean, projectId?: string) => Promise<void>;
  command: (
    args: string,
    projectId?: string,
  ) => Promise<{ num: number; error: boolean; lines: string[]; projectId?: string }>;
  /** Send literal input bytes to a pane (encoded to hex pairs). `projectId` is
   *  the pane's OWN project — required so keystrokes can't cross-wire into a
   *  different project's real pane across different tmux servers. */
  sendInput: (projectId: string, paneId: string, data: string | Uint8Array) => Promise<void>;
  /** Resume a pause-mode-paused pane: send `refresh-client -A %p:continue` and
   *  optimistically clear the paused flag (tmux also emits `%continue`). No-op if
   *  the pane is not paused. Gated feature; only fires when pause-mode is on. */
  resumePane: (projectId: string, paneId: string) => void;
  resize: (cols: number, rows: number, projectId?: string) => Promise<void>;
  /** Drop a single project's slice + its sinks. */
  resetProject: (projectId: string) => void;
  /** Clear every project (backend switch / teardown). */
  reset: () => void;
}

/** The active project's view, or a stable empty view when none is selected. */
export function selectActiveView(s: TmuxStore): TmuxViewState {
  return (s.activeProjectId != null && s.byProject[s.activeProjectId]) || EMPTY_VIEW;
}

export const useTmuxStore = create<TmuxStore>((set, get) => {
  // Pane sinks live in closure state, not in the reduced view, so the reducer
  // remains pure and serializable.
  const sinks = new Map<string, Set<(bytes: Uint8Array) => void>>();

  return {
    byProject: {},
    activeProjectId: null,

    setActiveProject: (projectId) =>
      set((st) =>
        st.activeProjectId === projectId && st.byProject[projectId]
          ? st
          : {
              activeProjectId: projectId,
              byProject: st.byProject[projectId]
                ? st.byProject
                : { ...st.byProject, [projectId]: emptyView() },
            },
      ),

    applyNotification: (projectId, wire) => {
      const n = fromWireNotification(wire);
      if (n.type === 'output') {
        const bound = sinks.get(sinkKey(projectId, n.paneId));
        if (bound) for (const s of bound) s(n.bytes);
        return;
      }
      set((st) => {
        const prev = st.byProject[projectId] ?? emptyView();
        const next = reduce(prev, n);
        if (next === prev) return st;
        return { byProject: { ...st.byProject, [projectId]: next } };
      });
    },

    setWindowDisplayName: (projectId, windowId, displayName) => {
      set((st) => {
        const slice = st.byProject[projectId];
        const win = slice?.windows[windowId];
        if (!slice || !win || win.displayName === displayName) return st;
        return {
          byProject: {
            ...st.byProject,
            [projectId]: {
              ...slice,
              windows: { ...slice.windows, [windowId]: { ...win, displayName } },
            },
          },
        };
      });
    },

    bindPaneSink: (projectId, paneId, sink) => {
      const key = sinkKey(projectId, paneId);
      let bound = sinks.get(key);
      if (!bound) {
        bound = new Set();
        sinks.set(key, bound);
      }
      bound.add(sink);
      return () => {
        bound!.delete(sink);
        if (bound!.size === 0) sinks.delete(key);
      };
    },

    setOpenError: (projectId, error) => {
      set((st) => {
        const prev = st.byProject[projectId] ?? emptyView();
        if (prev.openError === error) return st;
        return {
          byProject: {
            ...st.byProject,
            [projectId]: { ...prev, openError: error },
          },
        };
      });
    },

    open: async (projectId, opts) => {
      // Clear any prior openError (resets to "connecting" phase) before the IPC
      // call so the UI shows progress instead of hanging on the prior error.
      set((st) => {
        const prev = st.byProject[projectId] ?? emptyView();
        return {
          byProject: {
            ...st.byProject,
            [projectId]: { ...prev, openError: null },
          },
        };
      });
      const sessionName = await agentCockpit.tmuxControl.open(opts, projectId);
      set((st) => {
        const prev = st.byProject[projectId] ?? emptyView();
        return {
          byProject: {
            ...st.byProject,
            [projectId]: { ...prev, isOpen: true, openError: null, sessionName },
          },
        };
      });
    },
    close: async (kill, projectId) => {
      await agentCockpit.tmuxControl.close(kill, projectId);
    },
    command: (args, projectId) => agentCockpit.tmuxControl.command(args, projectId),
    sendInput: async (projectId, paneId, data) => {
      // The main-process manager `input()` does the encoding-aware chunking
      // (printable ASCII via send-keys -l, the rest via -H; split so a large
      // paste can't exceed tmux's control-command line limit). The renderer just
      // hands over the raw bytes as hex. `projectId` explicitly addresses the
      // pane's own project (local_repo_explorer-0255) — previously discarded,
      // which let keystrokes cross-wire into another project's real pane
      // across different tmux servers.
      await agentCockpit.tmuxControl.input(paneId, toHex(data), projectId);
    },
    resumePane: (projectId, paneId) => {
      const view = get().byProject[projectId];
      if (!view?.panes[paneId]?.paused) return;
      void agentCockpit.tmuxControl.command(refreshClientContinue(paneId), projectId).catch(() => {});
      set((st) => {
        const slice = st.byProject[projectId];
        const p = slice?.panes[paneId];
        if (!slice || !p?.paused) return st;
        return {
          byProject: {
            ...st.byProject,
            [projectId]: { ...slice, panes: { ...slice.panes, [paneId]: { ...p, paused: false } } },
          },
        };
      });
    },
    resize: async (cols, rows, projectId) => {
      await agentCockpit.tmuxControl.resize(cols, rows, projectId);
    },
    resetProject: (projectId) => {
      for (const k of [...sinks.keys()]) if (k.startsWith(`${projectId}${SEP}`)) sinks.delete(k);
      set((st) => {
        if (!st.byProject[projectId]) return st;
        const next = { ...st.byProject };
        delete next[projectId];
        return {
          byProject: next,
          activeProjectId: st.activeProjectId === projectId ? null : st.activeProjectId,
        };
      });
    },
    reset: () => {
      sinks.clear();
      set({ byProject: {}, activeProjectId: null });
    },
  };
});
