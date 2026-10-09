#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const guardianMode = args[0] === '--guardian';
const selfTest = args.includes('--self-test-supervisor');
const selfTestAppExit = args.includes('--self-test-app-exit');
const isolatedMode = args.includes('--isolated');
const runRoot = guardianMode ? '' : mkdtempSync(join(tmpdir(), 'agent-cockpit-dev-run-'));
const ownerSocket = join(runRoot, 'owner.sock');
const tmuxSocket = isolatedMode ? `ac-dev-${process.pid}-${randomBytes(4).toString('hex')}` : '';
const readyFile = process.env.AC_DEV_TEST_READY_FILE;
if (selfTest && !guardianMode && process.env.AC_DEV_TEST_ROOT_FILE)
  writeFileSync(process.env.AC_DEV_TEST_ROOT_FILE, runRoot);

function startOwnerServer() {
  const server = net.createServer();
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(ownerSocket, () => resolveServer(server));
  });
}

async function waitForMessage(connection, timeoutMs = 10_000) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(
      () => reject(new Error('development process guardian did not become ready')),
      timeoutMs,
    );
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      connection.off('data', onData);
      connection.off('close', onClose);
      resolveMessage(JSON.parse(buffer.slice(0, newline)));
    };
    const onClose = () => {
      clearTimeout(timer);
      connection.off('data', onData);
      reject(new Error('development process guardian connection closed'));
    };
    connection.on('data', onData);
    connection.once('close', onClose);
    connection.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function runGuardian() {
  const script = fileURLToPath(import.meta.url);
  return spawn(
    process.execPath,
    [
      script,
      '--guardian',
      ownerSocket,
      runRoot,
      tmuxSocket,
      join(runRoot, 'electron-main-exited'),
      ...(isolatedMode ? ['--isolated'] : []),
      ...(selfTest ? ['--self-test-supervisor'] : []),
      ...(selfTestAppExit ? ['--self-test-app-exit'] : []),
    ],
    {
      cwd: root,
      env: process.env,
      detached: true,
      stdio: 'inherit',
    },
  );
}

function runDevCommand(guardianRoot, isIsolated) {
  const vite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
  return {
    command: process.execPath,
    commandArgs: [
      vite,
      'dev',
      ...(isIsolated ? ['--', `--user-data-dir=${join(guardianRoot, 'profile')}`] : []),
    ],
  };
}

function processTable() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => {
      const match = line
        .trim()
        .match(
          /^([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+(\w+\s+\w+\s+[0-9]+\s+[0-9:]+\s+[0-9]+)\s+(.*)$/,
        );
      return match
        ? {
            pid: Number(match[1]),
            ppid: Number(match[2]),
            pgid: Number(match[3]),
            state: match[4],
            started: match[5],
            command: match[6],
          }
        : null;
    })
    .filter(Boolean);
}

async function runController() {
  let server;
  let guardian;
  let connection;
  let guardianExited = Promise.resolve();
  try {
    server = await startOwnerServer();
    guardian = runGuardian();
    guardianExited = new Promise((resolveExit) => {
      guardian.once('exit', (code, signal) =>
        resolveExit(code ?? (signal === 'SIGKILL' ? 137 : 1)),
      );
      guardian.once('error', () => resolveExit(1));
    });
    connection = await new Promise((resolveConnection, reject) => {
      server.once('connection', resolveConnection);
      guardian.once('error', reject);
    });
    let signalReceived = null;
    let controllerStopped;
    const stopped = new Promise((resolveStop) => {
      controllerStopped = resolveStop;
    });
    const onSignal = (signal) => {
      if (signalReceived) return;
      signalReceived = signal;
      connection.destroy();
      server.close();
      controllerStopped({ signal });
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));

    const ready = await waitForMessage(connection);
    if (ready.type !== 'ready')
      throw new Error(`unexpected guardian response: ${JSON.stringify(ready)}`);
    if (selfTest && readyFile) writeFileSync(readyFile, 'ready');
    const result = await Promise.race([waitForMessage(connection, 24 * 60 * 60 * 1000), stopped]);
    if ('signal' in result) {
      await guardianExited;
      process.exitCode = result.signal === 'SIGINT' ? 130 : 143;
    } else {
      process.exitCode = result.code;
      connection.destroy();
      server.close();
      await guardianExited;
    }
  } finally {
    connection?.destroy();
    server?.close();
    if (guardian && !connection && guardian.exitCode === null) guardian.kill('SIGTERM');
    await guardianExited;
    rmSync(runRoot, { recursive: true, force: true });
  }
}

async function runGuardianProcess() {
  const [, , , socketPath, guardianRoot, guardianTmuxSocket, appExitFile, ...guardianArgs] =
    process.argv;
  const isSelfTest = guardianArgs.includes('--self-test-supervisor');
  const isSelfTestAppExit = guardianArgs.includes('--self-test-app-exit');
  const isIsolated = guardianArgs.includes('--isolated');
  const connection = await new Promise((resolveConnection, reject) => {
    const deadline = Date.now() + 5_000;
    const connect = () => {
      const socket = net.createConnection(socketPath);
      socket.once('connect', () => resolveConnection(socket));
      socket.once('error', (error) => {
        socket.destroy();
        if ((error.code === 'ENOENT' || error.code === 'ECONNREFUSED') && Date.now() < deadline)
          setTimeout(connect, 25);
        else if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')
          reject(new Error('development process guardian could not connect to its owner'));
        else reject(error);
      });
    };
    connect();
  });
  const commandInfo = runDevCommand(guardianRoot, isIsolated);
  const childEnv = { ...process.env };
  childEnv.AC_DEV_APP_EXIT_FILE = appExitFile;
  if (isIsolated) {
    Object.assign(childEnv, {
      AC_TMUX_SOCKET: guardianTmuxSocket,
      AC_TMUX_EPHEMERAL: '1',
      COCKPIT_MUX_EPHEMERAL: '1',
      COCKPIT_MUX_HOME: join(guardianRoot, 'mux-home'),
    });
  }
  if (isSelfTest && process.env.AC_DEV_TEST_LAUNCH_FILE) {
    writeFileSync(
      process.env.AC_DEV_TEST_LAUNCH_FILE,
      JSON.stringify({
        commandArgs: commandInfo.commandArgs,
        environment: Object.fromEntries(
          ['AC_TMUX_SOCKET', 'AC_TMUX_EPHEMERAL', 'COCKPIT_MUX_EPHEMERAL', 'COCKPIT_MUX_HOME'].map(
            (key) => [key, childEnv[key] ?? null],
          ),
        ),
        cleanupSocket: isIsolated ? guardianTmuxSocket : null,
      }),
    );
  }
  if (isSelfTest) {
    commandInfo.command = process.execPath;
    childEnv.AC_DEV_TEST_CHILD_PID =
      process.env.AC_DEV_TEST_CHILD_PID ?? join(guardianRoot, 'child.pid');
    const simulatedApp = isSelfTestAppExit
      ? "const fs=require('node:fs');process.on('exit',()=>fs.writeFileSync(process.env.AC_DEV_APP_EXIT_FILE,'exited'));setTimeout(()=>process.exit(0),300)"
      : null;
    const supervisor = isSelfTestAppExit
      ? `const {spawn}=require('node:child_process');const fs=require('node:fs');fs.writeFileSync(process.env.AC_DEV_TEST_CHILD_PID,String(process.pid));spawn(process.execPath,['-e',${JSON.stringify(simulatedApp)}],{env:process.env,stdio:'ignore'});setInterval(()=>{},1000)`
      : "const fs=require('node:fs');fs.writeFileSync(process.env.AC_DEV_TEST_CHILD_PID,String(process.pid));setInterval(()=>{},1000)";
    commandInfo.commandArgs = ['-e', supervisor];
  }
  const child = spawn(commandInfo.command, commandInfo.commandArgs, {
    cwd: root,
    env: childEnv,
    detached: true,
    stdio: 'inherit',
  });
  const group = child.pid;
  if (!group) throw new Error('failed to start isolated Electron development process group');
  const leader = processTable().find((entry) => entry.pid === group && entry.pgid === group);
  if (!leader) throw new Error('could not capture development child process identity');
  const tracked = new Map();
  const leaderIdentity = `${leader.started}\n${leader.command}`;
  const observeGroup = () => {
    const processes = processTable();
    const currentLeader = processes.find(
      (entry) =>
        entry.pid === group &&
        entry.pgid === group &&
        `${entry.started}\n${entry.command}` === leaderIdentity &&
        !entry.state.startsWith('Z'),
    );
    if (!currentLeader) return;
    for (const entry of processes) {
      if (entry.pgid === group && !entry.state.startsWith('Z'))
        tracked.set(entry.pid, `${entry.started}\n${entry.command}`);
    }
  };
  observeGroup();
  const observer = setInterval(() => {
    try {
      observeGroup();
    } catch {
      // A transient process-table read failure is retried on the next interval.
    }
  }, 100);
  observer.unref();
  connection.write(`${JSON.stringify({ type: 'ready' })}\n`);

  let stopping = false;
  const stopChildGroup = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(observer);
    observeGroup();
    const liveTracked = () =>
      processTable().filter(
        (entry) =>
          entry.pgid === group &&
          !entry.state.startsWith('Z') &&
          tracked.get(entry.pid) === `${entry.started}\n${entry.command}`,
      );
    const leaderIsCurrent = () =>
      processTable().some(
        (entry) =>
          entry.pid === group &&
          entry.pgid === group &&
          !entry.state.startsWith('Z') &&
          `${entry.started}\n${entry.command}` === leaderIdentity,
      );
    const signalTracked = (signal) => {
      if (leaderIsCurrent()) {
        try {
          process.kill(-group, signal);
        } catch (error) {
          if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
        }
        return;
      }
      for (const entry of liveTracked()) {
        try {
          process.kill(entry.pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
        }
      }
    };
    signalTracked('SIGTERM');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_500));
    signalTracked('SIGKILL');
    if (isIsolated && guardianTmuxSocket) {
      try {
        execFileSync('tmux', ['-L', guardianTmuxSocket, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // The isolated server may already have exited with its last child.
      }
    }
    rmSync(guardianRoot, { recursive: true, force: true });
  };

  const childExit = new Promise((resolveExit) =>
    child.once('exit', (code, signal) =>
      resolveExit({ code: code ?? (signal === 'SIGKILL' ? 137 : 1) }),
    ),
  );
  const ownerClosed = new Promise((resolveClosed) =>
    connection.once('close', () => resolveClosed({ ownerClosed: true })),
  );
  let appExitPoll;
  const appExited = new Promise((resolveExit) => {
    appExitPoll = setInterval(() => {
      if (existsSync(appExitFile)) {
        clearInterval(appExitPoll);
        resolveExit({ appExited: true });
      }
    }, 50);
  });
  const result = await Promise.race([childExit, ownerClosed, appExited]);
  clearInterval(appExitPoll);
  await stopChildGroup();
  if (!result.ownerClosed) {
    const code = result.appExited ? 0 : result.code;
    connection.write(`${JSON.stringify({ type: 'exit', code })}\n`);
  }
  connection.destroy();
  if (!result.ownerClosed) rmSync(guardianRoot, { recursive: true, force: true });
}

if (args[0] === '--guardian') {
  await runGuardianProcess();
} else {
  await runController();
}
