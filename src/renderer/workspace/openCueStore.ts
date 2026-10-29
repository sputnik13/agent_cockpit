import { create } from 'zustand';

/**
 * A transient, renderer-only note that a terminal's `cockpit open` was RECORDED but the
 * Content panel was deliberately not shown (the reveal declined: Content is tabbed behind
 * the Terminal, a background tab of the group in use, another group is maximized, or there
 * is no room). `StatusRegion` renders it with a "Show" action so the open is never silent.
 *
 * Deliberately not part of the saved layout or of any persisted setting: it is a cue about
 * what just happened, gone after `OPEN_CUE_MS`, on the next open that DID show the panel,
 * or when the user clicks Show. At most one is kept: a newer decline replaces the older.
 */
export interface OpenCue {
  /** Tells cues apart, so a dismiss timer only clears the cue it was started for. */
  id: number;
  /** The project the open was for; the cue is only shown while it is the active one. */
  projectId: string;
  /** The opened file's name. */
  name: string;
  /** Its path as the open reported it (the tooltip carries it). */
  path: string;
  /** Why Content was not shown (`revealDeclinedReason`). */
  reason: string;
}

/** How long a cue stays before it dismisses itself. */
export const OPEN_CUE_MS = 15_000;

interface OpenCueState {
  cue: OpenCue | null;
  /** Show a cue, replacing any current one, and start its dismiss timer. */
  show: (cue: Omit<OpenCue, 'id'>) => void;
  /** Dismiss the current cue, if any. */
  clear: () => void;
}

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

export const useOpenCueStore = create<OpenCueState>((set, get) => ({
  cue: null,
  show: (cue) => {
    stopTimer();
    const id = nextId++;
    set({ cue: { ...cue, id } });
    timer = setTimeout(() => {
      timer = null;
      if (get().cue?.id === id) set({ cue: null });
    }, OPEN_CUE_MS);
  },
  clear: () => {
    stopTimer();
    set({ cue: null });
  },
}));

/** The last path segment (the whole path when it has none). */
export function cueFileName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || path;
}
