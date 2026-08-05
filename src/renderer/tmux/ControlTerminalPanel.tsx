import { useEffect, useRef, useState } from 'react';
import {
  useProjectsStore,
  useSessionStore,
  isConnected,
  isDisconnected,
  logDiagnostic,
} from '../providerClient';
import { useSettingsStore } from '../settings';
import { selectActiveView, useTmuxStore } from './tmuxStore';
import { PaneTree, firstPaneId, paneIds } from './PaneXterm';
import * as paneRegistry from './controlPaneRegistry';
import { FOCUS_TERMINAL_EVENT } from '../terminal/terminalRegistry';
import { readFocus, writeFocus } from '../workspace/focusMemory';
import {
  acquireControlSession,
  controlBridgeReady,
  createTerminalWindow,
  isHiddenWindow,
  nudgeClientSize,
  nudgePaneRows,
  pushClientSize,
  releaseControlSession,
  resetControlSession,
  subscribeReinit,
  syncFromTmux,
} from './controlSession';
import { killWindow as killWindowCmd, renameWindow as renameWindowCmd } from '@shared/tmux';
import { Button, Dialog, EmptyState, IconButton, TabbedPanelHeader, cn } from '../ui';

/**
 * Control-mode terminal surface (flag-gated alternative to the session-per-tab
 * panel). The per-project `tmux -CC` session is the source of truth: tmux windows
 * render as tabs and panes as splits, each pane bound to its own registry-owned
 * xterm. State is namespaced per project and never reset on switch, so revisiting
 * a project shows its windows instantly. Reserved windows (`persistent`, `run-1`)
 * and windows without a layout yet are hidden from the tab strip.
 */
export function ControlTerminalPanel(): JSX.Element {
  const activeId = useProjectsStore((s) => s.activeId);
  const isOpen = useTmuxStore((s) => selectActiveView(s).isOpen);
  const openError = useTmuxStore((s) => selectActiveView(s).openError);
  const providerConnected = useSessionStore(isConnected(activeId));
  const providerDisconnected = useSessionStore(isDisconnected(activeId));
  const windowOrder = useTmuxStore((s) => selectActiveView(s).windowOrder);
  const windows = useTmuxStore((s) => selectActiveView(s).windows);
  const panes = useTmuxStore((s) => selectActiveView(s).panes);
  const storeActivePaneId = useTmuxStore((s) => selectActiveView(s).activePaneId);
  const storeActiveWindowId = useTmuxStore((s) => selectActiveView(s).activeWindowId);
  // Pause-mode (gated): whether the active pane is currently paused by tmux flow
  // control. Drives the resume effect below. Always false unless pause-mode is on.
  const activePanePaused = useTmuxStore((s) => {
    const v = selectActiveView(s);
    return v.activePaneId ? (v.panes[v.activePaneId]?.paused ?? false) : false;
  });
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  // Inline tab rename: the window id being edited (null = none) + its draft text.
  const [editingWindow, setEditingWindow] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [closingWindow, setClosingWindow] = useState<{ id: string; label: string } | null>(null);
  const [bridgeMissing, setBridgeMissing] = useState(false);
  // The pane id created by the most recent split, captured deterministically
  // from the `split-window -P -F '#{pane_id}'` reply. The active-pane
  // resolution effect PREFERS this id (so the new pane gets visual + keyboard
  // focus) once it actually appears in the window's layout, then clears it.
  // Without this, resolution can run before the new pane is in `layout` and
  // falls back to the old pane — the new split gets visual focus but input
  // focus stays on the original (FR4).
  const pendingActivePaneRef = useRef<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** Pending rAF id for the focus-on-(re)open effect; cancelled on cleanup. */
  const focusRafRef = useRef(0);

  // Acquire or release the control session based on provider connection status.
  // - On project switch: invalidate cell-size cache; acquire if provider is connected.
  // - On providerDisconnected: release the control session + reset its state.
  // - On providerConnected (re-acquire after reconnect): acquire fresh.
  // This is the renderer's FR4 implementation: disconnect tears down; reconnect
  // rebuilds. The dependency on providerConnected/providerDisconnected ensures
  // the terminal reacts to connection state, not just project switch.
  useEffect(() => {
    if (!activeId) return;
    if (providerDisconnected) {
      // Provider disconnected: tear down the terminal control session.
      // Dispose the persistent xterm pane instances for this project too. This
      // is load-bearing: resetProject() drops the tmuxStore output sinks, but
      // paneRegistry.acquire() only (re)binds a pane's sink when it CREATES the
      // entry. Without disposing here, a reconnect re-acquires the cached entry,
      // skips bindPaneSink, and the rebuilt session has no sink wired — live
      // %output is dropped (terminal shows nothing) even though input still
      // reaches tmux. Disposing forces acquire() to rebuild + rebind on reconnect.
      paneRegistry.disposeProject(activeId);
      releaseControlSession();
      resetControlSession(activeId); // per-project: never clobber other live projects
      useTmuxStore.getState().resetProject(activeId);
      return;
    }
    if (!providerConnected) {
      // Provider is connecting/reconnecting: do not acquire yet.
      return;
    }
    // Provider is connected: acquire/re-acquire the control session.
    // Invalidate cell-size cache on each project switch so pushClientSize
    // re-measures from the newly active project's panes.
    paneRegistry.invalidateCellSize();
    if (!controlBridgeReady()) {
      setBridgeMissing(true);
      return;
    }
    acquireControlSession(activeId);
    return () => releaseControlSession();
  }, [activeId, providerConnected, providerDisconnected]);

  // Pause-mode (gated): when tmux flow control pauses the active/visible pane,
  // resume it so the foreground pane never stays stalled; background panes stay
  // paused (the intended memory bound) until activated, which re-runs this. No-op
  // unless pause-mode is enabled — panes only ever carry `paused` then.
  useEffect(() => {
    if (!activeId || !activePanePaused) return;
    const pid = useTmuxStore.getState().byProject[activeId]?.activePaneId;
    if (pid) useTmuxStore.getState().resumePane(activeId, pid);
  }, [activeId, storeActivePaneId, activePanePaused]);

  // Ctrl+` (handled in CockpitWorkspace) asks us to focus the active pane.
  useEffect(() => {
    const onFocus = (): void => paneRegistry.focusEntry(activeId, activePaneIdRef.current);
    window.addEventListener(FOCUS_TERMINAL_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_TERMINAL_EVENT, onFocus);
  }, [activeId]);

  // Report the panel size so tmux lays out windows/panes. The push is rAF-
  // throttled so a fast drag-resize collapses to at most one IPC per frame, but
  // the LAST event in a sequence still triggers a trailing push one frame after
  // the burst ends. A window-level `resize` listener is the backstop for
  // transitions (macOS green-button fullscreen) that don't always settle the
  // host RO on the final size.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isOpen) return;
    let rafId: number | null = null;
    const push = (): void => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        pushClientSize(host);
      });
    };
    const ro = new ResizeObserver(push);
    ro.observe(host);
    window.addEventListener('resize', push);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', push);
    };
  }, [isOpen]);

  // On first cold start, the ResizeObserver above fires before any pane has
  // rendered + fit, so getCellSize() returns null and clientCells falls back
  // to the 8x17 default — wrong for any non-default font, so tmux reports a
  // pane width that exceeds what xterm actually renders and the prompt
  // wraps until the user manually resizes. Re-push once the first pane fit
  // populates the real cell metric.
  useEffect(() => {
    return paneRegistry.onCellSizeReady(() => {
      const host = hostRef.current;
      if (host) requestAnimationFrame(() => pushClientSize(host));
    });
  }, []);

  // Restore keyboard focus to the active pane whenever the control session
  // (re)opens OR the active project changes. After a disconnect→reconnect the
  // session is rebuilt (FR4) and after a project switch the panel stays mounted
  // (isOpen unchanged) — in both cases the prior focus is lost and, without
  // this, the user must click the terminal to type. Keyed on activeId too so a
  // switch-back refocuses the project's active pane. Deferred two frames so the
  // (re)built panes have mounted + laid out and the per-project active-pane
  // resolution effect below has settled `activePaneIdRef` before we focus.
  useEffect(() => {
    if (!isOpen) return;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() =>
        paneRegistry.focusEntry(activeIdRef.current, activePaneIdRef.current),
      );
      focusRafRef.current = r2;
    });
    focusRafRef.current = r1;
    return () => {
      if (focusRafRef.current) cancelAnimationFrame(focusRafRef.current);
    };
  }, [isOpen, activeId]);

  // Font setting changes don't resize the panel, but they DO change the cell
  // size — re-push the client size in tmux cells so the pane width matches the
  // new font (otherwise lines wrap because tmux still believes the old cell
  // size). Double rAF gives each pane's appearance effect time to refit first,
  // so getCellSize() reads the new metrics.
  const fontFamily = useSettingsStore((s) => s.settings.fontFamily);
  const fontSize = useSettingsStore((s) => s.settings.fontSize);
  // Read the byobu toggle into a ref so the once-attached key listener (FA-3)
  // sees the live value without re-binding when the setting flips.
  const byobuKeybindings = useSettingsStore((s) => s.settings.byobuKeybindings);
  const byobuRef = useRef(byobuKeybindings);
  byobuRef.current = byobuKeybindings;
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !isOpen) return;
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => pushClientSize(host));
      // Cancel-safety: only the outer id is observable here; the inner runs at
      // most one frame later.
      void id2;
    });
    return () => cancelAnimationFrame(id1);
    // activeId is included so a PROJECT SWITCH re-pushes the client size: on
    // switch the host pixel size and isOpen are unchanged, so neither the host
    // ResizeObserver nor the font effect fires, and tmux would otherwise keep the
    // previous project's pane width while the reattached xterm fits to the current
    // window — a width mismatch that corrupts the display until a manual resize.
    // The double-rAF lets the reattached panes fit (term.cols ready) before
    // clientCells reads them.
  }, [isOpen, fontFamily, fontSize, activeId]);

  // Terminal tabs are every window except the hidden reserved ones and windows
  // that do not have a layout yet (mid-creation): a tab without a layout would
  // otherwise render the empty "No panes yet" body behind a clickable tab.
  const tabWindows = windowOrder.filter(
    (id) => !isHiddenWindow(windows[id]?.name) && windows[id]?.layout != null,
  );
  const currentWindow =
    selectedWindow && tabWindows.includes(selectedWindow) ? selectedWindow : tabWindows[0] ?? null;
  // `layout` stays the FULL layout (drives pane-id resolution + persistence);
  // `renderLayout` is the zoom-aware view tmux reports (a single pane when
  // zoomed). Zoom can be toggled from inside the app or externally — both arrive
  // via %layout-change, so the view always follows tmux (FR1.2).
  const currentWin = currentWindow ? windows[currentWindow] : undefined;
  const layout = currentWin?.layout ?? null;
  const isZoomed = currentWin?.isZoomed ?? false;
  const renderLayout = currentWin?.visibleLayout ?? layout;
  // Show the zoom toggle whenever the window is splittable (>1 pane) or already
  // zoomed (so the lone visible pane still offers an unzoom button — FR1.3).
  const showZoom = paneIds(layout).length > 1 || isZoomed;

  // Track the visible window's active pane. tmux emits two distinct
  // notifications depending on what changed:
  //   - %window-pane-changed: active PANE within a window changed
  //     (split-window, select-pane, click) — drives via storeActivePaneId.
  //   - %session-window-changed: active WINDOW changed (new-window,
  //     select-window) — drives via storeActiveWindowId. Pure window
  //     switches do NOT emit %window-pane-changed.
  // Both windowing notifications can arrive BEFORE the corresponding
  // layout-change, so the effect re-runs on layout/panes/tabWindows
  // updates too — whichever input completes last finishes the focus shift.
  useEffect(() => {
    // First: figure out which window should be visible. The pane's owning
    // window (from store.panes, set by layout-change) wins when known;
    // otherwise fall back to storeActiveWindowId (the case where the
    // active pane id isn't tracked, e.g. just after %session-window-changed
    // before %window-pane-changed for the new window's first pane fires).
    const targetWindow =
      (storeActivePaneId && panes[storeActivePaneId]?.windowId) || storeActiveWindowId;
    if (targetWindow && targetWindow !== currentWindow && tabWindows.includes(targetWindow)) {
      setSelectedWindow(targetWindow);
    }
    // Second: pick the active pane within the (possibly just-switched)
    // window. A just-created split's pane id (captured from the split reply)
    // wins as soon as it appears in the layout — this closes the race where
    // resolution ran before the new pane was laid out and fell back to the old
    // pane, leaving input focus on the original split (FR4). Otherwise prefer
    // tmux's choice, then the current local selection if still in the layout,
    // else fall back to first.
    setActivePaneId((cur) => {
      const pending = pendingActivePaneRef.current;
      if (pending && paneIds(layout).includes(pending)) {
        pendingActivePaneRef.current = null;
        return pending;
      }
      if (storeActivePaneId && paneIds(layout).includes(storeActivePaneId)) {
        return storeActivePaneId;
      }
      if (cur && paneIds(layout).includes(cur)) return cur;
      // Per-project memory: prefer the pane that was active last time this
      // project was open (survives app restart, when tmux state isn't in the
      // store yet), but only if it still exists in the layout.
      const remembered = readFocus('pane', activeId);
      if (remembered && paneIds(layout).includes(remembered)) return remembered;
      return firstPaneId(layout);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, storeActivePaneId, storeActiveWindowId, panes, tabWindows.length, activeId]);

  const activePaneIdRef = useRef<string | null>(activePaneId);
  activePaneIdRef.current = activePaneId;
  const currentWindowRef = useRef<string | null>(currentWindow);
  currentWindowRef.current = currentWindow;
  // Read in effects that run once / on a narrow dep set, so they never re-sync a
  // stale project after a switch.
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;

  // Restore live pane displays after a control-channel (re)attach. A SILENT
  // `-CC` reattach (network/keepalive flap, sleep/wake) keeps the project
  // `connected`, so no status transition fires and nothing else re-seeds the
  // panes or forces tmux to re-emit — the terminal would show its stale buffer
  // until a manual refresh. controlSession fires `subscribeReinit` after the
  // authoritative window sync for a fresh channel epoch; mirror the toolbar HARD
  // refresh (re-seed normal-screen panes from capture-pane so content missed
  // during the drop is recovered + a resize round-trip that SIGWINCHes the apps;
  // alt-screen TUIs are gated to repaint-only inside hardRecoverTab, no runaway
  // scroll). Subscribed once; reads live state via refs. Deferred a frame so any
  // panes mounted by the just-synced layout are acquired into the registry first.
  useEffect(() => {
    return subscribeReinit((projectId) => {
      if (projectId !== activeIdRef.current) return; // only the visible project has mounted panes
      requestAnimationFrame(() => {
        const pid = activeIdRef.current;
        const win = currentWindowRef.current;
        if (!pid || pid !== projectId || !win) return;
        void paneRegistry.hardRecoverTab(pid, win).catch(() => {});
        nudgeClientSize(hostRef.current);
        nudgePaneRows(pid, win);
        logDiagnostic(
          'info',
          'control-terminal',
          `reattach-reseed project=${pid} window=${win} trigger=channel-reattach`,
        );
      });
    });
  }, []);

  // Persist the active pane per project so it can be restored on switch-back /
  // after an app restart. Guarded on layout membership: during a project switch
  // there is a brief window where `activeId` is the new project but
  // `activePaneId` is still the previous project's pane — writing then would
  // store a stale id under the new project's key. Only persist once the pane id
  // belongs to the current project's layout.
  useEffect(() => {
    if (activeId && activePaneId && paneIds(layout).includes(activePaneId)) {
      writeFocus('pane', activeId, activePaneId);
    }
  }, [activeId, activePaneId, layout]);

  // After a structural command (new-window, split-window, select-window,
  // auto-recovery), re-report size and re-sync window/layout state. Focus
  // follows automatically via the %window-pane-changed mirror effect below
  // — tmux selects the new pane on split/new-window by default and emits
  // the event, which the reducer captures into store.activePaneId.
  const afterStructural = (): void => {
    pushClientSize(hostRef.current);
    const pid = activeIdRef.current;
    if (pid) void syncFromTmux(pid);
  };
  const cmd = (args: string): void => {
    void useTmuxStore.getState().command(args).then(afterStructural).catch(() => {});
  };
  // Open a new terminal tab via the single dir-named creation seam (the title
  // defaults to the directory basename and stays put — automatic-rename is off).
  const newWindow = (): void => {
    void createTerminalWindow().then(afterStructural).catch(() => {});
  };
  const target = activePaneId ?? '';

  // Three-tier in-place tab refresh. Both click modes repaint every pane from
  // xterm's OWN buffer (no remount) and force a real client resize round-trip
  // (`nudgeClientSize`) so tmux actually re-emits %output and SIGWINCHes the
  // apps — a same-size push is a tmux no-op, which is why a plain repaint rarely
  // fixed reflow/size desync. The size round-trip starts SYNCHRONOUSLY so it
  // targets the project active at CLICK time. `nudgePaneRows(projectId,
  // windowId)` runs immediately after as the third tier — a per-pane
  // absolute-height resize-pane round-trip — because tmux's layout algorithm
  // propagates a same-axis ±1 row/col client resize to only the FIRST child of
  // a split, so a stacked (top/bottom) split's non-first panes never received
  // the SIGWINCH that makes them visually redraw until this tier was added.
  // The immediately-after placement is load-bearing: rAF callbacks run in
  // registration order and the command channel is FIFO, so it guarantees the
  // per-pane commands execute only after the client-level shrink+restore
  // completes. `hard` (shift-click) additionally re-seeds normal-screen panes
  // from capture-pane for deep desync; alternate-screen panes are left to the
  // resize round-trips' redraw (re-seeding a live TUI would runaway-scroll —
  // gated inside hardRecoverTab), now backed by tier 3's per-pane SIGWINCH too,
  // not just tier 2's (which reaches only the first pane). Emits a structured
  // diagnostic entry — no buffer/screen dump. Full mechanism: see CLAUDE.md
  // "Control-mode tab refresh is three-tier".
  const refreshActiveTab = (hard: boolean): void => {
    const projectId = activeId;
    const windowId = currentWindow;
    if (!projectId || !windowId) return;
    const ids = paneIds(layout);
    if (hard) {
      void paneRegistry.hardRecoverTab(projectId, windowId).catch(() => {});
    } else {
      paneRegistry.recoverTab(projectId, windowId);
    }
    nudgeClientSize(hostRef.current);
    nudgePaneRows(projectId, windowId);
    const sizes = ids.map((id) => {
      const s = paneRegistry.getPaneTermSize(projectId, id);
      return s ? `${id}:${s.cols}x${s.rows}` : `${id}:?`;
    });
    const mode = hard ? 'hard-refresh' : 'manual-refresh';
    logDiagnostic(
      'info',
      'control-terminal',
      `${mode} project=${projectId} window=${windowId} active=${target || '-'} ` +
        `panes=[${sizes.join(',')}] layout=${ids.join('|')} trigger=${mode}`,
    );
  };

  // If the user closes the last terminal tab, the persistent holder keeps tmux
  // alive — open a fresh terminal. Gated on having had a terminal so it does not
  // race the initial window (ensureWindows owns initial creation).
  const ensuringRef = useRef(false);
  const hadTerminalsRef = useRef(false);
  useEffect(() => {
    if (!isOpen) {
      ensuringRef.current = false;
      hadTerminalsRef.current = false;
      return;
    }
    if (tabWindows.length > 0) {
      hadTerminalsRef.current = true;
      ensuringRef.current = false;
    } else if (hadTerminalsRef.current && !ensuringRef.current) {
      ensuringRef.current = true;
      void createTerminalWindow().then(afterStructural).catch(() => {});
    }
  }, [isOpen, tabWindows.length]);

  // Keyboard shortcuts: ⌘T new tab · ⌘D vertical split · ⌘⇧D horizontal split ·
  // ⌘⌥arrow move between splits · ⌘⇧[ / ⌘⇧] previous/next tab.
  useEffect(() => {
    // Split and capture the new pane id from the reply (`-P -F '#{pane_id}'`),
    // recording it as the pending-active pane so the resolution effect moves
    // BOTH visual and keyboard focus to it once it lands in the layout (FR4).
    const splitPane = (dir: 'h' | 'v', tgt: string): void => {
      void useTmuxStore
        .getState()
        .command(`split-window -${dir} -t ${tgt} -P -F '#{pane_id}'`)
        .then((r) => {
          const newId = r.lines[0]?.trim();
          if (newId) pendingActivePaneRef.current = newId;
          afterStructural();
        })
        .catch(() => {});
    };
    const navPane = (flag: 'L' | 'R' | 'U' | 'D'): void => {
      void useTmuxStore
        .getState()
        .command(`select-pane -${flag}`)
        .then(async () => {
          try {
            const r = await useTmuxStore.getState().command('display-message -p "#{pane_id}"');
            const id = r.lines[0]?.trim();
            if (id) setActivePaneId(id);
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    };
    const navTab = (dir: -1 | 1): void => {
      const view = selectActiveView(useTmuxStore.getState());
      const tabs = view.windowOrder.filter(
        (id) => !isHiddenWindow(view.windows[id]?.name) && view.windows[id]?.layout != null,
      );
      const idx = currentWindowRef.current ? tabs.indexOf(currentWindowRef.current) : -1;
      if (idx < 0 || tabs.length === 0) return;
      const next = tabs[(idx + dir + tabs.length) % tabs.length];
      if (next) {
        setSelectedWindow(next);
        void useTmuxStore.getState().command(`select-window -t ${next}`).then(afterStructural).catch(() => {});
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return;
      const tgt = activePaneIdRef.current ?? '';
      if (e.altKey) {
        const dir = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' }[e.key];
        if (dir) {
          e.preventDefault();
          navPane(dir as 'L' | 'R' | 'U' | 'D');
        }
        return;
      }
      if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault();
        navTab(e.code === 'BracketLeft' ? -1 : 1);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        void createTerminalWindow().then(afterStructural).catch(() => {});
      } else if (k === 'd' && !e.shiftKey && tgt) {
        e.preventDefault();
        splitPane('h', tgt);
      } else if (k === 'd' && e.shiftKey && tgt) {
        e.preventDefault();
        splitPane('v', tgt);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Byobu/screen-style keybindings (opt-in, FA-3). Attached ONCE; gated live on
  // byobuRef so toggling the setting takes effect without re-binding. Captured
  // before xterm (capture phase + stopImmediatePropagation) so the Ctrl+a prefix
  // byte never reaches the pane program. Coexists with the ⌘ shortcuts above.
  useEffect(() => {
    let armed = false; // Ctrl+a prefix pending
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    const disarm = (): void => {
      armed = false;
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
    };
    const arm = (): void => {
      armed = true;
      if (armTimer) clearTimeout(armTimer);
      // Auto-disarm after 2s (screen behaviour).
      armTimer = setTimeout(() => {
        armed = false;
        armTimer = null;
      }, 2000);
    };
    const run = (args: string): void =>
      void useTmuxStore.getState().command(args).then(afterStructural).catch(() => {});
    // Move active-window selection by `dir`, wrapping (mirrors the ⌘⇧[ / ] nav).
    const navTab = (dir: -1 | 1): void => {
      const view = selectActiveView(useTmuxStore.getState());
      const tabs = view.windowOrder.filter(
        (id) => !isHiddenWindow(view.windows[id]?.name) && view.windows[id]?.layout != null,
      );
      const idx = currentWindowRef.current ? tabs.indexOf(currentWindowRef.current) : -1;
      if (idx < 0 || tabs.length === 0) return;
      const next = tabs[(idx + dir + tabs.length) % tabs.length];
      if (next) {
        setSelectedWindow(next);
        run(`select-window -t ${next}`);
      }
    };
    const onByobuKey = (e: KeyboardEvent): void => {
      if (!byobuRef.current) return;
      const projectId = activeIdRef.current;
      if (!projectId) return;
      const tgt = activePaneIdRef.current;
      // Shift+Arrow → pane navigation (no prefix). Only when no other modifier
      // is held so it doesn't clash with text selection shortcuts.
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const dir = { ArrowLeft: 'L', ArrowRight: 'R', ArrowUp: 'U', ArrowDown: 'D' }[e.key];
        if (dir) {
          e.preventDefault();
          e.stopImmediatePropagation();
          run(`select-pane -${dir}`);
        }
        return;
      }
      // Armed: this keystroke is the suffix after Ctrl+a. Always consume it.
      if (armed) {
        e.preventDefault();
        e.stopImmediatePropagation();
        disarm();
        const k = e.key.toLowerCase();
        if (k === 'z' && tgt) run(`resize-pane -Z -t ${tgt}`);
        else if (k === 'n') navTab(1);
        else if (k === 'p') navTab(-1);
        else if (k === 'a' && tgt) {
          // Readline escape hatch: send a literal Ctrl+a (0x01) to the shell so
          // beginning-of-line stays reachable while Ctrl+a is the prefix.
          void useTmuxStore.getState().sendInput(projectId, tgt, '\x01').catch(() => {});
        }
        // Any other suffix is swallowed silently (screen behaviour).
        return;
      }
      // Arm on a bare Ctrl+a (no other modifiers).
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === 'a' || e.code === 'KeyA')) {
        e.preventDefault();
        e.stopImmediatePropagation();
        arm();
      }
    };
    window.addEventListener('keydown', onByobuKey, true);
    return () => {
      window.removeEventListener('keydown', onByobuKey, true);
      disarm();
    };
  }, []);

  if (!activeId) {
    return <EmptyState title="No active project" hint="Select a project to start a terminal." />;
  }
  if (bridgeMissing) {
    return (
      <EmptyState
        title="Restart required"
        hint="Restart the app (or the dev server) to enable tmux control mode — the preload bridge changed and cannot hot-reload."
      />
    );
  }
  if (providerDisconnected) {
    return (
      <EmptyState
        title="Disconnected"
        hint="Reconnect to view the terminal."
      />
    );
  }
  if (openError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <span className="text-sm font-medium text-fg">Failed to connect to tmux</span>
        <span className="max-w-xs text-xs text-dim">{openError}</span>
        <button
          type="button"
          className="rounded border border-edge bg-panel-2 px-3 py-1 text-xs text-fg hover:bg-elev"
          onClick={() => {
            if (activeId) acquireControlSession(activeId);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <TabbedPanelHeader
        tabs={
          <>
            {tabWindows.map((id, i) => {
              const w = windows[id];
              const name = w?.name;
              // The title is the tmux WINDOW NAME — stable (automatic-rename off),
              // defaulted to the directory basename at creation, and user-settable
              // by double-click. Fall back to the 1-based index when unnamed. The
              // live SCREEN-title displayName is now hover-only (tooltip), so the
              // tab no longer drifts to the last command.
              const label = name && name !== id ? name : String(i + 1);
              const titleAttr = [
                id,
                name && name !== id ? name : null,
                w?.displayName && w.displayName !== name ? w.displayName : null,
              ]
                .filter(Boolean)
                .join(' · ');
              const commitRename = (): void => {
                const next = editDraft.trim();
                // tmux format-expands rename-window args; escape `#` as `##` so a
                // literal `#` in the user's title isn't read as a format directive.
                if (next && next !== name) cmd(renameWindowCmd(id, next.replace(/#/g, '##')));
                setEditingWindow(null);
              };
              return editingWindow === id ? (
                <input
                  key={id}
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') setEditingWindow(null);
                    e.stopPropagation();
                  }}
                  className="w-24 border-t-2 border-accent bg-bg px-2.5 py-1 text-xs text-fg outline-none"
                />
              ) : (
                <div
                  key={id}
                  title={titleAttr}
                  onClick={() => {
                    setSelectedWindow(id);
                    // Select in tmux so split/pane navigation targets this window.
                    cmd(`select-window -t ${id}`);
                  }}
                  onDoubleClick={() => {
                    setEditDraft(name && name !== id ? name : '');
                    setEditingWindow(id);
                  }}
                  className={cn(
                    'group flex cursor-pointer items-center gap-1 border-t-2 py-1 pl-2.5 pr-1 text-xs',
                    id === currentWindow
                      ? 'border-accent bg-bg text-fg'
                      : 'border-transparent text-dim hover:bg-elev hover:text-fg',
                  )}
                >
                  {label}
                  <button
                    type="button"
                    aria-label={`Force close tab ${label}`}
                    title="Force close (kills every pane in this tab)"
                    onClick={(e) => {
                      e.stopPropagation();
                      setClosingWindow({ id, label });
                    }}
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-sm leading-none outline-none',
                      'hover:bg-elev hover:text-removed focus-visible:ring-2 focus-visible:ring-accent/60',
                      id === currentWindow ? 'opacity-60' : 'opacity-0',
                      'group-hover:opacity-100',
                    )}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <IconButton label="New tmux window" size="sm" onClick={newWindow}>
              +
            </IconButton>
          </>
        }
        actions={
          <>
            <IconButton
              label="Refresh tab: repaint + resize round-trip. Shift-click for a hard refresh (re-seed shell panes from tmux)."
              size="sm"
              disabled={!layout}
              onClick={(e) => refreshActiveTab(e.shiftKey)}
            >
              ⟳
            </IconButton>
            <IconButton label="Kill pane" size="sm" disabled={!target} onClick={() => cmd(`kill-pane -t ${target}`)}>
              ×
            </IconButton>
          </>
        }
      />
      <div ref={hostRef} className="relative min-h-0 flex-1">
        {renderLayout ? (
          <PaneTree
            projectId={activeId}
            node={renderLayout}
            activePaneId={activePaneId}
            onFocusPane={(id) => {
              setActivePaneId(id);
              // Tell tmux too so its active-pane state matches the click;
              // the resulting %window-pane-changed is a no-op via the
              // mirror effect since storeActivePaneId already equals id.
              void useTmuxStore.getState().command(`select-pane -t ${id}`).catch(() => {});
            }}
            showZoom={showZoom}
            isZoomed={isZoomed}
            onZoomPane={(id) => cmd(`resize-pane -Z -t ${id}`)}
          />
        ) : (
          <EmptyState
            title={isOpen ? 'No panes yet' : 'Connecting to tmux…'}
            hint={isOpen ? 'Opening a terminal…' : undefined}
          />
        )}
      </div>
      <Dialog
        open={closingWindow != null}
        onOpenChange={(open) => {
          if (!open) setClosingWindow(null);
        }}
        title="Force close tab"
        description={
          <>
            This immediately kills every pane and process running in{' '}
            <strong className="text-fg">{closingWindow?.label}</strong>, with no chance to save
            unsaved work. This cannot be undone.
            {tabWindows.length <= 1 && ' A new tab will open automatically since this is the last one.'}
          </>
        }
        footer={
          <>
            <Button variant="default" onClick={() => setClosingWindow(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (closingWindow) cmd(killWindowCmd(closingWindow.id));
                setClosingWindow(null);
              }}
            >
              Force Close
            </Button>
          </>
        }
      />
    </div>
  );
}
