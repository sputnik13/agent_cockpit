import { describe, expect, it } from 'vitest';
import {
  buildSendKeysCommands,
  capturePane,
  listPanesAltScreen,
  MAX_SEND_KEYS_CHUNK_BYTES,
  TERMINAL_SCROLLBACK,
} from './index';

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

describe('pause-mode (flow control) builders', () => {
  it('queries the tmux version', async () => {
    const { tmuxVersionQuery } = await import('./index');
    expect(tmuxVersionQuery()).toBe("display-message -p '#{version}'");
  });
  it('builds pause-after with a flooring + 1s floor', async () => {
    const { refreshClientPauseAfter, PAUSE_AFTER_SECONDS } = await import('./index');
    expect(refreshClientPauseAfter()).toBe(`refresh-client -f pause-after=${PAUSE_AFTER_SECONDS}`);
    expect(refreshClientPauseAfter(5)).toBe('refresh-client -f pause-after=5');
    expect(refreshClientPauseAfter(0)).toBe('refresh-client -f pause-after=1');
  });
  it('builds a per-pane continue (resume)', async () => {
    const { refreshClientContinue } = await import('./index');
    expect(refreshClientContinue('%4')).toBe('refresh-client -A %4:continue');
  });
});

describe('format-subscription (refresh-client -B) builders', () => {
  it('builds a subscribe with name:what:format (quoted)', async () => {
    const { refreshClientSubscribe } = await import('./index');
    expect(refreshClientSubscribe('title', '%3', '#{pane_title}')).toBe(
      "refresh-client -B 'title:%3:#{pane_title}'",
    );
  });
  it('builds an unsubscribe via empty format', async () => {
    const { refreshClientUnsubscribe } = await import('./index');
    expect(refreshClientUnsubscribe('title')).toBe("refresh-client -B 'title::'");
  });
});

describe('buildSendKeysCommands (all -H; never splits escape sequences)', () => {
  it('returns [] for empty input', () => {
    expect(buildSendKeysCommands('%1', '')).toEqual([]);
    expect(buildSendKeysCommands('%1', new Uint8Array(0))).toEqual([]);
  });

  it('sends a sub-chunk input as a single -H command', () => {
    expect(buildSendKeysCommands('%1', 'echo hi')).toEqual(['send-keys -t %1 -H 65 63 68 6f 20 68 69']);
  });

  it('sends control bytes via -H', () => {
    expect(buildSendKeysCommands('%1', '\r')).toEqual(['send-keys -t %1 -H 0d']);
  });

  it('keeps an escape sequence in ONE command (ESC not split from the rest)', () => {
    // SGR mouse report \x1b[<35;50;10M — must be a single send-keys, or it breaks
    // over SSH (the regression this fixes).
    const cmds = buildSendKeysCommands('%2', '\x1b[<35;50;10M');
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBe('send-keys -t %2 -H 1b 5b 3c 33 35 3b 35 30 3b 31 30 4d');
  });

  it('sends multibyte UTF-8 (>=0x80) via -H', () => {
    // 'é' = c3 a9
    expect(buildSendKeysCommands('%1', 'é')).toEqual(['send-keys -t %1 -H c3 a9']);
  });

  it('chunks a large input by size into ordered -H commands whose bytes concatenate', () => {
    const n = MAX_SEND_KEYS_CHUNK_BYTES * 2 + 10;
    const cmds = buildSendKeysCommands('%1', 'a'.repeat(n));
    expect(cmds).toHaveLength(3);
    expect(cmds.every((c) => c.startsWith('send-keys -t %1 -H '))).toBe(true);
    const bytes = cmds
      .map((c) => c.slice('send-keys -t %1 -H '.length).split(' '))
      .flat()
      .map((h) => parseInt(h, 16));
    expect(bytes).toEqual(Array.from({ length: n }, () => 0x61));
  });

  it('accepts a pre-built hex string and re-emits it (renderer path round-trip)', () => {
    expect(buildSendKeysCommands('%1', '65 63 68 6f')).toEqual(['send-keys -t %1 -H 65 63 68 6f']);
  });
});
