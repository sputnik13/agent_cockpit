#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), 'agent-cockpit-e2e-guardian-test-'));
const runRootFile = join(testRoot, 'run-root');
const guardianReport = join(testRoot, 'guardian-report.log');
const spawnGapRootFile = join(testRoot, 'spawn-gap-root');
const spawnGapReadyFile = join(testRoot, 'spawn-gap-ready');
const app =
  process.env['COCKPIT_E2E_APP'] ??
  join(root, 'release/mac-arm64/Agent Cockpit.app/Contents/MacOS/Agent Cockpit');
if (!existsSync(app)) throw new Error(`packaged test app is missing: ${app}`);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await delay(50);
  }
  return predicate();
}

async function verifyRunnerOwnerPublishGap() {
  const supervisor = spawn(
    process.execPath,
    [join(root, 'scripts/run-mux-e2e.mjs'), '--self-test-entrypoint'],
    {
      cwd: root,
      env: {
        ...process.env,
        COCKPIT_E2E_ROOT_FILE: spawnGapRootFile,
        COCKPIT_E2E_GUARDIAN_REPORT: guardianReport,
        COCKPIT_E2E_OWNER_PUBLISH_DELAY_MS: '10000',
        COCKPIT_E2E_BOOTSTRAP_READY_FILE: spawnGapReadyFile,
        COCKPIT_E2E_TEST_WAIT_FOR_SUPERVISOR_KILL: '1',
      },
      detached: true,
      stdio: 'ignore',
    },
  );
  if (!(await waitFor(() => existsSync(spawnGapRootFile), 10_000)))
    throw new Error('spawn-gap supervisor did not create its run-root marker');
  const gapRoot = readFileSync(spawnGapRootFile, 'utf8');
  const readyFile = join(gapRoot, 'runner-ready');
  if (!(await waitFor(() => existsSync(readyFile), 10_000)))
    throw new Error('spawn-gap runner did not start');
  if (!(await waitFor(() => existsSync(spawnGapReadyFile), 5_000)))
    throw new Error('spawn-gap runner did not reach the explicit bootstrap barrier');
  const owner = JSON.parse(readFileSync(join(gapRoot, 'supervisor-owner.json'), 'utf8'));
  const runnerOwnerPath = join(gapRoot, 'runner-owner.json');
  if (existsSync(runnerOwnerPath))
    throw new Error('spawn-gap regression did not reach the pre-publication window');
  const supervisorIdentity = processTable().find(
    (entry) =>
      entry.pid === owner.pid &&
      entry.started === owner.started &&
      entry.command === owner.command &&
      !entry.state.startsWith('Z'),
  );
  if (!supervisorIdentity)
    throw new Error('spawn-gap supervisor identity was not live at the explicit barrier');
  let captured = [];
  await waitFor(() => {
    captured = processTable().filter(
      (entry) =>
        entry.command.includes('scripts/mux-e2e-runner.mjs') &&
        entry.command.includes(basename(gapRoot)),
    );
    return captured.length > 0;
  }, 5_000);
  if (!captured.length)
    throw new Error('run-scoped bootstrap was not observable during the owner-publication gap');
  const gapIdentities = processTable().filter(
    (entry) => entry.pgid === captured[0].pgid && !entry.state.startsWith('Z'),
  );
  process.kill(supervisorIdentity.pid, 'SIGKILL');
  const guardianCleanedGap = await waitFor(() => {
    if (existsSync(gapRoot)) return false;
    const current = processTable();
    return gapIdentities.every(
      (identity) =>
        !current.some(
          (entry) =>
            entry.pid === identity.pid &&
            entry.started === identity.started &&
            entry.command === identity.command &&
            !entry.state.startsWith('Z'),
        ),
    );
  }, 15_000);
  if (!guardianCleanedGap)
    throw new Error(`guardian failed spawn-before-owner-record recovery for ${gapRoot}`);
  try {
    process.kill(supervisor.pid, 'SIGKILL');
  } catch {}
}

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

function isScopedAppOrMux(entry, runRoot) {
  // macOS can spell the same temporary directory as /var/... or
  // /private/var/... in different child command lines. The mkdtemp suffix is
  // unique to this run and stable across both spellings.
  if (!entry.command.includes(basename(runRoot))) return false;
  return (
    /(?:^|[\/\s])cockpit-mux(?:-[^/\s]+)?(?:\s|$)/.test(entry.command) ||
    entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit')
  );
}

let runRoot;
let socket;
let entrypoint;
let cleaned = false;
try {
  await verifyRunnerOwnerPublishGap();
  entrypoint = spawn(process.execPath, [join(root, 'scripts/run-mux-e2e.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      COCKPIT_E2E_APP: app,
      COCKPIT_E2E_ROOT_FILE: runRootFile,
      COCKPIT_E2E_GUARDIAN_REPORT: guardianReport,
    },
    detached: true,
    stdio: 'ignore',
  });
  if (!(await waitFor(() => existsSync(runRootFile), 10_000)))
    throw new Error('public E2E supervisor did not create its run-root marker');
  runRoot = readFileSync(runRootFile, 'utf8');
  const readyFile = join(runRoot, 'runner-ready');
  if (!(await waitFor(() => existsSync(readyFile), 180_000)))
    throw new Error(
      `E2E did not create a live mux pane; guardian report: ${existsSync(guardianReport) ? readFileSync(guardianReport, 'utf8') : '(none)'}`,
    );

  socket = readFileSync(join(runRoot, 'tmux-socket'), 'utf8');
  execFileSync('tmux', [
    '-L',
    socket,
    'new-session',
    '-d',
    '-s',
    'guardian-regression',
    'sleep 600',
  ]);
  const liveResources = processTable().filter((entry) => isScopedAppOrMux(entry, runRoot));
  if (
    !liveResources.some((entry) =>
      entry.command.includes('Agent Cockpit.app/Contents/MacOS/Agent Cockpit'),
    )
  )
    throw new Error(
      'guardian regression did not observe the packaged Electron app alive before SIGKILL',
    );

  const beforeKill = processTable();
  const runnerBootstrap = beforeKill.find(
    (entry) =>
      entry.command.includes('scripts/mux-e2e-runner.mjs') &&
      entry.command.includes(basename(runRoot)),
  );
  if (!runnerBootstrap)
    throw new Error('run-scoped Playwright bootstrap was not live before SIGKILL');
  const ownedPids = new Set([runnerBootstrap.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of beforeKill) {
      if (ownedPids.has(entry.ppid) && !ownedPids.has(entry.pid)) {
        ownedPids.add(entry.pid);
        changed = true;
      }
    }
  }
  const playwright = beforeKill.find(
    (entry) => ownedPids.has(entry.pid) && entry.command.includes('@playwright/test/cli.js'),
  );
  if (!playwright)
    throw new Error('Playwright process was not a child of the run-scoped bootstrap');
  const appOrMux = liveResources.filter((entry) => isScopedAppOrMux(entry, runRoot));
  const muxPids = new Set(
    appOrMux.filter((entry) => /cockpit-mux/.test(entry.command)).map((e) => e.pid),
  );
  const muxDescendants = new Set(muxPids);
  changed = true;
  while (changed) {
    changed = false;
    for (const entry of beforeKill) {
      if (muxDescendants.has(entry.ppid) && !muxDescendants.has(entry.pid)) {
        muxDescendants.add(entry.pid);
        changed = true;
      }
    }
  }
  const shellHelpers = beforeKill.filter(
    (entry) =>
      muxDescendants.has(entry.pid) && /(?:^|\/)(?:zsh|bash|fish|sh)(?:\s|$)/.test(entry.command),
  );
  if (!shellHelpers.length) throw new Error('no PTY shell descendant was observed before SIGKILL');
  const ptyProcessIdentities = beforeKill.filter((entry) => muxDescendants.has(entry.pid));
  const identitiesToReap = [...ownedPids]
    .map((pid) => beforeKill.find((entry) => entry.pid === pid))
    .filter(Boolean);
  identitiesToReap.push(...ptyProcessIdentities);
  if (
    !liveResources.some((entry) =>
      /(?:^|[\/\s])cockpit-mux(?:-[^/\s]+)?(?:\s|$)/.test(entry.command),
    )
  )
    throw new Error(
      'guardian regression did not observe the scoped cockpit-mux daemon alive before SIGKILL',
    );

  process.kill(entrypoint.pid, 'SIGKILL');
  const guardianCleaned = await waitFor(() => {
    if (existsSync(runRoot)) return false;
    const leftovers = processTable().filter((entry) => isScopedAppOrMux(entry, runRoot));
    if (leftovers.length) return false;
    const current = processTable();
    return identitiesToReap.every(
      (identity) =>
        !current.some(
          (entry) =>
            entry.pid === identity.pid &&
            entry.started === identity.started &&
            entry.command === identity.command &&
            !entry.state.startsWith('Z'),
        ),
    );
  }, 30_000);
  if (!guardianCleaned)
    throw new Error(
      `guardian failed to clean app/mux after entrypoint SIGKILL (root ${runRoot}); report: ${existsSync(guardianReport) ? readFileSync(guardianReport, 'utf8') : '(none)'}`,
    );

  try {
    execFileSync('tmux', ['-L', socket, 'display-message', '-p', '#{socket_path}'], {
      stdio: 'ignore',
    });
    throw new Error(`isolated tmux server ${socket} survived E2E entrypoint SIGKILL`);
  } catch (error) {
    if (error.message.includes('survived E2E')) throw error;
  }
  cleaned = true;
  console.log(
    'E2E guardian regression passed: SIGKILL reaped a live packaged app, mux daemon, Playwright run, and isolated tmux server.',
  );
} finally {
  if (!cleaned && entrypoint.exitCode === null) {
    try {
      process.kill(entrypoint.pid, 'SIGKILL');
    } catch {}
  }
  if (runRoot && existsSync(runRoot)) await waitFor(() => !existsSync(runRoot), 30_000);
  if (cleaned || !runRoot || !existsSync(runRoot))
    rmSync(testRoot, { recursive: true, force: true });
}
