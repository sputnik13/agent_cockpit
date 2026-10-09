#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [runRoot, socket, reportPath] = process.argv.slice(2);

function report(message) {
  if (reportPath) appendFileSync(reportPath, `${message}\n`);
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

function isAppOrMuxExecutable(entry) {
  return (
    /(?:^|[\/\s])cockpit-mux(?:-[^/\s]+)?(?:\s|$)/.test(entry.command) ||
    entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit')
  );
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Cleanup must remain live even when the supervisor was killed during an
    // older/non-atomic manifest publication.
    return fallback;
  }
}

function ownerIsAlive() {
  const ownerFile = `${runRoot}/supervisor-owner.json`;
  if (!existsSync(ownerFile)) return false;
  const owner = readJson(ownerFile, null);
  if (!owner) return false;
  try {
    process.kill(owner.pid, 0);
  } catch {
    return false;
  }
  return processTable().some(
    (entry) =>
      entry.pid === owner.pid &&
      entry.started === owner.started &&
      entry.command.includes('scripts/run-mux-e2e.mjs') &&
      !entry.state.startsWith('Z'),
  );
}

async function stopTestRunner() {
  const ownedFile = `${runRoot}/observed-processes.json`;
  const observed = readJson(ownedFile, []);
  const expected = Array.isArray(observed) ? observed : [];
  const runnerOwner = readJson(`${runRoot}/runner-owner.json`, null);
  if (runnerOwner && Number.isInteger(runnerOwner.pid)) {
    expected.push({
      pid: runnerOwner.pid,
      pgid: runnerOwner.pgid,
      started: runnerOwner.started,
      command: runnerOwner.command,
    });
  }
  // The run-scoped bootstrap remains the detached-group leader until the
  // Playwright child exits. Its unique run-root argument safely identifies it
  // even when the public supervisor dies before publishing runner-owner.json.
  const current = processTable();
  const runnerLeader = current.find(
    (entry) =>
      entry.pgid === entry.pid &&
      !entry.state.startsWith('Z') &&
      entry.command.includes('scripts/mux-e2e-runner.mjs') &&
      entry.command.includes(basename(runRoot)),
  );
  if (runnerLeader) {
    for (const entry of current) {
      if (entry.pgid === runnerLeader.pgid && !entry.state.startsWith('Z'))
        expected.push({
          pid: entry.pid,
          pgid: entry.pgid,
          started: entry.started,
          command: entry.command,
        });
    }
  }
  report(`recorded identities: ${JSON.stringify(expected)}`);
  const matches = () => {
    const processes = processTable();
    return expected.flatMap((identity) => {
      const entry = processes.find(
        (candidate) =>
          candidate.pid === identity.pid &&
          candidate.pgid === identity.pgid &&
          candidate.started === identity.started &&
          candidate.command === identity.command &&
          !candidate.state.startsWith('Z'),
      );
      return entry ? [entry] : [];
    });
  };
  for (const entry of matches()) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  report(`remaining owned processes after TERM: ${JSON.stringify(matches())}`);
  const until = Date.now() + 1_000;
  while (Date.now() < until && matches().length) await delay(25);
  for (const entry of matches()) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  report(`remaining owned processes after KILL: ${JSON.stringify(matches())}`);

  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {}

  const scopedProcesses = () =>
    processTable().filter(
      (entry) => entry.command.includes(basename(runRoot)) && isAppOrMuxExecutable(entry),
    );
  for (const entry of scopedProcesses()) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  report(`scoped app/mux processes after TERM: ${JSON.stringify(scopedProcesses())}`);
  const scopedUntil = Date.now() + 1_000;
  while (Date.now() < scopedUntil && scopedProcesses().length) await delay(25);
  for (const entry of scopedProcesses()) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  report(`scoped app/mux processes after KILL: ${JSON.stringify(scopedProcesses())}`);
  rmSync(runRoot, { recursive: true, force: true });
}

if (!runRoot || !socket) {
  throw new Error('mux e2e guardian requires a run root and isolated tmux socket');
}

appendFileSync(`${runRoot}/guardian.log`, `started pid=${process.pid}\n`);
appendFileSync(`${runRoot}/guardian.log`, `owner-alive=${ownerIsAlive()}\n`);
while (existsSync(runRoot) && ownerIsAlive()) await delay(100);
appendFileSync(`${runRoot}/guardian.log`, 'owner-exited; cleaning\n');
if (existsSync(runRoot)) await stopTestRunner();
