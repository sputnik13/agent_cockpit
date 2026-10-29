/**
 * `cockpit open` from a real terminal pane of the BUILT app (scenario 16, live):
 * the file opens as a Content tab and the terminal keeps the keyboard.
 *
 * Everything the run touches is owned by the run: an Electron profile
 * (`--user-data-dir`), a tmux socket (`ac-e2e-*`) inside its own `TMUX_TMPDIR` (set
 * for the app AND for every tmux call this spec makes, so both sides address the same
 * server and removing the directory removes any socket file a killed server leaves),
 * a mux home and two throwaway git projects, all removed afterwards. The
 * window is kept hidden (`COCKPIT_PLAYWRIGHT_HEADLESS`) so the run never takes
 * the developer's real desktop focus; DOM focus inside the page is what is
 * asserted, and that does not need an OS-focused window.
 *
 * The shell in the pane is `/bin/sh`: no rc files, no prompt framework, no
 * first-run wizard, so what is typed and what is printed are predictable.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const TMUX_SOCKET = `ac-e2e-cb-${process.pid}-${randomBytes(3).toString('hex')}`;

let app: ElectronApplication;
let page: Page;
let runDir: string;
let userDataDir: string;
/** This run's tmux socket directory (short: a unix socket path is limited to ~104 bytes). */
let tmuxTmpDir: string;

interface Project {
  id: string;
  root: string;
}
let projectA: Project;
let projectB: Project;

/** The app's environment: nothing inherited from a cockpit this run may be launched from. */
function isolatedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(ELECTRON_|AC_|COCKPIT_|NODE_ENV_ELECTRON_VITE$|TMUX|TMUX_PANE$)/.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    AC_TMUX_SOCKET: TMUX_SOCKET,
    AC_TMUX_EPHEMERAL: '1',
    TMUX_TMPDIR: tmuxTmpDir,
    // Nothing here uses the mux (the profile selects tmux control-mode below), but
    // if anything started one it must live in this run's home and die with the app.
    COCKPIT_MUX_HOME: join(userDataDir, 'mux-home'),
    COCKPIT_MUX_EPHEMERAL: '1',
    COCKPIT_PLAYWRIGHT_HEADLESS: '1',
    SHELL: '/bin/sh',
  };
}

function makeProject(name: string, files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(runDir, `${name}-`)));
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'e2e',
        GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
        GIT_COMMITTER_NAME: 'e2e',
        GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
      },
    });
  };
  git('init', '--initial-branch=main');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  git('add', '-A');
  git('commit', '-m', 'fixture');
  return root;
}

async function addProject(label: string, rootPath: string, activate: boolean): Promise<string> {
  return page.evaluate(
    async ({ label, rootPath, activate }) => {
      const project = await window.api.projects.add({
        label,
        connection: { kind: 'local', rootPath },
      });
      if (activate) await window.api.projects.activate(project.id);
      return project.id;
    },
    { label, rootPath, activate },
  );
}

const activeProjectId = (): Promise<string | null> =>
  page.evaluate(() => window.api.projects.getActive());
const activate = (id: string): Promise<void> =>
  page.evaluate((id) => window.api.projects.activate(id), id);

// ---- what the user would see / where the keyboard is ----

const terminalRows = () => page.locator('[data-panel-id="terminal"] .xterm-rows');
const terminalInput = () => page.locator('[data-panel-id="terminal"] .xterm-helper-textarea');
const contentTabs = () => page.getByRole('tablist', { name: 'Open files' }).getByRole('tab');

/** Close the Content panel the way a user does (its Dockview tab's close button). */
async function closeContentPanel(): Promise<void> {
  const tab = page.locator('.dv-tab', { hasText: 'Content' });
  await tab.hover();
  await tab.locator('.dv-default-tab-action').click({ force: true });
  await expect(page.locator('[data-panel-id="content"]')).toHaveCount(0);
}

/** Which panel holds DOM focus, and whether it is a terminal pane's input. */
const focusOwner = () =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      panel: el?.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? null,
      isXtermInput: el?.classList.contains('xterm-helper-textarea') ?? false,
    };
  });

/**
 * Whether `locator`'s element is actually what a user would see and hit at its position
 * (not merely rendered: a maximized panel covers the groups behind it without removing
 * them, and Playwright's own visibility check ignores that).
 */
const isOnScreen = (locator: Locator): Promise<boolean> =>
  locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return top !== null && (top === el || el.contains(top));
  });

async function expectTerminalFocused(): Promise<void> {
  await expect.poll(focusOwner).toEqual({ panel: 'terminal', isXtermInput: true });
}

/** Type a shell command into the focused terminal and run it. */
async function typeCommand(command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

/**
 * Prove the keyboard still reaches the shell: type an arithmetic echo whose OUTPUT
 * (`e2e-<a+b>`) differs from the typed text (`e2e-$((a+b))`), so only the shell
 * having run it can satisfy the assertion.
 */
async function expectShellResponds(a: number, b: number): Promise<void> {
  await typeCommand(`echo e2e-$((${a}+${b}))`);
  await expect(terminalRows()).toContainText(`e2e-${a + b}`);
}

/** Run tmux against THIS run's server (the same `TMUX_TMPDIR` the app was launched with). */
function tmux(...args: string[]): string {
  return execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], {
    encoding: 'utf8',
    // stderr is captured (it is on the thrown error), not echoed: "no server running" is
    // the expected answer during cleanup.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir },
  });
}

/**
 * Take down this run's tmux server, then its socket directory (a killed server can
 * leave its now-unconnectable socket file behind). The directory is only removed once
 * no server answers on it, so a server that survived is never orphaned.
 */
function removeIsolatedTmuxServer(): void {
  if (!tmuxTmpDir) return;
  try {
    tmux('kill-server');
  } catch {
    /* the app's own will-quit already took the isolated server down */
  }
  try {
    tmux('list-sessions');
  } catch {
    rmSync(tmuxTmpDir, { recursive: true, force: true });
  }
}

/**
 * Close the app; if it does not exit in time, kill it. A hung Electron would otherwise
 * outlive the run (and hold the profile, the tmux server and a window).
 */
async function closeApp(): Promise<void> {
  if (!app) return;
  const child = app.process();
  const closed = app.close().then(
    () => true,
    () => true,
  );
  const exited = await Promise.race([
    closed,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/** The tmux environment of a project's control-mode session (what its panes inherit). */
function sessionEnv(projectId: string, name: string): string {
  const sessions = tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
  const session = sessions.find((s) => s === `agent-cockpit-${projectId}`);
  if (!session)
    throw new Error(`no tmux session for project ${projectId} in: ${sessions.join(', ')}`);
  return tmux('show-environment', '-t', `=${session}`, name).trim().slice(`${name}=`.length);
}

/** The renderer's OWN idea of the active project (what the status bar is showing). */
async function expectActiveProject(projectId: string): Promise<void> {
  await expect(page.locator('[data-active-project]')).toHaveAttribute(
    'data-active-project',
    projectId,
  );
}

test.describe.serial('cockpit open from a terminal pane', () => {
  test.beforeAll(async () => {
    test.setTimeout(180_000);
    expect(existsSync(MAIN), `build the app first (npm run build): ${MAIN} is missing`).toBe(true);
    runDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-callback-e2e-'));
    userDataDir = join(runDir, 'profile');
    tmuxTmpDir = mkdtempSync(join('/tmp', 'ac-e2e-'));
    // A fresh profile defaults to the cockpit-mux backend with the WTerm renderer;
    // this spec drives the tmux control-mode backend with the xterm DOM renderer
    // (an existing config pins both), whose DOM it queries.
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      join(userDataDir, 'config.json'),
      JSON.stringify({ terminalBackend: 'control-mode', terminalRenderer: 'dom' }),
    );
    projectA = {
      id: '',
      root: makeProject('project-a', {
        'README.md': '# project A\n',
        'notes/todo.md': '- one\n',
        'docs/plan.md': '# plan\n',
        'docs/extra.md': '# extra\n',
      }),
    };
    projectB = { id: '', root: makeProject('project-b', { 'b-only.md': '# only in B\n' }) };

    app = await electron.launch({
      args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
      env: isolatedEnv(),
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(30_000);
    await page.waitForLoadState('domcontentloaded');
    projectA.id = await addProject('Project A', projectA.root, true);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expectActiveProject(projectA.id);
    await expect(terminalInput()).toBeAttached({ timeout: 60_000 });
  });

  test.afterAll(async () => {
    await closeApp();
    removeIsolatedTmuxServer();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
  });

  test('the pane has the callback variables, and the Content panel starts empty', async () => {
    await terminalInput().focus();
    await expectTerminalFocused();
    await typeCommand('echo "cli=[$COCKPIT_CLI]"');
    await expect(terminalRows()).toContainText(/cli=\[\/.*\/callback\/bin\/cockpit\]/);
    await expect(contentTabs()).toHaveCount(0);
  });

  test('`"$COCKPIT_CLI" open README.md` adds a Content tab and the terminal keeps the keyboard', async () => {
    await terminalInput().focus();
    await expectTerminalFocused();

    await typeCommand('"$COCKPIT_CLI" open README.md');

    const tab = contentTabs().filter({ hasText: 'README.md' });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('title', join(projectA.root, 'README.md'));
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectTerminalFocused();

    // Not just "activeElement": the very next keystrokes still reach the shell.
    await expectShellResponds(20, 22);
    await expectTerminalFocused();
  });

  test('opening the same file again reuses its tab; another file adds one; focus never moves', async () => {
    await terminalInput().focus();
    await typeCommand('"$COCKPIT_CLI" open README.md');
    await typeCommand('"$COCKPIT_CLI" open notes/todo.md');
    await expect(contentTabs()).toHaveCount(2);
    await expect(contentTabs().filter({ hasText: 'todo.md' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectTerminalFocused();
    await expectShellResponds(30, 3);
  });

  test('with the Content panel closed, an open brings it back without taking the keyboard', async () => {
    await closeContentPanel();

    await terminalInput().focus();
    await expectTerminalFocused();
    await typeCommand('"$COCKPIT_CLI" open docs/plan.md');

    await expect(page.locator('[data-panel-id="content"]')).toBeVisible();
    await expect(contentTabs().filter({ hasText: 'plan.md' })).toBeVisible();
    await expectTerminalFocused();
    await expectShellResponds(40, 4);
  });

  test('with the terminal maximized an open is declined: the keyboard stays and a status cue offers Show', async () => {
    const terminalPanel = page.locator('[data-panel-id="terminal"]');
    // Maximizing is the user's explicit choice; showing Content would have to undo it.
    await terminalPanel.getByRole('button', { name: 'Maximize panel' }).click();
    await expect(terminalPanel.getByRole('button', { name: 'Restore panel' })).toBeVisible();
    await terminalInput().focus();
    await expectTerminalFocused();

    await typeCommand('"$COCKPIT_CLI" open docs/extra.md');

    const cue = page.locator('[data-active-project]').getByRole('status');
    await expect(cue).toContainText('Opened extra.md in Content (hidden)');
    await expect(cue).toContainText('Show');
    await expectTerminalFocused();
    await expectShellResponds(60, 6); // still typing into the (still maximized) terminal
    // Recorded (its tab is the selected one and its document rendered) but NOT on screen,
    // and the maximized state was left alone.
    const tab = contentTabs().filter({ hasText: 'extra.md' });
    await expect(tab).toHaveCount(1);
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const extraDoc = page
      .locator('[data-panel-id="content"]')
      .getByRole('heading', { name: 'extra' });
    await expect(extraDoc).toBeAttached();
    expect(await isOnScreen(extraDoc)).toBe(false);
    await expect(terminalPanel.getByRole('button', { name: 'Restore panel' })).toBeVisible();

    // Show is an explicit request: it exits the maximized state, shows the file and takes the focus.
    await cue.getByRole('button', { name: 'Show extra.md in Content' }).click();
    await expect(terminalPanel.getByRole('button', { name: 'Maximize panel' })).toBeVisible();
    await expect.poll(() => isOnScreen(extraDoc)).toBe(true);
    await expect(cue).toBeEmpty();
    await expect.poll(focusOwner).toMatchObject({ panel: 'content' });
  });

  test('an open for a project that is NOT active only records its tab: no switch, no reveal', async () => {
    // B becomes a live background session (activate it, then go back to A).
    projectB.id = await addProject('Project B', projectB.root, true);
    await expectActiveProject(projectB.id);
    await expect(terminalInput()).toBeAttached();
    await expect.poll(() => sessionEnv(projectB.id, 'COCKPIT_CALLBACK_SOCK')).toMatch(/\.sock$/);
    await activate(projectA.id);
    await expectActiveProject(projectA.id);
    await expect(contentTabs()).toHaveCount(4);

    // A's Content panel is closed: a wrongly revealing handler would bring it back.
    await closeContentPanel();
    await terminalInput().focus();
    await expectTerminalFocused();

    // The real CLI, aimed at B's own socket, from outside any pane.
    execFileSync(
      sessionEnv(projectB.id, 'COCKPIT_CLI'),
      ['open', join(projectB.root, 'b-only.md')],
      {
        env: {
          ...process.env,
          COCKPIT_CALLBACK_SOCK: sessionEnv(projectB.id, 'COCKPIT_CALLBACK_SOCK'),
        },
      },
    );

    // A is untouched: still the active project, its Content panel still closed, the
    // keyboard still in its terminal. (The open is asynchronous: give it every chance
    // to land in the wrong place before asserting that it did not.)
    await page.waitForTimeout(1_500);
    expect(await activeProjectId()).toBe(projectA.id);
    await expectActiveProject(projectA.id);
    await expect(page.locator('[data-panel-id="content"]')).toHaveCount(0);
    await expectTerminalFocused();
    await expectShellResponds(50, 5);

    // ...and B recorded it: switching there shows the tab.
    await activate(projectB.id);
    await expectActiveProject(projectB.id);
    await expect(contentTabs().filter({ hasText: 'b-only.md' })).toBeVisible();
  });
});
