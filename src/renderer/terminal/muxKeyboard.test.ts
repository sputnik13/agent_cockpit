import { describe, expect, it } from 'vitest';
import { reduceMuxKeyboard, type MuxShortcutEvent } from './muxKeyboard';

const mac = { isMac: true, byobuKeybindings: false };
const byobu = { isMac: true, byobuKeybindings: true };

function key(overrides: Partial<MuxShortcutEvent>): MuxShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('reduceMuxKeyboard', () => {
  it.each([
    [key({ key: 't', metaKey: true }), { type: 'window.new' }],
    [key({ key: 'd', metaKey: true }), { type: 'pane.split', direction: 'horizontal' }],
    [key({ key: 'd', metaKey: true, shiftKey: true }), { type: 'pane.split', direction: 'vertical' }],
    [key({ key: 'ArrowLeft', metaKey: true, altKey: true }), { type: 'pane.move', direction: 'left' }],
    [key({ code: 'BracketRight', metaKey: true, shiftKey: true }), { type: 'window.move', delta: 1 }],
    [key({ key: 'w', metaKey: true }), { type: 'window.close' }],
    [key({ key: 'z', metaKey: true, shiftKey: true }), { type: 'pane.zoom.toggle' }],
  ])('maps the standard frontend shortcut %#', (event, action) => {
    expect(reduceMuxKeyboard(event, { byobuArmed: false }, mac)).toMatchObject({
      consume: true,
      action,
      nextState: { byobuArmed: false },
    });
  });

  it('maps the Byobu prefix without forwarding either key to a renderer', () => {
    const armed = reduceMuxKeyboard(key({ key: 'a', code: 'KeyA', ctrlKey: true }), { byobuArmed: false }, byobu);
    expect(armed).toEqual({ action: null, consume: true, nextState: { byobuArmed: true } });
    expect(reduceMuxKeyboard(key({ key: 'a', code: 'KeyA' }), armed.nextState, byobu)).toEqual({
      action: { type: 'pane.sendCtrlA' },
      consume: true,
      nextState: { byobuArmed: false },
    });
  });

  it('leaves ordinary terminal input alone', () => {
    expect(reduceMuxKeyboard(key({ key: 'x' }), { byobuArmed: false }, mac)).toEqual({
      action: null,
      consume: false,
      nextState: { byobuArmed: false },
    });
  });
});
