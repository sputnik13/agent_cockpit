/**
 * Streaming filter that intercepts SCREEN/tmux-style title-set sequences
 * (`\ek <title> \e\`) in a per-pane byte stream. xterm.js's VT500-
 * conformant parser doesn't recognize `\ek` as a string-terminator-
 * bounded introducer (it's a SCREEN convention, not part of ECMA-48),
 * so left alone the `\ek` is consumed as an empty ESC and the title
 * text renders as visible characters at the cursor (`vimvim`,
 * `claudeclaude` ghosts in the prompt area).
 *
 * The captured title is surfaced via the `onTitle` callback so the host
 * can promote it elsewhere (the window's tab displayName) instead of
 * throwing it away. State + title-buffer are kept per (projectId, paneId)
 * because tmux pane ids (%0, %1, …) repeat across projects' sessions —
 * keying on paneId alone would leak state across project switches.
 */
type TitleSkipState = 'normal' | 'esc' | 'skip' | 'skipEsc';

/** Map key is `${projectId}:${paneId}` to avoid cross-project state leakage. */
const titleSkip = new Map<string, TitleSkipState>();
const titleBuf = new Map<string, string>();

function stateKey(projectId: string, paneId: string): string {
  return `${projectId}:${paneId}`;
}

export function extractScreenTitle(
  projectId: string,
  paneId: string,
  input: Uint8Array,
  onTitle: (title: string) => void,
): Uint8Array {
  const key = stateKey(projectId, paneId);
  let state = titleSkip.get(key) ?? 'normal';
  let buf = titleBuf.get(key) ?? '';
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const b = input[i]!;
    switch (state) {
      case 'normal':
        if (b === 0x1b) state = 'esc';
        else out.push(b);
        break;
      case 'esc':
        if (b === 0x6b) {
          state = 'skip';
          buf = '';
        } else if (b === 0x1b) {
          // ESC ESC — restart escape sequence per VT parser convention.
        } else {
          // Not our sequence; let xterm.js process it normally.
          out.push(0x1b, b);
          state = 'normal';
        }
        break;
      case 'skip':
        if (b === 0x1b) state = 'skipEsc';
        else buf += String.fromCharCode(b);
        break;
      case 'skipEsc':
        if (b === 0x5c) {
          // '\' completes ST — emit captured title and reset.
          onTitle(buf);
          buf = '';
          state = 'normal';
        } else if (b === 0x1b) {
          // Another ESC inside the title; stay in skipEsc.
        } else {
          // ESC followed by non-ST in title; both belong to the title.
          buf += String.fromCharCode(0x1b) + String.fromCharCode(b);
          state = 'skip';
        }
        break;
    }
  }
  titleSkip.set(key, state);
  titleBuf.set(key, buf);
  return new Uint8Array(out);
}

/** Drop the per-pane filter state — call on pane dispose or in tests.
 *  Pass both projectId and paneId to clear one specific pane's state.
 *  Pass only projectId to clear all panes belonging to that project.
 *  Pass neither to clear all state (teardown/tests). */
export function resetScreenTitleState(projectId?: string, paneId?: string): void {
  if (projectId && paneId) {
    const key = stateKey(projectId, paneId);
    titleSkip.delete(key);
    titleBuf.delete(key);
  } else if (projectId) {
    // Clear all panes for the given project.
    const prefix = `${projectId}:`;
    for (const k of [...titleSkip.keys()]) {
      if (k.startsWith(prefix)) {
        titleSkip.delete(k);
        titleBuf.delete(k);
      }
    }
  } else {
    titleSkip.clear();
    titleBuf.clear();
  }
}
