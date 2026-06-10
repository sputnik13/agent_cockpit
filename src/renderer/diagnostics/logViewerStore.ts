import { create } from 'zustand';

interface LogViewerState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

export const useLogViewerStore = create<LogViewerState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
