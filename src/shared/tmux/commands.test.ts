import { describe, expect, it } from 'vitest';
import { capturePane, listPanesAltScreen, TERMINAL_SCROLLBACK } from './index';

describe('listPanesAltScreen builder (hard-refresh gating)', () => {
  it('targets the window and formats pane id + alternate-screen flag', () => {
    expect(listPanesAltScreen('@2')).toBe("list-panes -t @2 -F '#{pane_id} #{alternate_on}'");
  });
});

describe('capturePane builder (history-seed depth)', () => {
  it('omits -S when no startLine is given (visible-screen seed, today’s behavior)', () => {
    expect(capturePane('%0')).toBe('capture-pane -peJ -t %0');
  });

  it('emits -S -<n> when a startLine is given (deep-history seed)', () => {
    expect(capturePane('%3', { startLine: TERMINAL_SCROLLBACK })).toBe(
      `capture-pane -peJ -t %3 -S -${TERMINAL_SCROLLBACK}`,
    );
  });

  it('floors and clamps the start line to a non-negative integer', () => {
    expect(capturePane('%1', { startLine: 4999.9 })).toBe('capture-pane -peJ -t %1 -S -4999');
    expect(capturePane('%1', { startLine: -5 })).toBe('capture-pane -peJ -t %1 -S -0');
  });
});

describe('TERMINAL_SCROLLBACK (single source of scrollback depth)', () => {
  it('is the agreed target depth feeding tmux history-limit, capture -S, and xterm scrollback', () => {
    expect(TERMINAL_SCROLLBACK).toBe(5000);
  });
});
