#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), 'agent-cockpit-dev-supervisor-test-'));
const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageMetadata.name !== 'agent-cockpit' || packageMetadata.productName !== undefined)
  throw new Error('normal development must retain its historical agent-cockpit profile identity');
if (
  !/^productName:\s*Agent Cockpit\s*$/m.test(
    readFileSync(join(root, 'electron-builder.yml'), 'utf8'),
  )
)
  throw new Error('packaged Electron product name must remain unchanged');
const resourceVariables = [
  'AC_TMUX_SOCKET',
  'AC_TMUX_EPHEMERAL',
  'COCKPIT_MUX_EPHEMERAL',
  'COCKPIT_MUX_HOME',
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

async function runScenario(isolated, stopWhenAppExits = false) {
  const scenarioRoot = join(
    testRoot,
    stopWhenAppExits ? 'app-exit' : isolated ? 'isolated' : 'normal',
  );
  mkdirSync(scenarioRoot);
  const readyFile = join(scenarioRoot, 'ready');
  const childPidFile = join(scenarioRoot, 'child.pid');
  const runRootFile = join(scenarioRoot, 'run-root');
  const launchFile = join(scenarioRoot, 'launch.json');
  const args = [join(root, 'scripts/run-dev.mjs'), '--self-test-supervisor'];
  if (stopWhenAppExits) args.push('--self-test-app-exit');
  if (isolated) args.push('--isolated');
  const childEnv = { ...process.env };
  for (const key of resourceVariables) delete childEnv[key];
  Object.assign(childEnv, {
    AC_DEV_TEST_READY_FILE: readyFile,
    AC_DEV_TEST_CHILD_PID: childPidFile,
    AC_DEV_TEST_ROOT_FILE: runRootFile,
    AC_DEV_TEST_LAUNCH_FILE: launchFile,
  });
  const controller = spawn(process.execPath, args, {
    cwd: root,
    env: childEnv,
    detached: true,
    stdio: 'inherit',
  });
  let childPid;
  let runRoot;
  try {
    if (
      !(await waitFor(
        () =>
          existsSync(readyFile) &&
          existsSync(childPidFile) &&
          existsSync(runRootFile) &&
          existsSync(launchFile),
        10_000,
      ))
    ) {
      throw new Error(`dev supervisor ${isolated ? 'isolated' : 'normal'} self-test did not start`);
    }
    const launch = JSON.parse(readFileSync(launchFile, 'utf8'));
    childPid = Number(readFileSync(childPidFile, 'utf8'));
    runRoot = readFileSync(runRootFile, 'utf8');
    if (isolated) {
      if (!launch.commandArgs.some((arg) => arg.startsWith('--user-data-dir=')))
        throw new Error('isolated dev launch did not receive a temporary user-data directory');
      if (!launch.environment.AC_TMUX_SOCKET?.startsWith('ac-dev-'))
        throw new Error('isolated dev launch did not receive its unique tmux socket');
      if (
        launch.environment.AC_TMUX_EPHEMERAL !== '1' ||
        launch.environment.COCKPIT_MUX_EPHEMERAL !== '1'
      )
        throw new Error('isolated dev launch did not enable ephemeral session cleanup');
      if (launch.environment.COCKPIT_MUX_HOME !== join(runRoot, 'mux-home'))
        throw new Error(
          `isolated dev mux home was ${launch.environment.COCKPIT_MUX_HOME}; expected ${join(runRoot, 'mux-home')}`,
        );
      if (launch.cleanupSocket !== launch.environment.AC_TMUX_SOCKET)
        throw new Error('isolated dev cleanup target does not match its unique tmux socket');
    } else {
      if (launch.commandArgs.some((arg) => arg.startsWith('--user-data-dir=')))
        throw new Error('normal dev launch must not override Electron userData');
      if (resourceVariables.some((key) => launch.environment[key] !== null))
        throw new Error('normal dev launch must inherit default persistent session resources');
      if (launch.cleanupSocket !== null)
        throw new Error('normal dev cleanup must not target a tmux socket');
    }

    if (stopWhenAppExits) {
      const controllerExited = await waitFor(() => controller.exitCode !== null, 10_000);
      if (!controllerExited)
        throw new Error('dev supervisor remained alive after the simulated Electron app exited');
      if (controller.exitCode !== 0)
        throw new Error(`dev supervisor exited with ${controller.exitCode} after app quit`);
    } else {
      process.kill(controller.pid, 'SIGKILL');
    }
    const childWasReaped = await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch (error) {
        return error.code === 'ESRCH';
      }
    }, 5_000);
    if (!childWasReaped)
      throw new Error(`dev child process ${childPid} survived controller SIGKILL`);
    if (!(await waitFor(() => !existsSync(runRoot), 5_000)))
      throw new Error(`dev supervisor temporary root ${runRoot} survived guardian cleanup`);
  } finally {
    if (controller.exitCode === null) controller.kill('SIGKILL');
    if (childPid) {
      await waitFor(() => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch (error) {
          return error.code === 'ESRCH';
        }
      }, 5_000);
    }
    if (runRoot) await waitFor(() => !existsSync(runRoot), 5_000);
  }
}

try {
  const launcherOutput = join(testRoot, 'launcher-output');
  execFileSync(join(root, 'bin/make-dev-app'), [launcherOutput], { stdio: 'pipe' });
  const launcher = join(launcherOutput, 'Agent Cockpit (Dev).app');
  const launcherPlist = readFileSync(join(launcher, 'Contents/Info.plist'), 'utf8');
  if (!/<key>LSUIElement<\/key>\s*<true\/>/.test(launcherPlist))
    throw new Error('generated dev launcher must stay out of the Dock');
  const launcherScript = readFileSync(join(launcher, 'Contents/MacOS/launch'), 'utf8');
  if (!launcherScript.includes('exec npm run dev'))
    throw new Error('generated dev launcher must continue to run the normal dev command');

  await runScenario(false);
  await runScenario(true);
  await runScenario(false, true);
  console.log(
    'Dev supervisor tests passed: launcher is Dock-hidden; normal launches preserve default resources; isolated launches clean unique resources; app quit and controller SIGKILL both reap supervised processes.',
  );
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}
