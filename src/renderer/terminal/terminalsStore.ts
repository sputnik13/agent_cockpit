import { create } from 'zustand';
import { agentCockpit, useProjectsStore } from '../providerClient';

/**
 * Per-project terminal tabs. Each key maps to a tmux session
 * (agentCockpit-<projectId>-<key>); the list is restored from the provider on
 * project activation so terminals survive IDE restarts. Switching tabs is
 * purely client-side and does not affect the other IDE panels.
 */
interface TerminalsState {
  keys: string[];
  activeKey: string | null;
  init: () => Promise<void>;
  add: () => void;
  close: (key: string) => Promise<void>;
  setActive: (key: string) => void;
}

function nextKey(keys: string[]): string {
  const set = new Set(keys);
  let n = 1;
  while (set.has(`t${n}`)) n += 1;
  return `t${n}`;
}

export const useTerminalsStore = create<TerminalsState>((set) => ({
  keys: [],
  activeKey: null,

  init: async () => {
    if (!useProjectsStore.getState().activeId) {
      set({ keys: [], activeKey: null });
      return;
    }
    let keys: string[] = [];
    try {
      keys = await agentCockpit.terminal.list();
    } catch {
      keys = [];
    }
    if (keys.length === 0) keys = ['t1'];
    set({ keys, activeKey: keys[0] ?? null });
  },

  add: () =>
    set((s) => {
      const k = nextKey(s.keys);
      return { keys: [...s.keys, k], activeKey: k };
    }),

  close: async (key) => {
    try {
      await agentCockpit.terminal.close(key, true); // kill the tmux session
    } catch {
      /* ignore */
    }
    set((s) => {
      const keys = s.keys.filter((k) => k !== key);
      const activeKey = s.activeKey === key ? (keys[keys.length - 1] ?? null) : s.activeKey;
      return { keys, activeKey };
    });
  },

  setActive: (key) => set({ activeKey: key }),
}));
