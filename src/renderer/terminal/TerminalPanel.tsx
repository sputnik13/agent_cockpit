import { useCallback, useEffect, useRef, useState } from 'react';
import { agentCockpit, useProjectsStore } from '../providerClient';
import { useTerminalsStore } from './terminalsStore';
import { XtermView } from './XtermView';
import * as registry from './terminalRegistry';
import { reduceMuxKeyboard } from './muxKeyboard';
import { isTerminalKeyboardTarget } from './keyboardScope';
import { shouldRetainTerminalAfterExit } from './terminalExitPolicy';
import { SessionsDialog } from '../sessions';
import { ControlTerminalPanel } from '../tmux/ControlTerminalPanel';
import { useSettingsStore } from '../settings';
import type {
  MuxTopologyLayoutNode,
  MuxTopologyPane,
  MuxTopologySnapshot,
  MuxTopologySession,
  MuxTopologyWindow,
} from '@shared/providers/types';
import { usePanelFocusOverride } from '../workspace/panelFocusContext';
import { Button, EmptyState, IconButton, TabbedPanelHeader, cn } from '../ui';
import {
  adjacentMuxPane,
  EMPTY_MUX_TOPOLOGY,
  reconcileMuxTopology,
  type PaneDirection,
} from './muxTopologyModel';

// The standalone `cockpit-mux` CLI is intentionally a local API: it can add a
// pane or window without a renderer request. The protocol's persistent control
// channel does not publish topology-change events yet, so keep the visible
// Cockpit model convergent while an idle project is open.
const MUX_TOPOLOGY_POLL_MS = 500;
// Run owns its private `run` key through the same transport, but it is not a
// window in the user's interactive terminal workspace.
const MUX_RUN_TERMINAL_KEY = 'run';

function interactiveTopology(snapshot: MuxTopologySnapshot): MuxTopologySnapshot {
  const sessions = snapshot.sessions.filter((session) =>
    session.windows.some((window) =>
      window.panes.some((pane) => pane.key !== MUX_RUN_TERMINAL_KEY),
    ),
  );
  return {
    ...snapshot,
    activeSessionId: sessions.some((session) => session.sessionId === snapshot.activeSessionId)
      ? snapshot.activeSessionId
      : (sessions[0]?.sessionId ?? null),
    sessions,
  };
}

/**
 * Terminal dock panel. Switches between the session-per-tab backend and the
 * tmux control-mode (-CC) backend based on the persisted setting. Only the
 * selected backend's component mounts, so the other's sessions/effects stay
 * inert.
 */
export function TerminalPanel(): JSX.Element {
  const backend = useSettingsStore((s) => s.settings.terminalBackend);
  // Activating the Terminal panel focuses the active xterm pane, reusing the
  // proven FOCUS_TERMINAL_EVENT path that both backends already listen for.
  usePanelFocusOverride(() => window.dispatchEvent(new Event(registry.FOCUS_TERMINAL_EVENT)));
  return backend === 'control-mode' ? <ControlTerminalPanel /> : <SessionTerminalPanel />;
}

/**
 * Embedded terminal surface: a tab strip of independent terminals (each its own
 * persistent tmux session) plus the active terminal's xterm. Switching tabs is
 * client-side only; the other IDE panels do not follow terminal focus.
 */
function SessionTerminalPanel(): JSX.Element {
  const backend = useSettingsStore((s) => s.settings.terminalBackend);
  const activeId = useProjectsStore((s) => s.activeId);
  const keys = useTerminalsStore((s) => s.keys);
  const activeKey = useTerminalsStore((s) => s.activeKey);
  const init = useTerminalsStore((s) => s.init);
  const add = useTerminalsStore((s) => s.add);
  const addExisting = useTerminalsStore((s) => s.addExisting);
  const remove = useTerminalsStore((s) => s.remove);
  const close = useTerminalsStore((s) => s.close);
  const setActive = useTerminalsStore((s) => s.setActive);
  const keysRef = useRef(keys);
  const pendingMuxKeysRef = useRef(new Set<string>());
  const retiredMuxKeysRef = useRef(new Set<string>());
  // A window destroy owns its target keys until it has committed the daemon's
  // survivor snapshot. Terminal-exit notifications for those keys are expected
  // side effects of the same destroy; handling them independently can render a
  // disposed key in the gap before the survivor is selected.
  const closingMuxKeysRef = useRef(new Set<string>());
  // Stable mux keys identify durable daemon panes. Never reuse one during a
  // renderer lifetime: a delayed view from a closed pane must not be able to
  // attach to (or create over) the new pane that inherited its tab key.
  const issuedMuxKeysRef = useRef(new Set<string>());
  const activeMuxKeyRef = useRef<string | null>(null);
  // Cockpit mux follows tmux's terminal-workspace invariant: once the user
  // opens the dock, an exited final pane is immediately replaced by a fresh
  // default-shell pane. Keep this guard outside React state so concurrent
  // topology polls cannot create two roots in the open/attach gap.
  const ensuringMuxRootRef = useRef(false);
  const startMuxRootRef = useRef<() => void>(() => {});
  // A topology update rebinds the frontend command handler. Keep the Byobu
  // prefix outside that effect so Ctrl+A remains armed through a normal mux
  // refresh and Ctrl+A,A can always escape back to the shell.
  const byobuArmedRef = useRef(false);
  const byobuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A tree branch can have two physical neighbors in the opposite direction.
  // Remember the immediately preceding edge so Backtracking is deterministic:
  // bottom-right → left → full-height-left → right returns bottom-right rather
  // than jumping to its top-right sibling.
  const muxDirectionalReturnsRef = useRef(new Map<string, string>());
  keysRef.current = keys;
  for (const key of keys) issuedMuxKeysRef.current.add(key);
  // Per-key reset counter; bumping it re-acquires that terminal's xterm.
  const [resetTokens, setResetTokens] = useState<Record<string, number>>({});
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [topologySnapshot, setTopologySnapshot] = useState<MuxTopologySnapshot>(EMPTY_MUX_TOPOLOGY);
  const topologySnapshotRef = useRef<MuxTopologySnapshot>(EMPTY_MUX_TOPOLOGY);
  const topologyProjectIdRef = useRef<string | null>(null);
  const retiredTopologyEpochsRef = useRef(new Set<string>());
  const topology = topologySnapshot.sessions;
  /** Commit daemon topology only if its captured project is still visible. */
  const commitTopology = useCallback(
    (projectId: string, snapshot: MuxTopologySnapshot): boolean => {
      if (useProjectsStore.getState().activeId !== projectId) return false;
      if (topologyProjectIdRef.current !== projectId) {
        topologyProjectIdRef.current = projectId;
        topologySnapshotRef.current = EMPTY_MUX_TOPOLOGY;
        retiredTopologyEpochsRef.current.clear();
      }
      const current = topologySnapshotRef.current;
      const next = reconcileMuxTopology(
        current,
        interactiveTopology(snapshot),
        retiredTopologyEpochsRef.current,
      );
      if (next === current) return false;
      if (current.epoch && current.epoch !== next.epoch)
        retiredTopologyEpochsRef.current.add(current.epoch);
      topologySnapshotRef.current = next;
      setTopologySnapshot(next);
      return true;
    },
    [],
  );
  useEffect(() => {
    void init(backend !== 'cockpit-mux');
  }, [activeId, backend, init]);

  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId) {
      ensuringMuxRootRef.current = false;
      topologyProjectIdRef.current = null;
      topologySnapshotRef.current = EMPTY_MUX_TOPOLOGY;
      retiredTopologyEpochsRef.current.clear();
      setTopologySnapshot(EMPTY_MUX_TOPOLOGY);
      return;
    }
    if (topologyProjectIdRef.current !== activeId) {
      topologyProjectIdRef.current = activeId;
      topologySnapshotRef.current = EMPTY_MUX_TOPOLOGY;
      retiredTopologyEpochsRef.current.clear();
      setTopologySnapshot(EMPTY_MUX_TOPOLOGY);
    }
    let cancelled = false;
    void agentCockpit.muxSessions
      .topology(activeId)
      .then((sessions) => {
        if (cancelled || !commitTopology(activeId, sessions)) return;
        // The mux has no legacy renderer-only fallback. Without a root pane,
        // hiding the creation toolbar would strand the terminal workspace.
        if (interactiveTopology(sessions).sessions.length === 0) startMuxRootRef.current();
      })
      // A refresh failure has no authoritative topology content. Preserve the
      // current model; only an explicit backend/project transition may clear it.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeId, backend, commitTopology, keys]);

  // Ctrl+` (handled in CockpitWorkspace) asks us to focus the active terminal.
  useEffect(() => {
    const onFocus = (): void => registry.focusEntry(activeId, 'terminal', activeKey);
    window.addEventListener(registry.FOCUS_TERMINAL_EVENT, onFocus);
    return () => window.removeEventListener(registry.FOCUS_TERMINAL_EVENT, onFocus);
  }, [activeId, activeKey]);

  // A pending key blocks the initial root session only. Once a daemon session
  // exists, structural operations (split/new window) may optimistically select
  // their newly allocated key before topology reports it. Hiding the whole
  // existing mux during that gap unmounts every retained WTerm host, briefly
  // gives it a 0×0 rectangle, and forces WTerm to rebuild its DOM grid when the
  // response arrives. Keep the existing session mounted until the structural
  // snapshot includes the new pane/window.
  const pendingMuxKey = Boolean(
    activeKey && pendingMuxKeysRef.current.has(activeKey) && topology.length === 0,
  );
  const muxSession = pendingMuxKey
    ? undefined
    : (topology.find((session) => session.sessionId === topologySnapshot.activeSessionId) ??
      topology.find((session) =>
        session.windows.some((window) => window.panes.some((pane) => pane.key === activeKey)),
      ) ??
      // A daemon lifecycle operation can remove the selected key before Zustand
      // commits the survivor selected by the daemon. In that short interval the
      // topology remains authoritative: render its first session so the
      // selection effect below can adopt the survivor rather than disabling every
      // structural control. A newly requested logical tab instead mounts its own
      // renderer and opens its daemon session before active-session restoration
      // is allowed to choose an existing view.
      topology[0]);
  const muxWindows = muxSession ? orderedMuxWindows(muxSession) : [];
  const activeWindow =
    muxWindows.find((window) => window.windowId === muxSession?.activeWindowId) ?? muxWindows[0];
  const activeMuxPane = muxWindows
    .flatMap((window) => window.panes)
    .find((pane) => pane.key === activeKey);
  const activePaneId = activeWindow?.activePaneId ?? activeWindow?.panes[0]?.paneId ?? null;
  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeWindow) return;
    const daemonActivePane =
      activeWindow.panes.find((pane) => pane.paneId === activeWindow.activePaneId) ??
      activeWindow.panes[0];
    // Closing the final pane removes the renderer tab asynchronously while the
    // daemon collapses and reports its next selected pane. If those updates
    // cross, retain the daemon's authoritative selection rather than leaving a
    // visible pane with a stale tab key and disabled structural controls.
    if (daemonActivePane && daemonActivePane.key !== activeKey) setActive(daemonActivePane.key);
  }, [activeKey, activeWindow, backend, setActive]);
  // A restored topology can already agree with Zustand's active key on the
  // first render, so XtermView never observes a visible=false → true edge and
  // its local focus-on-visible hook has nothing to do. Reassert the daemon's
  // selected pane after the host has committed: reload/relaunch must restore
  // real keyboard ownership, not merely the highlighted pane metadata.
  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId || !activeWindow) return;
    const pane =
      activeWindow.panes.find((candidate) => candidate.paneId === activeWindow.activePaneId) ??
      activeWindow.panes[0];
    if (!pane || retiredMuxKeysRef.current.has(pane.key)) return;
    const frame = requestAnimationFrame(() => registry.focusEntry(activeId, 'terminal', pane.key));
    // Dockview's tab click completes after the child panel commits. Reassert
    // once after that click so the tab itself cannot remain the active element
    // when a restored single-pane window has no subsequent selection event.
    const settle = window.setTimeout(() => registry.focusEntry(activeId, 'terminal', pane.key), 75);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [activeId, activeKey, activeWindow, backend]);
  const muxSessionRef = useRef(muxSession);
  const activeWindowRef = useRef(activeWindow);
  const activePaneIdRef = useRef(activePaneId);
  const pendingMuxSelectionRef = useRef<{ windowId: string; paneId: string | null } | null>(null);
  const pendingSelection = pendingMuxSelectionRef.current;
  const pendingTargetExists =
    pendingSelection &&
    muxSession?.windows.some(
      (window) =>
        window.windowId === pendingSelection.windowId &&
        (pendingSelection.paneId === null ||
          window.panes.some((pane) => pane.paneId === pendingSelection.paneId)),
    );
  if (
    pendingSelection &&
    ((activeWindow?.windowId === pendingSelection.windowId &&
      activeWindow.activePaneId === pendingSelection.paneId) ||
      !pendingTargetExists)
  ) {
    // The daemon topology either confirmed the optimistic target or removed it
    // (for example, after its window was closed). In both cases the refs must
    // resume following authoritative topology before the next toolbar action.
    pendingMuxSelectionRef.current = null;
  }
  muxSessionRef.current = muxSession;
  // A Zustand active-key render can occur before React commits the topology
  // response. Do not let that stale topology overwrite the next keyboard
  // navigation target; it is confirmed or cleared just above.
  if (!pendingMuxSelectionRef.current) {
    activeWindowRef.current = activeWindow;
    activePaneIdRef.current = activePaneId;
    const activeMuxKey = activeWindow?.panes.find((pane) => pane.paneId === activePaneId)?.key;
    // A topology refresh may briefly report no active pane while the daemon is
    // applying a resize. Keep the last valid key so a shortcut remains a real
    // mux operation rather than silently becoming a no-op in that transition.
    if (activeMuxKey) activeMuxKeyRef.current = activeMuxKey;
  }
  const refreshTopology = useCallback((): void => {
    if (!activeId || backend !== 'cockpit-mux') return;
    void agentCockpit.muxSessions
      .topology(activeId)
      .then((sessions) => void commitTopology(activeId, sessions))
      .catch(() => {});
  }, [activeId, backend, commitTopology]);
  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId) return;
    let cancelled = false;
    const refreshExternalTopology = (): void => {
      void agentCockpit.muxSessions
        .topology(activeId)
        .then((snapshot) => {
          if (!cancelled) commitTopology(activeId, snapshot);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(refreshExternalTopology, MUX_TOPOLOGY_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeId, backend, commitTopology]);
  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId) return;
    const onTerminalOpened = (event: Event): void => {
      const detail = (event as CustomEvent<registry.TerminalOpenedDetail>).detail;
      if (detail.projectId !== activeId || detail.kind !== 'terminal') return;
      // A root logical-session create reserves its renderer key before its
      // daemon identity exists. Once that view has opened, allow the topology
      // snapshot to adopt it; keeping the reservation forever leaves every
      // structural control disabled despite a healthy daemon pane.
      pendingMuxKeysRef.current.delete(detail.key);
      ensuringMuxRootRef.current = false;
      void agentCockpit.muxSessions
        .topology(activeId)
        .then((snapshot) => {
          if (!commitTopology(activeId, snapshot)) return;
          const selectedSession = snapshot.sessions.find(
            (session) => session.sessionId === snapshot.activeSessionId,
          );
          const selectedWindow = selectedSession?.windows.find(
            (window) => window.windowId === selectedSession.activeWindowId,
          );
          const selectedPane = selectedWindow?.panes.find(
            (pane) => pane.paneId === selectedWindow.activePaneId,
          );
          // A restored root can finish opening after the first topology render.
          // Focus only when this newly ready terminal remains selected, so a
          // slow hidden sibling never steals user input.
          if (selectedPane?.key === detail.key) {
            requestAnimationFrame(() => registry.focusEntry(activeId, 'terminal', detail.key));
          }
        })
        .catch(() => {});
    };
    window.addEventListener(registry.TERMINAL_OPENED_EVENT, onTerminalOpened);
    return () => window.removeEventListener(registry.TERMINAL_OPENED_EVENT, onTerminalOpened);
  }, [activeId, backend, commitTopology]);
  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId || !activeKey) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refreshUntilActivePane = (): void => {
      void agentCockpit.muxSessions
        .topology(activeId)
        .then((snapshot) => {
          if (cancelled) return;
          commitTopology(activeId, snapshot);
          const ready = snapshot.sessions.some((session) =>
            session.windows.some((window) => window.panes.some((pane) => pane.key === activeKey)),
          );
          // Initial terminal.open and a restored WTerm complete after the
          // panel's first topology fetch. Keep the structural controls disabled
          // until that daemon identity is available instead of accepting a
          // stale renderer key as a split/window source.
          if (!ready && attempts++ < 10) timer = setTimeout(refreshUntilActivePane, 50);
        })
        .catch(() => {
          if (!cancelled && attempts++ < 10) timer = setTimeout(refreshUntilActivePane, 50);
        });
    };
    refreshUntilActivePane();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeId, activeKey, backend, commitTopology]);
  const selectPane = useCallback(
    (window: MuxTopologyWindow, pane: MuxTopologyPane): void => {
      const session =
        topology.find((candidate) =>
          candidate.windows.some(
            (candidateWindow) =>
              candidateWindow.windowId === window.windowId &&
              candidateWindow.panes.some((candidatePane) => candidatePane.paneId === pane.paneId),
          ),
        ) ?? muxSessionRef.current;
      if (!session || !activeId) return;
      // Keyboard commands can arrive before React commits the topology response.
      // Advance the navigation refs synchronously so a rapid second direction uses
      // the pane just selected rather than the stale source pane.
      activeWindowRef.current = window;
      activePaneIdRef.current = pane.paneId;
      activeMuxKeyRef.current = pane.key;
      pendingMuxSelectionRef.current = { windowId: window.windowId, paneId: pane.paneId };
      void agentCockpit.muxSessions
        .selectPane(activeId, session.sessionId, window.windowId, pane.paneId)
        .then((sessions) => {
          if (commitTopology(activeId, sessions) && !retiredMuxKeysRef.current.has(pane.key)) {
            setActive(pane.key, activeId);
            // The DOM focus owner is independent of the daemon selection and
            // can remain on the old xterm when every split stays visible.
            // Move it only after the authoritative snapshot committed, so a
            // keyboard traversal always targets the pane the daemon selected.
            requestAnimationFrame(() => registry.focusEntry(activeId, 'terminal', pane.key));
          }
        })
        .catch(() => {
          pendingMuxSelectionRef.current = null;
          refreshTopology();
        });
    },
    [activeId, commitTopology, refreshTopology, setActive, topology],
  );
  const selectWindow = useCallback(
    (window: MuxTopologyWindow): void => {
      const session =
        topology.find((candidate) =>
          candidate.windows.some((candidateWindow) => candidateWindow.windowId === window.windowId),
        ) ?? muxSessionRef.current;
      if (!session || !activeId) return;
      activeWindowRef.current = window;
      if (window.activePaneId) activePaneIdRef.current = window.activePaneId;
      const activeMuxKey = window.panes.find((pane) => pane.paneId === window.activePaneId)?.key;
      if (activeMuxKey) activeMuxKeyRef.current = activeMuxKey;
      pendingMuxSelectionRef.current = {
        windowId: window.windowId,
        paneId: window.activePaneId,
      };
      void agentCockpit.muxSessions
        .selectWindow(activeId, session.sessionId, window.windowId)
        .then((snapshot) => {
          if (!commitTopology(activeId, snapshot)) return;
          const selected = snapshot.sessions
            .find((item) => item.sessionId === session.sessionId)
            ?.windows.find((item) => item.windowId === window.windowId);
          const pane = selected?.panes.find((item) => item.paneId === selected.activePaneId);
          if (pane && !retiredMuxKeysRef.current.has(pane.key)) {
            setActive(pane.key, activeId);
            requestAnimationFrame(() => registry.focusEntry(activeId, 'terminal', pane.key));
          }
        })
        .catch(() => {
          pendingMuxSelectionRef.current = null;
          refreshTopology();
        });
    },
    [activeId, commitTopology, refreshTopology, setActive, topology],
  );
  const reserveMuxKey = useCallback((): string => {
    // The tab store commits independently from a daemon topology response.
    // Structural shortcuts must not reuse a just-created key during that gap.
    const topologyKeys =
      muxSessionRef.current?.windows.flatMap((window) => window.panes.map((pane) => pane.key)) ??
      [];
    const known = new Set([
      ...keysRef.current,
      ...topologyKeys,
      ...pendingMuxKeysRef.current,
      ...issuedMuxKeysRef.current,
      ...retiredMuxKeysRef.current,
    ]);
    // The mux protocol has historically used t<digits> keys. Keep that
    // interoperable shape while making each renderer-created key effectively
    // non-reusable across reloads and main-process retained-key state.
    let key = `t${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    while (known.has(key)) key = `t${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
    pendingMuxKeysRef.current.add(key);
    issuedMuxKeysRef.current.add(key);
    return key;
  }, []);
  const startMuxRoot = useCallback((): void => {
    if (!activeId || ensuringMuxRootRef.current) return;
    // A topology response may be in flight while the root is attached. The
    // reserved key is the durable local claim that prevents a second response
    // from opening a duplicate default shell.
    if (topologySnapshotRef.current.sessions.length > 0 || pendingMuxKeysRef.current.size > 0)
      return;
    ensuringMuxRootRef.current = true;
    const key = reserveMuxKey();
    registry.allowMuxCreate(activeId, key);
    add(key);
  }, [activeId, add, reserveMuxKey]);
  startMuxRootRef.current = startMuxRoot;
  const currentMuxSource = useCallback((): string | null => {
    const window = activeWindowRef.current;
    const paneId = activePaneIdRef.current;
    // Prefer the latest daemon topology over the renderer tab state. The latter
    // may lag a just-completed pane/window selection by one React commit.
    const selected = window?.panes.find((pane) => pane.paneId === paneId)?.key;
    const candidate = selected ?? activeMuxKeyRef.current;
    if (
      candidate &&
      topology.some((session) =>
        session.windows.some((item) => item.panes.some((pane) => pane.key === candidate)),
      )
    ) {
      return candidate;
    }
    return activeMuxPane?.key ?? null;
  }, [activeMuxPane?.key, topology]);
  const createMuxSplit = useCallback(
    (direction: 'horizontal' | 'vertical'): void => {
      // The daemon-owned selection is authoritative in mux mode. In particular,
      // do not let a stale renderer tab key turn a shortcut into an IPC request
      // for a pane that was never created by the mux.
      const sourceId = currentMuxSource();
      if (!sourceId) return;
      const key = reserveMuxKey();
      const splitWhenReady = async (): Promise<void> => {
        try {
          const id = await agentCockpit.terminal.split(
            sourceId,
            key,
            direction,
            activeId ?? undefined,
          );
          if (!activeId || useProjectsStore.getState().activeId !== activeId) return;
          activeMuxKeyRef.current = id;
          addExisting(id, activeId);
          const snapshot = await agentCockpit.muxSessions.topology(activeId).catch(() => null);
          if (!snapshot) {
            // The structural mutation already succeeded. A transient catalog
            // read must not repeat it and create a duplicate pane.
            refreshTopology();
            return;
          }
          if (useProjectsStore.getState().activeId !== activeId) return;
          const created = snapshot.sessions
            .flatMap((session) => session.windows.map((window) => ({ session, window })))
            .find(({ window }) => window.panes.some((pane) => pane.key === id));
          const createdPane = created?.window.panes.find((pane) => pane.key === id);
          // A structural operation creates the pane as selected in the daemon.
          // Reaffirm that selection after its asynchronous renderer attachment:
          // otherwise an older focused pane can win a late client-side selection
          // callback between `pane.split` and this topology reconciliation.
          // The returned snapshot also commits layout and selection together.
          const selected =
            created && createdPane
              ? await agentCockpit.muxSessions.selectPane(
                  activeId,
                  created.session.sessionId,
                  created.window.windowId,
                  createdPane.paneId,
                )
              : snapshot;
          if (useProjectsStore.getState().activeId !== activeId) return;
          if (created && createdPane) {
            activeWindowRef.current = created.window;
            activePaneIdRef.current = createdPane.paneId;
            pendingMuxSelectionRef.current = {
              windowId: created.window.windowId,
              paneId: createdPane.paneId,
            };
          }
          commitTopology(activeId, selected);
        } catch (error) {
          // A split RPC may have created a daemon pane before its attachment
          // failed. Never repeat a structural mutation against the same key;
          // the manager retains that durable identity and retries attachment.
          console.error('Cockpit mux split failed', error);
          refreshTopology();
        } finally {
          pendingMuxKeysRef.current.delete(key);
        }
      };
      void splitWhenReady();
    },
    [activeId, addExisting, commitTopology, currentMuxSource, refreshTopology, reserveMuxKey],
  );
  const createMuxWindow = useCallback((): void => {
    if (!activeId) return;
    const sourceId = currentMuxSource();
    if (!sourceId) return;
    const key = reserveMuxKey();
    void agentCockpit.terminal
      .newWindow(sourceId, key, activeId)
      .then((id) => {
        if (useProjectsStore.getState().activeId !== activeId) return;
        activeMuxKeyRef.current = id;
        addExisting(id, activeId);
        return agentCockpit.muxSessions.topology(activeId).then((snapshot) => {
          if (useProjectsStore.getState().activeId !== activeId) return;
          if (!commitTopology(activeId, snapshot)) return;
          const sessions = topologySnapshotRef.current.sessions;
          const session = sessions.find((item) =>
            item.windows.some((window) => window.panes.some((pane) => pane.key === id)),
          );
          const window =
            session?.windows.find((item) => item.windowId === session.activeWindowId) ??
            session?.windows[0];
          const pane = window?.panes.find((item) => item.key === id);
          if (session && window && pane) {
            // A keyboard traversal can arrive before React commits addExisting.
            // Advance the same refs used by its handler from the authoritative
            // new-window topology, not from the previous window.
            muxSessionRef.current = session;
            activeWindowRef.current = window;
            activePaneIdRef.current = pane.paneId;
          }
        });
      })
      .catch((error: unknown) => {
        console.error('Cockpit mux new window failed', error);
        refreshTopology();
      })
      .finally(() => pendingMuxKeysRef.current.delete(key));
  }, [activeId, addExisting, commitTopology, currentMuxSource, refreshTopology, reserveMuxKey]);

  const closeMuxWindow = useCallback((): void => {
    const projectId = activeId ?? useProjectsStore.getState().activeId;
    // Window selection and tab-state commits are deliberately asynchronous.
    // A ref is valid only while it still names a window in the current daemon
    // topology. A just-closed pane can otherwise leave it aimed at a removed
    // logical session, making the next close mutate an invisible window.
    const referencedSession = muxSessionRef.current;
    const referencedWindow = activeWindowRef.current;
    const session =
      (referencedSession &&
        referencedWindow &&
        topology.find(
          (candidate) =>
            candidate.sessionId === referencedSession.sessionId &&
            candidate.windows.some(
              (candidateWindow) => candidateWindow.windowId === referencedWindow.windowId,
            ),
        )) ||
      muxSession;
    const window =
      session?.windows.find((candidate) => candidate.windowId === referencedWindow?.windowId) ??
      activeWindow;
    if (!projectId || !session || !window) return;
    const closingKeys = new Set<string>();
    void (async () => {
      // Resolve the final target from daemon state immediately before its
      // atomic mutation. The tab store can remove a just-closed pane before
      // React has committed the corresponding topology response; in that gap
      // refs identify an old logical session while the daemon selection is
      // already authoritative.
      const currentSnapshot = await agentCockpit.muxSessions.topology(projectId);
      const currentTopology = currentSnapshot.sessions;
      // This is a destructive operation. The toolbar click captured one exact
      // daemon window; if it disappeared while the fresh topology request was
      // in flight, reconcile the UI and deliberately do nothing. Falling back
      // to the active or first survivor would close a different window than
      // the one the user selected.
      const target = muxWindowCloseTarget(currentTopology, session.sessionId, window.windowId);
      if (!target) {
        commitTopology(projectId, currentSnapshot);
        return undefined;
      }
      const targetPanes = target.window.panes;
      for (const pane of targetPanes) {
        closingKeys.add(pane.key);
        closingMuxKeysRef.current.add(pane.key);
        retiredMuxKeysRef.current.add(pane.key);
      }
      // Close the whole daemon window atomically. Its manager quiesces every
      // output poll before this lifecycle RPC, avoiding a renderer request
      // queue that can otherwise strand a single-pane destroy behind a stale
      // stream. The response is the authoritative survivor topology.
      const finalSnapshot = await agentCockpit.muxSessions.destroyWindow(
        projectId,
        target.session.sessionId,
        target.window.windowId,
      );
      // Preserve live renderers until the atomic daemon mutation succeeds; its
      // response is the guaranteed survivor catalog. A later best-effort read
      // may refine it, but must never gate local disposal.
      return { snapshot: finalSnapshot, targetPanes };
    })()
      .then((result) => {
        if (!result) return;
        const { snapshot, targetPanes } = result;
        if (useProjectsStore.getState().activeId !== projectId) {
          for (const pane of targetPanes) registry.dispose(projectId, 'terminal', pane.key);
          return;
        }
        // A background topology read may have committed the same post-close
        // state at a higher revision before this mutation response is
        // delivered. Always select from the newest accepted snapshot; do not
        // let a rejected older response leave the closed key active.
        // This snapshot is read after the daemon's atomic destroy completed.
        // It is the lifecycle boundary for this renderer transaction and must
        // replace any older queued inspection immediately.
        commitTopology(projectId, snapshot);
        const sessions = topologySnapshotRef.current.sessions;
        const survivingSession =
          sessions.find((candidate) => candidate.sessionId === session?.sessionId) ?? sessions[0];
        const survivingWindow =
          survivingSession?.windows.find(
            (candidate) => candidate.windowId === survivingSession.activeWindowId,
          ) ?? survivingSession?.windows[0];
        const survivingPane =
          survivingWindow?.panes.find(
            (candidate) => candidate.paneId === survivingWindow.activePaneId,
          ) ?? survivingWindow?.panes[0];
        // Select the survivor before removing the obsolete tabs. Zustand and
        // React can now publish one coherent state transition rather than
        // briefly rendering the closed key as a legacy fallback terminal.
        if (survivingPane) setActive(survivingPane.key, projectId);
        for (const pane of targetPanes) {
          registry.dispose(projectId, 'terminal', pane.key);
          remove(pane.key, projectId);
        }
        // Cmd/Ctrl+W may destroy the final mux window. Match the established
        // tmux dock behavior by immediately creating a fresh default-shell
        // root instead of exposing an empty terminal panel.
        if (sessions.length === 0) startMuxRootRef.current();
        // Terminal-exit and navigation callbacks queued before the destroy can
        // still run after this microtask. Reconcile once their turn has drained
        // from the renderer queue, always deriving the visible pane from the
        // daemon's post-close catalog.
        globalThis.setTimeout(() => {
          void agentCockpit.muxSessions
            .topology(projectId)
            .then((settled) => {
              if (useProjectsStore.getState().activeId !== projectId) return;
              commitTopology(projectId, settled);
              const accepted = topologySnapshotRef.current;
              const settledSession =
                accepted.sessions.find((candidate) => candidate.sessionId === session?.sessionId) ??
                accepted.sessions[0];
              const settledWindow =
                settledSession?.windows.find(
                  (candidate) => candidate.windowId === settledSession.activeWindowId,
                ) ?? settledSession?.windows[0];
              const settledPane =
                settledWindow?.panes.find(
                  (candidate) => candidate.paneId === settledWindow.activePaneId,
                ) ?? settledWindow?.panes[0];
              if (settledPane && !retiredMuxKeysRef.current.has(settledPane.key))
                setActive(settledPane.key, projectId);
            })
            .catch(() => {});
        }, 0);
      })
      .catch((error: unknown) => {
        // Closing is destructive, so retain the failure in Diagnostics instead
        // of silently restoring the unchanged topology and leaving the user to
        // infer that the action was ignored.
        console.error('Cockpit mux close window failed', error);
        refreshTopology();
      })
      .finally(() => {
        for (const key of closingKeys) closingMuxKeysRef.current.delete(key);
      });
  }, [
    activeId,
    activeWindow,
    commitTopology,
    muxSession,
    refreshTopology,
    remove,
    setActive,
    topology,
  ]);

  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId) return;
    return agentCockpit.events.onTerminalExit((event) => {
      if (event.projectId !== activeId) return;
      if (closingMuxKeysRef.current.has(event.terminalId)) return;
      if (shouldRetainTerminalAfterExit(event.info.signal)) {
        // Recovery has already seeded this terminal from the daemon's retained
        // screen. Keep its renderer mounted as a read-only snapshot: topology
        // still owns the pane, and disposing its keyed view would leave that
        // mounted pane blank without a new acquire edge.
        return;
      }
      // A normal child exit is a mux lifecycle event, not a tab that can be
      // reattached. Dispose before the key can be reused for a new pane.
      // Commit the daemon topology before disposing the renderer. Otherwise a
      // stale layout can remount this stable key between dispose and remove,
      // which opens an unintended new root mux session.
      void agentCockpit.muxSessions
        .topology(activeId)
        .then((snapshot) => {
          // This completion belongs to the captured project. A user may have
          // activated another project while its daemon topology was loading;
          // never replace that project's visible topology with a background
          // exit result.
          if (useProjectsStore.getState().activeId === activeId) {
            commitTopology(activeId, snapshot);
            if (interactiveTopology(snapshot).sessions.length === 0) startMuxRootRef.current();
          }
          registry.dispose(activeId, 'terminal', event.terminalId);
          remove(event.terminalId, activeId);
        })
        .catch(() => {
          registry.dispose(activeId, 'terminal', event.terminalId);
          remove(event.terminalId, activeId);
        });
    });
  }, [activeId, backend, commitTopology, remove]);

  const toggleMuxZoom = useCallback((): void => {
    const projectId = activeId;
    // Keyboard events may arrive between the daemon response and React's
    // render commit. The ref is advanced synchronously by commitTopology, so
    // derive zoom state from it rather than a callback closure that can still
    // describe the preceding unzoomed window.
    const snapshot = topologySnapshotRef.current;
    const priorSession = muxSessionRef.current;
    const session =
      snapshot.sessions.find((candidate) => candidate.sessionId === priorSession?.sessionId) ??
      snapshot.sessions.find((candidate) => candidate.sessionId === snapshot.activeSessionId) ??
      priorSession;
    const priorWindow = activeWindowRef.current;
    const window =
      session?.windows.find((candidate) => candidate.windowId === priorWindow?.windowId) ??
      session?.windows.find((candidate) => candidate.windowId === session?.activeWindowId) ??
      priorWindow;
    const paneId = window?.activePaneId ?? activePaneIdRef.current;
    if (!projectId || !session || !window || !paneId) return;
    void agentCockpit.muxSessions
      .zoomPane(projectId, session.sessionId, window.windowId, window.zoomedPaneId ? null : paneId)
      .then((snapshot) => void commitTopology(projectId, snapshot))
      .catch(() => refreshTopology());
  }, [activeId, commitTopology, refreshTopology]);

  useEffect(
    () => () => {
      if (byobuTimerRef.current) window.clearTimeout(byobuTimerRef.current);
      byobuTimerRef.current = null;
      byobuArmedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    if (backend !== 'cockpit-mux' || !activeId) return;
    const consume = (event: KeyboardEvent): void => {
      event.preventDefault();
      // WTerm also observes capture-phase events. Stop sibling listeners here,
      // not merely bubbling, so a mux command can never become terminal input.
      event.stopImmediatePropagation();
    };
    const disarmByobu = (): void => {
      byobuArmedRef.current = false;
      if (byobuTimerRef.current) window.clearTimeout(byobuTimerRef.current);
      byobuTimerRef.current = null;
    };
    const armByobu = (): void => {
      disarmByobu();
      byobuArmedRef.current = true;
      byobuTimerRef.current = window.setTimeout(disarmByobu, 2_000);
    };
    const movePane = (direction: PaneDirection): void => {
      const window = activeWindowRef.current;
      const paneId = activePaneIdRef.current;
      if (!window || !paneId) return;
      const returnKey = `${window.windowId}:${paneId}:${direction}`;
      const rememberedPaneId = muxDirectionalReturnsRef.current.get(returnKey);
      const target =
        window.panes.find((pane) => pane.paneId === rememberedPaneId) ??
        adjacentMuxPane(window.layout, window.panes, paneId, direction);
      if (!target) return;
      muxDirectionalReturnsRef.current.set(
        `${window.windowId}:${target.paneId}:${oppositePaneDirection(direction)}`,
        paneId,
      );
      selectPane(window, target);
    };
    const moveWindow = (delta: -1 | 1): void => {
      const session = muxSessionRef.current;
      const window = activeWindowRef.current;
      if (!session || !window) return;
      const windows = orderedMuxWindows(session);
      const index = windows.findIndex((item) => item.windowId === window.windowId);
      if (index < 0 || windows.length < 2) return;
      const target = windows[(index + delta + windows.length) % windows.length];
      if (target) selectWindow(target);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!isTerminalKeyboardTarget(event.target)) {
        // Never let a delayed prefix consume keys in settings, dialogs, or
        // other panels after focus has left the terminal surface.
        disarmByobu();
        return;
      }
      const result = reduceMuxKeyboard(
        event,
        { byobuArmed: byobuArmedRef.current },
        {
          isMac: navigator.platform.toUpperCase().includes('MAC'),
          byobuKeybindings: useSettingsStore.getState().settings.byobuKeybindings,
        },
      );
      if (!result.consume) return;
      consume(event);
      if (result.nextState.byobuArmed) armByobu();
      else disarmByobu();
      switch (result.action?.type) {
        case 'pane.move':
          movePane(result.action.direction);
          break;
        case 'window.move':
          moveWindow(result.action.delta);
          break;
        case 'window.new':
          // Cmd/Ctrl+T must create a daemon window, not a renderer-only tab.
          createMuxWindow();
          break;
        case 'pane.split':
          createMuxSplit(result.action.direction);
          break;
        case 'window.close':
          closeMuxWindow();
          break;
        case 'pane.zoom.toggle':
          toggleMuxZoom();
          break;
        case 'pane.sendCtrlA': {
          const terminalKey = activeMuxKeyRef.current;
          if (terminalKey)
            void agentCockpit.terminal
              .write(terminalKey, '\x01', 'input', activeId)
              .catch(() => {});
          break;
        }
      }
    };
    const onFocusIn = (event: FocusEvent): void => {
      if (!isTerminalKeyboardTarget(event.target)) disarmByobu();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focusin', onFocusIn, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('focusin', onFocusIn, true);
    };
  }, [
    activeId,
    backend,
    closeMuxWindow,
    createMuxSplit,
    createMuxWindow,
    selectPane,
    selectWindow,
    toggleMuxZoom,
  ]);

  if (!activeId) {
    return <EmptyState title="No active project" hint="Select a project to start a terminal." />;
  }

  // Reset the active tab: detach the host PTY, then re-acquire to reattach the
  // tmux session fresh (token bump must follow the await so re-open happens after
  // the old node-pty is gone, not alongside it).
  const resetActive = async (): Promise<void> => {
    if (!activeKey) return;
    await registry.reset(activeId, 'terminal', activeKey);
    setResetTokens((t) => ({ ...t, [activeKey]: (t[activeKey] ?? 0) + 1 }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-terminal-shortcut-scope>
      <TabbedPanelHeader
        tabs={
          <>
            {backend === 'cockpit-mux' && muxSession
              ? muxWindows.map((window, index) => (
                  <div
                    key={window.windowId}
                    onClick={() => selectWindow(window)}
                    className={cn(
                      'group flex cursor-pointer items-center gap-1 border-t-2 px-2.5 py-1 text-xs',
                      window.windowId === activeWindow?.windowId
                        ? 'border-accent bg-bg text-fg'
                        : 'border-transparent text-dim hover:bg-elev hover:text-fg',
                    )}
                  >
                    <span>Window {index + 1}</span>
                  </div>
                ))
              : keys.map((k) => (
                  <div
                    key={k}
                    onClick={() => setActive(k)}
                    className={cn(
                      'group flex cursor-pointer items-center gap-1 border-t-2 px-2.5 py-1 text-xs',
                      k === activeKey
                        ? 'border-accent bg-bg text-fg'
                        : 'border-transparent text-dim hover:bg-elev hover:text-fg',
                    )}
                  >
                    <span>{k}</span>
                    {keys.length > 1 && (
                      <span
                        role="button"
                        aria-label={`Close terminal ${k}`}
                        className="opacity-0 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Tear down the renderer instance; store.close kills the session.
                          registry.dispose(activeId, 'terminal', k);
                          void close(k);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </div>
                ))}
            {backend !== 'cockpit-mux' && (
              <IconButton label="New terminal" size="sm" onClick={() => add()}>
                +
              </IconButton>
            )}
          </>
        }
        actions={
          <>
            <IconButton
              label="Reset terminal (reattach session)"
              size="sm"
              disabled={!activeKey}
              onClick={() => void resetActive()}
            >
              ⟳
            </IconButton>
            <Button size="sm" title="Manage sessions" onClick={() => setSessionsOpen(true)}>
              Sessions
            </Button>
          </>
        }
      />
      <SessionsDialog open={sessionsOpen} onOpenChange={setSessionsOpen} />
      <div className="relative min-h-0 flex-1">
        {backend === 'cockpit-mux' && muxSession ? (
          <div className="relative h-full min-h-0">
            {muxWindows.map((window) => {
              const visible = window.windowId === activeWindow?.windowId;
              const panes = window.zoomedPaneId
                ? window.panes.filter((pane) => pane.paneId === window.zoomedPaneId)
                : window.panes;
              return (
                <div
                  key={window.windowId}
                  className="absolute inset-0"
                  // WTerm virtualizes scrollback from its host's layout box. A
                  // display:none window collapses that box to zero and lets a
                  // retained renderer preserve an obsolete virtual range.
                  // Keep previously visited windows measurable but hidden and
                  // non-interactive, so selecting one restores its live screen.
                  style={{
                    display: 'block',
                    visibility: visible ? 'visible' : 'hidden',
                    pointerEvents: visible ? 'auto' : 'none',
                  }}
                  aria-hidden={!visible}
                >
                  <MuxLayout
                    layout={
                      window.zoomedPaneId
                        ? {
                            paneId: window.zoomedPaneId,
                            direction: null,
                            ratio: null,
                            first: null,
                            second: null,
                          }
                        : window.layout
                    }
                    panes={panes}
                    projectId={activeId}
                    activePaneId={window.activePaneId}
                    visible={visible}
                    resetTokens={resetTokens}
                    onSelect={(pane) => {
                      // A direct pane selection begins a new navigation
                      // intent; it must not inherit a branch-return hint
                      // from a previous keyboard route.
                      muxDirectionalReturnsRef.current.clear();
                      selectPane(window, pane);
                    }}
                    onResize={(paneId, ratio) => {
                      void agentCockpit.muxSessions
                        .resizeSplit(activeId, muxSession.sessionId, window.windowId, paneId, ratio)
                        .then((sessions) => void commitTopology(activeId, sessions))
                        .catch(() => {});
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : backend === 'cockpit-mux' && pendingMuxKey && activeKey ? (
          // A newly added mux key must mount once even when another logical
          // session already exists. Its open creates that new daemon session;
          // mounting an unrelated key (especially a retained Run TTY) here
          // would reparent it into the interactive Terminal workspace.
          <div className="absolute inset-0" aria-hidden="false">
            <XtermView
              projectId={activeId}
              terminalKey={activeKey}
              visible
              resetToken={resetTokens[activeKey] ?? 0}
            />
          </div>
        ) : (
          keys.map((k) => (
            <div key={k} className="absolute inset-0">
              <XtermView
                projectId={activeId}
                terminalKey={k}
                visible={k === activeKey}
                resetToken={resetTokens[k] ?? 0}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MuxLayout({
  layout,
  panes,
  projectId,
  activePaneId,
  visible,
  resetTokens,
  onSelect,
  onResize,
  layoutEpoch = JSON.stringify(layout),
}: {
  layout: MuxTopologyLayoutNode | null;
  panes: MuxTopologyPane[];
  projectId: string;
  activePaneId: string | null;
  visible: boolean;
  resetTokens: Record<string, number>;
  onSelect(pane: MuxTopologyPane): void;
  onResize(paneId: string, ratio: number): void;
  /** Stable root-tree signature propagated to every retained leaf. */
  layoutEpoch?: string;
}): JSX.Element {
  if (!layout || layout.paneId) {
    const pane = panes.find((item) => item.paneId === layout?.paneId) ?? panes[0];
    if (!pane) return <div className="h-full bg-bg" />;
    return (
      <div
        data-mux-pane={pane.paneId}
        className={cn(
          // Keep every pane visually distinct in both renderer implementations.
          // The active treatment is a real border rather than a ring, so the
          // available terminal rectangle remains unambiguous when adjacent panes
          // use the same background colour.
          'h-full min-h-0 min-w-0 overflow-hidden border bg-bg',
          pane.paneId === activePaneId ? 'border-accent' : 'border-border',
        )}
        onMouseDown={() => onSelect(pane)}
      >
        <XtermView
          key={pane.key}
          projectId={projectId}
          terminalKey={pane.key}
          visible={visible}
          focusOnVisible={visible && pane.paneId === activePaneId}
          keepLayoutWhenHidden
          layoutEpoch={layoutEpoch}
          resetToken={resetTokens[pane.key] ?? 0}
        />
      </div>
    );
  }
  const direction = layout.direction === 'vertical' ? 'column' : 'row';
  const ratio = layout.ratio ?? 0.5;
  return (
    <div
      className="flex h-full min-h-0 min-w-0 gap-px bg-border"
      style={{ flexDirection: direction }}
    >
      <div className="min-h-0 min-w-0" style={{ flex: `${ratio} 1 0%` }}>
        <MuxLayout
          layout={layout.first}
          panes={panes}
          projectId={projectId}
          activePaneId={activePaneId}
          visible={visible}
          resetTokens={resetTokens}
          onSelect={onSelect}
          onResize={onResize}
          layoutEpoch={layoutEpoch}
        />
      </div>
      <div
        role="separator"
        aria-label="Resize split"
        className={
          direction === 'row'
            ? 'w-1 shrink-0 touch-none select-none cursor-col-resize bg-border hover:bg-accent'
            : 'h-1 shrink-0 touch-none select-none cursor-row-resize bg-border hover:bg-accent'
        }
        onPointerDown={(event) => {
          // Keep receiving the drag after the pointer leaves the narrow divider.
          // Without capture, a horizontal (below-split) drag commonly hands its
          // pointer stream to the terminal beneath it before the window handler
          // observes the final position.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          const divider = event.currentTarget;
          const host = divider.parentElement;
          const targetPaneId = firstLayoutPane(layout.first);
          if (!host || !targetPaneId) return;
          const bounds = host.getBoundingClientRect();
          const move = (pointer: PointerEvent): void => {
            const raw =
              direction === 'row'
                ? (pointer.clientX - bounds.left) / bounds.width
                : (pointer.clientY - bounds.top) / bounds.height;
            if (Number.isFinite(raw))
              divider.style.opacity = raw >= 0.1 && raw <= 0.9 ? '1' : '0.4';
          };
          const up = (pointer: PointerEvent): void => {
            window.removeEventListener('pointermove', move);
            divider.style.opacity = '';
            if (divider.hasPointerCapture(pointer.pointerId))
              divider.releasePointerCapture(pointer.pointerId);
            const raw =
              direction === 'row'
                ? (pointer.clientX - bounds.left) / bounds.width
                : (pointer.clientY - bounds.top) / bounds.height;
            onResize(targetPaneId, Math.max(0.1, Math.min(0.9, raw)));
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up, { once: true });
        }}
      />
      <div className="min-h-0 min-w-0" style={{ flex: `${1 - ratio} 1 0%` }}>
        <MuxLayout
          layout={layout.second}
          panes={panes}
          projectId={projectId}
          activePaneId={activePaneId}
          visible={visible}
          resetTokens={resetTokens}
          onSelect={onSelect}
          onResize={onResize}
          layoutEpoch={layoutEpoch}
        />
      </div>
    </div>
  );
}

function firstLayoutPane(layout: MuxTopologyLayoutNode | null): string | null {
  if (!layout) return null;
  return layout.paneId ?? firstLayoutPane(layout.first) ?? firstLayoutPane(layout.second);
}

/**
 * Resolve the one exact mux window a destructive toolbar action captured.
 * Unlike selection helpers, this deliberately has no active/first fallback:
 * topology changing while a close is in flight must make that action a no-op.
 */
export function muxWindowCloseTarget(
  topology: MuxTopologySession[],
  sessionId: string,
  windowId: string,
): { session: MuxTopologySession; window: MuxTopologyWindow } | null {
  const session = topology.find((candidate) => candidate.sessionId === sessionId);
  const window = session?.windows.find((candidate) => candidate.windowId === windowId);
  return session && window ? { session, window } : null;
}

/**
 * Window IDs are opaque identities. The daemon's `windowOrder` is the only
 * placement relation the UI may use for tabs, fallback, or previous/next
 * navigation. Retain a defensive append-only fallback for a mixed-version
 * daemon that has not yet sent the additive field.
 */
export function orderedMuxWindows(session: MuxTopologySession): MuxTopologyWindow[] {
  const byID = new Map(session.windows.map((window) => [window.windowId, window]));
  const ordered: MuxTopologyWindow[] = [];
  for (const windowID of session.windowOrder) {
    const window = byID.get(windowID);
    if (!window) continue;
    ordered.push(window);
    byID.delete(windowID);
  }
  return [...ordered, ...byID.values()];
}

function oppositePaneDirection(direction: PaneDirection): PaneDirection {
  return ({ left: 'right', right: 'left', up: 'down', down: 'up' } as const)[direction];
}
