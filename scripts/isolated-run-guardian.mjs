#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [profileRoot, buildRoot, tmuxSocket, ownerPidValue, ownerStarted] = process.argv.slice(2);
const ownerPid = Number(ownerPidValue);
if (
  !profileRoot ||
  !buildRoot ||
  !tmuxSocket ||
  !Number.isInteger(ownerPid) ||
  ownerPid <= 0 ||
  !ownerStarted
) {
  throw new Error(
    'isolated-run guardian requires unique profile/build roots, a tmux socket, and owner identity',
  );
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

const identities = new Map();
let appWasLaunched = false;
function ownerIsAlive(processes) {
  return processes.some(
    (entry) =>
      entry.pid === ownerPid && entry.started === ownerStarted && !entry.state.startsWith('Z'),
  );
}

function scopedProcess(entry) {
  const profileToken = basename(profileRoot);
  const buildToken = basename(buildRoot);
  return entry.command.includes(profileToken) || entry.command.includes(buildToken);
}

function observeOwned(processes) {
  // Never discover descendants from a numeric PID until its original start
  // identity has been observed alive. Otherwise PID reuse could enroll an
  // unrelated process tree after the launcher exits.
  const verifiedOwner = ownerIsAlive(processes);
  if (!verifiedOwner && identities.size === 0) return;
  let changed = true;
  const owned = new Set();
  if (verifiedOwner) owned.add(ownerPid);
  for (const [pid, identity] of identities) {
    const entry = processes.find((candidate) => candidate.pid === pid);
    if (entry && identity === `${entry.started}\n${entry.command}` && !entry.state.startsWith('Z'))
      owned.add(pid);
  }
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
    if (owned.has(entry.pid) && entry.pid !== ownerPid && !entry.state.startsWith('Z'))
      identities.set(entry.pid, `${entry.started}\n${entry.command}`);
    if (
      entry.command.includes(basename(profileRoot)) &&
      entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit')
    )
      appWasLaunched = true;
  }
}

function liveOwnedProcesses() {
  return processTable().filter((entry) => {
    if (entry.pid === process.pid) return false;
    if (entry.state.startsWith('Z')) return false;
    const identity = identities.get(entry.pid);
    return (identity && identity === `${entry.started}\n${entry.command}`) || scopedProcess(entry);
  });
}

async function cleanOwnedResources() {
  try {
    execFileSync('tmux', ['-L', tmuxSocket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // The unique server may not have started.
  }
  const candidates = () => liveOwnedProcesses();
  for (const entry of candidates()) {
    try {
      process.kill(entry.pid, 'SIGTERM');
    } catch {}
  }
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline && candidates().length) await delay(25);
  for (const entry of candidates()) {
    try {
      process.kill(entry.pid, 'SIGKILL');
    } catch {}
  }
  const leftovers = candidates();
  if (leftovers.length)
    throw new Error(
      `isolated processes survived teardown: ${leftovers.map((entry) => `${entry.pid} ${entry.command}`).join('\n')}`,
    );
  rmSync(profileRoot, { recursive: true, force: true });
  if (!appWasLaunched) rmSync(buildRoot, { recursive: true, force: true });
}

while (true) {
  if (!existsSync(profileRoot) && !existsSync(buildRoot)) break;
  let processes;
  try {
    processes = processTable();
  } catch {
    await delay(250);
    continue;
  }
  observeOwned(processes);
  const appIsAlive = processes.some(
    (entry) =>
      !entry.state.startsWith('Z') &&
      entry.command.includes(basename(profileRoot)) &&
      entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit'),
  );
  if (ownerIsAlive(processes) || appIsAlive) {
    await delay(100);
    continue;
  }
  await cleanOwnedResources();
  break;
}
