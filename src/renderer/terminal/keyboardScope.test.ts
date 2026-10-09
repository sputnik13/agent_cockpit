// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isTerminalKeyboardTarget } from './keyboardScope';

describe('isTerminalKeyboardTarget', () => {
  it('accepts keys from descendants of a terminal surface', () => {
    document.body.innerHTML = '<div class="ac-term"><textarea></textarea></div>';
    expect(isTerminalKeyboardTarget(document.querySelector('textarea'))).toBe(true);
  });

  it('accepts terminal-panel navigation controls but not its editable fields', () => {
    document.body.innerHTML =
      '<section data-terminal-shortcut-scope><button>Window 1</button><input /></section>';
    expect(isTerminalKeyboardTarget(document.querySelector('button'))).toBe(true);
    expect(isTerminalKeyboardTarget(document.querySelector('input'))).toBe(false);
  });

  it('rejects keys from settings and other non-terminal controls', () => {
    document.body.innerHTML = '<input /><button>Save</button>';
    expect(isTerminalKeyboardTarget(document.querySelector('input'))).toBe(false);
    expect(isTerminalKeyboardTarget(document.querySelector('button'))).toBe(false);
    expect(isTerminalKeyboardTarget(window)).toBe(false);
  });
});
