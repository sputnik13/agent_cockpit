import { describe, expect, it } from 'vitest';
import { TmuxControlParser } from './parser';
import type { LayoutChangeNotification, OutputNotification, ReplyNotification } from './types';

/** Feed a set of complete lines (CRLF-terminated, as tmux emits) at once. */
function feedLines(p: TmuxControlParser, lines: string[]): ReturnType<TmuxControlParser['feed']> {
  return p.feed(lines.map((l) => `${l}\r\n`).join(''));
}

describe('TmuxControlParser framing', () => {
  it('buffers a partial line until its newline arrives', () => {
    const p = new TmuxControlParser();
    expect(p.feed('%window-ad')).toEqual([]);
    const out = p.feed('d @1\r\n');
    expect(out).toEqual([{ type: 'window-add', windowId: '@1' }]);
  });

  it('splits multiple notifications in one chunk', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%window-add @1', '%window-add @2']);
    expect(out).toEqual([
      { type: 'window-add', windowId: '@1' },
      { type: 'window-add', windowId: '@2' },
    ]);
  });

  it('tolerates bare LF line endings', () => {
    const p = new TmuxControlParser();
    const out = p.feed('%window-close @3\n');
    expect(out).toEqual([{ type: 'window-close', windowId: '@3' }]);
  });
});

describe('TmuxControlParser reply correlation', () => {
  it('correlates a %begin/%end block to its command number', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, [
      '%begin 1700000000 7 1',
      'line one',
      'line two',
      '%end 1700000000 7 1',
    ]);
    expect(out).toHaveLength(1);
    const reply = out[0] as ReplyNotification;
    expect(reply).toMatchObject({ type: 'reply', num: 7, error: false });
    expect(reply.lines).toEqual(['line one', 'line two']);
  });

  it('marks a block closed by %error as an error reply', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%begin 1700000000 9 1', "can't find pane", '%error 1700000000 9 1']);
    const reply = out[0] as ReplyNotification;
    expect(reply).toMatchObject({ type: 'reply', num: 9, error: true });
    expect(reply.lines).toEqual(["can't find pane"]);
  });

  it('treats %-prefixed text inside a reply block as body, not notifications', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, [
      '%begin 1 3 1',
      '%this is literal command output',
      '%end 1 3 1',
    ]);
    expect(out).toHaveLength(1);
    expect((out[0] as ReplyNotification).lines).toEqual(['%this is literal command output']);
  });

  it('emits notifications that arrive between reply blocks', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, [
      '%begin 1 1 1',
      '%end 1 1 1',
      '%window-add @5',
      '%begin 1 2 1',
      'ok',
      '%end 1 2 1',
    ]);
    expect(out.map((n) => n.type)).toEqual(['reply', 'window-add', 'reply']);
    expect((out[0] as ReplyNotification).num).toBe(1);
    expect((out[2] as ReplyNotification).num).toBe(2);
  });
});

describe('TmuxControlParser %output decode', () => {
  it('decodes octal-escaped output bytes for a pane', () => {
    const p = new TmuxControlParser();
    // "\033[0m$ " escaped -> ESC '[' '0' 'm' '$' ' '
    const out = feedLines(p, ['%output %2 \\033[0m$ ']);
    const n = out[0] as OutputNotification;
    expect(n.type).toBe('output');
    expect(n.paneId).toBe('%2');
    expect(Array.from(n.bytes)).toEqual([27, 0x5b, 0x30, 0x6d, 0x24, 0x20]);
  });

  it('preserves an escaped backslash in output', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%output %0 a\\\\b']);
    const n = out[0] as OutputNotification;
    expect(Array.from(n.bytes)).toEqual([0x61, 0x5c, 0x62]);
  });

  it('handles empty output payload', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%output %0 ']);
    expect(Array.from((out[0] as OutputNotification).bytes)).toEqual([]);
  });
});

describe('TmuxControlParser window/pane/session notifications', () => {
  it('parses window-renamed with a multi-word name', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%window-renamed @1 my shell']);
    expect(out[0]).toEqual({ type: 'window-renamed', windowId: '@1', name: 'my shell' });
  });

  it('parses unlinked-window-add and window-pane-changed', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%unlinked-window-add @9', '%window-pane-changed @1 %4']);
    expect(out[0]).toEqual({ type: 'unlinked-window-add', windowId: '@9' });
    expect(out[1]).toEqual({ type: 'window-pane-changed', windowId: '@1', paneId: '%4' });
  });

  it('parses session-changed and sessions-changed', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%session-changed $0 agent-cockpit-proj', '%sessions-changed']);
    expect(out[0]).toEqual({ type: 'session-changed', sessionId: '$0', name: 'agent-cockpit-proj' });
    expect(out[1]).toEqual({ type: 'sessions-changed' });
  });

  it('parses client-session-changed and client-detached', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%client-session-changed /dev/ttys001 $0 sess', '%client-detached /dev/ttys001']);
    expect(out[0]).toEqual({
      type: 'client-session-changed',
      client: '/dev/ttys001',
      sessionId: '$0',
      name: 'sess',
    });
    expect(out[1]).toEqual({ type: 'client-detached', client: '/dev/ttys001' });
  });

  it('parses pane-mode-changed, exit, continue, pause', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%pane-mode-changed %3', '%continue %3', '%pause %3', '%exit server exited']);
    expect(out[0]).toEqual({ type: 'pane-mode-changed', paneId: '%3' });
    expect(out[1]).toEqual({ type: 'continue', paneId: '%3' });
    expect(out[2]).toEqual({ type: 'pause', paneId: '%3' });
    expect(out[3]).toEqual({ type: 'exit', reason: 'server exited' });
  });

  it('parses bare %exit with no reason', () => {
    const p = new TmuxControlParser();
    expect(feedLines(p, ['%exit'])[0]).toEqual({ type: 'exit', reason: null });
  });

  it('emits an unknown notification for unmodeled % lines', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%something-new arg1 arg2']);
    expect(out[0]).toEqual({ type: 'unknown', line: '%something-new arg1 arg2' });
  });
});

describe('TmuxControlParser %layout-change', () => {
  it('parses layout-change into a pane tree', () => {
    const p = new TmuxControlParser();
    // Real tmux emits: window-id layout visible-layout flags.
    const layout = 'cccc,80x24,0,0{40x24,0,0,1,39x24,41,0,2}';
    const out = feedLines(p, [`%layout-change @1 ${layout} ${layout} *`]);
    const n = out[0] as LayoutChangeNotification;
    expect(n.type).toBe('layout-change');
    expect(n.windowId).toBe('@1');
    expect(n.layout.root.type).toBe('split');
    expect(n.flags).toBe('*');
  });

  it('parses layout-change with a visible-layout field', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%layout-change @1 aaaa,80x24,0,0,0 bbbb,80x24,0,0,0 *']);
    const n = out[0] as LayoutChangeNotification;
    expect(n.layout.checksum).toBe('aaaa');
    expect(n.visibleLayout?.checksum).toBe('bbbb');
  });

  it('falls back to unknown when the layout string is malformed', () => {
    const p = new TmuxControlParser();
    const out = feedLines(p, ['%layout-change @1 not-a-layout']);
    expect(out[0]?.type).toBe('unknown');
  });
});

describe('TmuxControlParser byte input', () => {
  it('accepts Uint8Array chunks and frames them correctly', () => {
    const p = new TmuxControlParser();
    const enc = new TextEncoder();
    const out = p.feed(enc.encode('%window-add @7\r\n'));
    expect(out).toEqual([{ type: 'window-add', windowId: '@7' }]);
  });
});
