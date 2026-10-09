import { create } from 'zustand';
import { agentCockpit, useProjectsStore } from '../providerClient';

/**
 * Per-project terminal tabs. Each key maps to a tmux session
 * (agentCockpit-<projectId>-<key>); the list is restored from the provider on
 * project activation so terminals survive IDE restarts. Switching tabs is
 * purely client-side and does not affect the other IDE panels.
 */
interface TerminalsState {
  projectId: string | null;
  keys: string[];
  activeKey: string | null;
  init: (ensureInitialTerminal?: boolean) => Promise<void>;
  /** Add a terminal tab, optionally with a caller-reserved stable key. */
  add: (key?: string) => string;
  addExisting: (key: string, projectId?: string) => void;
  remove: (key: string, projectId?: string) => void;
  close: (key: string) => Promise<void>;
  setActive: (key: string, projectId?: string) => void;
}

function nextKey(keys: string[]): string {
  const set = new Set(keys);
  let n = 1;
  while (set.has(`t${n}`)) n += 1;
  return `t${n}`;
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  projectId: null,
  keys: [],
  activeKey: null,

  init: async (ensureInitialTerminal = true) => {
    // Capture the selected project before awaiting provider I/O. A late list
    // from a previously selected project must never replace the visible
    // project's tabs.
    const projectId = useProjectsStore.getState().activeId;
    if (!projectId) {
      if (!useProjectsStore.getState().activeId) set({ keys: [], activeKey: null });
      return;
    }
    // An explicit create may happen while this inventory request is in flight.
    // Do not let the older list response erase the new key and strand its mux
    // renderer before it can create the daemon-owned logical session.
    const initialKeys = get().keys;
    const initialActiveKey = get().activeKey;
    let keys: string[] = [];
    try {
      keys = await agentCockpit.terminal.list(projectId);
    } catch {
      keys = [];
    }
    if (useProjectsStore.getState().activeId !== projectId) return;
    if (get().keys !== initialKeys || get().activeKey !== initialActiveKey) return;
    // A newly requested mux pane is published to the tab store before its
    // XtermView has opened the daemon session. In that small interval an empty
    // inventory is not authoritative; applying it would unmount the only view
    // capable of completing the create.
    if (keys.length === 0 && get().keys.length > 0 && get().projectId === projectId) return;
    if (keys.length === 0 && ensureInitialTerminal) keys = ['t1'];
    set({ projectId, keys, activeKey: keys[0] ?? null });
  },

  add: (requestedKey) => {
    let key = '';
    set((s) => {
      key = requestedKey && !s.keys.includes(requestedKey) ? requestedKey : nextKey(s.keys);
      return { projectId: useProjectsStore.getState().activeId, keys: [...s.keys, key], activeKey: key };
    });
    return key;
  },

  addExisting: (key, projectId = useProjectsStore.getState().activeId ?? undefined) => {
    if (projectId && useProjectsStore.getState().activeId !== projectId) return;
    set((s) => ({
      keys: s.keys.includes(key) ? s.keys : [...s.keys, key],
      activeKey: key,
    }));
  },

  remove: (key, projectId = useProjectsStore.getState().activeId ?? undefined) => {
    if (projectId && useProjectsStore.getState().activeId !== projectId) return;
    set((s) => {
      const keys = s.keys.filter((item) => item !== key);
      return {
        keys,
        activeKey: s.activeKey === key ? (keys[keys.length - 1] ?? null) : s.activeKey,
      };
    });
  },

  close: async (key) => {
    const projectId = useProjectsStore.getState().activeId;
    await agentCockpit.terminal.close(key, true, projectId ?? undefined); // kill the mux pane
    // The close is addressed to the project captured above. Do not let its
    // eventual completion remove a same-named tab after the user switches.
    useTerminalsStore.getState().remove(key, projectId ?? undefined);
  },

  setActive: (key, projectId = useProjectsStore.getState().activeId ?? undefined) => {
    if (projectId && useProjectsStore.getState().activeId !== projectId) return;
    set({ activeKey: key });
  },
}));
