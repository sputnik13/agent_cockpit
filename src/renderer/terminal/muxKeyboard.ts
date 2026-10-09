/**
 * Renderer-agnostic keyboard contract for the Cockpit mux.
 *
 * xterm and WTerm receive terminal bytes only after this frontend reducer has
 * declined a key. The returned command is deliberately about mux intent, not
 * a renderer API, so either terminal surface can use the same backend command
 * path.
 */
export type MuxKeyboardAction =
  | { type: 'pane.move'; direction: 'left' | 'right' | 'up' | 'down' }
  | { type: 'window.move'; delta: -1 | 1 }
  | { type: 'window.new' }
  | { type: 'pane.split'; direction: 'horizontal' | 'vertical' }
  | { type: 'window.close' }
  | { type: 'pane.zoom.toggle' }
  | { type: 'pane.sendCtrlA' };

export interface MuxShortcutEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface MuxKeyboardState {
  byobuArmed: boolean;
}

export interface MuxKeyboardResult {
  action: MuxKeyboardAction | null;
  consume: boolean;
  nextState: MuxKeyboardState;
}

const IDLE: MuxKeyboardState = { byobuArmed: false };

function arrowDirection(key: string): 'left' | 'right' | 'up' | 'down' | null {
  return (
    ({ ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const)[key] ??
    null
  );
}

/** Translate one frontend key event into a mux command, if it owns the key. */
export function reduceMuxKeyboard(
  event: MuxShortcutEvent,
  state: MuxKeyboardState = IDLE,
  options: { isMac: boolean; byobuKeybindings: boolean },
): MuxKeyboardResult {
  const idle = (): MuxKeyboardResult => ({ action: null, consume: false, nextState: state });
  const command = (action: MuxKeyboardAction): MuxKeyboardResult => ({
    action,
    consume: true,
    nextState: IDLE,
  });
  const primary = options.isMac ? event.metaKey : event.ctrlKey;
  const direction = arrowDirection(event.key);

  if (primary && event.altKey && direction) return command({ type: 'pane.move', direction });
  if (primary && event.shiftKey && (event.code === 'BracketLeft' || event.code === 'BracketRight'))
    return command({ type: 'window.move', delta: event.code === 'BracketLeft' ? -1 : 1 });
  if (primary && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === 't' && !event.shiftKey) return command({ type: 'window.new' });
    if (key === 'd') return command({ type: 'pane.split', direction: event.shiftKey ? 'vertical' : 'horizontal' });
    if (key === 'w' && !event.shiftKey) return command({ type: 'window.close' });
    if (key === 'z' && event.shiftKey) return command({ type: 'pane.zoom.toggle' });
  }

  if (!options.byobuKeybindings) return idle();
  if (event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && direction)
    return command({ type: 'pane.move', direction });
  if (state.byobuArmed) {
    const key = event.key.toLowerCase();
    const action =
      key === 'z'
        ? { type: 'pane.zoom.toggle' as const }
        : key === 'n'
          ? { type: 'window.move' as const, delta: 1 as const }
          : key === 'p'
            ? { type: 'window.move' as const, delta: -1 as const }
            : key === 'a'
              ? { type: 'pane.sendCtrlA' as const }
              : null;
    return { action, consume: true, nextState: IDLE };
  }
  if (
    event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === 'a' || event.code === 'KeyA')
  ) {
    return { action: null, consume: true, nextState: { byobuArmed: true } };
  }
  return idle();
}
