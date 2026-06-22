/**
 * Real-tmux integration tests for the local control-mode manager. Each test
 * spawns an actual `tmux -L agent-cockpit -CC` session on the dedicated socket
 * and asserts that commands produce the expected control-protocol
 * notifications. Gated like local.test.ts: if node-pty's native binding or tmux
 * is unavailable in this runtime, the test returns early (skips) rather than
 * failing.
 *
 * Note on bootstrap: on attach tmux emits `%window-add` + initial `%output`,
 * but NOT `%layout-change` — layout notifications only fire on a *change*. So
 * initial enumeration goes through `list-windows`/`list-panes` commands, and
 * the split/resize tests assert the layout that follows their mutation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTmuxControlManager, hasTmux } from './tmuxControl';
import { parseLayout, TERMINAL_SCROLLBACK } from '@shared/tmux';
import type { LayoutChangeNotification, TmuxNotification } from '@shared/tmux';

const SOCKET = 'agent-cockpit';

/** Spawn a manager on a fresh project id + temp cwd; null when unspawnable. */
function spawnManager(): { mgr: LocalTmuxControlManager; cwd: string } | null {
  if (!hasTmux()) return null;
  const cwd = mkdtempSync(join(tmpdir(), 'cockpit-tmuxctl-'));
  const pid = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const mgr = new LocalTmuxControlManager(pid, cwd);
  try {
    mgr.open({ cols: 80, rows: 24 });
  } catch {
    rmSync(cwd, { recursive: true, force: true });
    return null; // node-pty native binding unavailable (e.g. Electron-ABI)
  }
  return { mgr, cwd };
}

/** Wait until `predicate` sees a matching notification, or time out. */
function waitFor(
  mgr: LocalTmuxControlManager,
  predicate: (n: TmuxNotification) => boolean,
  timeoutMs = 4000,
): Promise<TmuxNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('timed out waiting for notification'));
    }, timeoutMs);
    const off = mgr.onNotification((n) => {
      if (predicate(n)) {
        clearTimeout(timer);
        off();
        resolve(n);
      }
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the first pane id of the (single, initial) window via list-panes. */
async function firstPaneId(mgr: LocalTmuxControlManager): Promise<string> {
  const reply = await mgr.command("list-panes -F '#{pane_id}'");
  const id = reply.lines[0]?.trim() ?? '';
  return id;
}

describe('LocalTmuxControlManager (real tmux -CC)', () => {
  let active: { mgr: LocalTmuxControlManager; cwd: string } | null = null;

  afterEach(() => {
    if (active) {
      try {
        active.mgr.killSession();
      } catch {
        /* ignore */
      }
      try {
        execFileSync('tmux', ['-L', SOCKET, 'kill-session', '-t', active.mgr.sessionName()], {
          stdio: 'ignore',
        });
      } catch {
        /* already gone */
      }
      rmSync(active.cwd, { recursive: true, force: true });
      active = null;
    }
  });

  it('opens a control session and emits the initial %window-add', async () => {
    active = spawnManager();
    if (!active) return; // tmux/node-pty unavailable: skip
    const evt = await waitFor(active.mgr, (n) => n.type === 'window-add');
    expect(evt.type).toBe('window-add');
    expect(active.mgr.isOpen()).toBe(true);
  });

  it('enumerates the initial window layout via list-windows', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const reply = await active.mgr.command("list-windows -F '#{window_layout}'");
    expect(reply.error).toBe(false);
    const layoutStr = reply.lines[0]!.trim();
    const layout = parseLayout(layoutStr);
    expect(layout.root).toBeDefined();
  });

  it('creates a new window via command and observes %window-add', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const added = waitFor(
      active.mgr,
      (n) => n.type === 'window-add' || n.type === 'unlinked-window-add',
    );
    const reply = await active.mgr.newWindow({ name: 'second' });
    expect(reply.error).toBe(false);
    const evt = await added;
    expect(['window-add', 'unlinked-window-add']).toContain(evt.type);
  });

  it('splits a pane and re-emits a layout with a split root', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const paneId = await firstPaneId(active.mgr);
    expect(paneId.startsWith('%')).toBe(true);

    const splitLayout = waitFor(
      active.mgr,
      (n) =>
        n.type === 'layout-change' &&
        (n as LayoutChangeNotification).layout.root.type === 'split',
    );
    const splitReply = await active.mgr.splitWindow(paneId, 'lr');
    expect(splitReply.error).toBe(false);
    const after = (await splitLayout) as LayoutChangeNotification;
    expect(after.layout.root.type).toBe('split');
  });

  it('round-trips input via send-keys (literal + hex) and seeds scrollback', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const paneId = await firstPaneId(active.mgr);

    // Type `echo cockpit-ok` then Enter (CR = 0x0d).
    await active.mgr.input(paneId, 'echo cockpit-ok');
    await active.mgr.input(paneId, '\r');
    await delay(700);

    const lines = await active.mgr.capturePane(paneId);
    expect(lines.join('\n')).toContain('cockpit-ok');
  });

  it('seeds the global history-limit before new-session so the initial pane inherits it', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const paneId = await firstPaneId(active.mgr);
    // FR3: the auto-created initial pane must report the configured limit,
    // proving set -g history-limit ran before new-session created the pane.
    const reply = await active.mgr.command(
      `display-message -p -t ${paneId} '#{history_limit}'`,
    );
    expect(reply.error).toBe(false);
    expect(reply.lines[0]?.trim()).toBe(String(TERMINAL_SCROLLBACK));
  });

  it('generic command() resolves with the error flag for an invalid target (tolerant)', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const reply = await active.mgr.command('kill-pane -t %99999');
    expect(reply.error).toBe(true);
  });

  it('structural mutation wrappers reject on a tmux %error (non-tolerant)', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    await expect(active.mgr.killPane('%99999')).rejects.toThrow(/tmux command error/);
  });

  it('accepts resizeClient without error', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const reply = await active.mgr.resizeClient(120, 40);
    expect(reply.error).toBe(false);
  });

  it('detach (close) keeps the session alive on the socket', async () => {
    active = spawnManager();
    if (!active) return;
    await waitFor(active.mgr, (n) => n.type === 'window-add');
    const name = active.mgr.sessionName();
    active.mgr.close();
    await delay(250);
    const ls = execFileSync('tmux', ['-L', SOCKET, 'ls', '-F', '#{session_name}'], {
      encoding: 'utf8',
    });
    expect(ls).toContain(name);
  });
});
