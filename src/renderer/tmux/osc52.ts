/**
 * OSC 52 (operating-system-command 52) is the terminal clipboard protocol. tmux
 * emits it to the client when text is copied and `set-clipboard on` is set (see
 * `terminalConfig`), so a selection reaches the system clipboard, not only tmux's
 * paste-buffer. The sequence body is `<selection>;<payload>` where payload is
 * base64 for a SET, or `?` for a READ request.
 */

/**
 * Decode an OSC 52 **set**-clipboard payload to its text, or `null` when it is
 * not a set we should honor:
 *  - a read request (`?`) — ignored so terminal apps cannot exfiltrate the
 *    clipboard back into the program;
 *  - an empty/clear payload;
 *  - malformed base64.
 * The base64 is decoded as UTF-8 (tmux/apps send UTF-8 selections).
 */
export function decodeOsc52Write(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (payload === '' || payload === '?') return null;
  try {
    const bin = atob(payload);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
