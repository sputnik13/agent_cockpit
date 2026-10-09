#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runRoot = mkdtempSync(join(tmpdir(), 'agent-cockpit-mux-e2e-run-'));
const socket = `ac-e2e-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const readyFile = join(runRoot, 'runner-ready');
const sigkillCheck = process.argv.includes('--verify-sigkill-cleanup');
const selfTestEntrypoint =
  process.argv.includes('--self-test-entrypoint') ||
  process.env.COCKPIT_E2E_SELF_TEST_ENTRYPOINT === '1';
const selfTestInterrupt = process.argv.includes('--self-test-interrupt');
const selfTest = process.argv.includes('--self-test') || selfTestInterrupt || selfTestEntrypoint;
let selfTestHelperPid = 0;
// Remember process identities, not only bare PGIDs: process groups can be
// reused after a test exits. A group is signaled only while one of its sampled
// members still has the same PID, PGID, start time, and command.
const observedGroups = new Map();
const observedGroupLeaders = new Map();
let receivedSignal = null;
let runnerIdentity = null;
let signalEscalationTimer;

function processTable() {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/);
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

function isAppOrMuxExecutable(entry) {
  return (
    /(?:^|[\/\s])cockpit-mux(?:-[^/\s]+)?(?:\s|$)/.test(entry.command) ||
    entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit')
  );
}

function commandIsInRunRoot(entry) {
  // /var/folders and /private/var/folders may refer to the same macOS path.
  return entry.command.includes(basename(runRoot));
}

function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value));
  renameSync(temporaryPath, path);
}

function startGuardian() {
  if (selfTest || process.env.COCKPIT_E2E_ROOT_FILE)
    writeFileSync(process.env.COCKPIT_E2E_ROOT_FILE ?? join(runRoot, 'run-root'), runRoot);
  writeFileSync(join(runRoot, 'tmux-socket'), socket);
  const owner = processTable().find((entry) => entry.pid === process.pid);
  if (!owner) throw new Error('could not capture e2e supervisor process identity for guardian');
  writeJsonAtomically(join(runRoot, 'supervisor-owner.json'), owner);
  const guardian = spawn(
    process.execPath,
    [
      join(root, 'scripts', 'mux-e2e-guardian.mjs'),
      runRoot,
      socket,
      process.env.COCKPIT_E2E_GUARDIAN_REPORT ?? '',
    ],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'ignore', openSync(join(runRoot, 'guardian.log'), 'a')],
    },
  );
  guardian.on('error', (error) => writeFileSync(join(runRoot, 'guardian.log'), String(error)));
  writeFileSync(join(runRoot, 'guardian.pid'), String(guardian.pid ?? ''));
  guardian.unref();
}

function rememberOwnedProcessGroups() {
  const processes = processTable();
  const owned = new Set(
    processes
      .filter((entry) => commandIsInRunRoot(entry) && isAppOrMuxExecutable(entry))
      .map((entry) => entry.pid),
  );
  const runnerEntry = processes.find((entry) => entry.pid === runner?.pid);
  if (runnerEntry && runnerIdentity === `${runnerEntry.started}\n${runnerEntry.command}`)
    owned.add(runnerEntry.pid);
  if (selfTest && existsSync(readyFile)) {
    const helperPid = Number(readFileSync(readyFile, 'utf8'));
    if (
      Number.isInteger(helperPid) &&
      helperPid > 0 &&
      processes.some((entry) => entry.pid === helperPid)
    )
      owned.add(helperPid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (owned.has(entry.ppid) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        changed = true;
      }
    }
  }
  for (const entry of processes) {
    if (owned.has(entry.pid) && entry.pgid > 0) {
      if (!observedGroups.has(entry.pgid)) observedGroups.set(entry.pgid, new Map());
      observedGroups.get(entry.pgid).set(entry.pid, `${entry.started}\n${entry.command}`);
      if (entry.pid === entry.pgid)
        observedGroupLeaders.set(entry.pgid, `${entry.started}\n${entry.command}`);
    }
  }
  // While a verified leader is still present, capture all members of its
  // process group. Some helpers can detach from the parent process tree while
  // remaining in the run's process group. Never adopt group members after the
  // exact leader identity has disappeared; PGIDs are reusable.
  for (const [pgid, leaderIdentity] of observedGroupLeaders) {
    const leader = processes.find(
      (entry) =>
        entry.pid === pgid &&
        entry.pgid === pgid &&
        leaderIdentity.startsWith(`${entry.started}\n`),
    );
    if (!leader) continue;
    for (const entry of processes) {
      if (entry.pgid !== pgid || entry.state.startsWith('Z')) continue;
      if (!observedGroups.has(pgid)) observedGroups.set(pgid, new Map());
      observedGroups.get(pgid).set(entry.pid, `${entry.started}\n${entry.command}`);
    }
  }
  const identities = [];
  for (const [pgid, members] of observedGroups) {
    for (const [pid, identity] of members) {
      const separator = identity.indexOf('\n');
      identities.push({
        pid,
        pgid,
        started: identity.slice(0, separator),
        command: identity.slice(separator + 1),
      });
    }
  }
  writeJsonAtomically(join(runRoot, 'observed-processes.json'), identities);
}

function liveGroupMembers(pgid) {
  const identities = observedGroups.get(pgid);
  if (!identities) return [];
  return processTable().filter(
    (entry) =>
      entry.pgid === pgid &&
      !entry.state.startsWith('Z') &&
      identities.get(entry.pid) === `${entry.started}\n${entry.command}`,
  );
}

function signalObservedGroup(pgid, signal) {
  const members = processTable().filter(
    (entry) => entry.pgid === pgid && !entry.state.startsWith('Z'),
  );
  if (members.length === 0) return;
  const knownLeader = observedGroupLeaders.get(pgid);
  const currentLeader = members.find((entry) => entry.pid === pgid);
  const leaderMatches =
    currentLeader && knownLeader === `${currentLeader.started}\n${currentLeader.command}`;
  if (currentLeader && knownLeader && !leaderMatches) return;
  // A PGID is reusable once its original leader/group has gone away. Never
  // signal a leaderless group by its historic number: signal only sampled
  // identities in that case, each of which is checked again below.
  if (leaderMatches) {
    try {
      process.kill(-pgid, signal);
      return;
    } catch (error) {
      if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
    }
  }
  for (const entry of members) {
    const identity = observedGroups.get(pgid)?.get(entry.pid);
    if (identity !== `${entry.started}\n${entry.command}`) continue;
    try {
      process.kill(entry.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}

function killTestTmuxServer() {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // The unique test server may never have started or may already be gone.
  }
}

function testTmuxServerIsGone() {
  try {
    execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{socket_path}'], {
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function cleanup(runner, pgid) {
  rememberOwnedProcessGroups();
  if (runner && runner.exitCode === null) signalObservedGroup(pgid, 'SIGTERM');
  for (const ownedGroup of observedGroups.keys()) signalObservedGroup(ownedGroup, 'SIGTERM');
  await waitUntil(() => {
    rememberOwnedProcessGroups();
    return ![...observedGroups.keys()].some((group) => liveGroupMembers(group).length > 0);
  }, 2_000);
  for (const ownedGroup of observedGroups.keys()) {
    signalObservedGroup(ownedGroup, 'SIGKILL');
  }
  await waitUntil(() => {
    rememberOwnedProcessGroups();
    return ![...observedGroups.keys()].some((group) => liveGroupMembers(group).length > 0);
  }, 2_000);
  killTestTmuxServer();
  await waitUntil(testTmuxServerIsGone, 2_000);
  if (!testTmuxServerIsGone())
    throw new Error(`isolated tmux server for socket ${socket} survived teardown`);

  // Mux daemons are detached by Electron; their --home path is unique to this
  // run. Never use a broad pkill or touch the developer's default tmux socket.
  const scopedMux = () =>
    processTable().filter((entry) => commandIsInRunRoot(entry) && isAppOrMuxExecutable(entry));
  for (const entry of scopedMux()) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  await waitUntil(() => scopedMux().length === 0, 2_000);
  for (const entry of scopedMux()) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  const leftovers = scopedMux();
  if (leftovers.length) {
    throw new Error(
      `scoped app/mux processes survived teardown: ${leftovers.map((p) => `${p.pid} ${p.command}`).join('\n')}`,
    );
  }
  if (liveGroupMembers(pgid).length)
    throw new Error(`test process group ${pgid} survived teardown`);
  rmSync(runRoot, { recursive: true, force: true });
}

async function waitForOwnerPipeShutdown(pgid) {
  rememberOwnedProcessGroups();
  const scopedAppMux = () =>
    processTable().filter(
      (entry) => entry.command.includes(runRoot) && isAppOrMuxExecutable(entry),
    );
  return waitUntil(
    () =>
      scopedAppMux().length === 0 &&
      [...observedGroups.keys()]
        .filter((ownedGroup) => ownedGroup !== pgid)
        .every((ownedGroup) => liveGroupMembers(ownedGroup).length === 0),
    5_000,
  );
}

async function waitForKillReadiness(pgid) {
  return waitUntil(() => {
    rememberOwnedProcessGroups();
    const processes = processTable();
    const hasScopedMux = processes.some(
      (entry) =>
        commandIsInRunRoot(entry) &&
        isAppOrMuxExecutable(entry) &&
        /cockpit-mux/.test(entry.command),
    );
    const hasOwnedPtyShell = [...observedGroups.entries()].some(
      ([group, identities]) =>
        group !== pgid &&
        [...identities.keys()].some((pid) => {
          const entry = processes.find(
            (candidate) => candidate.pid === pid && candidate.pgid === group,
          );
          return entry && /(^|\/)(zsh|bash|fish|sh)(\s|$)/.test(entry.command);
        }),
    );
    return hasScopedMux && hasOwnedPtyShell;
  }, 10_000);
}

let runner;
let expectedSigkill = false;
let finished = false;
const command = process.execPath;
const args = selfTest
  ? [
      '-e',
      `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const helper = ${selfTestEntrypoint ? 'null' : "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })"};
      writeFileSync(process.env.COCKPIT_RUNNER_READY, String(helper?.pid ?? process.pid));
      if (process.env.COCKPIT_E2E_BOOTSTRAP_READY_FILE) writeFileSync(process.env.COCKPIT_E2E_BOOTSTRAP_READY_FILE, 'ready');
      ${selfTestEntrypoint ? "if (process.env.COCKPIT_E2E_TEST_WAIT_FOR_SUPERVISOR_KILL !== '1') setTimeout(() => process.kill(Number(process.env.COCKPIT_E2E_ENTRYPOINT_PID), 'SIGKILL'), 1000);" : selfTestInterrupt ? "setTimeout(() => process.kill(Number(process.env.COCKPIT_E2E_ENTRYPOINT_PID), 'SIGINT'), 1000);" : "setTimeout(() => process.kill(process.pid, 'SIGKILL'), 1000);"}
      setInterval(() => {}, 1000);
    `,
    ]
  : [
      join(root, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      '-c',
      'playwright.mux.config.ts',
    ];
if (!selfTest && process.env.COCKPIT_E2E_GREP) {
  args.push('--grep', process.env.COCKPIT_E2E_GREP);
}

const env = {
  ...process.env,
  AC_TMUX_SOCKET: socket,
  COCKPIT_E2E_TEMP_ROOT: runRoot,
  COCKPIT_E2E_RESULTS_DIR: join(runRoot, 'results'),
  COCKPIT_E2E_READY_FILE: readyFile,
  // The dedicated SIGKILL regression asserts that the explicit owner pipe
  // reaps ephemeral daemons. Normal topology tests exercise production mode,
  // where a daemon survives Electron quit and is reaped by the run guardian.
  ...(sigkillCheck ? { COCKPIT_MUX_EPHEMERAL: '1' } : {}),
  ...(sigkillCheck ? { COCKPIT_E2E_KILL_AFTER_READY: '1' } : {}),
  ...(selfTest ? { COCKPIT_RUNNER_READY: readyFile } : {}),
  ...(process.env.COCKPIT_E2E_BOOTSTRAP_READY_FILE
    ? { COCKPIT_E2E_BOOTSTRAP_READY_FILE: process.env.COCKPIT_E2E_BOOTSTRAP_READY_FILE }
    : {}),
  ...(selfTestEntrypoint || selfTestInterrupt
    ? { COCKPIT_E2E_ENTRYPOINT_PID: String(process.pid) }
    : {}),
};

startGuardian();
runner = spawn(
  process.execPath,
  [join(root, 'scripts', 'mux-e2e-runner.mjs'), runRoot, command, ...args],
  { cwd: root, env, detached: true, stdio: 'inherit' },
);
const processGroup = runner.pid;
if (!processGroup) throw new Error('failed to start isolated Playwright process group');
const ownerPublishDelay = Number(process.env.COCKPIT_E2E_OWNER_PUBLISH_DELAY_MS ?? 0);
if (Number.isFinite(ownerPublishDelay) && ownerPublishDelay > 0)
  await new Promise((resolve) => setTimeout(resolve, Math.min(ownerPublishDelay, 10_000)));
const runnerEntry = processTable().find((entry) => entry.pid === processGroup);
if (runnerEntry) {
  runnerIdentity = `${runnerEntry.started}\n${runnerEntry.command}`;
  observedGroupLeaders.set(processGroup, runnerIdentity);
  writeJsonAtomically(join(runRoot, 'runner-owner.json'), { pid: processGroup, ...runnerEntry });
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (receivedSignal) return;
    receivedSignal = signal;
    // Interrupt only the detached group created for this run. The signal
    // handler leaves the normal exit path to await the runner and run cleanup.
    signalObservedGroup(processGroup, 'SIGTERM');
    signalEscalationTimer = setTimeout(() => {
      try {
        rememberOwnedProcessGroups();
        for (const ownedGroup of observedGroups.keys()) signalObservedGroup(ownedGroup, 'SIGKILL');
        for (const entry of processTable().filter(
          (candidate) => commandIsInRunRoot(candidate) && isAppOrMuxExecutable(candidate),
        )) {
          try {
            process.kill(entry.pid, 'SIGKILL');
          } catch {}
        }
        killTestTmuxServer();
      } catch {}
    }, 2_000);
    signalEscalationTimer.unref();
  });
}
rememberOwnedProcessGroups();
const processObserver = setInterval(() => {
  try {
    rememberOwnedProcessGroups();
  } catch {}
}, 100);
processObserver.unref();

const exitCode = await new Promise((resolve, reject) => {
  runner.once('error', reject);
  runner.once('exit', (code, signal) => {
    expectedSigkill = sigkillCheck && signal === 'SIGKILL';
    resolve(code ?? (signal === 'SIGKILL' ? 137 : 1));
  });
  if (sigkillCheck || selfTest) {
    let readinessPending = false;
    const interval = setInterval(() => {
      if (!existsSync(readyFile)) return;
      if (sigkillCheck && !readinessPending) {
        readinessPending = true;
        void waitForKillReadiness(processGroup).then((ready) => {
          clearInterval(interval);
          if (!ready) return;
          signalObservedGroup(processGroup, 'SIGKILL');
        });
        return;
      }
      if (sigkillCheck) return;
      clearInterval(interval);
      if (selfTestInterrupt || selfTestEntrypoint) return;
      if (selfTest) signalObservedGroup(processGroup, 'SIGKILL');
    }, 25);
    interval.unref();
  }
});
clearInterval(processObserver);
clearTimeout(signalEscalationTimer);

if (selfTest && existsSync(readyFile)) selfTestHelperPid = Number(readFileSync(readyFile, 'utf8'));

try {
  // In the hard-kill mode, first give the Electron-owned daemon a chance to
  // stop solely because SIGKILL closed its owner-pipe writer. The supervisor's
  // ordinary process-group fallback must not mask a broken owner-pipe path.
  const ownerPipeShutdownSucceeded =
    sigkillCheck && expectedSigkill ? await waitForOwnerPipeShutdown(processGroup) : true;
  await cleanup(runner, processGroup);
  finished = true;
  if (!ownerPipeShutdownSucceeded)
    throw new Error('mux/app processes survived Electron owner-pipe EOF after runner SIGKILL');
} finally {
  if (!finished) rmSync(runRoot, { recursive: true, force: true });
}

if (sigkillCheck && !expectedSigkill)
  throw new Error('SIGKILL cleanup check did not observe the expected runner SIGKILL');
if (selfTestInterrupt && receivedSignal !== 'SIGINT')
  throw new Error('interrupt cleanup self-test did not observe SIGINT');
if (sigkillCheck) {
  console.log(
    'SIGKILL cleanup passed: the Playwright process group, scoped mux/app, and isolated tmux server were reaped.',
  );
} else if (selfTest) {
  try {
    process.kill(selfTestHelperPid, 0);
    throw new Error(`self-test helper ${selfTestHelperPid} survived SIGKILL cleanup`);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  console.log(
    selfTestInterrupt
      ? 'Supervisor self-test passed: SIGINT of the supervisor reaped the runner process group.'
      : 'Supervisor self-test passed: SIGKILL of the runner reaped its child process.',
  );
}
process.exitCode =
  receivedSignal === 'SIGINT'
    ? 130
    : receivedSignal === 'SIGTERM'
      ? 143
      : sigkillCheck || selfTest
        ? 0
        : exitCode;
