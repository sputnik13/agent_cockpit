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
  isHiddenWindow,
  pushClientSize,
  releaseControlSession,
  resetControlSession,
  syncFromTmux,
} from './controlSession';
import { EmptyState, IconButton, cn } from '../ui';

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
  const [selectedWindow, setSelectedWindow] = useState<string | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
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
      resetControlSession();
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
  }, [isOpen, fontFamily, fontSize]);

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
  const target = activePaneId ?? '';

  // Non-destructive in-place tab refresh (FR1–FR3): recover every pane in the
  // active tab (refit + atlas rebuild + repaint from xterm's OWN buffer — no
  // dispose, no capture-pane re-seed, no remount), then push the client size
  // SYNCHRONOUSLY so it targets the project active at CLICK time (a deferred
  // rAF could resize the wrong project after a switch). Emits a structured
  // diagnostic entry — no buffer/screen dump.
  const recoverActiveTab = (): void => {
    const projectId = activeId;
    const windowId = currentWindow;
    if (!projectId || !windowId) return;
    const ids = paneIds(layout);
    paneRegistry.recoverTab(projectId, windowId);
    pushClientSize(hostRef.current);
    const sizes = ids.map((id) => {
      const s = paneRegistry.getPaneTermSize(projectId, id);
      return s ? `${id}:${s.cols}x${s.rows}` : `${id}:?`;
    });
    logDiagnostic(
      'info',
      'control-terminal',
      `manual-refresh project=${projectId} window=${windowId} active=${target || '-'} ` +
        `panes=[${sizes.join(',')}] layout=${ids.join('|')} trigger=manual-refresh`,
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
      void useTmuxStore.getState().command('new-window').then(afterStructural).catch(() => {});
    }
  }, [isOpen, tabWindows.length]);

  // Keyboard shortcuts: ⌘T new tab · ⌘D vertical split · ⌘⇧D horizontal split ·
  // ⌘⌥arrow move between splits · ⌘⇧[ / ⌘⇧] previous/next tab.
  useEffect(() => {
    const run = (args: string): void =>
      void useTmuxStore.getState().command(args).then(afterStructural).catch(() => {});
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
        run('new-window');
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
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-edge bg-panel px-1">
        {tabWindows.map((id, i) => {
          const w = windows[id];
          const name = w?.name;
          // Prefer the SCREEN-title-derived displayName so the tab tracks the
          // active command/cwd; fall back to tmux window name; finally the
          // 1-based tab index when nothing useful is set.
          const label = w?.displayName ?? (name && name !== id ? name : String(i + 1));
          const titleAttr = [
            id,
            name && name !== id ? name : null,
            w?.displayName && w.displayName !== name ? w.displayName : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div
              key={id}
              title={titleAttr}
              onClick={() => {
                setSelectedWindow(id);
                // Select in tmux so split/pane navigation targets this window.
                cmd(`select-window -t ${id}`);
              }}
              className={cn(
                'cursor-pointer border-t-2 px-2.5 py-1 text-xs',
                id === currentWindow
                  ? 'border-accent bg-bg text-fg'
                  : 'border-transparent text-dim hover:bg-elev hover:text-fg',
              )}
            >
              {label}
            </div>
          );
        })}
        <IconButton label="New tmux window" size="sm" onClick={() => cmd('new-window')}>
          +
        </IconButton>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label="Refresh tab (repaint without touching tmux)"
            size="sm"
            disabled={!layout}
            onClick={recoverActiveTab}
          >
            ⟳
          </IconButton>
          <IconButton label="Kill pane" size="sm" disabled={!target} onClick={() => cmd(`kill-pane -t ${target}`)}>
            ×
          </IconButton>
        </div>
      </div>
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
    </div>
  );
}
