#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), 'agent-cockpit-isolated-guardian-test-'));
const profileRoot = join(testRoot, 'agent-cockpit-isolated-test-profile');
const buildRoot = join(testRoot, 'isolated-current-test-build');
mkdirSync(profileRoot);
mkdirSync(buildRoot);
const socket = `ac-isolated-test-${process.pid}`;
const readyFile = join(testRoot, 'child.pid');
const controller = spawn(
  process.execPath,
  [
    '-e',
    "const {spawn,execFileSync}=require('node:child_process');const fs=require('node:fs');const owner=execFileSync('ps',['-o','lstart=','-p',String(process.pid)],{encoding:'utf8'}).trim();spawn(process.execPath,[process.argv[1],process.argv[2],process.argv[3],process.argv[4],String(process.pid),owner],{stdio:'ignore'});const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[5],String(child.pid));setInterval(()=>{},1000)",
    join(root, 'scripts/start-isolated-run-guardian.mjs'),
    profileRoot,
    buildRoot,
    socket,
    readyFile,
  ],
  { cwd: root, detached: true, stdio: 'ignore' },
);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

function processTable() {
  return execFileSync('ps', ['-axo', 'pid=,stat=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      return match ? { pid: Number(match[1]), state: match[2], command: match[3] } : null;
    })
    .filter(Boolean);
}

try {
  if (!(await waitFor(() => existsSync(readyFile), 5_000)))
    throw new Error('isolated-run guardian fixture did not start its child');
  const childPid = Number(readFileSync(readyFile, 'utf8'));
  execFileSync('tmux', ['-L', socket, 'new-session', '-d', '-s', 'guardian-test', 'sleep 600']);
  process.kill(controller.pid, 'SIGKILL');

  const cleaned = await waitFor(() => {
    const child = processTable().find(
      (entry) => entry.pid === childPid && !entry.state.startsWith('Z'),
    );
    return !child && !existsSync(profileRoot) && !existsSync(buildRoot);
  }, 8_000);
  if (!cleaned) throw new Error('isolated-run guardian did not reap the child and temporary roots');
  try {
    execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{socket_path}'], {
      stdio: 'ignore',
    });
    throw new Error(`isolated tmux server ${socket} survived guardian cleanup`);
  } catch (error) {
    if (error.message.includes('survived guardian')) throw error;
  }
  console.log(
    'Isolated-run guardian regression passed: SIGKILL reaped the child, temporary roots, and unique tmux server.',
  );
} finally {
  try {
    process.kill(controller.pid, 'SIGKILL');
  } catch {}
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  if (!existsSync(profileRoot) && !existsSync(buildRoot))
    rmSync(testRoot, { recursive: true, force: true });
}
