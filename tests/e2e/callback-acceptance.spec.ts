/**
 * Integrated acceptance of the terminal callback socket against the BUILT app: real
 * panes on every local backend, driven by keystrokes, with the real `cockpit` CLI.
 * `callback-open.spec.ts` covers the renderer leg on the tmux control-mode backend
 * (scenario 16); this file covers the rest of the end-to-end scenarios:
 *
 *   17  `cockpit open` from a control-mode, a session-per-tab and a cockpit-mux pane
 *       (including a split and a new window; panes made by the in-pane `cockpit-mux`
 *       commands are asserted to LACK the variables); two projects never cross,
 *       including when the other project started the tmux server / mux daemon
 *   19  restart: the app is relaunched with the tmux server and the mux daemon alive
 *   20  `deterministicSessionNames` on: injection is off and the CLI exits 3
 *
 * Every run (`support/callbackRun.ts`) owns its own Electron profile, tmux socket and
 * `TMUX_TMPDIR`, mux home and git projects (under one short directory; the profile of the
 * runs that exercise the /tmp socket fallback is a separate directory under os.tmpdir()),
 * simulates being launched from inside another cockpit pane (the outer app's variables are
 * in the launch environment), and fails if teardown leaves any process, socket, pane shell
 * or directory.
 *
 * Verified on macOS only (the harness and some assertions assume `/tmp` is `/private/tmp`).
 * The mux shortcuts are `ControlOrMeta`: Cmd on macOS, Ctrl elsewhere, like the app.
 */
import { expect, test } from '@playwright/test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { CallbackRun, git, shellQuote, type PaneEnv, type Project } from './support/callbackRun';

const README = '# project A\n';

/** What a pane of `project` must see: its own socket, version, CLI; nothing from the outer app. */
function expectOwnValues(run: CallbackRun, env: PaneEnv, project: Project): string {
  const sock = env.vars['COCKPIT_CALLBACK_SOCK'];
  expect(sock, 'COCKPIT_CALLBACK_SOCK is set').toBeTruthy();
  run.expectSocketLocation(project.id, sock!);
  expect(env.vars['COCKPIT_CALLBACK_VERSION']).toBe('1');
  expect(env.vars['COCKPIT_CLI'], 'COCKPIT_CLI is set').toBeTruthy();
  run.expectCliLink(env.vars['COCKPIT_CLI']!);
  for (const [name, value] of Object.entries(env.vars)) {
    expect(run.isOuter(value), `${name} is not the outer app's value`).toBe(false);
  }
  return sock!;
}

/** A pane that was not given the callback variables (and not the outer app's either). */
function expectNoCallbackVariables(run: CallbackRun, env: PaneEnv, muxHome = run.muxHome): void {
  const callback = Object.keys(env.vars).filter(
    (name) => name.startsWith('COCKPIT_CALLBACK_') || name === 'COCKPIT_CLI',
  );
  expect(callback, 'no callback variable in this pane').toEqual([]);
  // The deliberate isolation overrides are not callback variables and survive the scrub.
  expect(env.vars['COCKPIT_MUX_HOME']).toBe(muxHome);
}

/** The shared tmux server: indexed `update-environment`, a clean global environment. */
function expectTmuxServerState(run: CallbackRun): void {
  // (Only the matching lines are compared: a failure must never print the whole environment.)
  const leaked = run
    .tmux('show-environment', '-g')
    .split('\n')
    .filter((line) => /^(COCKPIT_CALLBACK_|COCKPIT_CLI)/.test(line));
  expect(
    leaked,
    'the server was started variable-free: no callback variable in its global env',
  ).toEqual([]);
  const options = run.tmux('show-options', '-g', 'update-environment');
  expect(options).toMatch(/update-environment\[100\] COCKPIT_CALLBACK_SOCK\b/);
  expect(options).toMatch(/update-environment\[101\] COCKPIT_CALLBACK_VERSION\b/);
  expect(options).toMatch(/update-environment\[102\] COCKPIT_CLI\b/);
  expect(options, "tmux's own defaults are kept").toMatch(/\bDISPLAY\b/);
  expect(
    options.match(/COCKPIT_CALLBACK_SOCK/g),
    'one element per variable, never grown',
  ).toHaveLength(1);
}

test.describe.serial('scenario 17: local session-per-tab panes, two projects', () => {
  let run: CallbackRun;
  let a: Project;
  let b: Project;
  let sockA = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    run = new CallbackRun({ name: 'spt', backend: 'session-per-tab', profile: 'spaced' });
    const rootA = run.makeProject('project-a', {
      'README.md': README,
      'docs/plan.md': '# plan\n',
    });
    const rootB = run.makeProject('project-b', { 'b-only.md': '# only in B\n' });
    await run.launch();
    a = await run.openFirstProject('Project A', rootA);
    b = { id: '', label: 'Project B', root: rootB };
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  test("project A's first pane has its own variables and the server is clean", async () => {
    const pane = run.keyedPane('t1');
    await run.awaitShell(pane, basename(a.root));
    const env = await run.env(pane, 'a-t1');
    sockA = expectOwnValues(run, env, a);
    expect(env.vars['TMUX_PANE'], 'tmux gives every pane its identity').toMatch(/^%\d+$/);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY'], 'mux-only variable').toBeUndefined();
    expectTmuxServerState(run);
  });

  test('`"$COCKPIT_CLI" open README.md` adds the tab and the terminal keeps the keyboard', async () => {
    const pane = run.keyedPane('t1');
    const result = await run.cli(pane, ['open', 'README.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`]);
    await expect(run.contentTabs().first()).toHaveText('README.md'); // labelled with the file name
    await run.expectTerminalFocused();
    // Again, spelled `./README.md` (the documented form): the same tab, not a second one.
    expect(await run.cli(pane, ['open', './README.md'])).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`]);
  });

  test("project B's pane, created after A started the server, opens into B only", async () => {
    b = await run.addProject(b.label, b.root, true);
    await run.expectActiveProject(b);
    const pane = run.keyedPane('t1');
    await run.awaitShell(pane, basename(b.root));
    const env = await run.env(pane, 'b-t1');
    const sockB = expectOwnValues(run, env, b);
    expect(sockB, 'a socket per project').not.toBe(sockA);
    expectTmuxServerState(run);

    const result = await run.cli(pane, ['open', 'b-only.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${b.root}/b-only.md`]);
    await run.expectTerminalFocused();

    // ...and A recorded nothing for it.
    await run.activate(a);
    await run.expectTabs([`${a.root}/README.md`]);
  });

  test('a new terminal tab of A, created after B exists, still opens into A only', async () => {
    await run.activate(a);
    await run.page.getByRole('button', { name: 'New terminal' }).click();
    const pane = run.keyedPane('t2');
    await run.awaitShell(pane, basename(a.root));
    const env = await run.env(pane, 'a-t2');
    expect(expectOwnValues(run, env, a), "A's own socket, not B's").toBe(sockA);

    const result = await run.cli(pane, ['open', 'docs/plan.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`, `${a.root}/docs/plan.md`]);
    await run.activate(b);
    await run.expectTabs([`${b.root}/b-only.md`]);
  });
});

test.describe.serial('scenario 17: tmux control-mode panes, two projects, a later window', () => {
  let run: CallbackRun;
  let a: Project;
  let b: Project;
  let sockA = '';

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // A long profile path: the /tmp/ac-cb-<uid>/ fallback location, as an isolated run
    // under os.tmpdir() always gets.
    run = new CallbackRun({ name: 'ctl', backend: 'control-mode', profile: 'long' });
    const rootA = run.makeProject('project-a', {
      'README.md': README,
      'docs/plan.md': '# plan\n',
    });
    const rootB = run.makeProject('project-b', { 'b-only.md': '# only in B\n' });
    await run.launch();
    a = await run.openFirstProject('Project A', rootA);
    b = { id: '', label: 'Project B', root: rootB };
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  test("A's pane: the variables, the session environment and a clean server", async () => {
    const pane = run.controlPane();
    await run.awaitShell(pane, basename(a.root));
    const env = await run.env(pane, 'a-w1');
    sockA = expectOwnValues(run, env, a);
    expect(env.vars['TMUX_PANE']).toMatch(/^%\d+$/);
    // What the pane has is what its tmux SESSION has: the mechanism that reaches panes.
    const session = `agent-cockpit-${a.id}`;
    expect(run.tmuxSessionEnv(session, 'COCKPIT_CALLBACK_SOCK')).toBe(sockA);
    expect(run.tmuxSessionEnv(session, 'COCKPIT_CLI')).toBe(env.vars['COCKPIT_CLI']);
    expectTmuxServerState(run);
  });

  test('`"$COCKPIT_CLI" open README.md` adds A\'s tab and the terminal keeps the keyboard', async () => {
    const pane = run.controlPane();
    const result = await run.cli(pane, ['open', 'README.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`]);
    await run.expectTerminalFocused();
  });

  test("B's pane, created after A started the server, opens into B only", async () => {
    b = await run.addProject(b.label, b.root, true);
    await run.expectActiveProject(b);
    const pane = run.controlPane();
    await run.awaitShell(pane, basename(b.root));
    const env = await run.env(pane, 'b-w1');
    expect(expectOwnValues(run, env, b), 'a socket per project').not.toBe(sockA);
    expect(run.tmuxSessionEnv(`agent-cockpit-${b.id}`, 'COCKPIT_CALLBACK_SOCK')).toBe(
      env.vars['COCKPIT_CALLBACK_SOCK'],
    );
    expectTmuxServerState(run);

    const result = await run.cli(pane, ['open', 'b-only.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${b.root}/b-only.md`]);
    await run.expectTerminalFocused();

    await run.activate(a);
    await run.expectTabs([`${a.root}/README.md`]);
  });

  test("A's later window (the + button), created after B exists, opens into A only", async () => {
    await run.activate(a);
    const pane = run.controlPane();
    const first = (await run.env(pane, 'a-w1-again')).pid;
    await run.page.getByRole('button', { name: 'New tmux window' }).click();
    // The new window's shell is a different process; keep asking until the visible pane is it.
    let env: PaneEnv | undefined;
    await expect
      .poll(
        async () => {
          await expect(pane.input).toHaveCount(1);
          env = await run.env(pane, 'a-w2');
          return env.pid;
        },
        { timeout: 40_000 },
      )
      .not.toBe(first);
    expect(expectOwnValues(run, env!, a), "A's own socket, not B's").toBe(sockA);

    const result = await run.cli(pane, ['open', 'docs/plan.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`, `${a.root}/docs/plan.md`]);
    await run.activate(b);
    await run.expectTabs([`${b.root}/b-only.md`]);
  });

  test('paths: a linked worktree, a symlinked directory and an external file', async () => {
    await run.activate(a);
    const pane = run.controlPane();
    await run.awaitShell(pane, basename(a.root));
    // A linked worktree of A (a sibling directory), a symlink to A's docs, a file outside A.
    const worktree = join(run.projectsDir, 'linked-wt');
    git(a.root, 'worktree', 'add', '-b', 'wt-branch', worktree);
    writeFileSync(join(worktree, 'wt-only.md'), '# only in the worktree\n');
    symlinkSync(join(a.root, 'docs'), join(a.root, 'linkdocs'));
    const outside = join(run.base, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'note.md'), '# outside\n');
    const canonicalWorktree = realpathSync(worktree);

    // The same relative name in two worktrees is two tabs; a worktree-only file opens with
    // that worktree in its identity. (Reached through the /tmp symlink: the tab uses the
    // canonical path.)
    for (const file of [join(worktree, 'wt-only.md'), join(worktree, 'README.md')]) {
      expect(await run.cli(pane, ['open', file])).toMatchObject({ rc: 0, stderr: '' });
    }
    const expected = [
      `${a.root}/README.md`,
      `${a.root}/docs/plan.md`,
      `${canonicalWorktree}/wt-only.md`,
      `${canonicalWorktree}/README.md`,
    ];
    await run.expectTabs(expected);

    // A symlinked directory resolves to the file's real tab: nothing new opens.
    expect(await run.cli(pane, ['open', 'linkdocs/plan.md'])).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs(expected);

    // A path outside every worktree opens as an external file, in its logical form.
    const logicalOutside = join(outside, 'note.md');
    expect(await run.cli(pane, ['open', logicalOutside])).toMatchObject({ rc: 0, stderr: '' });
    expect(await run.tabTitles()).toContain(logicalOutside);
  });

  test('a stale or a missing socket in the environment fails not-connected and changes nothing', async () => {
    const pane = run.controlPane();
    const tabs = await run.tabTitles();
    const stale = run.makeStaleSocket('stale');
    const staleRun = await run.cli(
      pane,
      ['open', 'README.md'],
      `COCKPIT_CALLBACK_SOCK=${shellQuote(stale)} "$COCKPIT_CLI"`,
    );
    expect(staleRun.rc, 'not connected').toBe(3);
    expect(staleRun.seconds).toBeLessThanOrEqual(5);
    expect(staleRun.stderr).toContain('connection refused');
    const missing = await run.cli(
      pane,
      ['open', 'README.md'],
      'COCKPIT_CALLBACK_SOCK=/nonexistent/ac-cb.sock "$COCKPIT_CLI"',
    );
    expect(missing.rc).toBe(3);
    expect(missing.stderr).toContain('no such socket');
    // No UI change (the open is asynchronous: give a wrongly accepted one time to land).
    await run.page.waitForTimeout(1_000);
    expect(await run.tabTitles()).toEqual(tabs);
  });
});

test.describe
  .serial('scenario 17: cockpit-mux panes, a split, a new window, in-pane commands', () => {
  let run: CallbackRun;
  let a: Project;
  let b: Project;
  let sockA = '';
  let rootKey = '';
  let splitKey = '';
  let windowKey = '';
  const cwdName = (project: Project): string => basename(project.root);

  /** The pane keys of `project` that the mux knows, waiting until there are `count`. */
  const paneKeys = async (project: Project, count: number): Promise<string[]> => {
    let keys: string[] = [];
    await expect
      .poll(
        async () => {
          keys = (await run.muxPanes(project)).map((pane) => pane.key);
          return keys.length;
        },
        { timeout: 30_000 },
      )
      .toBe(count);
    return keys;
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    run = new CallbackRun({ name: 'mux', backend: 'cockpit-mux', profile: 'spaced' });
    const rootA = run.makeProject('project-a', {
      'README.md': README,
      'docs/plan.md': '# plan\n',
      'notes/todo.md': '- one\n',
    });
    const rootB = run.makeProject('project-b', { 'b-only.md': '# only in B\n' });
    await run.launch();
    a = await run.openFirstProject('Project A', rootA);
    b = { id: '', label: 'Project B', root: rootB };
    [rootKey] = await paneKeys(a, 1);
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  test("A's root pane: the variables with its own mux key, and no tmux", async () => {
    const pane = run.keyedPane(rootKey);
    await run.awaitShell(pane, cwdName(a));
    const env = await run.env(pane, 'a-root');
    sockA = expectOwnValues(run, env, a);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY'], 'the app-chosen terminal key').toBe(rootKey);
    expect(env.vars['TMUX_PANE'], 'no tmux here').toBeUndefined();
  });

  test('`"$COCKPIT_CLI" open README.md` adds A\'s tab and the terminal keeps the keyboard', async () => {
    const result = await run.cli(run.keyedPane(rootKey), ['open', 'README.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`]);
    await expect(run.contentTabs().first()).toHaveText('README.md');
    await run.expectTerminalFocused();
    expect(await run.cli(run.keyedPane(rootKey), ['open', './README.md'])).toMatchObject({
      rc: 0,
      stderr: '',
    });
    await run.expectTabs([`${a.root}/README.md`]); // the same tab again, not a second one
  });

  test('a split pane (Cmd+D) has the variables with a key of its own and opens into A', async () => {
    const root = run.keyedPane(rootKey);
    await root.input.focus();
    await run.page.keyboard.press('ControlOrMeta+d');
    const keys = await paneKeys(a, 2);
    splitKey = keys.find((key) => key !== rootKey)!;
    const pane = run.keyedPane(splitKey);
    await run.awaitShell(pane, cwdName(a));
    const env = await run.env(pane, 'a-split');
    expect(expectOwnValues(run, env, a), "the project's socket, shared by its panes").toBe(sockA);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY'], "the split pane's own key").toBe(splitKey);
    expect(splitKey).not.toBe(rootKey);

    const result = await run.cli(pane, ['open', 'docs/plan.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`, `${a.root}/docs/plan.md`]);
    await run.expectTerminalFocused();
  });

  test('a pane made by the in-pane `cockpit-mux pane split` lacks the variables', async () => {
    const [{ paneId }] = (await run.muxPanes(a)).filter((pane) => pane.key === rootKey);
    await run.shell(
      run.keyedPane(rootKey),
      `${shellQuote(run.muxBinary())} --home ${shellQuote(run.muxHome)} pane split ` +
        `--pane ${paneId} --direction vertical --cwd ${shellQuote(a.root)}`,
    );
    const keys = await paneKeys(a, 3);
    const inPaneKey = keys.find((key) => key !== rootKey && key !== splitKey)!;
    const pane = run.keyedPane(inPaneKey);
    await run.awaitShell(pane, cwdName(a));
    const env = await run.env(pane, 'a-inpane-split');
    // The daemon spawned it with the daemon's own environment: no per-project values, no
    // key, and nothing from the OUTER app either (the startup scrub removed it before the
    // daemon was started). The deliberate isolation override survives the scrub.
    expectNoCallbackVariables(run, env);

    // `"$COCKPIT_CLI" open ...` fails in the shell; the documented form explains why.
    const bare = await run.cli(pane, ['open', 'README.md']);
    expect(bare.rc).toBe(127);
    expect(bare.stderr).toContain('not found');
    await run.shell(pane, '"${COCKPIT_CLI:?cockpit callback unavailable}" open README.md');
    await expect(pane.rows).toContainText(/COCKPIT_CLI: cockpit callback unavailable/);
    await run.expectTabs([`${a.root}/README.md`, `${a.root}/docs/plan.md`]);
  });

  test('a new window (Cmd+T) has the variables with a key of its own and opens into A', async () => {
    const known = (await run.muxPanes(a)).map((pane) => pane.key);
    await run.keyedPane(rootKey).input.focus();
    await run.page.keyboard.press('ControlOrMeta+t');
    const keys = await paneKeys(a, known.length + 1);
    windowKey = keys.find((key) => !known.includes(key))!;
    const pane = run.keyedPane(windowKey);
    await run.awaitShell(pane, cwdName(a));
    const env = await run.env(pane, 'a-window');
    expect(expectOwnValues(run, env, a)).toBe(sockA);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY']).toBe(windowKey);

    const result = await run.cli(pane, ['open', 'notes/todo.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([
      `${a.root}/README.md`,
      `${a.root}/docs/plan.md`,
      `${a.root}/notes/todo.md`,
    ]);
    await run.expectTerminalFocused();
  });

  test('a window made by the in-pane `cockpit-mux window new` lacks the variables', async () => {
    const known = (await run.muxPanes(a)).map((pane) => pane.key);
    const { sessionId } = (await run.muxPanes(a))[0]!;
    await run.shell(
      run.keyedPane(windowKey),
      `${shellQuote(run.muxBinary())} --home ${shellQuote(run.muxHome)} window new ` +
        `--session ${sessionId} --cwd ${shellQuote(a.root)}`,
    );
    const keys = await paneKeys(a, known.length + 1);
    const inPaneKey = keys.find((key) => !known.includes(key))!;
    // The new window is not selected for us: open it from the window strip, as a user would.
    const windows = (await run.muxTopology(a)).sessions[0]!.windowOrder.length;
    await run.page.getByText(`Window ${windows}`, { exact: true }).click();
    const pane = run.keyedPane(inPaneKey);
    await run.awaitShell(pane, cwdName(a));
    const env = await run.env(pane, 'a-inpane-window');
    expectNoCallbackVariables(run, env);
    const bare = await run.cli(pane, ['open', 'README.md']);
    expect(bare.rc).toBe(127);
  });

  test("B's pane, created after A started the daemon, opens into B only", async () => {
    b = await run.addProject(b.label, b.root, true);
    await run.expectActiveProject(b);
    const [bKey] = await paneKeys(b, 1);
    const pane = run.keyedPane(bKey!);
    await run.awaitShell(pane, cwdName(b));
    const env = await run.env(pane, 'b-root');
    expect(expectOwnValues(run, env, b), 'a socket per project').not.toBe(sockA);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY']).toBe(bKey);

    const result = await run.cli(pane, ['open', 'b-only.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${b.root}/b-only.md`]);
    await run.expectTerminalFocused();

    await run.activate(a);
    await run.expectTabs([
      `${a.root}/README.md`,
      `${a.root}/docs/plan.md`,
      `${a.root}/notes/todo.md`,
    ]);
  });
});

test.describe.serial('scenario 19: relaunch with the tmux server alive (control-mode)', () => {
  let run: CallbackRun;
  let a: Project;
  let b: Project;
  let envA: PaneEnv;
  let envB: PaneEnv;
  const marker = `survivor-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // The tmux server must outlive the app: no AC_TMUX_EPHEMERAL, and an explicit cleanup
    // (the harness's teardown kills this run's server and removes its directory).
    run = new CallbackRun({
      name: 'rst',
      backend: 'control-mode',
      profile: 'long',
      persistent: true,
    });
    const rootA = run.makeProject('project-a', { 'README.md': README, 'docs/plan.md': '# plan\n' });
    const rootB = run.makeProject('project-b', { 'b-only.md': '# only in B\n' });
    await run.launch();
    a = await run.openFirstProject('Project A', rootA);
    b = { id: '', label: 'Project B', root: rootB };
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  test('launch 1: both projects have a live pane with the variables, A is active', async () => {
    const pane = run.controlPane();
    await run.awaitShell(pane, basename(a.root));
    await run.shell(pane, `PRE_RESTART=${marker}-a; export PRE_RESTART`);
    envA = await run.env(pane, 'a-before');
    expectOwnValues(run, envA, a);
    expect(await run.cli(pane, ['open', 'README.md'])).toMatchObject({ rc: 0, stderr: '' });

    b = await run.addProject(b.label, b.root, true);
    await run.expectActiveProject(b);
    await run.awaitShell(pane, basename(b.root));
    await run.shell(pane, `PRE_RESTART=${marker}-b; export PRE_RESTART`);
    envB = await run.env(pane, 'b-before');
    expectOwnValues(run, envB, b);

    await run.activate(a); // the project that is active when the app quits
  });

  test('the app quits: the server and both shells survive, the sockets are gone, a surviving pane reports not-connected', async () => {
    await run.quit();
    expect(run.tmuxServerUp(), 'the tmux server outlives the app').toBe(true);
    for (const env of [envA, envB]) {
      expect(
        existsSync(env.vars['COCKPIT_CALLBACK_SOCK']!),
        'the listener unlinked its socket',
      ).toBe(false);
    }
    // Typed through tmux itself, into the surviving shells, with nobody to answer.
    for (const [env, file] of [
      [envA, 'README.md'],
      [envB, 'b-only.md'],
    ] as const) {
      const result = await run.cliViaTmux(env.pid, ['open', file]);
      expect(result.rc, 'not connected').toBe(3);
      expect(result.seconds, 'within the 5 s deadline').toBeLessThanOrEqual(5);
      expect(result.stderr).toContain('not connected to Agent Cockpit');
      expect(result.stderr).toContain('no such socket');
    }
  });

  test("relaunch: A's surviving shell works once A is re-activated; B stays not-connected until activated", async () => {
    await run.launch();
    await run.expectActiveProject(a);
    const pane = run.controlPane();
    await run.awaitShell(pane, basename(a.root));

    // The very same shell, with exactly the environment it had: already-running shells never
    // gain variables, and need none because the socket path is deterministic.
    await run.shell(pane, 'echo pre=$PRE_RESTART');
    await expect(pane.rows).toContainText(`pre=${marker}-a`);
    const again = await run.env(pane, 'a-after');
    expect(again.pid, 'the same shell survived').toBe(envA.pid);
    expect(again.vars, 'its environment is unchanged').toEqual(envA.vars);
    const sock = envA.vars['COCKPIT_CALLBACK_SOCK']!;
    expect(lstatSync(sock).isSocket(), 'A listener is bound again on the same path').toBe(true);

    const result = await run.cli(pane, ['open', 'docs/plan.md']);
    expect(result).toMatchObject({ rc: 0, stderr: '' });
    expect(await run.tabTitles()).toContain(`${a.root}/docs/plan.md`);
    await run.expectTerminalFocused();

    // B has not been activated in this run of the app: no session, no listener, no socket.
    expect(existsSync(envB.vars['COCKPIT_CALLBACK_SOCK']!), 'lazy: B has no listener yet').toBe(
      false,
    );
    const before = await run.cliViaTmux(envB.pid, ['open', 'b-only.md']);
    expect(before.rc).toBe(3);
    expect(before.stderr).toContain('not connected to Agent Cockpit');

    // Activating B starts its session and binds the same path; its surviving shell works.
    await run.activate(b);
    await expect
      .poll(() => existsSync(envB.vars['COCKPIT_CALLBACK_SOCK']!), { timeout: 20_000 })
      .toBe(true);
    const after = await run.cliViaTmux(envB.pid, ['open', 'b-only.md']);
    expect(after).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${b.root}/b-only.md`]);

    // The pane the user sees for B is that same surviving shell.
    await run.awaitShell(pane, basename(b.root));
    await run.shell(pane, 'echo pre=$PRE_RESTART');
    await expect(pane.rows).toContainText(`pre=${marker}-b`);
  });

  test('a NEW window after the relaunch has the variables: the re-attach refreshed the session, it did not strip it', async () => {
    await run.activate(a);
    const sock = envA.vars['COCKPIT_CALLBACK_SOCK']!;
    expect(run.tmuxSessionEnv(`agent-cockpit-${a.id}`, 'COCKPIT_CALLBACK_SOCK')).toBe(sock);
    const pane = run.controlPane();
    await run.page.getByRole('button', { name: 'New tmux window' }).click();
    let fresh: PaneEnv | undefined;
    await expect
      .poll(
        async () => {
          await expect(pane.input).toHaveCount(1);
          fresh = await run.env(pane, 'a-new-after');
          return fresh.pid;
        },
        { timeout: 40_000 },
      )
      .not.toBe(envA.pid);
    expect(fresh!.vars['COCKPIT_CALLBACK_SOCK']).toBe(sock);
    expect(await run.cli(pane, ['open', 'README.md'])).toMatchObject({ rc: 0, stderr: '' });
  });
});

test.describe.serial('scenario 19: relaunch with the mux daemon alive (cockpit-mux)', () => {
  let run: CallbackRun;
  let a: Project;
  let b: Project;
  let envA: PaneEnv;
  let envB: PaneEnv;
  let daemon: number[] = [];
  const marker = `survivor-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // The mux daemon must outlive the app: no COCKPIT_MUX_EPHEMERAL (the daemon is detached
    // and has no owner pipe), and an explicit cleanup in the harness's teardown.
    run = new CallbackRun({
      name: 'mrs',
      backend: 'cockpit-mux',
      profile: 'spaced',
      persistent: true,
    });
    const rootA = run.makeProject('project-a', { 'README.md': README, 'docs/plan.md': '# plan\n' });
    const rootB = run.makeProject('project-b', { 'b-only.md': '# only in B\n' });
    await run.launch();
    a = await run.openFirstProject('Project A', rootA);
    b = { id: '', label: 'Project B', root: rootB };
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  /** The only pane of `project`, once the mux reports it. */
  const onlyPane = async (project: Project): Promise<ReturnType<CallbackRun['keyedPane']>> => {
    let key = '';
    await expect
      .poll(
        async () => {
          const panes = await run.muxPanes(project);
          key = panes[0]?.key ?? '';
          return panes.length;
        },
        { timeout: 30_000 },
      )
      .toBe(1);
    return run.keyedPane(key);
  };

  test('launch 1: both projects have a live pane with the variables, A is active', async () => {
    const paneA = await onlyPane(a);
    await run.awaitShell(paneA, basename(a.root));
    await run.shell(paneA, `PRE_RESTART=${marker}-a; export PRE_RESTART`);
    envA = await run.env(paneA, 'a-before');
    expectOwnValues(run, envA, a);
    expect(await run.cli(paneA, ['open', 'README.md'])).toMatchObject({ rc: 0, stderr: '' });

    b = await run.addProject(b.label, b.root, true);
    await run.expectActiveProject(b);
    const paneB = await onlyPane(b);
    await run.awaitShell(paneB, basename(b.root));
    await run.shell(paneB, `PRE_RESTART=${marker}-b; export PRE_RESTART`);
    envB = await run.env(paneB, 'b-before');
    expectOwnValues(run, envB, b);

    await run.activate(a); // the project that is active when the app quits
    daemon = run.muxDaemonPids();
    expect(daemon, 'one daemon serves both projects').toHaveLength(1);
  });

  test('the app quits: the daemon and both shells survive, the sockets are gone', async () => {
    await run.quit();
    expect(run.muxDaemonPids(), 'the same daemon outlives the app').toEqual(daemon);
    for (const env of [envA, envB]) {
      expect(
        existsSync(env.vars['COCKPIT_CALLBACK_SOCK']!),
        'the listener unlinked its socket',
      ).toBe(false);
      // The environment a surviving pane has, with nobody to answer (the pane itself cannot
      // be typed into without the app, so its CLI is run with its values from outside).
      const result = run.cliOutsidePane(env.vars, ['open', 'README.md']);
      expect(result.rc, 'not connected').toBe(3);
      expect(result.stderr).toContain('not connected to Agent Cockpit');
      expect(result.stderr).toContain('no such socket');
    }
  });

  test("relaunch: A's surviving shell works once A is re-activated; B stays not-connected until activated", async () => {
    await run.launch();
    await run.expectActiveProject(a);
    expect(run.muxDaemonPids(), 'the relaunched app attaches to the same daemon').toEqual(daemon);
    const paneA = await onlyPane(a);
    await run.awaitShell(paneA, basename(a.root));

    // The very same shell, with exactly the environment it had.
    await run.shell(paneA, 'echo pre=$PRE_RESTART');
    await expect(paneA.rows).toContainText(`pre=${marker}-a`);
    const again = await run.env(paneA, 'a-after');
    expect(again.pid, 'the same shell survived').toBe(envA.pid);
    expect(again.vars, 'its environment is unchanged').toEqual(envA.vars);
    expect(lstatSync(envA.vars['COCKPIT_CALLBACK_SOCK']!).isSocket()).toBe(true);

    expect(await run.cli(paneA, ['open', 'docs/plan.md'])).toMatchObject({ rc: 0, stderr: '' });
    expect(await run.tabTitles()).toContain(`${a.root}/docs/plan.md`);
    await run.expectTerminalFocused();

    // B has not been activated in this run of the app: no session, no listener, no socket.
    expect(existsSync(envB.vars['COCKPIT_CALLBACK_SOCK']!), 'lazy: B has no listener yet').toBe(
      false,
    );
    const before = run.cliOutsidePane(envB.vars, ['open', 'b-only.md']);
    expect(before.rc).toBe(3);
    expect(before.stderr).toContain('not connected to Agent Cockpit');

    await run.activate(b);
    await expect
      .poll(() => existsSync(envB.vars['COCKPIT_CALLBACK_SOCK']!), { timeout: 20_000 })
      .toBe(true);
    const paneB = await onlyPane(b);
    await run.awaitShell(paneB, basename(b.root));
    await run.shell(paneB, 'echo pre=$PRE_RESTART');
    await expect(paneB.rows).toContainText(`pre=${marker}-b`);
    expect(await run.cli(paneB, ['open', 'b-only.md'])).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${b.root}/b-only.md`]);
  });

  test('a NEW split after the relaunch has the variables with a key of its own', async () => {
    await run.activate(a);
    const paneA = await onlyPane(a);
    const known = (await run.muxPanes(a)).map((pane) => pane.key);
    await paneA.input.focus();
    await run.page.keyboard.press('ControlOrMeta+d');
    let key = '';
    await expect
      .poll(
        async () => {
          key =
            (await run.muxPanes(a)).map((pane) => pane.key).find((k) => !known.includes(k)) ?? '';
          return key;
        },
        { timeout: 30_000 },
      )
      .not.toBe('');
    const pane = run.keyedPane(key);
    await run.awaitShell(pane, basename(a.root));
    const env = await run.env(pane, 'a-split-after');
    expect(env.vars['COCKPIT_CALLBACK_SOCK']).toBe(envA.vars['COCKPIT_CALLBACK_SOCK']);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY']).toBe(key);
    expect(await run.cli(pane, ['open', 'README.md'])).toMatchObject({ rc: 0, stderr: '' });
  });
});

/**
 * With `deterministicSessionNames` on, tmux sessions are shared between installs, so this
 * install injects nothing into them (requirement 12): no variable in the pane, no
 * `update-environment` entry of its own, a diagnostics note, and the CLI (run by the path
 * the app links) exits 3 with a reason instead of reaching another install's app.
 */
for (const backend of ['control-mode', 'session-per-tab'] as const) {
  test.describe.serial(`scenario 20: deterministicSessionNames on (${backend})`, () => {
    let run: CallbackRun;
    let a: Project;

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      run = new CallbackRun({
        name: backend === 'control-mode' ? 'dnc' : 'dns',
        backend,
        profile: 'spaced',
        settings: { deterministicSessionNames: true },
      });
      const root = run.makeProject('project-a', { 'README.md': README });
      await run.launch();
      a = await run.openFirstProject('Project A', root);
    });

    test.afterAll(async () => {
      await run?.teardown();
    });

    test('the pane has no callback variable, the server no entry of ours, and the CLI exits 3', async () => {
      const pane = backend === 'control-mode' ? run.controlPane() : run.keyedPane('t1');
      await run.awaitShell(pane, basename(a.root));
      const env = await run.env(pane, 'gated');
      expectNoCallbackVariables(run, env);
      expect(env.vars['TMUX_PANE'], 'it is a real tmux pane').toMatch(/^%\d+$/);

      // The server was started variable-free, and this install never put an entry of its own
      // into the (server-global) update-environment.
      expect(
        run
          .tmux('show-environment', '-g')
          .split('\n')
          .filter((line) => /^(COCKPIT_CALLBACK_|COCKPIT_CLI)/.test(line)),
      ).toEqual([]);
      expect(run.tmux('show-options', '-g', 'update-environment')).not.toMatch(/COCKPIT_/);

      // The diagnostics buffer says why.
      const notes = await run.logLines('callback injection disabled');
      expect(
        notes.some(
          (line) => line.includes(`project=${a.id}`) && line.includes(`backend=${backend}`),
        ),
      ).toBe(true);
      expect(notes.join('\n')).toContain('reason=deterministic-session-names');

      // The app still links its CLI; run by that path in a pane without the socket it exits 3.
      const cli = join(realpathSync(run.userDataDir), 'callback', 'bin', 'cockpit');
      const result = await run.cli(pane, ['open', 'README.md'], shellQuote(cli));
      expect(result.rc, 'not connected').toBe(3);
      expect(result.seconds, 'within the 5 s deadline').toBeLessThanOrEqual(5);
      expect(result.stderr).toContain('not connected to Agent Cockpit');
      expect(result.stderr).toContain('COCKPIT_CALLBACK_SOCK is not set');

      // The documented form explains it without running anything.
      await run.shell(pane, '"${COCKPIT_CLI:?cockpit callback unavailable}" open README.md');
      await expect(pane.rows).toContainText(/COCKPIT_CLI: cockpit callback unavailable/);
      await run.expectTabs([]); // nothing opened, nowhere
    });
  });
}

test.describe.serial('scenario 20: deterministicSessionNames on does not gate the mux', () => {
  let run: CallbackRun;
  let a: Project;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    run = new CallbackRun({
      name: 'dnm',
      backend: 'cockpit-mux',
      profile: 'spaced',
      settings: { deterministicSessionNames: true },
    });
    const root = run.makeProject('project-a', { 'README.md': README });
    await run.launch();
    a = await run.openFirstProject('Project A', root);
  });

  test.afterAll(async () => {
    await run?.teardown();
  });

  test('mux sessions are namespaced by the project id, so injection stays on and open works', async () => {
    const [{ key }] = await (async () => {
      let panes: Awaited<ReturnType<CallbackRun['muxPanes']>> = [];
      await expect
        .poll(async () => (panes = await run.muxPanes(a)).length, { timeout: 30_000 })
        .toBe(1);
      return panes;
    })();
    const pane = run.keyedPane(key);
    await run.awaitShell(pane, basename(a.root));
    const env = await run.env(pane, 'mux-det');
    expectOwnValues(run, env, a);
    expect(env.vars['COCKPIT_CALLBACK_MUX_KEY']).toBe(key);
    expect(await run.cli(pane, ['open', 'README.md'])).toMatchObject({ rc: 0, stderr: '' });
    await run.expectTabs([`${a.root}/README.md`]);
    // (The provider still logs its session-per-tab manager's gate note under this setting;
    // that manager is unused with the mux backend, and the values above are the proof.)
  });
});

/**
 * The hazard requirement 12 exists for: two installs (here, two apps with their own
 * profiles and project ids) that share tmux session names via `deterministicSessionNames`
 * attach to ONE tmux session. If either wrote its socket into it, the pane would open files
 * in whichever install attached last. Neither does: the shared pane has no variable.
 */
test.describe.serial('scenario 20: two installs sharing one tmux session', () => {
  let one: CallbackRun;
  let two: CallbackRun;
  let root: string;
  let first: PaneEnv;
  let session = '';
  const marker = `shared-${Date.now().toString(36)}`;

  /**
   * Neither install wrote anything into the shared SESSION: its own environment has no
   * callback variable (what a new window would inherit), and the server has no
   * update-environment entry that would copy one in on an attach. A shell that already
   * existed proves nothing here: its environment was fixed when it started.
   */
  const expectSessionClean = (install: CallbackRun): void => {
    for (const name of ['COCKPIT_CALLBACK_SOCK', 'COCKPIT_CALLBACK_VERSION', 'COCKPIT_CLI']) {
      expect(install.tmuxSessionEnv(session, name), `${name} in the shared session`).toBeNull();
    }
    expect(
      install.tmux('show-options', '-g', 'update-environment'),
      'no callback update-environment entry on the shared server',
    ).not.toMatch(/COCKPIT_/);
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const settings = { deterministicSessionNames: true };
    one = new CallbackRun({ name: 'sh1', backend: 'control-mode', profile: 'spaced', settings });
    two = new CallbackRun({
      name: 'sh2',
      backend: 'control-mode',
      profile: 'spaced',
      settings,
      tmuxFrom: one,
    });
    root = one.makeProject('shared', { 'README.md': README });
  });

  test.afterAll(async () => {
    // Install 1 owns the shared tmux server and its directory: it is torn down even when
    // install 2's teardown reports residue.
    try {
      await two?.teardown();
    } finally {
      await one?.teardown();
    }
  });

  test('install 1 creates the session: its pane has no variable', async () => {
    await one.launch();
    const project = await one.openFirstProject('Shared (install 1)', root);
    const pane = one.controlPane();
    await one.awaitShell(pane, basename(root));
    await one.shell(pane, `PRE_SHARED=${marker}; export PRE_SHARED`);
    first = await one.env(pane, 'shared-one');
    expectNoCallbackVariables(one, first);
    expect(project.id).toBeTruthy();
  });

  test('install 2 attaches to the SAME session and writes nothing into it; open reaches neither install', async () => {
    await two.launch();
    const project = await two.openFirstProject('Shared (install 2)', root);
    const pane = two.controlPane();
    await two.awaitShell(pane, basename(root));
    // One session, one shell, shared by both installs.
    await two.shell(pane, 'echo shared=$PRE_SHARED');
    await expect(pane.rows).toContainText(`shared=${marker}`);
    const env = await two.env(pane, 'shared-two');
    expect(env.pid, 'the same shell').toBe(first.pid);
    // (The shared session's environment is the one install 1's server start gave it.)
    expectNoCallbackVariables(two, env, one.muxHome);
    const sessions = two
      .tmux('list-sessions', '-F', '#{session_name}')
      .split('\n')
      .filter((name) => name.startsWith('agent-cockpit-'));
    expect(sessions, 'one session for both installs').toHaveLength(1);
    expect(sessions[0]).not.toContain(project.id); // named by the project root, not by an id
    session = sessions[0]!;
    expectSessionClean(two);

    // Each install's own CLI, run in the shared pane: no socket, exit 3, nothing opened.
    for (const install of [one, two]) {
      const cli = join(realpathSync(install.userDataDir), 'callback', 'bin', 'cockpit');
      const result = await two.cli(pane, ['open', 'README.md'], shellQuote(cli));
      expect(result.rc).toBe(3);
      expect(result.stderr).toContain('COCKPIT_CALLBACK_SOCK is not set');
    }
    await one.page.waitForTimeout(1_000);
    await two.expectTabs([]);
    await one.expectTabs([]);
  });

  test('a NEW window opened through install 2 inherits the session: still no variable', async () => {
    const pane = two.controlPane();
    await two.page.getByRole('button', { name: 'New tmux window' }).click();
    let fresh: PaneEnv | undefined;
    await expect
      .poll(
        async () => {
          await expect(pane.input).toHaveCount(1);
          fresh = await two.env(pane, 'shared-two-new');
          return fresh.pid;
        },
        { timeout: 40_000 },
      )
      .not.toBe(first.pid);
    expectNoCallbackVariables(two, fresh!, one.muxHome);
    expectSessionClean(two);
    await two.expectTabs([]);
    await one.expectTabs([]);
  });
});
