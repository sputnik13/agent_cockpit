/**
 * Harness for the terminal callback socket's live acceptance specs: a `CallbackRun`
 * owns every resource one scenario touches and removes all of it afterwards.
 *
 * Everything lives under ONE short directory (`/tmp/ac-e2e-cb-XXXXXX`, short because a
 * unix socket path is limited to ~104 bytes), except the profile of the runs that force
 * the /tmp socket fallback:
 *
 *   home/      HOME for the app (so no ~/.tmux.conf, ~/Library/Logs or ~/.ssh is read)
 *   App Support/ac   the Electron user-data dir of a `spaced` run: a path with a space
 *              like the real macOS profile, short enough for the primary socket location.
 *              A `long` run instead puts it in its own directory under os.tmpdir(), too
 *              long for that location, which forces the /tmp socket fallback; teardown
 *              removes and scans that directory too.
 *   tmux/      TMUX_TMPDIR, so the run's tmux socket lives (and dies) inside the directory
 *   mux/       COCKPIT_MUX_HOME
 *   reports/   files written by commands typed into panes (the exact environment and CLI
 *              output of a pane, read back by the test instead of scraped off the screen)
 *   projects/  throwaway git projects
 *
 * Nothing here touches the user's profile, the default `agent-cockpit` tmux socket or
 * their mux home. `teardown()` closes the app, kills this run's tmux server and mux
 * daemon, removes its fallback socket files (never the shared `/tmp/ac-cb-<uid>/`
 * directory) and its directories, then FAILS if any process, socket, directory or pane
 * shell named for the run is still there. Every cleanup step runs even if an earlier one
 * throws; the failures are reported together at the end.
 *
 * Verified on macOS only: the paths (`/tmp` is `/private/tmp`), `ps` and the profile layout
 * assume it.
 *
 * Panes are driven the way a user does: keystrokes into the focused xterm. The shell is
 * `/bin/sh` (no rc files, no prompt framework), so what is typed and printed is predictable.
 */
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MuxTopologySnapshot } from '../../../src/shared/providers/types';

export const ROOT = join(__dirname, '..', '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const UID = process.getuid?.() ?? 0;

export type Backend = 'control-mode' | 'session-per-tab' | 'cockpit-mux';

export interface RunOptions {
  /** Short label, used in directory and socket names. */
  name: string;
  backend: Backend;
  /**
   * The tmux server and the mux daemon outlive the app (scenario 19). Default: both are
   * ephemeral (`AC_TMUX_EPHEMERAL=1` / `COCKPIT_MUX_EPHEMERAL=1`) and die with the app.
   */
  persistent?: boolean;
  /**
   * `spaced`: the profile is `<base>/App Support/ac`, a path with a space short enough for
   * the primary socket location (`<userData>/callback/<h>.sock`). `long`: the profile is
   * under `os.tmpdir()`, too long for it, so the `/tmp/ac-cb-<uid>/` fallback is used.
   */
  profile?: 'spaced' | 'long';
  /** Extra settings written to the profile's `config.json` before the first launch. */
  settings?: Record<string, unknown>;
  /**
   * Use another run's tmux server (same socket and `TMUX_TMPDIR`), as a second install on
   * the same host does. The other run owns its directory; this one only attaches.
   */
  tmuxFrom?: CallbackRun;
}

export interface Project {
  id: string;
  label: string;
  root: string;
}

/** A pane's environment as the shell in it sees it. */
export interface PaneEnv {
  /** The shell's pid. */
  pid: number;
  /** Every `COCKPIT_*` variable plus `TMUX_PANE`. */
  vars: Record<string, string>;
}

export interface CliResult {
  rc: number;
  /** Whole seconds the command took (`date +%s` granularity: 0 means under a second, ±1). */
  seconds: number;
  stderr: string;
}

/** One terminal pane: the xterm of a single shell. */
export interface Pane {
  name: string;
  rows: Locator;
  input: Locator;
}

type PaneApi = {
  projects: {
    add(input: {
      label: string;
      connection: { kind: 'local'; rootPath: string };
    }): Promise<{ id: string }>;
    activate(id: string): Promise<void>;
    getActive(): Promise<string | null>;
  };
  muxSessions: {
    topology(projectId?: string): Promise<MuxTopologySnapshot>;
    shutdown(): Promise<string[]>;
  };
  logs: { get(): Promise<Array<{ level: string; context?: string; message: string }>> };
};
type ApiWindow = { api: PaneApi };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The environment of every git command a test runs: no user or system git configuration
 * (a signing or hook setting of the developer's must not change a fixture), a fixed author.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'e2e',
    GIT_AUTHOR_EMAIL: 'e2e@example.invalid',
    GIT_COMMITTER_NAME: 'e2e',
    GIT_COMMITTER_EMAIL: 'e2e@example.invalid',
  };
}

/** Run git in `cwd` with {@link gitEnv}. */
export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: gitEnv() });
}

/** Single-quote a word for the pane's shell. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `ps` lines (pid + command) mentioning any of `needles`. */
function processesMentioning(needles: string[]): string[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter((line) => line.trim() !== '' && needles.some((needle) => line.includes(needle)))
    .map((line) => line.trim());
}

export class CallbackRun {
  readonly base: string;
  readonly homeDir: string;
  readonly userDataDir: string;
  readonly tmuxTmpDir: string;
  readonly tmuxSocket: string;
  readonly muxHome: string;
  readonly reportsDir: string;
  readonly projectsDir: string;
  readonly backend: Backend;
  readonly persistent: boolean;
  /** What marks a process as this run's: its directory, and its tmux socket when it owns one. */
  private readonly needles: string[];
  readonly profile: 'spaced' | 'long';
  app!: ElectronApplication;
  page!: Page;
  private readonly sockets = new Set<string>();
  private readonly shellPids = new Set<number>();
  private counter = 0;
  private tornDown = false;
  /** An app launched by this run is up (not yet quit). */
  private running = false;

  constructor(opts: RunOptions) {
    this.backend = opts.backend;
    this.persistent = opts.persistent ?? false;
    this.profile = opts.profile ?? 'spaced';
    this.base = mkdtempSync(join('/tmp', `ac-e2e-cb-${opts.name}-`));
    this.homeDir = join(this.base, 'home');
    this.tmuxTmpDir = opts.tmuxFrom?.tmuxTmpDir ?? join(this.base, 'tmux');
    this.muxHome = join(this.base, 'mux');
    this.reportsDir = join(this.base, 'reports');
    this.projectsDir = join(this.base, 'projects');
    for (const dir of [this.homeDir, this.reportsDir, this.projectsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    this.userDataDir =
      this.profile === 'spaced'
        ? join(this.base, 'App Support', 'ac')
        : join(tmpdir(), `agent-cockpit-callback-e2e-profile-${randomBytes(4).toString('hex')}`);
    mkdirSync(this.userDataDir, { recursive: true });
    // A fresh profile defaults to the cockpit-mux backend with the WTerm renderer; the specs
    // drive the xterm DOM renderer on every backend (an existing config pins both), whose
    // DOM they query.
    writeFileSync(
      join(this.userDataDir, 'config.json'),
      JSON.stringify({
        terminalBackend: opts.backend,
        terminalRenderer: 'dom',
        ...opts.settings,
      }),
    );
    mkdirSync(this.tmuxTmpDir, { recursive: true });
    this.tmuxSocket =
      opts.tmuxFrom?.tmuxSocket ?? `ac-e2e-cb-${process.pid}-${randomBytes(3).toString('hex')}`;
    // A run that only attaches to another run's tmux server leaves the processes naming
    // that socket (the other install's app, the server) to their owner's teardown.
    // The profile is a needle too: a `long` run keeps it outside `base`, and the Electron
    // processes name it on their command line.
    this.needles = opts.tmuxFrom
      ? [this.base, this.userDataDir]
      : [this.base, this.tmuxSocket, this.userDataDir];
  }

  // ---- the app -----------------------------------------------------------------------

  /** The app's environment: nothing inherited from a cockpit this run may be launched from. */
  appEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (/^(ELECTRON_|AC_|COCKPIT_|NODE_ENV_ELECTRON_VITE$|TMUX|TMUX_PANE$)/.test(key)) continue;
      // `/bin/sh` reads $ENV when interactive; no startup file may change what a pane prints.
      if (/^(ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND)$/.test(key)) continue;
      env[key] = value;
    }
    return {
      ...env,
      // The app is routinely launched from inside a cockpit pane: simulate the OUTER app's
      // variables. The startup scrub must remove them before any spawn, so no pane (and
      // no tmux server or mux daemon) of this run may ever carry them (`isOuter`).
      COCKPIT_CALLBACK_SOCK: join(this.base, 'outer', 'outer.sock'),
      COCKPIT_CALLBACK_VERSION: '1',
      COCKPIT_CLI: join(this.base, 'outer', 'cockpit'),
      COCKPIT_CALLBACK_MUX_KEY: 'outer-pane',
      HOME: this.homeDir,
      AC_TMUX_SOCKET: this.tmuxSocket,
      TMUX_TMPDIR: this.tmuxTmpDir,
      COCKPIT_MUX_HOME: this.muxHome,
      ...(this.persistent ? {} : { AC_TMUX_EPHEMERAL: '1', COCKPIT_MUX_EPHEMERAL: '1' }),
      COCKPIT_PLAYWRIGHT_HEADLESS: '1',
      SHELL: '/bin/sh',
    };
  }

  async launch(): Promise<void> {
    expect(existsSync(MAIN), `build the app first (npm run build): ${MAIN} is missing`).toBe(true);
    this.app = await electron.launch({
      args: [MAIN, `--user-data-dir=${this.userDataDir}`, `--tmux-socket=${this.tmuxSocket}`],
      env: this.appEnv(),
    });
    this.running = true;
    this.page = await this.app.firstWindow();
    this.page.setDefaultTimeout(30_000);
    await this.page.waitForLoadState('domcontentloaded');
  }

  /**
   * Quit the app the way a user does. `closed` when the Electron main process exited by
   * itself, `killed` when it had to be killed after 15 s (a hung Electron would outlive the
   * run, holding its profile, tmux server and window).
   *
   * Playwright's own `close()` promise is deliberately not awaited: it settles only when
   * every process that inherited the app's stdio is gone, and macOS keeps Electron's
   * `chrome_crashpad_handler` alive for as long as a process that inherited the app's crash
   * port is (the tmux server and shells of a persistent run). The exit of the main process
   * is what "the app quit" means; `teardown()` waits for the helpers after it has taken
   * the tmux server and the mux daemon down.
   */
  async quit(): Promise<'closed' | 'killed' | 'none'> {
    const app = this.app;
    if (!app || !this.running) return 'none';
    this.running = false;
    const child = app.process();
    try {
      void app.close().catch(() => undefined);
    } catch {
      /* already closed */
    }
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await sleep(50);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      return 'killed';
    }
    return 'closed';
  }

  // ---- projects ----------------------------------------------------------------------

  /** A throwaway git project (committed, so worktree listing works) under this run. */
  makeProject(name: string, files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(this.projectsDir, `${name}-`)));
    git(root, 'init', '--initial-branch=main');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    git(root, 'add', '-A');
    git(root, 'commit', '-m', 'fixture');
    return root;
  }

  async addProject(label: string, root: string, activate: boolean): Promise<Project> {
    const id = await this.page.evaluate(
      async ({ label, root, activate }) => {
        const api = (window as unknown as ApiWindow).api;
        const project = await api.projects.add({
          label,
          connection: { kind: 'local', rootPath: root },
        });
        if (activate) await api.projects.activate(project.id);
        return project.id;
      },
      { label, root, activate },
    );
    return { id, label, root };
  }

  activeProjectId(): Promise<string | null> {
    return this.page.evaluate(() => (window as unknown as ApiWindow).api.projects.getActive());
  }

  async activate(project: Project): Promise<void> {
    await this.page.evaluate(
      (id) => (window as unknown as ApiWindow).api.projects.activate(id),
      project.id,
    );
    await this.expectActiveProject(project);
  }

  /** The renderer's OWN idea of the active project (what the status bar shows). */
  async expectActiveProject(project: Project): Promise<void> {
    await expect(this.page.locator('[data-active-project]')).toHaveAttribute(
      'data-active-project',
      project.id,
    );
  }

  /** The first project: add, activate, and reload so the renderer starts on it. */
  async openFirstProject(label: string, root: string): Promise<Project> {
    const project = await this.addProject(label, root, true);
    await this.page.reload();
    await this.page.waitForLoadState('domcontentloaded');
    await this.expectActiveProject(project);
    return project;
  }

  // ---- panes -------------------------------------------------------------------------

  /** The pane of tmux control-mode's current window (one pane is rendered at a time). */
  controlPane(): Pane {
    const host = this.page.locator('[data-panel-id="terminal"]');
    return {
      name: 'control',
      rows: host.locator('.xterm-rows'),
      input: host.locator('.xterm-helper-textarea'),
    };
  }

  /** A pane identified by its terminal key (session-per-tab `t1`..., a mux pane's key). */
  keyedPane(key: string): Pane {
    const host = this.page.locator(`[data-panel-id="terminal"] [data-terminal-key="${key}"]`);
    return {
      name: key,
      rows: host.locator('.xterm-rows'),
      input: host.locator('.xterm-helper-textarea'),
    };
  }

  /** Type one line into a pane's shell (the pane is focused first, as a click would). */
  async shell(pane: Pane, command: string): Promise<void> {
    await pane.input.focus();
    await this.page.keyboard.type(command);
    await this.page.keyboard.press('Enter');
  }

  /**
   * Wait until the shell in `pane` answers AND is in the project directory `cwdName` (the
   * basename of the project root): proof that the keystrokes reach the right project's shell.
   */
  async awaitShell(pane: Pane, cwdName: string): Promise<void> {
    const tag = `up${++this.counter}`;
    await expect(pane.input).toBeAttached({ timeout: 60_000 });
    await this.shell(pane, `echo ${tag}:\${PWD##*/}`);
    await expect(pane.rows).toContainText(`${tag}:${cwdName}`, { timeout: 30_000 });
  }

  /** The `COCKPIT_*` variables and `TMUX_PANE` the shell in `pane` really has. */
  async env(pane: Pane, label: string): Promise<PaneEnv> {
    const file = join(this.reportsDir, `${label}-${++this.counter}.env`);
    await this.shell(
      pane,
      `{ echo "PID=$$"; env | grep -E '^(COCKPIT_|TMUX_PANE=)'; } > ${file}.tmp; mv ${file}.tmp ${file}`,
    );
    await expect.poll(() => existsSync(file), { timeout: 20_000 }).toBe(true);
    const vars: Record<string, string> = {};
    let pid = 0;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const name = line.slice(0, at);
      const value = line.slice(at + 1);
      if (name === 'PID') pid = Number(value);
      else vars[name] = value;
    }
    expect(pid, `${label}: the report names the shell's pid`).toBeGreaterThan(0);
    this.shellPids.add(pid);
    if (vars['COCKPIT_CALLBACK_SOCK']) this.sockets.add(vars['COCKPIT_CALLBACK_SOCK']);
    return { pid, vars };
  }

  /**
   * Run a command in `pane`'s shell with its stderr captured to a file, and return the
   * exit code, whole seconds taken and the stderr. `bin` defaults to the documented
   * quoted form `"$COCKPIT_CLI"`.
   */
  async cli(pane: Pane, args: string[], bin = '"$COCKPIT_CLI"'): Promise<CliResult> {
    const tag = `cli${++this.counter}`;
    const err = join(this.reportsDir, `${tag}.err`);
    await this.shell(
      pane,
      `s=$(date +%s); ${bin} ${args.map(shellQuote).join(' ')} 2> ${err}; ` +
        `echo ${tag}-rc=$? dt=$(( $(date +%s) - s ))`,
    );
    const done = new RegExp(`${tag}-rc=(\\d+) dt=(\\d+)`);
    await expect
      .poll(async () => done.test((await pane.rows.textContent()) ?? ''), { timeout: 30_000 })
      .toBe(true);
    const match = done.exec((await pane.rows.textContent()) ?? '')!;
    return {
      rc: Number(match[1]),
      seconds: Number(match[2]),
      stderr: existsSync(err) ? readFileSync(err, 'utf8') : '',
    };
  }

  /**
   * Run a command in a surviving tmux pane WITHOUT the app, by typing it through tmux itself
   * (`send-keys`), exactly what the user's keyboard would do. The pane is found by its
   * shell's pid; the exit code, whole seconds taken and stderr come back through files.
   */
  async cliViaTmux(shellPid: number, args: string[], bin = '"$COCKPIT_CLI"'): Promise<CliResult> {
    const panes = this.tmux('list-panes', '-a', '-F', '#{pane_id} #{pane_pid}')
      .split('\n')
      .map((line) => line.split(' '));
    const pane = panes.find(([, pid]) => Number(pid) === shellPid)?.[0];
    expect(pane, `a tmux pane whose shell is ${shellPid}`).toBeTruthy();
    const out = join(this.reportsDir, `tmux-cli${++this.counter}`);
    this.tmux(
      'send-keys',
      '-t',
      pane!,
      '-l',
      `s=$(date +%s); ${bin} ${args.map(shellQuote).join(' ')} 2> ${out}.err; ` +
        `echo "$? $(( $(date +%s) - s ))" > ${out}.tmp; mv ${out}.tmp ${out}`,
    );
    this.tmux('send-keys', '-t', pane!, 'Enter');
    await expect.poll(() => existsSync(out), { timeout: 30_000 }).toBe(true);
    const [rc, seconds] = readFileSync(out, 'utf8').trim().split(' ').map(Number);
    return { rc: rc!, seconds: seconds!, stderr: readFileSync(`${out}.err`, 'utf8') };
  }

  /**
   * The same CLI binary with the same socket a pane has, run from the test process (for a
   * pane the test cannot type into, such as a background mux pane).
   */
  cliOutsidePane(vars: Record<string, string>, args: string[]): CliResult {
    const started = Date.now();
    const result = spawnSync(vars['COCKPIT_CLI']!, args, {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        PATH: process.env['PATH'] ?? '',
        COCKPIT_CALLBACK_SOCK: vars['COCKPIT_CALLBACK_SOCK'] ?? '',
        ...(vars['COCKPIT_CALLBACK_MUX_KEY']
          ? { COCKPIT_CALLBACK_MUX_KEY: vars['COCKPIT_CALLBACK_MUX_KEY'] }
          : {}),
      },
    });
    return {
      rc: result.status ?? -1,
      seconds: Math.round((Date.now() - started) / 1000),
      stderr: result.stderr,
    };
  }

  // ---- what the user sees ------------------------------------------------------------

  contentTabs(): Locator {
    return this.page.getByRole('tablist', { name: 'Open files' }).getByRole('tab');
  }

  /** The hover titles (full paths) of the active project's Content tabs, in order. */
  tabTitles(): Promise<Array<string | null>> {
    return this.contentTabs().evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute('title')));
  }

  async expectTabs(titles: string[]): Promise<void> {
    await expect.poll(() => this.tabTitles(), { timeout: 20_000 }).toEqual(titles);
  }

  /** Which panel holds DOM focus, and whether it is a terminal pane's input. */
  focusOwner(): Promise<{ panel: string | null; isXtermInput: boolean }> {
    return this.page.evaluate(() => {
      const el = document.activeElement;
      return {
        panel: el?.closest('[data-panel-id]')?.getAttribute('data-panel-id') ?? null,
        isXtermInput: el?.classList.contains('xterm-helper-textarea') ?? false,
      };
    });
  }

  async expectTerminalFocused(): Promise<void> {
    await expect.poll(() => this.focusOwner()).toEqual({ panel: 'terminal', isXtermInput: true });
  }

  /** Main-process log lines (the Diagnostics buffer) containing `text`. */
  async logLines(text: string): Promise<string[]> {
    const entries = await this.page.evaluate(() => (window as unknown as ApiWindow).api.logs.get());
    return entries.filter((e) => e.message.includes(text)).map((e) => e.message);
  }

  // ---- tmux --------------------------------------------------------------------------

  /** Run tmux against THIS run's server (the same TMUX_TMPDIR the app was launched with). */
  tmux(...args: string[]): string {
    const env = { ...process.env, TMUX_TMPDIR: this.tmuxTmpDir };
    delete env['TMUX'];
    delete env['TMUX_PANE'];
    return execFileSync('tmux', ['-L', this.tmuxSocket, ...args], {
      encoding: 'utf8',
      // stderr is captured (it is on the thrown error), not echoed: "no server running" is
      // the expected answer during cleanup.
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  }

  /**
   * A tmux session's own value of `name` (what its panes inherit), or null when the session
   * has none (unset, or tmux's `-NAME` removal marker).
   */
  tmuxSessionEnv(session: string, name: string): string | null {
    let line: string;
    try {
      line = this.tmux('show-environment', '-t', `=${session}`, name).trim();
    } catch {
      return null; // tmux: "unknown variable"
    }
    return line.startsWith(`${name}=`) ? line.slice(name.length + 1) : null;
  }

  tmuxServerUp(): boolean {
    try {
      this.tmux('list-sessions');
      return true;
    } catch {
      return false;
    }
  }

  // ---- mux ---------------------------------------------------------------------------

  /** The cockpit-mux binary the app launches (the dev build's `cockpit-mux/dist`). */
  muxBinary(): string {
    const dist = join(ROOT, 'cockpit-mux', 'dist');
    const manifestName = readdirSync(dist).find((name) => /^manifest-[\d.]+\.json$/.test(name));
    if (!manifestName) throw new Error(`no cockpit-mux manifest in ${dist}`);
    const manifest = JSON.parse(readFileSync(join(dist, manifestName), 'utf8')) as {
      binaries: Array<{ os: string; arch: string; filename: string }>;
    };
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const entry = manifest.binaries.find((item) => item.os === os && item.arch === arch);
    if (!entry) throw new Error(`no cockpit-mux build for ${os}-${arch} in ${dist}`);
    return join(dist, entry.filename);
  }

  muxTopology(project: Project): Promise<MuxTopologySnapshot> {
    return this.page.evaluate(
      (id) => (window as unknown as ApiWindow).api.muxSessions.topology(id),
      project.id,
    );
  }

  /** Every non-reserved pane of the project's mux sessions as `{sessionId, windowId, paneId, key}`. */
  async muxPanes(
    project: Project,
  ): Promise<Array<{ sessionId: string; windowId: string; paneId: string; key: string }>> {
    const snapshot = await this.muxTopology(project);
    return snapshot.sessions.flatMap((session) =>
      session.windows.flatMap((window) =>
        window.panes
          .filter((pane) => pane.key !== 'run')
          .map((pane) => ({
            sessionId: session.sessionId,
            windowId: window.windowId,
            paneId: pane.paneId,
            key: pane.key,
          })),
      ),
    );
  }

  /** Pids of daemons started with this run's mux home. */
  muxDaemonPids(): number[] {
    return processesMentioning([`--home ${this.muxHome}`])
      .filter((line) => line.includes('cockpit-mux'))
      .map((line) => Number(line.split(/\s+/, 1)[0]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  /**
   * A unix socket FILE with nothing listening behind it: what is left when a listener is
   * killed without its shutdown path. Returns its path (inside this run's directory).
   */
  makeStaleSocket(name: string): string {
    const path = join(this.reportsDir, `${name}.sock`);
    try {
      execFileSync(
        process.execPath,
        [
          '-e',
          "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))",
          path,
        ],
        { stdio: 'ignore' },
      );
    } catch {
      /* the child killed itself on purpose */
    }
    expect(lstatSync(path).isSocket(), 'a leftover socket file').toBe(true);
    return path;
  }

  /** True when `value` is one of the simulated OUTER app's variables (see `appEnv`). */
  isOuter(value: string | undefined): boolean {
    return (
      value !== undefined && (value.includes(join(this.base, 'outer')) || value === 'outer-pane')
    );
  }

  // ---- the socket contract -----------------------------------------------------------

  /**
   * Assert a `COCKPIT_CALLBACK_SOCK` value follows the documented location rules for this
   * run's profile, and that the socket is a unix socket (mode 0600) in a 0700 directory
   * owned by the user.
   */
  expectSocketLocation(projectId: string, sock: string): void {
    const hash = createHash('sha256').update(projectId).digest('hex').slice(0, 12);
    if (this.profile === 'spaced') {
      // (Electron canonicalizes the user-data dir: /tmp is /private/tmp on macOS.)
      expect(sock, 'the primary location: <userData>/callback/<h>.sock').toBe(
        join(realpathSync(this.userDataDir), 'callback', `${hash}.sock`),
      );
      expect(sock).toContain(' '); // the default macOS profile path has a space; so does this one
    } else {
      expect(sock, 'the /tmp fallback: /tmp/ac-cb-<uid>/<h>.sock').toMatch(
        new RegExp(`^/tmp/ac-cb-${UID}/[0-9a-f]{12}\\.sock$`),
      );
    }
    const socket = lstatSync(sock);
    expect(socket.isSocket(), `${sock} is a unix socket`).toBe(true);
    expect(socket.mode & 0o777, 'the socket is 0600').toBe(0o600);
    expect(socket.uid).toBe(UID);
    const dir = lstatSync(join(sock, '..'));
    expect(dir.isDirectory() && !dir.isSymbolicLink(), 'a real directory').toBe(true);
    expect(dir.mode & 0o777, 'the directory is 0700').toBe(0o700);
    expect(dir.uid).toBe(UID);
  }

  /** Assert `COCKPIT_CLI` is this profile's link to a runnable helper binary. */
  expectCliLink(cli: string): void {
    expect(cli).toBe(join(realpathSync(this.userDataDir), 'callback', 'bin', 'cockpit'));
    expect(lstatSync(cli).isSymbolicLink(), 'COCKPIT_CLI is a symlink').toBe(true);
    expect(existsSync(cli), `COCKPIT_CLI resolves: ${readlinkSync(cli)}`).toBe(true);
  }

  // ---- cleanup -----------------------------------------------------------------------

  /**
   * Close the app, take down this run's tmux server and mux daemon, remove its socket
   * files and directory, and fail on any residue named for the run.
   */
  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    const problems: string[] = [];
    /** One cleanup step: whatever it throws becomes a reported problem, never a skipped step. */
    const step = async (label: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    try {
      // A persistent mux daemon outlives the app by design: while the app is still up, ask the
      // daemon to shut down through it (the app's own "shut down mux"); signals are the fallback.
      await step('ask the mux daemon to shut down', async () => {
        if (this.persistent && this.app && this.running && this.muxDaemonPids().length > 0) {
          await this.shutdownMuxThroughApp().catch(() => undefined);
        }
      });
      await step('quit the app', async () => {
        if ((await this.quit()) === 'killed') {
          problems.push('the app did not exit by itself and was killed');
        }
      });
      await step('stop the mux daemon', () => this.stopMuxDaemon(problems));
      await step('take the tmux server down', async () => {
        try {
          this.tmux('kill-server');
        } catch {
          /* no server (the app's own will-quit already took the ephemeral one down) */
        }
        await expect
          .poll(() => this.tmuxServerUp(), {
            message: 'the run tmux server is gone',
            timeout: 10_000,
          })
          .toBe(false);
      });
      await step('remove the callback sockets', () => {
        for (const sock of this.sockets) {
          if (existsSync(sock)) {
            problems.push(`callback socket still present after the app exited: ${sock}`);
            rmSync(sock, { force: true });
          }
        }
      });
      await step('check the pane shells', async () => {
        await sleep(300);
        for (const pid of this.shellPids) {
          if (alive(pid)) {
            problems.push(`pane shell ${pid} still running`);
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* gone meanwhile */
            }
          }
        }
      });
      await step('wait for and stop stray processes', async () => {
        // Electron's crash handler exits shortly after the last process that inherited its port.
        const helperDeadline = Date.now() + 10_000;
        while (processesMentioning(this.needles).length > 0 && Date.now() < helperDeadline) {
          await sleep(100);
        }
        for (const line of processesMentioning(this.needles)) {
          problems.push(`process still running: ${line.slice(0, 200)}`);
          const pid = Number(line.split(/\s+/, 1)[0]);
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* gone meanwhile */
            }
          }
        }
      });
    } finally {
      // The directories go even if something above threw unexpectedly.
      for (const dir of new Set([this.base, this.userDataDir])) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          problems.push(
            `cannot remove ${dir}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (existsSync(this.base)) problems.push(`directory still present: ${this.base}`);
    if (existsSync(this.userDataDir)) problems.push(`profile still present: ${this.userDataDir}`);
    if (existsSync(join('/tmp', `tmux-${UID}`, this.tmuxSocket))) {
      problems.push(`tmux socket in the default directory: /tmp/tmux-${UID}/${this.tmuxSocket}`);
    }
    expect(problems, 'no residue left by the run').toEqual([]);
  }

  private async stopMuxDaemon(problems: string[]): Promise<void> {
    let pids = this.muxDaemonPids();
    if (pids.length === 0) return;
    // An ephemeral daemon exits by itself when the app's owner pipe closes, and a
    // persistent one has just been asked to shut down: give both a moment before signalling.
    const deadline = Date.now() + 5_000;
    while (pids.length > 0 && Date.now() < deadline) {
      await sleep(100);
      pids = this.muxDaemonPids();
    }
    if (pids.length === 0) return;
    if (!this.persistent)
      problems.push(`ephemeral mux daemon outlived the app: ${pids.join(', ')}`);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone meanwhile */
      }
    }
    const killDeadline = Date.now() + 3_000;
    while (this.muxDaemonPids().length > 0 && Date.now() < killDeadline) await sleep(100);
    for (const pid of this.muxDaemonPids()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone meanwhile */
      }
    }
  }

  /** Stop this run's persistent mux daemon through the app (the explicit "shut down mux"). */
  async shutdownMuxThroughApp(): Promise<void> {
    await this.page.evaluate(() => (window as unknown as ApiWindow).api.muxSessions.shutdown());
  }
}
