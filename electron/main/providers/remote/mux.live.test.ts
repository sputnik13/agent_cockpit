import { afterAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { RemoteConnectionSpec } from '../types';
import { RemoteHelperLauncher } from './helper';
import { RemoteMuxLauncher } from './mux';
import { MuxClient } from './muxClient';
import { RemoteMuxConnectionManager } from './muxConnection';
import { RemoteMuxTerminalManager } from './muxTerminal';
import { Ssh2Transport } from './transport';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

const enabled = process.env.COCKPIT_MUX_LIVE_SSH === '1';
const describeLive = enabled ? describe : describe.skip;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when COCKPIT_MUX_LIVE_SSH=1`);
  return value;
}

async function eventually(assertion: () => void, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error('timed out waiting for live mux condition');
}

async function attachFromSshPty(
  transport: Ssh2Transport,
  command: string,
  expected: string,
  close: 'detach' | 'channel',
): Promise<string> {
  const pty = await transport.openPty(command, { cols: 100, rows: 32 });
  let output = '';
  let closed = false;
  pty.onData((data) => {
    output += Buffer.from(data).toString('utf8');
  });
  pty.onClose(() => {
    closed = true;
  });
  await eventually(() => expect(output).toContain(expected));
  if (close === 'detach') pty.write('\x02d');
  else pty.close();
  await eventually(() => expect(closed).toBe(true));
  return output;
}

async function eventuallyPaneOutput(
  client: MuxClient,
  paneId: string,
  clientId: string,
  expected: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let output = '';
  while (Date.now() < deadline) {
    const response = await client.request<{ outputs: Array<{ data: Uint8Array }> }>('pane.output', {
      pane_id: paneId,
      client_id: clientId,
      from_sequence: 1,
    });
    output = Buffer.concat(response.outputs.map((chunk) => Buffer.from(chunk.data))).toString('utf8');
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mux pane ${paneId} did not emit ${expected}: ${output}`);
}

describeLive('RemoteMuxLauncher (disposable live SSH host)', () => {
  const transport = new Ssh2Transport();
  let client: MuxClient | null = null;
  let sessionId: string | null = null;
  let connection: RemoteMuxConnectionManager | null = null;
  let terminals: RemoteMuxTerminalManager | null = null;

  afterAll(async () => {
    if (client && sessionId) {
      await client.request('session.destroy', { session_id: sessionId }).catch(() => undefined);
    }
    client?.close();
    terminals?.closeAll();
    connection?.close();
    await transport.disconnect();
  });

  it('provisions Linux arm64, starts the daemon, and serves xterm-ghostty from a mux pane', async () => {
    const spec: RemoteConnectionSpec = {
      kind: 'remote',
      host: requireEnv('COCKPIT_MUX_LIVE_HOST'),
      port: Number(requireEnv('COCKPIT_MUX_LIVE_PORT')),
      user: requireEnv('COCKPIT_MUX_LIVE_USER'),
      identityPath: requireEnv('COCKPIT_MUX_LIVE_IDENTITY'),
      remotePath: requireEnv('COCKPIT_MUX_LIVE_PATH'),
    };
    await transport.connect(spec);
    const artifactDir = requireEnv('COCKPIT_MUX_LIVE_ARTIFACTS');
    const launched = await new RemoteMuxLauncher(transport, artifactDir).launch();
    client = new MuxClient(launched.channel, 'live-ssh-project');
    client.open();

    const created = await client.request<{ session_id: string; pane_id: string }>('session.create', {
      command: '/bin/sh',
      args: ['-lc', "printf 'live-linux-mux\\n'; infocmp xterm-ghostty; sleep 30"],
      cwd: spec.remotePath,
      key: 'live-linux-terminfo',
    });
    sessionId = created.session_id;
    await client.request('session.attach', {
      session_id: created.session_id,
      pane_id: created.pane_id,
      client_id: 'live-ssh-cockpit',
      cols: 100,
      rows: 32,
    });

    let output = '';
    for (let attempt = 0; attempt < 80 && !output.includes('xterm-ghostty'); attempt += 1) {
      const response = await client.request<{ outputs: Array<{ sequence: number; data: Uint8Array }> }>(
        'pane.output',
        { pane_id: created.pane_id, client_id: 'live-ssh-cockpit', from_sequence: 1 },
      );
      output += Buffer.concat(response.outputs.map((chunk) => Buffer.from(chunk.data))).toString('utf8');
      if (!output.includes('xterm-ghostty')) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(launched.remotePath).toMatch(/cockpit-mux-.*-linux-arm64$/);
    expect(output).toContain('live-linux-mux');
    expect(output).toContain('xterm-ghostty');

    await client.request('session.destroy', { session_id: created.session_id });
    sessionId = null;
    client.close();
    client = null;

    const epochs: number[] = [];
    connection = new RemoteMuxConnectionManager(
      async () => (await new RemoteMuxLauncher(transport, artifactDir).launch()).channel,
      'live-ssh-project',
    );
    connection.onAttached.add((epoch) => epochs.push(epoch));
    terminals = new RemoteMuxTerminalManager(connection, spec.remotePath, 'live-ssh-project');
    const terminal = await terminals.open({ cols: 100, rows: 32, key: 'live-ssh-reconnect' });
    const received: string[] = [];
    terminals.onData(terminal.id, (data) => received.push(Buffer.from(data).toString('utf8')));
    terminals.write(terminal.id, 'nvim -u NONE\n');
    await eventually(() => expect(received.join('')).toContain('\x1b[?1049h'));

    received.splice(0);
    connection.current().close();
    await eventually(() => expect(epochs).toEqual([1, 2]));
    await eventually(() => expect(received.join('')).toContain('\x1b[?1049h'));
    terminals.write(terminal.id, ':echo "remote-reconnected"\r');
    await eventually(() => expect(received.join('')).toContain('remote-reconnected'));
    terminals.write(terminal.id, ':qa!\r');
    await terminals.close(terminal.id, { kill: true });
    terminals = null;
    connection.close();
    connection = null;

    const helper = await new RemoteHelperLauncher(
      transport,
      join(process.cwd(), 'remote-helper', 'dist'),
    ).launch();
    try {
      const coexistence = await transport.exec(
        'test -x "$HOME/.agent-cockpit/helper-0.1.0-linux-arm64" && test -L "$HOME/.agent-cockpit/cockpit-mux" && test -S "$HOME/.agent-cockpit/mux/mux.sock"',
      );
      expect(coexistence.code).toBe(0);
    } finally {
      helper.channel.close();
    }

    const fallbackLaunch = await new RemoteMuxLauncher(transport, artifactDir).launch();
    const fallbackClient = new MuxClient(fallbackLaunch.channel, 'live-ssh-project');
    fallbackClient.open();
    const fallback = await fallbackClient.request<{ session_id: string; pane_id: string }>('session.create', {
      command: '/bin/sh',
      args: ['-lc', "printf 'fallback-ssh-pty\\n'; sleep 30"],
      cwd: spec.remotePath,
      key: 'live-ssh-fallback',
    });
    const fallbackCommand = 'exec "$HOME/.agent-cockpit/cockpit-mux" attach';
    await attachFromSshPty(transport, fallbackCommand, 'fallback-ssh-pty', 'channel');
    await attachFromSshPty(transport, fallbackCommand, 'fallback-ssh-pty', 'detach');
    const listed = await transport.exec('"$HOME/.agent-cockpit/cockpit-mux" ls');
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(fallback.session_id);
    await fallbackClient.request('session.destroy', { session_id: fallback.session_id });
    fallbackClient.close();

    const isolatedHome = '"$HOME/.agent-cockpit/live-isolated-mux"';
    const isolatedStart = await transport.exec(
      [
        `mkdir -p ${isolatedHome}`,
        `chmod 700 ${isolatedHome}`,
        `COCKPIT_MUX_HOME=${isolatedHome} nohup "$HOME/.agent-cockpit/cockpit-mux" > ${isolatedHome}/mux.log 2>&1 < /dev/null &`,
        'for attempt in 1 2 3 4 5 6 7 8 9 10; do',
        `  if test -S ${isolatedHome}/mux.sock; then exit 0; fi`,
        '  sleep 0.1',
        'done',
        'exit 1',
      ].join('\n'),
    );
    expect(isolatedStart.code).toBe(0);
    const isolatedBridge = await transport.execStream(
      `exec "$HOME/.agent-cockpit/cockpit-mux" --socket ${isolatedHome}/mux.sock bridge`,
    );
    const isolatedClient = new MuxClient(isolatedBridge, 'live-ssh-project');
    isolatedClient.open();
    const isolated = await isolatedClient.request<{ session_id: string; pane_id: string }>('session.create', {
      command: '/bin/sh',
      args: ['-lc', 'sleep 30'],
      cwd: spec.remotePath,
      key: 'live-ssh-isolated-home',
    });
    const isolatedListed = await transport.exec(
      `COCKPIT_MUX_HOME=${isolatedHome} "$HOME/.agent-cockpit/cockpit-mux" ls`,
    );
    const defaultListed = await transport.exec('"$HOME/.agent-cockpit/cockpit-mux" ls');
    expect(isolatedListed.stdout).toContain(isolated.session_id);
    expect(defaultListed.stdout).not.toContain(isolated.session_id);
    await isolatedClient.request('session.destroy', { session_id: isolated.session_id });
    await isolatedClient.request('mux.shutdown', {});
    isolatedClient.close();

    const broadcastLaunch = await new RemoteMuxLauncher(transport, artifactDir).launch();
    const broadcastClient = new MuxClient(broadcastLaunch.channel, 'live-ssh-project');
    broadcastClient.open();
    const root = await broadcastClient.request<{ session_id: string; pane_id: string }>('session.create', {
      command: '/bin/sh',
      args: ['-lc', 'printf "root:ready\\n"; while IFS= read -r line; do printf "root:%s\\n" "$line"; done'],
      cwd: spec.remotePath,
      key: 'live-ssh-broadcast-root',
    });
    const peer = await broadcastClient.request<{ session_id: string; pane_id: string }>('pane.split', {
      pane_id: root.pane_id,
      command: '/bin/sh',
      args: ['-lc', 'printf "peer:ready\\n"; while IFS= read -r line; do printf "peer:%s\\n" "$line"; done'],
      cwd: spec.remotePath,
      key: 'live-ssh-broadcast-peer',
    });
    const cockpitClientId = 'live-ssh-cockpit-broadcast';
    await broadcastClient.request('session.attach', {
      session_id: root.session_id,
      pane_id: root.pane_id,
      client_id: cockpitClientId,
      cols: 100,
      rows: 32,
    });
    await broadcastClient.request('pane.broadcast', {
      pane_id: root.pane_id,
      client_id: cockpitClientId,
      enabled: true,
    });
    const observerLaunch = await new RemoteMuxLauncher(transport, artifactDir).launch();
    const observer = new MuxClient(observerLaunch.channel, 'live-ssh-project');
    observer.open();
    const observerClientId = 'live-ssh-cockpit-observer';
    await observer.request('session.attach', {
      session_id: peer.session_id,
      pane_id: peer.pane_id,
      client_id: observerClientId,
      cols: 100,
      rows: 32,
    });
    await observer.request('pane.broadcast', {
      pane_id: peer.pane_id,
      client_id: observerClientId,
      enabled: true,
    });

    const broadcastPty = await transport.openPty(
      `exec "$HOME/.agent-cockpit/cockpit-mux" attach ${root.session_id}`,
      { cols: 100, rows: 32 },
    );
    let broadcastPtyOutput = '';
    let broadcastPtyClosed = false;
    broadcastPty.onData((data) => {
      broadcastPtyOutput += Buffer.from(data).toString('utf8');
    });
    broadcastPty.onClose(() => {
      broadcastPtyClosed = true;
    });
    await eventually(() => expect(broadcastPtyOutput).toContain('root:'));
    broadcastPty.write('tty-broadcast-suppressed\n');
    await eventually(() => expect(broadcastPtyOutput).toContain('root:tty-broadcast-suppressed'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const peerWhileTty = await observer.request<{ outputs: Array<{ data: Uint8Array }> }>('pane.output', {
      pane_id: peer.pane_id,
      client_id: observerClientId,
      from_sequence: 1,
    });
    expect(Buffer.concat(peerWhileTty.outputs.map((chunk) => Buffer.from(chunk.data))).toString('utf8')).not.toContain(
      'peer:tty-broadcast-suppressed',
    );
    broadcastPty.write('\x02d');
    await eventually(() => expect(broadcastPtyClosed).toBe(true));

    const reattachedLaunch = await new RemoteMuxLauncher(transport, artifactDir).launch();
    const reattached = new MuxClient(reattachedLaunch.channel, 'live-ssh-project');
    reattached.open();
    await reattached.request('session.attach', {
      session_id: root.session_id,
      pane_id: root.pane_id,
      client_id: cockpitClientId,
      cols: 100,
      rows: 32,
    });
    await reattached.request('pane.write', {
      pane_id: root.pane_id,
      client_id: cockpitClientId,
      data: Buffer.from('cockpit-broadcast-resumed\n'),
      kind: 'input',
    });
    await eventuallyPaneOutput(observer, peer.pane_id, observerClientId, 'peer:cockpit-broadcast-resumed');
    await reattached.request('session.destroy', { session_id: root.session_id });
    await reattached.request('session.destroy', { session_id: peer.session_id });
    broadcastClient.close();
    observer.close();
    reattached.close();
  }, 30_000);
});
