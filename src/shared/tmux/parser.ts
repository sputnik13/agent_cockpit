/**
 * Streaming parser for the tmux control-mode (`-CC`) protocol.
 *
 * tmux speaks a line-oriented protocol on the control client's stdout. Each
 * line is either:
 * - a `%`-prefixed notification (`%output`, `%window-add`, `%layout-change`, …),
 * - or part of a command reply block delimited by
 *   `%begin <ts> <num> <flags>` … `%end <ts> <num> <flags>` /
 *   `%error <ts> <num> <flags>`. Lines inside a block are the reply body for the
 *   command tagged `<num>`.
 *
 * `feed(chunk)` accepts arbitrary byte/string fragments (handling partial lines
 * across chunk boundaries) and returns the typed notifications completed by that
 * chunk. The parser is transport-agnostic: the host wires `feed` to a node-pty
 * or SSH channel; the renderer never runs it directly.
 *
 * Pure with respect to I/O — it holds only line-buffering and in-flight reply
 * state. tmux uses `\r\n` line endings on the control stream; we tolerate `\n`.
 */
import { decodeOutput } from './codec';
import { tryParseLayout } from './layout';
import type { ReplyNotification, TmuxNotification } from './types';

interface OpenReply {
  num: number;
  lines: string[];
}

export class TmuxControlParser {
  /** Bytes received but not yet terminated by a newline. */
  private buffer = '';
  /** The currently-open `%begin` reply block, if any. */
  private openReply: OpenReply | null = null;

  /**
   * Feed a raw chunk (string or bytes) and return the notifications it
   * completed. Partial trailing lines are retained for the next call.
   */
  feed(chunk: string | Uint8Array): TmuxNotification[] {
    const text = typeof chunk === 'string' ? chunk : latin1Decode(chunk);
    this.buffer = stripDcsWrapper(this.buffer + text);
    const out: TmuxNotification[] = [];
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      let line = this.buffer.slice(0, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line, out);
      nl = this.buffer.indexOf('\n');
    }
    return out;
  }

  private handleLine(line: string, out: TmuxNotification[]): void {
    // Inside a reply block, every non-`%end`/`%error` line is reply body —
    // even a line that begins with `%` (e.g. command output text).
    if (this.openReply) {
      if (line.startsWith('%end ') || line.startsWith('%error ')) {
        this.closeReply(line, out);
        return;
      }
      this.openReply.lines.push(line);
      return;
    }

    if (!line.startsWith('%')) {
      // Stray non-notification line outside any block; ignore (tmux should not
      // emit these on the control stream, but be defensive).
      return;
    }

    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);

    switch (tag) {
      case '%begin':
        this.openBegin(rest);
        return;
      case '%output':
        out.push(this.parseOutput(rest));
        return;
      case '%window-add':
        out.push({ type: 'window-add', windowId: firstToken(rest) });
        return;
      case '%unlinked-window-add':
        out.push({ type: 'unlinked-window-add', windowId: firstToken(rest) });
        return;
      case '%window-close':
      case '%unlinked-window-close':
        out.push({ type: 'window-close', windowId: firstToken(rest) });
        return;
      case '%window-renamed': {
        const [windowId, name] = splitFirst(rest);
        out.push({ type: 'window-renamed', windowId, name });
        return;
      }
      case '%window-pane-changed': {
        const t = rest.split(' ');
        out.push({ type: 'window-pane-changed', windowId: t[0] ?? '', paneId: t[1] ?? '' });
        return;
      }
      case '%layout-change':
        out.push(this.parseLayoutChange(rest));
        return;
      case '%session-changed': {
        const [sessionId, name] = splitFirst(rest);
        out.push({ type: 'session-changed', sessionId, name });
        return;
      }
      case '%session-renamed':
        out.push({ type: 'session-renamed', name: rest });
        return;
      case '%sessions-changed':
        out.push({ type: 'sessions-changed' });
        return;
      case '%session-window-changed': {
        // Emitted by tmux 3.5+ when a session's active window changes
        // (e.g. new-window selects the new window). For control-mode
        // clients this is the primary signal that focus should shift to
        // a different window; %window-pane-changed is NOT emitted for
        // pure window switches.
        const t = rest.split(' ');
        out.push({ type: 'session-window-changed', sessionId: t[0] ?? '', windowId: t[1] ?? '' });
        return;
      }
      case '%client-session-changed': {
        const t = rest.split(' ');
        out.push({
          type: 'client-session-changed',
          client: t[0] ?? '',
          sessionId: t[1] ?? '',
          name: t.slice(2).join(' '),
        });
        return;
      }
      case '%client-detached':
        out.push({ type: 'client-detached', client: firstToken(rest) });
        return;
      case '%pane-mode-changed':
        out.push({ type: 'pane-mode-changed', paneId: firstToken(rest) });
        return;
      case '%exit':
        out.push({ type: 'exit', reason: rest.length > 0 ? rest : null });
        return;
      case '%continue':
        out.push({ type: 'continue', paneId: firstToken(rest) });
        return;
      case '%pause':
        out.push({ type: 'pause', paneId: firstToken(rest) });
        return;
      default:
        out.push({ type: 'unknown', line });
        return;
    }
  }

  /** Open a reply block: `%begin <ts> <num> <flags>`. */
  private openBegin(rest: string): void {
    const t = rest.split(' ');
    const num = Number(t[1]);
    this.openReply = { num: Number.isFinite(num) ? num : -1, lines: [] };
  }

  /** Close a reply block on `%end`/`%error <ts> <num> <flags>`. */
  private closeReply(line: string, out: TmuxNotification[]): void {
    const open = this.openReply!;
    this.openReply = null;
    const error = line.startsWith('%error ');
    const reply: ReplyNotification = { type: 'reply', num: open.num, error, lines: open.lines };
    out.push(reply);
  }

  /** Parse `%output %<pane> <octal-escaped-bytes>`. */
  private parseOutput(rest: string): TmuxNotification {
    const sp = rest.indexOf(' ');
    const paneId = sp === -1 ? rest : rest.slice(0, sp);
    const payload = sp === -1 ? '' : rest.slice(sp + 1);
    return { type: 'output', paneId, bytes: decodeOutput(payload) };
  }

  /** Parse `%layout-change @<win> <layout> [<visible-layout> [<flags>]]`. */
  private parseLayoutChange(rest: string): TmuxNotification {
    const t = rest.split(' ');
    const windowId = t[0] ?? '';
    const layoutStr = t[1] ?? '';
    const visibleStr = t[2];
    const flags = t.length > 3 ? t.slice(3).join(' ') : (t[3] ?? null);
    const layout = tryParseLayout(layoutStr);
    if (!layout) {
      return { type: 'unknown', line: `%layout-change ${rest}` };
    }
    return {
      type: 'layout-change',
      windowId,
      layout,
      visibleLayout: visibleStr ? tryParseLayout(visibleStr) : null,
      flags: flags ?? null,
    };
  }
}

/**
 * tmux control-mode double (`-CC`) wraps the whole control stream in a DCS:
 * the introducer `ESC P 1000 p` on attach and the terminator `ESC \` on detach.
 * These are not part of the line protocol, so strip them before framing. They
 * only ever appear at control-mode enter/exit boundaries, so a global strip is
 * safe and keeps the parser otherwise pure line-based.
 */
const DCS_INTRODUCER = 'P1000p';
const DCS_TERMINATOR = '\\';
function stripDcsWrapper(s: string): string {
  let out = s;
  if (out.includes(DCS_INTRODUCER)) out = out.split(DCS_INTRODUCER).join('');
  if (out.includes(DCS_TERMINATOR)) out = out.split(DCS_TERMINATOR).join('');
  return out;
}

/** First space-delimited token of a string. */
function firstToken(s: string): string {
  const sp = s.indexOf(' ');
  return sp === -1 ? s : s.slice(0, sp);
}

/** Split into [first token, remainder]. */
function splitFirst(s: string): [string, string] {
  const sp = s.indexOf(' ');
  if (sp === -1) return [s, ''];
  return [s.slice(0, sp), s.slice(sp + 1)];
}

/**
 * Decode bytes as latin1 so each byte maps 1:1 to a char code. The control
 * stream's structural bytes are ASCII; `%output` payloads are octal-escaped by
 * tmux (also ASCII), so latin1 line-framing never corrupts them. The decoder in
 * {@link decodeOutput} reconstructs the real bytes.
 */
function latin1Decode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}
