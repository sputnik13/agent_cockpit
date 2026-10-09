import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const APP =
  process.env['COCKPIT_E2E_APP'] ??
  join(ROOT, 'release', 'mac-arm64', 'Agent Cockpit.app', 'Contents', 'MacOS', 'Agent Cockpit');
const requestedTmuxSocket = process.env['AC_TMUX_SOCKET'];
if (requestedTmuxSocket && !/^ac-e2e-[a-zA-Z0-9_-]+$/.test(requestedTmuxSocket)) {
  throw new Error(
    `refusing non-isolated E2E tmux socket ${requestedTmuxSocket}; use an ac-e2e-* socket`,
  );
}
const TEST_TMUX_SOCKET = requestedTmuxSocket ?? `ac-e2e-${process.pid}-${randomBytes(4).toString('hex')}`;

// A valid, deterministic 1×1 opaque-red RGBA PNG. Keeping this as protocol
// payload instead of a fixture file exercises the real direct Kitty transfer
// path from the PTY through the mux into WTerm's graphics overlay.
const KITTY_DIRECT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

let browser: Browser | null = null;
let appProcess: ChildProcessWithoutNullStreams | null = null;
let page: Page;
let userDataDir: string;
let projectRoot: string;
let primaryProjectId: string;

function e2eTempRoot(): string {
  return process.env['COCKPIT_E2E_TEMP_ROOT'] ?? tmpdir();
}

function makeProject(): string {
  const root = mkdtempSync(join(e2eTempRoot(), 'agent-cockpit-mux-e2e-project-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# mux e2e fixture\n');
  return root;
}

function packagedMuxCli(): string {
  const dist = join(dirname(APP), '..', 'Resources', 'cockpit-mux', 'dist');
  const binary = readdirSync(dist).find((name) => /^cockpit-mux-.*-darwin-arm64$/.test(name));
  if (!binary) throw new Error(`packaged cockpit-mux CLI is missing from ${dist}`);
  return join(dist, binary);
}

function profileMuxDaemonPID(): number | undefined {
  const home = join(userDataDir, 'mux-home');
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of processes.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && match[2]!.includes('cockpit-mux') && match[2]!.includes(`--home ${home}`))
      return Number(match[1]);
  }
  return undefined;
}

async function reserveDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('failed to reserve a local debugging port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function launch(muxLifecycle: 'inherit' | 'production' = 'inherit'): Promise<Page> {
  if (!existsSync(APP)) throw new Error(`packaged Agent Cockpit executable is missing: ${APP}`);
  const debugPort = await reserveDebugPort();
  const appEnvironment = {
    ...process.env,
    HOME: userDataDir,
    COCKPIT_MUX_HOME: join(userDataDir, 'mux-home'),
    AC_TMUX_EPHEMERAL: '1',
    AC_TMUX_SOCKET: TEST_TMUX_SOCKET,
    // Electron has no true headless mode; keep the real window hidden while
    // Playwright drives the packaged renderer over Chromium DevTools.
    COCKPIT_PLAYWRIGHT_HEADLESS: '1',
  };
  if (muxLifecycle === 'production') delete appEnvironment['COCKPIT_MUX_EPHEMERAL'];
  // The test still launches the configured default shell, but must not source
  // the developer's interactive zsh config (which can start background jobs
  // that outlive the isolated mux profile).
  delete appEnvironment['ZDOTDIR'];
  appProcess = spawn(
    APP,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
    {
      stdio: 'pipe',
      env: appEnvironment,
    },
  );
  appProcess.stderr.resume();
  appProcess.stdout.resume();
  await expect
    .poll(
      async () => {
        try {
          browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15_000, message: 'packaged Electron app did not expose its CDP endpoint' },
    )
    .toBe(true);
  const context = browser.contexts()[0];
  if (!context) throw new Error('packaged Electron app did not create a browser context');
  const [window] = context.pages();
  if (!window) throw new Error('packaged Electron app did not create a renderer window');
  window.setDefaultTimeout(15_000);
  await window.waitForLoadState('domcontentloaded');
  return window;
}

async function waitForAppExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([
      once(child, 'exit'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('packaged app did not exit')), 5_000),
      ),
    ]);
  }
}

async function expectSuccessfulAppExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await waitForAppExit(child);
  expect(child.signalCode, 'Electron should exit normally, not from a signal').toBeNull();
  expect(child.exitCode, 'Electron should exit with a successful status').toBe(0);
}

async function releaseAppConnection(child: ChildProcessWithoutNullStreams): Promise<void> {
  const connectedBrowser = browser;
  browser = null;
  appProcess = null;
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
  await connectedBrowser?.close().catch(() => {});
}

/** Close the actual Electron window so window-all-closed invokes app.quit(). */
async function quitAppNormally(): Promise<void> {
  const child = appProcess;
  const connectedBrowser = browser;
  if (!child || !connectedBrowser) throw new Error('packaged app is not running');
  const cdp = await connectedBrowser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find(
      (candidate) => candidate.type === 'page' && candidate.url === page.url(),
    );
    if (!target) throw new Error(`could not find Electron window target for ${page.url()}`);
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  } finally {
    // Closing the last Electron page can disconnect CDP before detach settles.
    await cdp.detach().catch(() => {});
  }
  await expectSuccessfulAppExit(child);
  await releaseAppConnection(child);
}

type Topology = Array<{
  sessionId: string;
  windowOrder: string[];
  activeWindowId: string;
  windows: Array<{
    windowId: string;
    activePaneId: string;
    layout: {
      direction: 'horizontal' | 'vertical' | null;
      ratio: number | null;
      first: unknown;
      second: unknown;
    };
    panes: Array<{ sessionId: string; paneId: string; key: string; cols: number; rows: number }>;
    zoomedPaneId: string | null;
  }>;
}>;

type TopologySnapshot = {
  activeSessionId: string;
  sessions: Topology;
};

type MuxShape = {
  name: string;
  splits: Array<'horizontal' | 'vertical'>;
  // Source/target are pane creation indexes. This is intentionally separate
  // from the renderer's adjacency implementation: unchanged selection may be
  // accepted only for directions absent from this scenario oracle.
  edges: ReadonlyArray<readonly [number, 'left' | 'right' | 'up' | 'down', number]>;
};

// The bounded non-isomorphic pane trees from TEST_PLAN.md. Keeping the shape
// table as data makes a failure reproducible from its test title rather than a
// fragile sequence of interactions hidden in a hand-authored example.
const MUX_SHAPES: readonly MuxShape[] = [
  { name: 'root', splits: [], edges: [] },
  {
    name: 'horizontal-pair',
    splits: ['horizontal'],
    edges: [
      [0, 'right', 1],
      [1, 'left', 0],
    ],
  },
  {
    name: 'vertical-pair',
    splits: ['vertical'],
    edges: [
      [0, 'down', 1],
      [1, 'up', 0],
    ],
  },
  {
    name: 'horizontal-then-vertical',
    splits: ['horizontal', 'vertical'],
    edges: [
      [0, 'right', 1],
      [1, 'left', 0],
      [1, 'down', 2],
      [2, 'up', 1],
      [2, 'left', 0],
    ],
  },
  {
    name: 'vertical-then-horizontal',
    splits: ['vertical', 'horizontal'],
    edges: [
      [0, 'down', 1],
      [1, 'up', 0],
      [1, 'right', 2],
      [2, 'left', 1],
      [2, 'up', 0],
    ],
  },
  {
    name: 'three-leaf-horizontal',
    splits: ['horizontal', 'horizontal'],
    edges: [
      [0, 'right', 1],
      [1, 'left', 0],
      [1, 'right', 2],
      [2, 'left', 1],
    ],
  },
] as const;

const PRODUCTION_RELAUNCH_TEST =
  'keeps the same live mux shell across an Electron quit and relaunch';

const OPPOSITE_DIRECTION: Record<
  'left' | 'right' | 'up' | 'down',
  'left' | 'right' | 'up' | 'down'
> = {
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};

const PANE_SHORTCUT: Record<'left' | 'right' | 'up' | 'down', string> = {
  left: 'Meta+Alt+ArrowLeft',
  right: 'Meta+Alt+ArrowRight',
  up: 'Meta+Alt+ArrowUp',
  down: 'Meta+Alt+ArrowDown',
};

const MUX_SHORTCUT = {
  splitRight: 'Meta+d',
  splitBelow: 'Meta+Shift+d',
  newWindow: 'Meta+t',
  closeWindow: 'Meta+w',
  zoom: 'Meta+Shift+z',
} as const;

async function exitActiveMuxPane(): Promise<void> {
  // Every split remains visible, so the active window can contain several
  // textareas. The frontend command is intentionally tested through the pane
  // that currently owns DOM focus, which is the same path a real shell exit
  // takes.
  const input = page.locator('textarea:focus');
  await expect(input).toHaveCount(1);
  await input.pressSequentially('exit');
  await input.press('Enter');
}

async function topologySnapshot(): Promise<TopologySnapshot> {
  return page.evaluate(() => window.api.muxSessions.topology());
}

async function topology(): Promise<Topology> {
  return (await topologySnapshot()).sessions;
}

/** Resolve the daemon session that owns the currently rendered mux window. */
async function activeTopologySession(): Promise<Topology[number]> {
  const visibleKeys = await activeWindowTerminals().evaluateAll((terminals) =>
    terminals
      .map((terminal) => terminal.parentElement?.dataset.terminalKey)
      .filter((key): key is string => Boolean(key)),
  );
  const session = (await topology()).find((candidate) =>
    candidate.windows.some((window) => window.panes.some((pane) => visibleKeys.includes(pane.key))),
  );
  expect(
    session,
    `visible terminal keys must belong to one mux session: ${visibleKeys.join(', ')}`,
  ).toBeDefined();
  return session!;
}

/** The inactive mux windows remain laid out but use visibility:hidden. */
function activeWindowTerminals(): Locator {
  return page.locator('[aria-hidden="false"] .ac-term');
}

function focusedActiveWindowTerminals(): Locator {
  return page.locator('[aria-hidden="false"] .ac-term.focused');
}

async function visibleXtermRows(terminal: Locator): Promise<string[]> {
  return terminal.locator('.xterm-rows > div').allTextContents();
}

function xtermViewportHasMarker(rows: string[], marker: string): boolean {
  // A narrow split can wrap one logical marker across several xterm DOM rows.
  // The viewport is still the visible oracle. Trim right-padding first: xterm
  // exposes each visual row at its full cell width, and retaining that padding
  // would insert spaces into a marker that wraps across two rows.
  return rows
    .map((row) => row.trimEnd())
    .join('')
    .includes(marker);
}

async function visibleWtermRows(terminal: Locator): Promise<string[]> {
  return terminal.evaluate((host) => {
    const viewport = host.getBoundingClientRect();
    return [...host.querySelectorAll<HTMLElement>('.term-row')]
      .filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      })
      .map((row) => row.textContent ?? '');
  });
}

type WtermViewportDiagnostic = {
  connected: boolean;
  textContainsMarker: boolean;
  mountedRows: number;
  visibleRows: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  clientWidth: number;
};

async function wtermViewportDiagnostic(
  terminal: Locator,
  marker: string,
): Promise<WtermViewportDiagnostic> {
  return terminal.evaluate((host, expectedMarker) => {
    const viewport = host.getBoundingClientRect();
    const rows = [...host.querySelectorAll<HTMLElement>('.term-row')];
    const visibleRows = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    });
    return {
      connected: host.isConnected,
      textContainsMarker: (host.textContent ?? '').includes(expectedMarker),
      mountedRows: rows.length,
      visibleRows: visibleRows.length,
      scrollTop: host.scrollTop,
      scrollHeight: host.scrollHeight,
      clientHeight: host.clientHeight,
      clientWidth: host.clientWidth,
    };
  }, marker);
}

/** Fail with the live WTerm virtual-viewport state, not only a Boolean predicate. */
async function expectVisibleWtermMarker(
  terminal: Locator,
  marker: string,
  message: string,
): Promise<void> {
  let last: WtermViewportDiagnostic | null = null;
  try {
    await expect
      .poll(
        async () => {
          last = await wtermViewportDiagnostic(terminal, marker);
          return (
            last.textContainsMarker &&
            (await canonicalWtermViewport(await visibleWtermRows(terminal))).includes(marker)
          );
        },
        { message, timeout: 5_000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(last)}`, { cause: error });
  }
}

function canonicalWtermViewport(rows: string[]): string {
  // WTerm reflows its DOM grid when a pane's measured width changes by a cell.
  // Compare the rendered character stream, not incidental row wrapping/padding.
  return rows.map((row) => row.trimEnd()).join('');
}

type WtermTransitionProbe = {
  /** The synchronous, pre-action state. It is deliberately excluded from frame counters. */
  baseline: {
    connected: boolean;
    markerVisible: boolean;
    visibleRowCount: number;
  } | null;
  frames: number;
  visibleFrames: number;
  blankFrames: number;
  markerMissingFrames: number;
  disconnectedFrames: number;
  gridChanges: number;
  rowContentChanges: number;
  rowInsertions: number;
  rowRemovals: number;
  samples: Array<{
    time: number;
    visible: boolean;
    connected: boolean;
    clientWidth: number;
    clientHeight: number;
    scrollTop: number;
    scrollHeight: number;
    markerVisible: boolean;
    visibleRowCount: number;
  }>;
};

type WtermTransitionBaseline = NonNullable<WtermTransitionProbe['baseline']>;

/**
 * Observe the real WTerm DOM across an interaction. Unlike the old row-node
 * counter, this catches the renderer replacing children inside an existing
 * row. Frame samples distinguish an intentionally hidden mux window from a
 * returned pane that briefly paints empty content.
 */
async function beginWtermTransitionProbe(
  terminal: Locator,
  marker: string,
): Promise<WtermTransitionBaseline> {
  return terminal.evaluate((host, markerText) => {
    type ProbeHost = HTMLElement & {
      __acWtermTransitionProbe?: WtermTransitionProbe;
      __acWtermTransitionObserver?: MutationObserver;
      __acWtermTransitionFrame?: number;
    };
    const target = host as ProbeHost;
    const state: WtermTransitionProbe = {
      baseline: null,
      frames: 0,
      visibleFrames: 0,
      blankFrames: 0,
      markerMissingFrames: 0,
      disconnectedFrames: 0,
      gridChanges: 0,
      rowContentChanges: 0,
      rowInsertions: 0,
      rowRemovals: 0,
      samples: [],
    };
    const rowsIn = (node: Node): number => {
      if (!(node instanceof HTMLElement)) return 0;
      return Number(node.matches('.term-row')) + node.querySelectorAll('.term-row').length;
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;
        const targetRow =
          record.target instanceof HTMLElement && record.target.closest('.term-row');
        if (targetRow && (record.addedNodes.length > 0 || record.removedNodes.length > 0)) {
          state.rowContentChanges += 1;
        }
        if (record.target instanceof HTMLElement && record.target.matches('.term-grid'))
          state.gridChanges += 1;
        record.addedNodes.forEach((node) => (state.rowInsertions += rowsIn(node)));
        record.removedNodes.forEach((node) => (state.rowRemovals += rowsIn(node)));
      }
    });
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    const collect = () => {
      const pane = target.closest<HTMLElement>('[aria-hidden]');
      const visible = pane?.getAttribute('aria-hidden') !== 'true';
      const viewport = target.getBoundingClientRect();
      const rows = [...target.querySelectorAll<HTMLElement>('.term-row')].filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      // A narrow split may wrap the marker between DOM rows. Mirror the
      // viewport oracle used by the user-visible assertions: row-local matching
      // would report a false disappearance even though the rendered character
      // stream is continuous.
      const markerVisible = rows
        .map((row) => (row.textContent ?? '').trimEnd())
        .join('')
        .includes(markerText);
      return {
        time: performance.now(),
        visible,
        connected: target.isConnected,
        clientWidth: target.clientWidth,
        clientHeight: target.clientHeight,
        scrollTop: target.scrollTop,
        scrollHeight: target.scrollHeight,
        markerVisible,
        visibleRowCount: rows.length,
      };
    };
    const sample = (): void => {
      const sampleState = collect();
      state.frames += 1;
      if (!sampleState.connected) state.disconnectedFrames += 1;
      if (sampleState.visible) {
        state.visibleFrames += 1;
        if (sampleState.visibleRowCount === 0) state.blankFrames += 1;
        if (!sampleState.markerVisible) state.markerMissingFrames += 1;
      }
      if (state.samples.length < 180) state.samples.push(sampleState);
      target.__acWtermTransitionFrame = requestAnimationFrame(sample);
    };
    target.__acWtermTransitionProbe = state;
    target.__acWtermTransitionObserver = observer;
    // Record the pre-action baseline synchronously. It is intentionally not
    // included in transition counters: a seed still rendering at this point is
    // setup failure, not evidence that focus caused a redraw.
    const baseline = collect();
    state.baseline = {
      connected: baseline.connected,
      markerVisible: baseline.markerVisible,
      visibleRowCount: baseline.visibleRowCount,
    };
    target.__acWtermTransitionFrame = requestAnimationFrame(sample);
    return state.baseline;
  }, marker);
}

async function endWtermTransitionProbe(terminal: Locator): Promise<WtermTransitionProbe> {
  return terminal.evaluate((host) => {
    type ProbeHost = HTMLElement & {
      __acWtermTransitionProbe?: WtermTransitionProbe;
      __acWtermTransitionObserver?: MutationObserver;
      __acWtermTransitionFrame?: number;
    };
    const target = host as ProbeHost;
    if (target.__acWtermTransitionFrame !== undefined)
      cancelAnimationFrame(target.__acWtermTransitionFrame);
    target.__acWtermTransitionObserver?.disconnect();
    const result = target.__acWtermTransitionProbe;
    delete target.__acWtermTransitionFrame;
    delete target.__acWtermTransitionObserver;
    delete target.__acWtermTransitionProbe;
    if (!result) throw new Error('WTerm transition probe was not installed');
    return result;
  });
}

/** Require a marker to stay in the real DOM viewport across several paints. */
async function waitForStableWtermMarker(terminal: Locator, marker: string): Promise<void> {
  for (let frame = 0; frame < 3; frame += 1) {
    await expect
      .poll(async () => canonicalWtermViewport(await visibleWtermRows(terminal)).includes(marker), {
        message: `WTerm marker ${marker} was not visible`,
      })
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
  }
}

function activeWindowTerminal(key: string): Locator {
  return page.locator(`[aria-hidden="false"] [data-terminal-key="${key}"] .ac-term`);
}

/** A retained pane in a hidden window is still mounted but not interactive. */
function anyWindowTerminal(key: string): Locator {
  return page.locator(`[data-terminal-key="${key}"] .ac-term`);
}

function layoutDirections(layout: Topology[0]['windows'][0]['layout'] | null): string[] {
  if (!layout?.direction) return [];
  return [
    layout.direction,
    ...layoutDirections(layout.first as Topology[0]['windows'][0]['layout']),
    ...layoutDirections(layout.second as Topology[0]['windows'][0]['layout']),
  ];
}

async function closeApp(): Promise<void> {
  const child = appProcess;
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    await waitForAppExit(child);
  }
  if (child) await releaseAppConnection(child);
  else {
    const connectedBrowser = browser;
    browser = null;
    await connectedBrowser?.close().catch(() => {});
  }
}

/** Stop the daemon owned by this temporary profile so serial E2E cases do not
 * leave one detached long-lived process each on developer machines. */
async function stopProfileMuxDaemon(): Promise<void> {
  const home = join(userDataDir, 'mux-home');
  if (!existsSync(home)) return;
  const expectedCommand = `${packagedMuxCli()} --home ${home}`;
  const processLines = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const pids = processLines
    .split('\n')
    .filter((line) => line.includes(expectedCommand))
    .map((line) => Number(line.trim().split(/\s+/, 1)[0]))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const deadline = Date.now() + 2_000;
  while (pids.length > 0 && Date.now() < deadline) {
    const stillRunning = pids.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!stillRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  const remaining = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (remaining.length > 0)
    throw new Error(`profile cockpit-mux processes survived teardown: ${remaining.join(', ')}`);
}

/** Drive xterm's real virtual-viewport key path and prove every page advances. */
async function scrollTerminalToMarker(
  terminal: Locator,
  marker: string,
  direction: 'up' | 'down' = 'up',
): Promise<void> {
  const textarea = terminal.locator('textarea');
  await textarea.click();
  const shortcut = direction === 'up' ? 'Shift+PageUp' : 'Shift+PageDown';
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const visibleRows = await visibleXtermRows(terminal);
    // xterm can share a marker with the prompt or wrap it across DOM rows.
    if (xtermViewportHasMarker(visibleRows, marker)) return;
    await textarea.press(shortcut);
    try {
      await expect
        .poll(() => visibleXtermRows(terminal), { timeout: 750 })
        .not.toEqual(visibleRows);
    } catch {
      // Electron occasionally leaves Shift+PageDown with the browser after a
      // restored hidden pane becomes visible. Fall back to the terminal's real
      // wheel input path; this is still a user-visible viewport operation, not
      // a private scrollback query or a synthetic renderer mutation.
      const box = await terminal.boundingBox();
      expect(box, `xterm ${direction} fallback needs a visible terminal`).not.toBeNull();
      await terminal.hover({ position: { x: box!.width / 2, y: box!.height / 2 } });
      await page.mouse.wheel(0, direction === 'up' ? -480 : 480);
      await expect
        .poll(() => visibleXtermRows(terminal), {
          message: `xterm ${direction} page ${attempt + 1} did not change after keyboard or wheel input`,
          timeout: 1_000,
        })
        .not.toEqual(visibleRows);
    }
  }
  await expect
    .poll(async () => xtermViewportHasMarker(await visibleXtermRows(terminal), marker), {
      message: `expected retained terminal output ${marker} after real scroll input`,
    })
    .toBe(true);
}

async function wheelXtermAndRequireVisibleRowsChange(terminal: Locator): Promise<void> {
  const xterm = terminal.locator('.xterm');
  const box = await xterm.boundingBox();
  expect(box, 'xterm must be visible before testing wheel input').not.toBeNull();
  const visibleRows = await visibleXtermRows(terminal);
  await xterm.hover({ position: { x: box!.width / 2, y: box!.height / 2 } });
  await page.mouse.wheel(0, -120);
  await expect
    .poll(() => visibleXtermRows(terminal), {
      message: 'xterm wheel input did not change the visible rows',
      timeout: 1_000,
    })
    .not.toEqual(visibleRows);
}

/** WTerm uses its DOM host's ordinary wheel path for virtualized history. */
async function scrollWtermToMarker(terminal: Locator, marker: string): Promise<void> {
  const box = await terminal.boundingBox();
  expect(box, `WTerm for ${marker} must be visible`).not.toBeNull();
  await terminal.hover({ position: { x: box!.width / 2, y: box!.height / 2 } });
  let pages = 0;
  // A 120px wheel gesture can advance only a few rows on a high-DPI WTerm
  // grid. The fixture deliberately emits 300 tail rows, so budget enough real
  // viewport advances to reach the early marker on both dense and large-font
  // configurations.
  for (let gesture = 0; gesture < 320 && pages < 160; gesture += 1) {
    const visibleRows = await visibleWtermRows(terminal);
    if (visibleRows.some((row) => row.includes(marker))) return;
    await page.mouse.wheel(0, -120);
    // WTerm briefly empties its virtualized row range while applying a wheel
    // offset. That is an asynchronous DOM implementation detail, not a
    // semantic scroll boundary; require the viewport to repopulate, then let
    // the final marker assertion prove real movement through retained history.
    await expect
      .poll(() => visibleWtermRows(terminal), {
        message: `WTerm wheel gesture ${gesture + 1} left its viewport empty`,
        timeout: 1_000,
      })
      .not.toEqual([]);
    if (JSON.stringify(await visibleWtermRows(terminal)) !== JSON.stringify(visibleRows))
      pages += 1;
  }
  await expect
    .poll(async () => (await visibleWtermRows(terminal)).some((row) => row.includes(marker)), {
      message: `expected retained WTerm output ${marker} after real wheel input`,
    })
    .toBe(true);
}

test.describe('packaged Cockpit mux topology', () => {
  // Each scenario owns a fresh Electron profile and daemon home. Topology,
  // renderer attachment, and persistence are deliberately tested inside an
  // individual scenario; sharing a live daemon between cases turns a prior
  // destructive lifecycle test into hidden setup for the next one.
  test.beforeEach(async ({}, testInfo) => {
    userDataDir = mkdtempSync(join(e2eTempRoot(), 'agent-cockpit-mux-e2e-profile-'));
    projectRoot = makeProject();
    const productionMux =
      testInfo.title.startsWith(PRODUCTION_RELAUNCH_TEST) &&
      process.env['COCKPIT_E2E_KILL_AFTER_READY'] !== '1';
    page = await launch(productionMux ? 'production' : 'inherit');
    // Exercise the real first-launch ordering: main must resolve/persist fresh
    // defaults before opening SQLite creates the profile's store.db.
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({ terminalBackend: 'cockpit-mux', terminalRenderer: 'wterm' });
    primaryProjectId = await page.evaluate(async (rootPath) => {
      const project = await window.api.projects.add({
        label: 'Mux E2E',
        connection: { kind: 'local', rootPath },
      });
      await window.api.projects.activate(project.id);
      await window.api.settings.set({
        terminalBackend: 'cockpit-mux',
        // First validate mux lifecycle through xterm; the dedicated WTerm case
        // below exercises its reparented Ghostty DOM grid directly.
        terminalRenderer: 'dom',
      });
      return project.id;
    }, projectRoot);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => page.evaluate(() => window.api.settings.get()))
      .toMatchObject({
        terminalBackend: 'cockpit-mux',
        terminalRenderer: 'dom',
      });
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    // The Cockpit mux terminal dock follows tmux's invariant: it owns at
    // least one live default-shell pane and never requires a renderer toolbar
    // click to bootstrap it.
    await expect(activeWindowTerminals().locator('.xterm')).toHaveCount(1);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    // The supervisor's SIGKILL regression waits for a real renderer-owned mux
    // pane, not merely for Electron/CDP startup, before killing Playwright.
    if (process.env['COCKPIT_E2E_READY_FILE'])
      writeFileSync(process.env['COCKPIT_E2E_READY_FILE'], 'mux-pane-ready');
    await activeWindowTerminals().first().click();
    await expect(page.getByRole('button', { name: 'Split right' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Split below' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New window' })).toHaveCount(0);
    await expect
      .poll(async () =>
        page.locator('[aria-hidden="false"] [data-mux-pane] .ac-term').evaluate((host) => {
          const terminal = host.getBoundingClientRect();
          const pane = host.closest<HTMLElement>('[data-mux-pane]')!.getBoundingClientRect();
          const style = getComputedStyle(host);
          return {
            boxSizing: style.boxSizing,
            padding: style.padding,
            fillsWidth: Math.abs(terminal.width - (pane.width - 2)) <= 1,
            fillsHeight: Math.abs(terminal.height - (pane.height - 2)) <= 1,
          };
        }),
      )
      .toEqual({ boxSizing: 'border-box', padding: '0px', fillsWidth: true, fillsHeight: true });
  });

  test(PRODUCTION_RELAUNCH_TEST, async () => {
    const marker = 'cockpit-mux-production-daemon-survived-app-quit';
    const shellMarker = `cockpit-mux-shell-${randomBytes(6).toString('hex')}`;
    const initial = await activeTopologySession();
    const pane = initial.windows[0]!.panes[0]!;
    const terminal = activeWindowTerminal(pane.key);
    await terminal.click();
    await page.keyboard.type(
      `typeset MUX_E2E_SESSION_MARKER=$(printf '%s%s' 'cockpit-mux-shell-' '${shellMarker.slice('cockpit-mux-shell-'.length)}')`,
    );
    await page.keyboard.press('Enter');
    await page.keyboard.type(
      `printf '%s%s\\n' 'cockpit-mux-production-' 'daemon-survived-app-quit'; printf 'cockpit-mux-shell-state:%s:%s\\n' "$$" "$MUX_E2E_SESSION_MARKER"`,
    );
    await page.keyboard.press('Enter');
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    await expect(terminal).toContainText(new RegExp(`cockpit-mux-shell-state:\\d+:${shellMarker}`));
    const initialShellState = (await terminal.innerText()).match(
      new RegExp(`cockpit-mux-shell-state:(\\d+):(${shellMarker})`),
    );
    expect(
      initialShellState,
      'initial output must expose the original shell identity',
    ).toBeDefined();
    const daemonBeforeQuit = profileMuxDaemonPID();
    expect(daemonBeforeQuit).toBeGreaterThan(0);

    // Close the real Electron window so its window-all-closed handler invokes
    // app.quit(), then reconnect in production mode using the same profile.
    await quitAppNormally();
    page = await launch('production');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    expect(profileMuxDaemonPID()).toBe(daemonBeforeQuit);
    await expect
      .poll(async () => {
        const session = (await topology()).find(
          (candidate) => candidate.sessionId === initial.sessionId,
        );
        return session?.windows.flatMap((window) =>
          window.panes.map((candidate) => candidate.paneId),
        );
      })
      .toContain(pane.paneId);
    const reattachedTerminal = activeWindowTerminal(pane.key);
    // Probe the restored shell instead of requiring the renderer to repaint
    // its prior scrollback; this scenario isolates daemon/shell lifecycle.
    await reattachedTerminal.click();
    await page.keyboard.type(
      `printf 'cockpit-mux-reconnected-shell-state:%s:%s\\n' "$$" "$MUX_E2E_SESSION_MARKER"`,
    );
    await page.keyboard.press('Enter');
    const reconnectedStatePattern = new RegExp(
      `cockpit-mux-reconnected-shell-state:(\\d+):(${shellMarker})`,
    );
    await expect(reattachedTerminal).toContainText(reconnectedStatePattern);
    const reconnectedShellState = (await reattachedTerminal.innerText()).match(
      reconnectedStatePattern,
    );
    expect(
      reconnectedShellState && `${reconnectedShellState[1]}:${reconnectedShellState[2]}`,
      'the shell PID and unexported variable must survive the application quit',
    ).toBe(`${initialShellState![1]}:${initialShellState![2]}`);
  });

  for (const shape of MUX_SHAPES) {
    test(`state-space seed=mux-shape-v1 shape=${shape.name}`, async () => {
      const markers = new Map<string, string>();
      let navigationGeneration = 0;
      const typeComposedMarker = async (terminal: Locator, marker: string): Promise<void> => {
        // The terminal echoes the typed shell command. Split the marker across
        // two shell arguments so an exact-marker assertion proves command
        // execution/output rather than merely local input echo.
        const pivot = Math.ceil(marker.length / 2);
        await terminal
          .locator('textarea')
          .pressSequentially(
            `printf '%s%s\\n' '${marker.slice(0, pivot)}' '${marker.slice(pivot)}'`,
          );
        await terminal.locator('textarea').press('Enter');
        await expect(terminal).toContainText(marker);
      };
      const recordMarker = async (
        _sessionId: string,
        _windowId: string,
        pane: Topology[number]['windows'][number]['panes'][number],
      ): Promise<string> => {
        // This must fit even the narrowest three-leaf pane. Pane identity is
        // retained by the map and test annotation; the output token itself
        // only needs to be unique per live terminal, not repeat UUIDs that
        // force xterm to soft-wrap its visible-history oracle.
        const marker = `mux-m${markers.size + 1}`;
        markers.set(pane.paneId, marker);
        const terminal = activeWindowTerminal(pane.key);
        await typeComposedMarker(terminal, marker);
        return marker;
      };
      const activeWindow = async (): Promise<Topology[number]['windows'][number]> => {
        const session = await activeTopologySession();
        const window = session.windows.find(
          (candidate) => candidate.windowId === session.activeWindowId,
        );
        expect(
          window,
          `${shape.name}: selected window must be in the daemon snapshot`,
        ).toBeDefined();
        return window!;
      };
      const expectActivePane = async (windowId: string, paneId: string): Promise<void> => {
        await expect
          .poll(
            async () => {
              const session = await activeTopologySession();
              return session.windows.find((candidate) => candidate.windowId === windowId)
                ?.activePaneId;
            },
            { message: `${shape.name}: expected active pane ${paneId} in ${windowId}` },
          )
          .toBe(paneId);
      };

      const initialSession = await activeTopologySession();
      let window = await activeWindow();
      await recordMarker(initialSession.sessionId, window.windowId, window.panes[0]!);

      // Every topology mutation uses the keyboard-first mux contract. The
      // production header intentionally exposes window identity only; it has
      // no split/window manipulation toolbar.
      for (const split of shape.splits) {
        const before = window.panes.length;
        await page.keyboard.press(
          split === 'horizontal' ? MUX_SHORTCUT.splitRight : MUX_SHORTCUT.splitBelow,
        );
        await expect.poll(async () => (await activeWindow()).panes.length).toBe(before + 1);
        window = await activeWindow();
        const created = window.panes.find((pane) => !markers.has(pane.paneId));
        expect(created, `${shape.name}: split must add exactly one new pane`).toBeDefined();
        await recordMarker(initialSession.sessionId, window.windowId, created!);
      }

      // Discover every real geometry edge from the daemon snapshot, navigate
      // it through the advertised shortcut, and return through both the
      // shortcut and the visible pane control. Invalid directions remain
      // no-ops, which is the negative-case oracle in TEST_PLAN.md.
      for (const source of window.panes) {
        await activeWindowTerminal(source.key).click();
        await expectActivePane(window.windowId, source.paneId);
        for (const direction of ['left', 'right', 'up', 'down'] as const) {
          await page.keyboard.press(PANE_SHORTCUT[direction]);
          const targetWindow = await activeWindow();
          const targetId = targetWindow.activePaneId;
          if (targetId === source.paneId) continue;
          const target = targetWindow.panes.find((pane) => pane.paneId === targetId);
          expect(target, `${shape.name}: ${direction} must select a live target`).toBeDefined();
          await expect(activeWindowTerminal(target!.key).locator('textarea')).toBeFocused();
          const outboundMarker = `mux-nav:${shape.name}:${source.paneId}:${direction}:${++navigationGeneration}`;
          await typeComposedMarker(activeWindowTerminal(target!.key), outboundMarker);
          await expect(activeWindowTerminal(source.key)).not.toContainText(outboundMarker);
          await page.keyboard.press(PANE_SHORTCUT[OPPOSITE_DIRECTION[direction]]);
          await expectActivePane(window.windowId, source.paneId);
          await expect(activeWindowTerminal(source.key).locator('textarea')).toBeFocused();
          const returnMarker = `mux-nav:${shape.name}:${target!.paneId}:${OPPOSITE_DIRECTION[direction]}:${++navigationGeneration}`;
          await typeComposedMarker(activeWindowTerminal(source.key), returnMarker);
          await expect(activeWindowTerminal(target!.key)).not.toContainText(returnMarker);
          await activeWindowTerminal(target!.key).click();
          await expectActivePane(window.windowId, target!.paneId);
          await activeWindowTerminal(source.key).click();
          await expectActivePane(window.windowId, source.paneId);
        }
      }

      // The generated dimensions name the valid edges independently of the
      // renderer's geometry resolver. This prevents a disabled left/up route
      // from being mistaken for an invalid direction merely because selection
      // did not change during exploratory navigation above.
      for (const [sourceIndex, direction, targetIndex] of shape.edges) {
        const source = window.panes[sourceIndex]!;
        const target = window.panes[targetIndex]!;
        await activeWindowTerminal(source.key).click();
        await expectActivePane(window.windowId, source.paneId);
        await page.keyboard.press(PANE_SHORTCUT[direction]);
        await expectActivePane(window.windowId, target.paneId);
        await expect(activeWindowTerminal(target.key).locator('textarea')).toBeFocused();
        await page.keyboard.press(PANE_SHORTCUT[OPPOSITE_DIRECTION[direction]]);
        await expectActivePane(window.windowId, source.paneId);
      }

      // Progress through W=1 → 2 → 3. Each window receives its own marker
      // while focused, and both creation routes are used.
      await page.keyboard.press('Meta+t');
      await expect.poll(async () => (await activeTopologySession()).windows.length).toBe(2);
      window = await activeWindow();
      await recordMarker(initialSession.sessionId, window.windowId, window.panes[0]!);
      await page.keyboard.press(MUX_SHORTCUT.newWindow);
      await expect.poll(async () => (await activeTopologySession()).windows.length).toBe(3);
      window = await activeWindow();
      await recordMarker(initialSession.sessionId, window.windowId, window.panes[0]!);

      const initialWindows = (await activeTopologySession()).windows;
      for (let index = 0; index < initialWindows.length; index += 1) {
        const source = initialWindows[index]!;
        await page.getByText(`Window ${index + 1}`, { exact: true }).click();
        await expect
          .poll(async () => (await activeTopologySession()).activeWindowId)
          .toBe(source.windowId);
        for (const [shortcut, delta] of [
          ['Meta+Shift+BracketRight', 1],
          ['Meta+Shift+BracketLeft', -1],
        ] as const) {
          const target =
            initialWindows[(index + delta + initialWindows.length) % initialWindows.length]!;
          await page.keyboard.press(shortcut);
          await expect
            .poll(async () => (await activeTopologySession()).activeWindowId)
            .toBe(target.windowId);
          const targetPane = target.panes.find((pane) => pane.paneId === target.activePaneId)!;
          await expect(activeWindowTerminal(targetPane.key).locator('textarea')).toBeFocused();
          // The navigation matrix deliberately emits more than one viewport
          // of output. Find the durable original marker by real xterm scroll
          // input rather than treating virtualization as data loss.
          await scrollTerminalToMarker(
            activeWindowTerminal(targetPane.key),
            markers.get(targetPane.paneId)!,
          );
          const outboundMarker = `mux-window-nav:${shape.name}:${source.windowId}:${shortcut}:${++navigationGeneration}`;
          await typeComposedMarker(activeWindowTerminal(targetPane.key), outboundMarker);
          const sourcePane = source.panes.find((pane) => pane.paneId === source.activePaneId)!;
          await expect(anyWindowTerminal(sourcePane.key)).not.toContainText(outboundMarker);
          await page.getByText(`Window ${index + 1}`, { exact: true }).click();
          await expect
            .poll(async () => (await activeTopologySession()).activeWindowId)
            .toBe(source.windowId);
          await expect(activeWindowTerminal(sourcePane.key).locator('textarea')).toBeFocused();
          const returnMarker = `mux-window-nav:${shape.name}:${target.windowId}:return:${++navigationGeneration}`;
          await typeComposedMarker(activeWindowTerminal(sourcePane.key), returnMarker);
          await expect(anyWindowTerminal(targetPane.key)).not.toContainText(returnMarker);
        }
      }

      // Snapshot the daemon-owned interaction state before either renderer
      // reload. Pane IDs/layout alone are insufficient: the selected window,
      // each window's last-focused pane, and the screen data behind every pane
      // are the continuity contract the user experiences after relaunch.
      const shapedSession = await activeTopologySession();
      const shapedWindows = shapedSession.windows.map((candidate) => ({
        windowId: candidate.windowId,
        paneIds: candidate.panes.map((pane) => pane.paneId),
        activePaneId: candidate.activePaneId,
        layout: JSON.stringify(candidate.layout),
      }));
      const shapedActiveWindowId = shapedSession.activeWindowId;
      const expectRestoredSession = async (stage: 'reload' | 'relaunch'): Promise<void> => {
        await expect
          .poll(async () => (await topologySnapshot()).activeSessionId)
          .toBe(initialSession.sessionId);
        await expect
          .poll(
            async () => {
              const restored = await activeTopologySession();
              return {
                activeWindowId: restored.activeWindowId,
                windows: restored.windows.map((candidate) => ({
                  windowId: candidate.windowId,
                  paneIds: candidate.panes.map((pane) => pane.paneId),
                  activePaneId: candidate.activePaneId,
                  layout: JSON.stringify(candidate.layout),
                })),
              };
            },
            {
              message: `${shape.name}: ${stage} must restore windows, layouts, and per-window focus`,
            },
          )
          .toEqual({
            activeWindowId: shapedActiveWindowId,
            windows: shapedWindows,
          });
        const restoredActive = await activeWindow();
        const restoredActivePane = restoredActive.panes.find(
          (pane) => pane.paneId === restoredActive.activePaneId,
        )!;
        await scrollTerminalToMarker(
          activeWindowTerminal(restoredActivePane.key),
          markers.get(restoredActivePane.paneId)!,
        );
        await expect(
          activeWindowTerminal(restoredActivePane.key).locator('textarea'),
        ).toBeFocused();

        // Visit every restored window through the visible tab control. This is
        // the actual DOM/renderer proof that detached panes retained the right
        // screen, rather than merely an inspection of catalog IDs.
        for (const [index, expected] of shapedWindows.entries()) {
          await page.getByText(`Window ${index + 1}`, { exact: true }).click();
          await expect
            .poll(async () => (await activeTopologySession()).activeWindowId)
            .toBe(expected.windowId);
          const restored = await activeWindow();
          await expect(restored.panes.map((pane) => pane.paneId)).toEqual(expected.paneIds);
          for (const pane of restored.panes) {
            await scrollTerminalToMarker(activeWindowTerminal(pane.key), markers.get(pane.paneId)!);
          }
          const selected = restored.panes.find((pane) => pane.paneId === expected.activePaneId)!;
          await expect(activeWindowTerminal(selected.key).locator('textarea')).toBeFocused();
        }
        const activeIndex = shapedWindows.findIndex(
          (candidate) => candidate.windowId === shapedActiveWindowId,
        );
        await page.getByText(`Window ${activeIndex + 1}`, { exact: true }).click();
        await expect
          .poll(async () => (await activeTopologySession()).activeWindowId)
          .toBe(shapedActiveWindowId);
      };

      test.info().annotations.push({
        type: 'mux-state-space',
        description: JSON.stringify({
          seed: 'mux-shape-v1',
          shape: shape.name,
          markers: Object.fromEntries(markers),
        }),
      });
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
      await expectRestoredSession('reload');

      await closeApp();
      page = await launch();
      await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
      await expectRestoredSession('relaunch');

      // Exercise lifecycle mutations from every generated tree, not only from
      // the hand-authored two-pane scenario below. A disposable split gives
      // the root shape a legal resize/zoom/close target; for the other shapes
      // it verifies the recursive tree still accepts a fourth transient leaf.
      await page.getByText('Window 1', { exact: true }).click();
      const lifecycleWindow = await activeWindow();
      const baselinePaneIDs = lifecycleWindow.panes.map((pane) => pane.paneId);
      await page.keyboard.press(MUX_SHORTCUT.splitRight);
      await expect
        .poll(async () => (await activeWindow()).panes.length)
        .toBe(baselinePaneIDs.length + 1);
      const splitWindow = await activeWindow();
      const disposablePane = splitWindow.panes.find(
        (pane) => !baselinePaneIDs.includes(pane.paneId),
      )!;
      await recordMarker(initialSession.sessionId, splitWindow.windowId, disposablePane);
      const divider = page.getByRole('separator', { name: 'Resize split' }).last();
      const dividerBox = await divider.boundingBox();
      expect(dividerBox, `${shape.name}: split must expose a resizable divider`).not.toBeNull();
      await page.mouse.move(
        dividerBox!.x + Math.max(1, dividerBox!.width / 2),
        dividerBox!.y + Math.max(1, dividerBox!.height / 2),
      );
      await page.mouse.down();
      await page.mouse.move(
        dividerBox!.x + Math.max(8, dividerBox!.width / 2 + 32),
        dividerBox!.y + Math.max(1, dividerBox!.height / 2),
      );
      await page.mouse.up();
      await expect
        .poll(async () => JSON.stringify((await activeWindow()).layout))
        .not.toBe(JSON.stringify(splitWindow.layout));
      await page.keyboard.press(MUX_SHORTCUT.zoom);
      await expect
        .poll(async () => (await activeWindow()).zoomedPaneId)
        .toBe(disposablePane.paneId);
      await page.keyboard.press(MUX_SHORTCUT.zoom);
      await expect.poll(async () => (await activeWindow()).zoomedPaneId).toBeNull();
      await activeWindowTerminal(disposablePane.key).click();
      await exitActiveMuxPane();
      await expect
        .poll(async () => (await activeWindow()).panes.map((pane) => pane.paneId))
        .toEqual(baselinePaneIDs);

      // A final-pane close is a window destruction path. Create it through the
      // keyboard command, retain a marker, then require the selected surviving
      // window and its original terminal surface to remain intact.
      const windowsBeforeDisposableClose = (await activeTopologySession()).windows.length;
      await page.keyboard.press(MUX_SHORTCUT.newWindow);
      await expect
        .poll(async () => (await activeTopologySession()).windows.length)
        .toBe(windowsBeforeDisposableClose + 1);
      const disposableWindow = await activeWindow();
      const disposableWindowPane = disposableWindow.panes[0]!;
      await recordMarker(initialSession.sessionId, disposableWindow.windowId, disposableWindowPane);
      await page.keyboard.press(MUX_SHORTCUT.closeWindow);
      // Closing the selected final pane briefly unmounts the retired terminal
      // before React commits the daemon-selected survivor. Query the named
      // session during that intentional DOM gap, then assert the visible
      // terminal surface below once it has settled.
      await expect
        .poll(
          async () =>
            (await topology()).find((candidate) => candidate.sessionId === initialSession.sessionId)
              ?.windows.length,
        )
        .toBe(windowsBeforeDisposableClose);
      await expect(activeWindowTerminals()).not.toContainText(
        markers.get(disposableWindowPane.paneId)!,
      );
    });
  }

  test('routes the complete keyboard mux contract through both terminal renderers', async () => {
    for (const renderer of ['dom', 'wterm'] as const) {
      await page.evaluate(async (terminalRenderer) => {
        const sessions = await window.api.muxSessions.list();
        await Promise.all(
          sessions.map((session) =>
            window.api.muxSessions.destroy(session.projectId, session.sessionId),
          ),
        );
        // Do not opt into Byobu here: a fresh isolated profile must expose
        // Shift+Arrow and Ctrl+A shortcuts without a hidden settings step.
        await window.api.settings.set({ terminalRenderer });
      }, renderer);
      await page.reload();
      await page.waitForLoadState('domcontentloaded');
      await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
      await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
      await activeWindowTerminals().first().click();

      await page.keyboard.press(MUX_SHORTCUT.splitRight);
      await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
      const horizontal = await activeTopologySession();
      const window = horizontal.windows.find(
        (item) => item.windowId === horizontal.activeWindowId,
      )!;
      const left = window.panes[0]!;
      const right = window.panes[1]!;
      await page.keyboard.press(PANE_SHORTCUT.left);
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
        .toBe(left.paneId);
      await page.keyboard.press('Shift+ArrowRight');
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
        .toBe(right.paneId);

      await page.keyboard.press('Control+a');
      // Topology polling recreates the handler. The prefix must survive that
      // routine React update rather than being lost before its second key.
      await page.waitForTimeout(750);
      await page.keyboard.press('z');
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.zoomedPaneId)
        .toBe(right.paneId);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('z');
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.zoomedPaneId)
        .toBeNull();

      await page.keyboard.press(MUX_SHORTCUT.newWindow);
      await expect.poll(async () => (await activeTopologySession()).windows.length).toBe(2);
      const secondWindowId = (await activeTopologySession()).activeWindowId;
      await page.keyboard.press('Control+a');
      await page.keyboard.press('p');
      await expect
        .poll(async () => (await activeTopologySession()).activeWindowId)
        .not.toBe(secondWindowId);
      await page.keyboard.press('Control+a');
      await page.keyboard.press('n');
      await expect
        .poll(async () => (await activeTopologySession()).activeWindowId)
        .toBe(secondWindowId);

      await page.keyboard.press(MUX_SHORTCUT.closeWindow);
      // Destroying a selected final window intentionally leaves a brief DOM
      // gap while the daemon selects its survivor. Assert its catalog first;
      // `activeTopologySession()` derives identity from a mounted terminal and
      // is not valid in that transition.
      await expect.poll(async () => (await topology())[0]?.windows.length).toBe(1);
      await expect(page.getByRole('button', { name: 'Split right' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New window' })).toHaveCount(0);
    }
  });

  test('creates panes from each focused source through the keyboard shortcut', async () => {
    let generation = 0;
    const marker = async (paneKey: string, label: string): Promise<string> => {
      const value = `mux-create-source:${label}:${++generation}`;
      const terminal = activeWindowTerminal(paneKey);
      const pivot = Math.ceil(value.length / 2);
      await terminal
        .locator('textarea')
        .pressSequentially(`printf '%s%s\\n' '${value.slice(0, pivot)}' '${value.slice(pivot)}'`);
      await terminal.locator('textarea').press('Enter');
      await expect(terminal).toContainText(value);
      return value;
    };
    const activeWindow = async () => {
      const session = await activeTopologySession();
      return session.windows.find((window) => window.windowId === session.activeWindowId)!;
    };

    let window = await activeWindow();
    await marker(window.panes[0]!.key, 'root');
    await page.keyboard.press('Meta+d');
    await expect.poll(async () => (await activeWindow()).panes.length).toBe(2);
    window = await activeWindow();
    // Freeze this two-pane frontier: each original leaf is a distinct valid
    // split source. Close each disposable child through its top-level shell
    // exit so the next source exercises the same baseline tree.
    const baselinePaneIds = new Set(window.panes.map((pane) => pane.paneId));
    for (const [index, source] of window.panes.entries()) {
      await activeWindowTerminal(source.key).click();
      await expect.poll(async () => (await activeWindow()).activePaneId).toBe(source.paneId);
      await marker(source.key, `source-${index}`);
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await activeWindowTerminal(source.key).click();
        const before = (await activeWindow()).panes.length;
        await page.keyboard.press(MUX_SHORTCUT.splitRight);
        await expect.poll(async () => (await activeWindow()).panes.length).toBe(before + 1);
        const created = (await activeWindow()).panes.find(
          (pane) => !baselinePaneIds.has(pane.paneId),
        );
        expect(
          created,
          `shortcut split ${attempt} from source ${source.paneId} must create one unique pane`,
        ).toBeDefined();
        const createdMarker = await marker(created!.key, `created-from-${index}-${attempt}`);
        await expect(activeWindowTerminal(source.key)).not.toContainText(createdMarker);
        await exitActiveMuxPane();
        await expect.poll(async () => (await activeWindow()).panes.length).toBe(before);
      }
    }
  });

  test('does not steal focus from Preferences while idle topology polling continues', async () => {
    await activeWindowTerminals().first().click();
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    const beforeSession = await activeTopologySession();
    const beforeWindow = beforeSession.windows.find(
      (window) => window.windowId === beforeSession.activeWindowId,
    )!;
    await page.getByRole('button', { name: 'Preferences' }).click();
    const input = page.getByRole('checkbox', { name: 'Persist Cockpit mux scrollback' });
    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('z');
    await expect
      .poll(async () => {
        const currentSession = await activeTopologySession();
        const current = currentSession.windows.find(
          (window) => window.windowId === currentSession.activeWindowId,
        )!;
        return { activePaneId: current.activePaneId, zoomedPaneId: current.zoomedPaneId };
      })
      .toEqual({
        activePaneId: beforeWindow.activePaneId,
        zoomedPaneId: beforeWindow.zoomedPaneId,
      });
    // The renderer polls the daemon every 500ms. Cross several intervals so a
    // semantic no-op snapshot cannot reactivate the hidden terminal textarea.
    await page.waitForTimeout(1_600);
    await expect(input).toBeFocused();
  });

  test('reflects local CLI pane and window creation in an idle Cockpit terminal', async () => {
    const initial = await activeTopologySession();
    const rootWindow = initial.windows.find(
      (window) => window.windowId === initial.activeWindowId,
    )!;
    const rootPane = rootWindow.panes.find((pane) => pane.paneId === rootWindow.activePaneId)!;
    const cli = packagedMuxCli();
    const home = join(userDataDir, 'mux-home');

    execFileSync(cli, [
      '--home',
      home,
      'pane',
      'split',
      '--pane',
      rootPane.paneId,
      '--direction',
      'horizontal',
      '--key',
      'cli-pane',
    ]);
    await expect.poll(async () => (await activeTopologySession()).windows[0]?.panes.length).toBe(2);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    await expect(activeWindowTerminal('cli-pane').locator('textarea')).toBeFocused();

    execFileSync(cli, [
      '--home',
      home,
      'window',
      'new',
      '--session',
      initial.sessionId,
      '--key',
      'cli-window',
    ]);
    await expect.poll(async () => (await activeTopologySession()).windows.length).toBe(2);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await expect(activeWindowTerminal('cli-window').locator('textarea')).toBeFocused();
  });

  test('keeps the project terminal workspace selected when Run opens its private mux tty', async () => {
    await page.evaluate(() => window.api.settings.set({ showRunPanel: true }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const terminalSession = await activeTopologySession();
    const terminalWindow = terminalSession.windows.find(
      (window) => window.windowId === terminalSession.activeWindowId,
    )!;
    const terminalPane = terminalWindow.panes.find(
      (pane) => pane.paneId === terminalWindow.activePaneId,
    )!;
    const marker = 'cockpit-mux-terminal-survives-run';
    await activeWindowTerminal(terminalPane.key)
      .locator('textarea')
      .pressSequentially("printf '%s%s\\n' 'cockpit-mux-terminal-' 'survives-run'");
    await activeWindowTerminal(terminalPane.key).locator('textarea').press('Enter');
    await expect(activeWindowTerminal(terminalPane.key)).toContainText(marker);

    // The workspace preset can omit the optional Run panel even after its
    // setting changes, so drive the same packaged IPC operation it uses. This
    // still exercises the real provider/daemon boundary while avoiding a
    // layout-specific tab assumption in this mux acceptance suite.
    await page.evaluate(async () => {
      await window.api.terminal.open({
        key: 'run',
        kind: 'run',
        cols: 80,
        rows: 24,
        createIfMissing: true,
      });
      await window.api.terminal.write('run', "printf '%s\\n' cockpit-mux-run-output");
    });
    await expect
      .poll(async () =>
        (await topology()).some((session) =>
          session.windows.some((window) => window.panes.some((pane) => pane.key === 'run')),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => (await topologySnapshot()).activeSessionId)
      .toBe(terminalSession.sessionId);
    await expect(activeWindowTerminal(terminalPane.key)).toContainText(marker);
    await expect(activeWindowTerminal(terminalPane.key).locator('textarea')).toBeFocused();

    // A retained Run TTY is not a Terminal tab. Exercise the hard edge where
    // it is the only remaining daemon session. The terminal workspace must
    // immediately replace its exited root, then reload without mounting Run
    // into the interactive workspace.
    await page.evaluate((key) => window.api.terminal.close(key, true), terminalPane.key);
    await expect
      .poll(async () =>
        (await topology()).some((session) =>
          session.windows.some((window) =>
            window.panes.some((pane) => pane.key === terminalPane.key),
          ),
        ),
      )
      .toBe(false);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect.poll(() => page.evaluate(() => window.api.terminal.list())).toHaveLength(1);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
  });

  test('uses session-owned window placement through the lexical ID boundary', async () => {
    const logicalSessionId = (await activeTopologySession()).sessionId;
    const sessionTopology = async () =>
      (await topology()).find((session) => session.sessionId === logicalSessionId);
    const markerByWindow = new Map<string, string>();
    const sendMarker = async (windowId: string): Promise<void> => {
      const marker = `cockpit-mux-placement-${windowId}`;
      markerByWindow.set(windowId, marker);
      const input = activeWindowTerminals().locator('textarea').first();
      await input.pressSequentially(`printf '${marker}\\n'`);
      await input.press('Enter');
      await expect(activeWindowTerminals()).toContainText(marker);
    };
    const expectPlacement = async (expected: string[]): Promise<void> => {
      await expect
        .poll(async () => {
          const session = await sessionTopology();
          return {
            declared: session?.windowOrder,
            rendered: session?.windows.map((window) => window.windowId),
          };
        })
        .toEqual({ declared: expected, rendered: expected });
    };
    const selectWithKeyboard = async (windowId: string): Promise<void> => {
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const session = await activeTopologySession();
        if (session.activeWindowId === windowId) {
          await expect(activeWindowTerminals()).toContainText(markerByWindow.get(windowId)!);
          return;
        }
        await page.keyboard.press('Meta+Shift+BracketRight');
      }
      throw new Error(`keyboard navigation did not select ${windowId}`);
    };

    let session = await sessionTopology();
    expect(session).toBeDefined();
    let expected = [...session!.windowOrder];
    await sendMarker(expected[0]!);
    // The isolated profile starts at window-1. Creating through window-11
    // proves that the displayed/navigated order does not revert to lexical ID
    // order (`window-10` before `window-9`).
    while (expected.length < 11) {
      const priorLength = expected.length;
      await page.keyboard.press(MUX_SHORTCUT.newWindow);
      await expect
        .poll(async () => (await sessionTopology())?.windows.length)
        .toBe(priorLength + 1);
      session = await sessionTopology();
      expect(session).toBeDefined();
      expected.push(session!.activeWindowId);
      await sendMarker(session!.activeWindowId);
      await expectPlacement(expected);
    }
    expect([...expected].sort()).not.toEqual(expected);

    // Verify both keyboard directions before exercising deterministic close
    // fallback for a middle, first, and final placement.
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect.poll(async () => (await activeTopologySession()).activeWindowId).toBe(expected[9]);
    await expect(activeWindowTerminals()).toContainText(markerByWindow.get(expected[9]!)!);
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(expected[10]);
    await expect(activeWindowTerminals()).toContainText(markerByWindow.get(expected[10]!)!);

    for (const index of [5, 0, -1]) {
      const closeIndex = index < 0 ? expected.length - 1 : index;
      const closingWindow = expected[closeIndex]!;
      await selectWithKeyboard(closingWindow);
      expected.splice(closeIndex, 1);
      const expectedActive = expected[Math.min(closeIndex, expected.length - 1)]!;
      await page.keyboard.press(MUX_SHORTCUT.closeWindow);
      await expectPlacement(expected);
      // The daemon snapshot is the source of truth immediately after a
      // lifecycle mutation. The terminal host is then asserted below once
      // React has committed the selected survivor; resolving session identity
      // from a transiently unmounted host would turn that normal commit gap
      // into a non-retryable test-helper failure.
      await expect.poll(async () => (await sessionTopology())?.activeWindowId).toBe(expectedActive);
      await expect(activeWindowTerminals()).toContainText(markerByWindow.get(expectedActive)!);
    }

    // Leave the serial suite with one clean window. This is still the actual
    // keyboard lifecycle path, not a direct daemon cleanup shortcut.
    while (expected.length > 1) {
      const priorLength = expected.length;
      await page.keyboard.press(MUX_SHORTCUT.closeWindow);
      await expect
        .poll(async () => (await sessionTopology())?.windows.length)
        .toBe(priorLength - 1);
      const sessionAfterClose = await sessionTopology();
      expect(sessionAfterClose).toBeDefined();
      expected = [...sessionAfterClose!.windowOrder];
      const settledWindow = sessionAfterClose!.windows.find(
        (window) => window.windowId === sessionAfterClose!.activeWindowId,
      );
      expect(settledWindow).toBeDefined();
      // Do not begin another destructive close while the renderer still owns
      // the just-retired tab. This proves the surviving daemon selection is
      // actually rendered and prevents this serial suite from manufacturing a
      // lifecycle race for the following split/persistence scenario.
      await expect(activeWindowTerminals()).toContainText(
        markerByWindow.get(settledWindow!.windowId)!,
      );
    }
    await expect.poll(async () => (await sessionTopology())?.windows.length).toBe(1);
  });

  test('keeps split topology, terminal output, active window, and zoom across reload and relaunch', async () => {
    const initialMarker = 'cockpit-mux-initial-marker';
    const initialCompleteMarker = 'cockpit-mux-initial-complete';
    const firstWindowMarker = 'cockpit-mux-first-window-marker';
    const historyCompleteMarker = 'cockpit-mux-history-complete';
    const activeMarker = 'cockpit-mux-active-marker';
    const input = activeWindowTerminals().locator('textarea').first();
    await input.pressSequentially(`printf '${initialMarker}\\n'`);
    await input.press('Enter');
    await expect(page.getByText(initialMarker, { exact: true })).toBeVisible();
    await input.pressSequentially(
      "for i in $(seq 1 120); do echo cockpit-mux-follow-$i; done; printf '%s%s\\n' 'cockpit-mux-initial-' 'complete'",
    );
    await input.press('Enter');
    await expect(page.getByText(initialCompleteMarker, { exact: true })).toBeVisible();
    const initialTerminal = activeWindowTerminals().first();
    await expect
      .poll(() => visibleXtermRows(initialTerminal))
      .not.toContain('cockpit-mux-follow-1');
    await wheelXtermAndRequireVisibleRowsChange(initialTerminal);

    const splitErrors: string[] = [];
    const onSplitConsole = (message: { type(): string; text(): string }): void => {
      if (message.type() === 'error') splitErrors.push(message.text());
    };
    page.on('console', onSplitConsole);
    try {
      await page.keyboard.press(MUX_SHORTCUT.splitRight);
      await expect
        .poll(async () => (await topology())[0]?.windows[0]?.panes.length, {
          message: `Split right did not mutate topology. Renderer errors: ${splitErrors.join(' | ') || 'none'}`,
        })
        .toBe(2);
    } finally {
      page.off('console', onSplitConsole);
    }
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    let state = await topology();
    expect(state).toHaveLength(1);
    expect(state[0]!.windows).toHaveLength(1);
    expect(state[0]!.windows[0]!.panes).toHaveLength(2);
    const initialPaneKey = state[0]!.windows[0]!.panes[0]!.key;
    const historyPaneKey = state[0]!.windows[0]!.panes[1]!.key;
    // Pane attachment and the selected-pane topology response cross the
    // main-process bridge independently. Assert the daemon's eventual
    // selection rather than treating its still-attaching predecessor snapshot
    // as the final split result.
    await expect
      .poll(async () => (await topology())[0]?.windows[0]?.activePaneId)
      .toBe(state[0]!.windows[0]!.panes[1]!.paneId);
    state = await topology();
    await page.keyboard.press('Meta+Alt+ArrowLeft');
    await expect
      .poll(async () => (await topology())[0]?.windows[0]?.activePaneId)
      .toBe(state[0]!.windows[0]!.panes[0]!.paneId);
    const leftPane = activeWindowTerminal(state[0]!.windows[0]!.panes[0]!.key);
    await expect(leftPane.locator('textarea')).toBeFocused();
    await page.keyboard.type("printf '%s%s\\n' 'cockpit-mux-' 'left-focus'");
    await page.keyboard.press('Enter');
    await expect(leftPane).toContainText('cockpit-mux-left-focus');
    await expect(activeWindowTerminal(state[0]!.windows[0]!.panes[1]!.key)).not.toContainText(
      'cockpit-mux-left-focus',
    );
    await page.keyboard.press('Meta+Alt+ArrowRight');
    await expect
      .poll(async () => (await topology())[0]?.windows[0]?.activePaneId)
      .toBe(state[0]!.windows[0]!.panes[1]!.paneId);
    const firstWindowInput = activeWindowTerminal(state[0]!.windows[0]!.panes[1]!.key).locator(
      'textarea',
    );
    await expect(firstWindowInput).toBeFocused();
    await page.keyboard.type("printf '%s%s\\n' 'cockpit-mux-' 'right-focus'");
    await page.keyboard.press('Enter');
    await expect(activeWindowTerminal(state[0]!.windows[0]!.panes[1]!.key)).toContainText(
      'cockpit-mux-right-focus',
    );
    await firstWindowInput.pressSequentially(
      `for i in $(seq 1 40); do echo cockpit-mux-history-$i; done; printf '%s%s\\n' 'cockpit-mux-first-' 'window-marker'`,
    );
    await firstWindowInput.press('Enter');
    // The marker is deliberately composed from separate input fragments: its
    // exact text cannot come from local terminal echo, only from the shell's
    // executed printf output.
    await expect(page.getByText(firstWindowMarker, { exact: true })).toBeVisible();
    await firstWindowInput.pressSequentially(
      "for i in $(seq 1 300); do echo cockpit-mux-history-tail-$i; done; printf '%s%s\\n' 'cockpit-mux-history-' 'complete'",
    );
    await firstWindowInput.press('Enter');
    await expect(page.getByText(historyCompleteMarker, { exact: true })).toBeVisible();
    const historicalPane = activeWindowTerminal(state[0]!.windows[0]!.panes[1]!.key);
    await expect.poll(() => visibleXtermRows(historicalPane)).toContain(historyCompleteMarker);
    const divider = page.getByRole('separator', { name: 'Resize split' });
    const box = await divider.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 1, box!.y + Math.max(1, box!.height / 2));
    await page.mouse.down();
    await page.mouse.move(box!.x + 80, box!.y + Math.max(1, box!.height / 2));
    await page.mouse.up();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.layout.ratio)
      .not.toBe(0.5);
    await expect.poll(() => visibleXtermRows(historicalPane)).toContain(historyCompleteMarker);
    // Set a real virtual scroll position before changing topology. This proves
    // the user-visible viewport itself, not a private daemon query, survives
    // the lifecycle transitions below.
    await scrollTerminalToMarker(historicalPane, 'cockpit-mux-history-1');
    const historicalRows = await visibleXtermRows(historicalPane);

    const muxErrors: string[] = [];
    const onConsole = (message: { type(): string; text(): string }): void => {
      if (message.type() === 'error') muxErrors.push(message.text());
    };
    page.on('console', onConsole);
    await page.keyboard.press('Meta+t');
    try {
      await expect.poll(async () => (await topology())[0]?.windows.length).toBe(2);
    } finally {
      page.off('console', onConsole);
      if (muxErrors.length) console.log({ muxErrors });
    }
    // A mux window belongs to the current logical session; Cmd+T must not
    // leave an unowned root session behind while its window is being attached.
    expect(await topology()).toHaveLength(1);
    await expect(page.getByText('Window 2', { exact: true })).toBeVisible();
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await topology())[0]?.activeWindowId)
      .toBe(state[0]!.windows[0]!.windowId);
    // A user deliberately reading history must remain there across both pane
    // and window navigation. This catches reattach/replay paths that repaint
    // correctly but silently force xterm back to its live tail.
    await expect(historicalPane).toContainText('cockpit-mux-history-1');
    await expect.poll(() => visibleXtermRows(historicalPane)).toEqual(historicalRows);
    await page.keyboard.press('Meta+Alt+ArrowLeft');
    await page.keyboard.press('Meta+Alt+ArrowRight');
    await expect(historicalPane).toContainText('cockpit-mux-history-1');
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expect
      .poll(async () => (await topology())[0]?.activeWindowId)
      .not.toBe(state[0]!.windows[0]!.windowId);
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect(historicalPane).toContainText('cockpit-mux-history-1');
    await expect.poll(() => visibleXtermRows(historicalPane)).toEqual(historicalRows);
    await scrollTerminalToMarker(historicalPane, historyCompleteMarker, 'down');
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expect
      .poll(async () => (await topology())[0]?.activeWindowId)
      .not.toBe(state[0]!.windows[0]!.windowId);
    await page.keyboard.press(MUX_SHORTCUT.splitBelow);
    await expect
      .poll(async () => {
        const current = await topology();
        return current[0]?.windows.find((window) => window.windowId === current[0]?.activeWindowId)
          ?.panes.length;
      })
      .toBe(2);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    state = await topology();
    const secondWindow = state[0]!.windows.find(
      (window) => window.windowId === state[0]!.activeWindowId,
    )!;
    expect(layoutDirections(secondWindow.layout)).toContain('vertical');
    expect(secondWindow.activePaneId).toBe(secondWindow.panes[1]!.paneId);
    await page.keyboard.press('Meta+Alt+ArrowUp');
    await expect
      .poll(async () => {
        const current = await topology();
        return current[0]?.windows.find((window) => window.windowId === current[0]?.activeWindowId)
          ?.activePaneId;
      })
      .toBe(secondWindow.panes[0]!.paneId);
    const upPane = activeWindowTerminal(secondWindow.panes[0]!.key);
    await expect(upPane.locator('textarea')).toBeFocused();
    await page.keyboard.type("printf '%s%s\\n' 'cockpit-mux-' 'up-focus'");
    await page.keyboard.press('Enter');
    await expect(upPane).toContainText('cockpit-mux-up-focus');
    await page.keyboard.press('Meta+Alt+ArrowDown');
    await expect
      .poll(async () => {
        const current = await topology();
        return current[0]?.windows.find((window) => window.windowId === current[0]?.activeWindowId)
          ?.activePaneId;
      })
      .toBe(secondWindow.panes[1]!.paneId);
    const downPane = activeWindowTerminal(secondWindow.panes[1]!.key);
    await expect(downPane.locator('textarea')).toBeFocused();
    await page.keyboard.type("printf '%s%s\\n' 'cockpit-mux-' 'down-focus'");
    await page.keyboard.press('Enter');
    await expect(downPane).toContainText('cockpit-mux-down-focus');
    await page.keyboard.press('Meta+d');
    await expect
      .poll(async () => {
        const current = await topology();
        return current[0]?.windows.find((window) => window.windowId === current[0]?.activeWindowId)
          ?.panes.length;
      })
      .toBe(3);
    const activeInput = focusedActiveWindowTerminals().locator('textarea');
    await expect(activeInput).toHaveCount(1);
    await activeInput.focus();
    await expect(activeInput).toBeFocused();
    await activeInput.pressSequentially(`printf '${activeMarker}\\n'`);
    await activeInput.press('Enter');
    await expect(focusedActiveWindowTerminals()).toContainText(activeMarker);
    await page.keyboard.press(MUX_SHORTCUT.zoom);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);

    state = await topology();
    expect(state[0]!.windows).toHaveLength(2);
    const activeWindow = state[0]!.windows.find(
      (window) => window.windowId === state[0]!.activeWindowId,
    );
    expect(activeWindow).toBeDefined();
    expect(activeWindow!.zoomedPaneId).not.toBeNull();
    const liveLogicalSessionId = state[0]!.sessionId;
    const livePane = activeWindow!.panes.find(
      (pane) => pane.paneId === activeWindow!.activePaneId,
    )!;

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await expect(activeWindowTerminal(livePane.key)).toContainText(activeMarker);
    state = await topology();
    expect(state).toHaveLength(1);
    expect(
      state[0]!.windows.find((window) => window.windowId === state[0]!.activeWindowId)
        ?.zoomedPaneId,
    ).not.toBeNull();

    await closeApp();
    page = await launch();
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    state = await topology();
    expect(state).toHaveLength(1);
    expect(state[0]!.windows).toHaveLength(2);
    expect(state[0]!.sessionId).toBe(liveLogicalSessionId);
    expect(
      state[0]!.windows.find((window) => window.windowId === state[0]!.activeWindowId)
        ?.zoomedPaneId,
    ).not.toBeNull();
    await expect(activeWindowTerminal(livePane.key)).toContainText(activeMarker);
    const relaunchInput = activeWindowTerminal(livePane.key).locator('textarea');
    await relaunchInput.click();
    await relaunchInput.pressSequentially("printf '%s%s\\n' 'cockpit-mux-' 'relaunch-output'");
    await relaunchInput.press('Enter');
    await expect(activeWindowTerminal(livePane.key)).toContainText('cockpit-mux-relaunch-output');

    await page.keyboard.press(MUX_SHORTCUT.zoom);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(3);
    expect(await topology()).toHaveLength(1);
    await page.getByText('Window 1', { exact: true }).click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    state = await topology();
    expect(state).toHaveLength(1);
    const firstWindow = state[0]!.windows[0]!;
    expect(state[0]!.activeWindowId).toBe(firstWindow.windowId);
    expect(firstWindow.panes.map((pane) => pane.key)).toEqual([initialPaneKey, historyPaneKey]);
    await expect(activeWindowTerminal(initialPaneKey)).toHaveCount(1);
    await expect(activeWindowTerminal(historyPaneKey)).toHaveCount(1);
    // Both panes must expose their pre-relaunch history through real terminal
    // input; no private daemon query stands in for the user's visible screen.
    await scrollTerminalToMarker(activeWindowTerminal(initialPaneKey), initialMarker);
    await scrollTerminalToMarker(activeWindowTerminal(historyPaneKey), firstWindowMarker);
    await activeWindowTerminal(historyPaneKey).click();
    await expect
      .poll(async () => (await topology())[0]?.windows[0]?.activePaneId)
      .toBe(firstWindow.panes[1]!.paneId);

    await exitActiveMuxPane();
    await expect.poll(async () => (await topology())[0]?.windows[0]?.panes.length).toBe(1);
    expect(await topology()).toHaveLength(1);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const closeWindowErrors: string[] = [];
    const onCloseWindowConsole = (message: { type(): string; text(): string }): void => {
      if (message.type() === 'error') closeWindowErrors.push(message.text());
    };
    page.on('console', onCloseWindowConsole);
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect
      .poll(async () => (await topology())[0]?.windows.length, {
        message: `Close window did not mutate topology. Renderer errors: ${closeWindowErrors.join(' | ') || 'none'}`,
      })
      .toBe(1);
    page.off('console', onCloseWindowConsole);
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect.poll(async () => (await topology()).length).toBe(1);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect
      .poll(async () => {
        const sessions = await topology();
        const window = sessions[0]?.windows.find(
          (candidate) => candidate.windowId === sessions[0]?.activeWindowId,
        );
        return {
          sessions: sessions.length,
          windows: sessions[0]?.windows.length ?? 0,
          panes: window?.panes.length ?? 0,
        };
      })
      .toEqual({ sessions: 1, windows: 1, panes: 1 });
    // Hidden windows deliberately retain their renderers while a session is
    // live. The final-root invariant is about the visible workspace.
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await expect(page.getByText('failed to start terminal', { exact: false })).toHaveCount(0);
  });

  test('keeps the xterm window model monotonic across successive closes', async () => {
    // This deliberately drives the same keyboard controls a user uses. It
    // exercises the close order that previously allowed a late topology read
    // to put already-destroyed windows back into the rendered tab strip.
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'dom' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    // The project session created by setup is retained across the renderer
    // switch; Cockpit deliberately does not create a second Session N surface.
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await activeWindowTerminals().first().click();
    const logicalSessionId = (await activeTopologySession()).sessionId;
    const sessionTopology = async () =>
      (await topology()).find((session) => session.sessionId === logicalSessionId);

    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect.poll(async () => (await sessionTopology())?.windows.length).toBe(2);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await activeWindowTerminals().first().click();
    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect.poll(async () => (await sessionTopology())?.windows.length).toBe(3);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await activeWindowTerminals().first().click();
    const initial = await sessionTopology();
    expect(initial).toBeDefined();
    const [firstWindow, secondWindow, thirdWindow] = initial!.windows;
    expect(firstWindow).toBeDefined();
    expect(secondWindow).toBeDefined();
    expect(thirdWindow).toBeDefined();

    // Traverse through the real shortcut path before each destructive action.
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(firstWindow!.windowId);
    const sessionAfterClose = sessionTopology;
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect
      .poll(async () => (await sessionAfterClose())?.windows.map((window) => window.windowId))
      .toEqual([secondWindow!.windowId, thirdWindow!.windowId]);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const afterFirstClose = await sessionAfterClose();
    expect(afterFirstClose).toBeDefined();
    const visibleKeys = await activeWindowTerminals().evaluateAll((terminals) =>
      terminals.map((terminal) => terminal.parentElement?.dataset.terminalKey),
    );
    const currentWindow = afterFirstClose!.windows.find(
      (window) => window.windowId === afterFirstClose!.activeWindowId,
    );
    expect(visibleKeys).toEqual(currentWindow!.panes.map((pane) => pane.key));
    await expect(activeWindowTerminals()).not.toContainText('failed to start terminal');

    // The daemon normalizes selection to the first surviving window. Close it
    // through the keyboard control and require the obsolete pair never returns.
    await expect
      .poll(async () => (await sessionAfterClose())?.activeWindowId)
      .toBe(secondWindow!.windowId);
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect
      .poll(async () => (await sessionAfterClose())?.windows.map((window) => window.windowId))
      .toEqual([thirdWindow!.windowId]);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const finalWindow = await sessionAfterClose();
    const finalPane = finalWindow!.windows[0]!.panes[0]!;
    const finalTerminal = activeWindowTerminal(finalPane.key);
    await expect(finalTerminal.locator('textarea')).toBeFocused();
    await page.keyboard.type("printf '%s%s\\n' 'cockpit-mux-' 'final-window-focus'");
    await page.keyboard.press('Enter');
    await expect(finalTerminal).toContainText('cockpit-mux-final-window-focus');
    const finalKeys = await activeWindowTerminals().evaluateAll((terminals) =>
      terminals.map((terminal) => terminal.parentElement?.dataset.terminalKey),
    );
    expect(finalKeys).toEqual([finalPane.key]);

    // Reload and clean-relaunch persistence are exercised by the dedicated
    // xterm topology scenario above. This focused case keeps the close-order
    // contract isolated: both the daemon catalog and rendered xterm surface
    // must converge immediately after each destructive operation.
  });

  test('keeps xterm panes distinct and resizes a below split', async () => {
    // Boundaries are a mux affordance, not a renderer-specific decoration.
    // Verify the real DOM surface is bordered before exercising the previously
    // untested horizontal divider (the divider itself runs through the same
    // daemon-backed topology mutation users receive).
    const initialPane = page.locator('[aria-hidden="false"] [data-mux-pane]').first();
    await expect(initialPane).toHaveCSS('border-top-width', '1px');
    await expect(initialPane).toHaveCSS('border-left-width', '1px');
    await page.keyboard.press(MUX_SHORTCUT.splitBelow);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    await expect(page.locator('[aria-hidden="false"] [data-mux-pane]')).toHaveCount(2);
    const beforeSession = await activeTopologySession();
    const before = beforeSession.windows.find(
      (window) => window.windowId === beforeSession.activeWindowId,
    )!.layout.ratio;
    const divider = page.getByRole('separator', { name: 'Resize split' });
    const box = await divider.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 + 48);
    await page.mouse.up();
    await expect
      .poll(async () => {
        const session = await activeTopologySession();
        return session.windows.find((window) => window.windowId === session.activeWindowId)?.layout
          .ratio;
      })
      .not.toBe(before);
  });

  test('does not replay existing shell output when splitting right', async () => {
    // A split resizes the original PTY, but must not seed/replay that pane a
    // second time. This catches the shell-visible duplicate status/prompt line
    // reported after each Split right action without mistaking a normal SIGWINCH
    // redraw for a second copy of prior terminal bytes.
    const marker = 'cockpit-mux-shell-output-once';
    const terminal = activeWindowTerminals().first();
    const input = terminal.locator('textarea');
    await input.pressSequentially(`printf '${marker}\\n'`);
    await input.press('Enter');
    await expect(terminal).toContainText(marker);
    const occurrences = async (): Promise<number> =>
      (await terminal.locator('.xterm-rows > div').allTextContents()).join('\n').split(marker)
        .length - 1;
    const before = await occurrences();
    expect(before).toBeGreaterThan(0);
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    await expect.poll(occurrences).toBe(before);
  });

  test('keeps a real Neovim grid visible and resizes it when WTerm splits right', async () => {
    const resizeErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && message.text().includes('Failed to resize terminal'))
        resizeErrors.push(message.text());
    });
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'wterm' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    const nvimPane = activeWindowTerminals().first();
    const nvimKey = await nvimPane.evaluate(
      (host) => host.parentElement?.dataset.terminalKey ?? '',
    );
    expect(nvimKey).not.toBe('');
    const input = nvimPane.locator('textarea');
    await input.pressSequentially('nvim --clean');
    await input.press('Enter');
    await expect(nvimPane).toContainText('Nvim', { timeout: 15_000 });

    const reportSize = async (marker: string): Promise<{ cols: number; rows: number }> => {
      await input.press('Escape');
      await input.pressSequentially(`:echo '${marker}:' . &columns . 'x' . &lines`);
      await input.press('Enter');
      await expect
        .poll(async () => (await visibleWtermRows(nvimPane)).join('\n'))
        .toMatch(new RegExp(`${marker}:(\\d+)x(\\d+)`));
      const rows = (await visibleWtermRows(nvimPane)).join('\n');
      const match = rows.match(new RegExp(`${marker}:(\\d+)x(\\d+)`));
      if (!match) throw new Error(`missing ${marker} Neovim geometry report`);
      return { cols: Number(match[1]), rows: Number(match[2]) };
    };

    const before = await reportSize('COCKPIT-NVIM-BEFORE');
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    await expect
      .poll(async () => {
        const session = await activeTopologySession();
        const activeWindow = session.windows.find(
          (window) => window.windowId === session.activeWindowId,
        );
        const pane = activeWindow?.panes.find((candidate) => candidate.key === nvimKey);
        return pane && { cols: pane.cols, rows: pane.rows };
      })
      .not.toEqual({ cols: before.cols, rows: before.rows });
    const postSplitSession = await activeTopologySession();
    const postSplitWindow = postSplitSession.windows.find(
      (window) => window.windowId === postSplitSession.activeWindowId,
    );
    const daemonGeometry = postSplitWindow?.panes.find((candidate) => candidate.key === nvimKey);
    expect(daemonGeometry).toBeDefined();
    // The split selects its new sibling. Use the same explicit pane-selection
    // path a user uses before sending the Neovim command to the retained pane.
    await activeWindowTerminal(nvimKey).click();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(daemonGeometry!.paneId);
    const after = await reportSize('COCKPIT-NVIM-AFTER');
    expect(
      after.cols,
      JSON.stringify({ before, after, daemonGeometry, resizeErrors }),
    ).toBeLessThan(before.cols);
    expect(after.rows).toBeGreaterThanOrEqual(1);

    const siblingPane = postSplitWindow?.panes.find((pane) => pane.key !== nvimKey);
    expect(siblingPane, 'a WTerm split must retain a distinct sibling pane').toBeDefined();
    const retainedNvimPane = activeWindowTerminal(nvimKey);
    const siblingTerminal = activeWindowTerminal(siblingPane!.key);
    await expect
      .poll(
        async () =>
          canonicalWtermViewport(await visibleWtermRows(retainedNvimPane)).includes('Nvim'),
        {
          message: 'expected a stable Neovim surface before pane-focus validation',
        },
      )
      .toBe(true);
    await waitForStableWtermMarker(retainedNvimPane, 'Nvim');
    const nvimBaseline = await beginWtermTransitionProbe(retainedNvimPane, 'Nvim');
    expect(nvimBaseline.connected, 'Neovim host must remain connected before focus traversal').toBe(
      true,
    );
    expect(
      nvimBaseline.markerVisible,
      'Neovim surface must be visible before focus traversal',
    ).toBe(true);
    await siblingTerminal.click();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(siblingPane!.paneId);
    await retainedNvimPane.click();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(daemonGeometry!.paneId);
    await waitForStableWtermMarker(retainedNvimPane, 'Nvim');
    const nvimFocusProbe = await endWtermTransitionProbe(retainedNvimPane);
    expect(
      nvimFocusProbe.disconnectedFrames,
      'Neovim focus traversal must retain the terminal host',
    ).toBe(0);
    expect(
      nvimFocusProbe.blankFrames,
      'Neovim focus traversal must not paint a blank viewport',
    ).toBe(0);
    expect(
      nvimFocusProbe.markerMissingFrames,
      'Neovim surface must remain visible across focus traversal',
    ).toBe(0);
  });

  test('proves WTerm reply routing and records the bundled core XTGETTCAP gap', async () => {
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'wterm' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    const terminal = activeWindowTerminals().first();
    const input = terminal.locator('textarea');
    await expect(input).toHaveCount(1);

    // DA1 is implemented by the exact shipped Ghostty-WASM core. Its exact
    // reply proves the complete live path through WTerm, terminalRegistry,
    // IPC, mux pane.write(kind=reply), and this same PTY. The shell puts its
    // TTY in a bounded raw-read mode and renders the reply itself, so this is
    // an end-to-end terminal assertion rather than an instrumentation hook.
    const captureReply = (query: string, label: string) =>
      `saved=$(stty -g); stty -echo -icanon min 0 time 5; printf '${query}'; reply=$(dd bs=1 count=64 2>/dev/null | od -An -tx1 | tr -d ' \\n'); stty "$saved"; printf 'cockpit-mux-capability-probe:${label}:%s\\n' "$reply"`;
    await input.pressSequentially(captureReply('\\033[c', 'da1'));
    await input.press('Enter');
    await expect(terminal).toContainText('cockpit-mux-capability-probe:da1:1b5b3f313b3263');

    // XTGETTCAP(TN) takes that identical path but currently receives no core
    // response. Keep this explicit passing regression test until an upstream
    // WASM release implements the query; changing this assertion is then an
    // intentional compatibility upgrade, not a silent claim of support.
    await input.pressSequentially(captureReply('\\033P+q544e\\033\\\\', 'xtgettcap-tn'));
    await input.press('Enter');
    await expect(terminal).toContainText('cockpit-mux-capability-probe:xtgettcap-tn:');
    await expect(terminal).not.toContainText('cockpit-mux-capability-probe:xtgettcap-tn:1b');
  });

  test('renders a direct Kitty PNG in the packaged WTerm overlay', async () => {
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'wterm' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    const terminal = activeWindowTerminals().first();
    const input = terminal.locator('textarea');
    await expect(input).toHaveCount(1);

    // Read the terminal's direct-image response while the shell TTY is raw.
    // This proves the actual PTY → mux → WTerm → reply-route cycle, rather
    // than treating the renderer's DOM as an isolated unit under test.
    const command =
      `saved=$(stty -g); stty -echo -icanon min 0 time 5; ` +
      `printf '\\033_Ga=T,f=100,i=2718;${KITTY_DIRECT_PNG_BASE64}\\033\\\\'; ` +
      `reply=$(dd bs=1 count=64 2>/dev/null | od -An -tx1 | tr -d ' \\n'); ` +
      `stty "$saved"; printf 'cockpit-mux-kitty-png-reply:%s\\n' "$reply"`;
    await input.pressSequentially(command);
    await input.press('Enter');

    await expect(terminal).toContainText(
      'cockpit-mux-kitty-png-reply:1b5f47693d323731383b4f4b1b5c',
    );
    const image = terminal.locator('.term-images canvas.term-image');
    await expect(image).toHaveCount(1);
    await expect
      .poll(async () =>
        image.evaluate((canvas) => {
          const target = canvas as HTMLCanvasElement;
          const pixels = target.getContext('2d')?.getImageData(0, 0, 1, 1).data;
          return {
            width: target.width,
            height: target.height,
            pixels: pixels ? [...pixels] : [],
          };
        }),
      )
      .toEqual({ width: 1, height: 1, pixels: [255, 0, 0, 255] });
  });

  test('replays a direct Kitty image after a WTerm renderer reload while the daemon lives', async () => {
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'wterm' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    const terminal = activeWindowTerminals().first();
    const input = terminal.locator('textarea');
    await expect(input).toHaveCount(1);

    await input.pressSequentially(
      `printf '\\033_Ga=T,f=100,i=2719;${KITTY_DIRECT_PNG_BASE64}\\033\\\\'; ` +
        "printf '%s\\n' cockpit-mux-kitty-replay-source",
    );
    await input.press('Enter');
    await expect(terminal).toContainText('cockpit-mux-kitty-replay-source');
    const image = terminal.locator('.term-images canvas.term-image');
    await expect(image).toHaveCount(1);

    // This destroys only the renderer. The packaged main process and its mux
    // daemon stay alive, so the next attach must receive text then a quiet
    // direct-graphics seed from native libghostty state.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    const reloaded = activeWindowTerminals().first();
    const replayedImage = reloaded.locator('.term-images canvas.term-image');
    await expect(replayedImage).toHaveCount(1);
    await expect
      .poll(async () =>
        replayedImage.evaluate((canvas) => {
          const target = canvas as HTMLCanvasElement;
          const pixels = target.getContext('2d')?.getImageData(0, 0, 1, 1).data;
          return { width: target.width, height: target.height, pixels: pixels ? [...pixels] : [] };
        }),
      )
      .toEqual({ width: 1, height: 1, pixels: [255, 0, 0, 255] });
  });

  test('keeps Wterm pane navigation and the prior window visible', async () => {
    const marker = 'cockpit-mux-wterm-window-marker';
    const historyCompleteMarker = 'cockpit-mux-wterm-history-complete';
    const splitSiblingMarker = 'cockpit-mux-wterm-split-sibling-marker';
    await page.evaluate(() => window.api.settings.set({ terminalRenderer: 'wterm' }));
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    // Renderer selection must not manufacture another logical session: this
    // project continues using the durable session created in beforeEach.
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Split right' })).toHaveCount(0);

    const originalPaneView = activeWindowTerminals().first();
    const originalPaneKey = await originalPaneView.evaluate(
      (host) => host.parentElement?.dataset.terminalKey ?? '',
    );
    expect(originalPaneKey).not.toBe('');
    const input = originalPaneView.locator('textarea');
    await input.pressSequentially(
      "for i in $(seq 1 5); do echo cockpit-mux-wterm-history-$i; done; printf '%s%s\\n' 'cockpit-mux-wterm-' 'window-marker'; for i in $(seq 1 300); do echo cockpit-mux-wterm-history-tail-$i; done; printf '%s%s\\n' 'cockpit-mux-wterm-history-' 'complete'",
    );
    await input.press('Enter');
    await expect(page.getByText(historyCompleteMarker, { exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          canonicalWtermViewport(await visibleWtermRows(originalPaneView)).includes(
            historyCompleteMarker,
          ),
        {
          message:
            'expected the original WTerm pane to be following its live tail before the split',
        },
      )
      .toBe(true);
    await expect.poll(async () => (await activeTopologySession()).windows[0]?.panes.length).toBe(1);

    const wtermSplitErrors: string[] = [];
    const onWtermSplitConsole = (message: { type(): string; text(): string }): void => {
      if (message.type() === 'error') wtermSplitErrors.push(message.text());
    };
    page.on('console', onWtermSplitConsole);
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.panes.length, {
        message: `WTerm split did not mutate topology. Renderer errors: ${wtermSplitErrors.join(' | ') || 'none'}`,
      })
      .toBe(2);
    page.off('console', onWtermSplitConsole);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    let session = await activeTopologySession();
    const firstWindow = session.windows[0]!;
    const originalPane = firstWindow.panes.find((pane) => pane.key === originalPaneKey);
    expect(
      originalPane,
      'topology must retain the original pane identity after a split',
    ).toBeDefined();
    const splitSibling = firstWindow.panes.find((pane) => pane.key !== originalPaneKey);
    expect(splitSibling, 'split must create one distinct sibling pane').toBeDefined();
    await page.keyboard.press('Meta+Alt+ArrowLeft');
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(originalPane!.paneId);
    const wtermHistoryPane = activeWindowTerminal(originalPane!.key);
    await expectVisibleWtermMarker(
      wtermHistoryPane,
      historyCompleteMarker,
      'expected the original pane content after creating a split and focusing back to it',
    );
    await page.keyboard.press('Meta+Alt+ArrowRight');
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(splitSibling!.paneId);
    const wtermSplitSibling = activeWindowTerminal(splitSibling!.key);
    // Split the output marker across shell arguments. A direct `printf 'marker'`
    // command echoes the complete marker while it is still being typed, letting
    // the assertion race the command's actual PTY output and its subsequent
    // WTerm render. Only the executed printf joins these fragments contiguously.
    const splitMarkerPivot = Math.ceil(splitSiblingMarker.length / 2);
    await wtermSplitSibling
      .locator('textarea')
      .pressSequentially(
        `printf '%s%s\\n' '${splitSiblingMarker.slice(0, splitMarkerPivot)}' '${splitSiblingMarker.slice(splitMarkerPivot)}'`,
      );
    await wtermSplitSibling.locator('textarea').press('Enter');
    await expect
      .poll(
        async () =>
          canonicalWtermViewport(await visibleWtermRows(wtermSplitSibling)).includes(
            splitSiblingMarker,
          ),
        {
          message: 'expected the new split pane to render its own output',
        },
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          canonicalWtermViewport(await visibleWtermRows(wtermHistoryPane)).includes(
            historyCompleteMarker,
          ),
        {
          message:
            'expected original pane content before tracing right-to-left pane focus navigation',
        },
      )
      .toBe(true);
    await Promise.all([
      waitForStableWtermMarker(wtermHistoryPane, historyCompleteMarker),
      waitForStableWtermMarker(wtermSplitSibling, splitSiblingMarker),
    ]);
    // Record the first complete focus round-trip after both panes are seeded.
    // WTerm can rewrite descendants of an existing row, so node-level row
    // insertion/removal alone is not proof of visual continuity. These probes
    // sample every renderer frame while both split panes stay visible.
    const focusBaselines = await Promise.all([
      beginWtermTransitionProbe(wtermHistoryPane, historyCompleteMarker),
      beginWtermTransitionProbe(wtermSplitSibling, splitSiblingMarker),
    ]);
    for (const [index, baseline] of focusBaselines.entries()) {
      expect(baseline.connected, `focus baseline ${index} must retain the WTerm host`).toBe(true);
      expect(
        baseline.visibleRowCount,
        `focus baseline ${index} must have materialized WTerm rows`,
      ).toBeGreaterThan(0);
      expect(
        baseline.markerVisible,
        `focus baseline ${index} must contain its marker before navigation: ${JSON.stringify(baseline)}`,
      ).toBe(true);
    }
    // The manual failure is reported during repeated panel changes, not only
    // the first focus round-trip. Exercise both routes a user can take:
    // shortcuts after the terminal textarea owns focus, and direct pane clicks.
    // The probes stay live through the whole sequence so even a short-lived
    // empty frame is a test failure rather than a post-action DOM snapshot.
    for (let cycle = 0; cycle < 12; cycle += 1) {
      if (cycle % 2 === 0) {
        await page.keyboard.press('Meta+Alt+ArrowLeft');
      } else {
        await wtermHistoryPane.click();
      }
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId, {
          message: `WTerm focus cycle ${cycle + 1} did not select the original pane`,
        })
        .toBe(originalPane!.paneId);
      await expect
        .poll(
          async () =>
            canonicalWtermViewport(await visibleWtermRows(wtermHistoryPane)).includes(
              historyCompleteMarker,
            ),
          {
            message: `WTerm focus cycle ${cycle + 1} lost original-pane content`,
          },
        )
        .toBe(true);

      if (cycle % 2 === 0) {
        await page.keyboard.press('Meta+Alt+ArrowRight');
      } else {
        await wtermSplitSibling.click();
      }
      await expect
        .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId, {
          message: `WTerm focus cycle ${cycle + 1} did not select the split pane`,
        })
        .toBe(splitSibling!.paneId);
      await expect
        .poll(
          async () =>
            canonicalWtermViewport(await visibleWtermRows(wtermSplitSibling)).includes(
              splitSiblingMarker,
            ),
          {
            message: `WTerm focus cycle ${cycle + 1} lost split-pane content`,
          },
        )
        .toBe(true);
    }
    await Promise.all([
      waitForStableWtermMarker(wtermHistoryPane, historyCompleteMarker),
      waitForStableWtermMarker(wtermSplitSibling, splitSiblingMarker),
    ]);
    const focusProbes = await Promise.all([
      endWtermTransitionProbe(wtermHistoryPane),
      endWtermTransitionProbe(wtermSplitSibling),
    ]);
    for (const [index, probe] of focusProbes.entries()) {
      expect(
        probe.visibleFrames,
        'focus transition must include sampled visible frames',
      ).toBeGreaterThan(0);
      expect(probe.disconnectedFrames, 'focus transition must retain the terminal host').toBe(0);
      expect(probe.blankFrames, 'focus transition must not paint an empty WTerm viewport').toBe(0);
      expect(
        probe.markerMissingFrames,
        `focus probe ${index} lost its marker after a settled baseline: ${JSON.stringify({
          probe: {
            baseline: probe.baseline,
            markerMissingFrames: probe.markerMissingFrames,
            disconnectedFrames: probe.disconnectedFrames,
            blankFrames: probe.blankFrames,
            gridChanges: probe.gridChanges,
            rowContentChanges: probe.rowContentChanges,
            rowInsertions: probe.rowInsertions,
            rowRemovals: probe.rowRemovals,
          },
        })}`,
      ).toBe(0);
    }

    // Start a real wheel gesture only after WTerm's own DOM scroll surface
    // exists; this exercises user reader intent, not a synthetic scrollTop.
    await expect(wtermHistoryPane).toHaveClass(/has-scrollback/);
    await page.waitForTimeout(300);
    await scrollWtermToMarker(wtermHistoryPane, marker);
    const divider = page.getByRole('separator', { name: 'Resize split' });
    const dividerBox = await divider.boundingBox();
    expect(dividerBox).not.toBeNull();
    await page.mouse.move(dividerBox!.x + 1, dividerBox!.y + Math.max(1, dividerBox!.height / 2));
    await page.mouse.down();
    await page.mouse.move(dividerBox!.x + 80, dividerBox!.y + Math.max(1, dividerBox!.height / 2));
    await page.mouse.up();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.layout.ratio)
      .not.toBe(0.5);
    // Topology commits before WTerm's ResizeObserver-derived DOM grid has
    // finished reflowing. Wait for that async reflow before comparing the
    // reader's retained logical history position.
    await page.waitForTimeout(300);
    await expect
      .poll(async () =>
        (await visibleWtermRows(wtermHistoryPane)).some((row) => row.includes(marker)),
      )
      .toBe(true);

    const windowBaseline = await beginWtermTransitionProbe(wtermHistoryPane, marker);
    expect(windowBaseline.connected, 'window-transition baseline must retain the WTerm host').toBe(
      true,
    );
    expect(
      windowBaseline.visibleRowCount,
      'window-transition baseline must have materialized WTerm rows',
    ).toBeGreaterThan(0);
    expect(
      windowBaseline.markerVisible,
      'window-transition baseline must contain its marker before navigation',
    ).toBe(true);
    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect.poll(async () => (await activeTopologySession()).windows.length).toBe(2);
    const newWindowInput = activeWindowTerminals().locator('textarea');
    await expect(newWindowInput).toHaveCount(1);
    await expect(newWindowInput).toBeFocused();
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(firstWindow.windowId);
    await page.waitForTimeout(300);
    const windowProbe = await endWtermTransitionProbe(wtermHistoryPane);
    expect(
      windowProbe.visibleFrames,
      'returned mux window must include sampled visible frames',
    ).toBeGreaterThan(0);
    expect(windowProbe.disconnectedFrames, 'window switching must retain the terminal host').toBe(
      0,
    );
    expect(
      windowProbe.blankFrames,
      'returning a mux window must not paint an empty WTerm viewport',
    ).toBe(0);
    expect(
      windowProbe.markerMissingFrames,
      'returned mux window must retain its visible marker on every frame',
    ).toBe(0);
    // The marker belongs to the original left pane; the right pane remains the
    // explicitly selected pane after traversal. The same retained marker must
    // stay visible: that proves the DOM viewport neither blanked nor reset its
    // scroll position. Do not compare raw visual rows here—WTerm may rewrap a
    // command echo by one cell when the hidden window becomes measurable again,
    // and whitespace at that wrap boundary is not terminal content loss.
    await expect
      .poll(async () =>
        canonicalWtermViewport(await visibleWtermRows(wtermHistoryPane)).includes(marker),
      )
      .toBe(true);
    await expect(focusedActiveWindowTerminals()).not.toContainText(marker);
    await wtermHistoryPane.click();
    await expect
      .poll(async () => (await activeTopologySession()).windows[0]?.activePaneId)
      .toBe(originalPane!.paneId);
    await expect
      .poll(
        async () =>
          canonicalWtermViewport(await visibleWtermRows(wtermHistoryPane)).includes(marker),
        {
          message:
            'expected the reactivated WTerm pane to rematerialize its retained visible content',
        },
      )
      .toBe(true);
    await page.keyboard.press(MUX_SHORTCUT.zoom);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await page.keyboard.press(MUX_SHORTCUT.zoom);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);

    // A fresh WTerm core must rebuild daemon-owned history after both renderer
    // reload and a clean app relaunch; no retained in-memory grid may stand in
    // for this persistence proof.
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    const reloadedWtermHistoryPane = activeWindowTerminal(originalPane!.key);
    await expect(reloadedWtermHistoryPane).toHaveClass(/has-scrollback/);
    await page.waitForTimeout(300);
    await scrollWtermToMarker(reloadedWtermHistoryPane, marker);

    await closeApp();
    page = await launch();
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    const relaunchedWtermHistoryPane = activeWindowTerminal(originalPane!.key);
    await expect(relaunchedWtermHistoryPane).toHaveClass(/has-scrollback/);
    await page.waitForTimeout(300);
    await scrollWtermToMarker(relaunchedWtermHistoryPane, marker);
    await relaunchedWtermHistoryPane.click();
    await page.keyboard.press('Meta+Shift+BracketRight');

    await activeWindowTerminals().first().click();
    await page.keyboard.press(MUX_SHORTCUT.splitBelow);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2, { timeout: 15_000 });
    session = await activeTopologySession();
    const secondWindow = session.windows.find(
      (window) => window.windowId === session.activeWindowId,
    )!;
    const lowerPaneId = secondWindow.activePaneId;
    expect(lowerPaneId).not.toBeNull();
    // The horizontal divider in a below-split must be a real resize control,
    // not merely a visible separator. This specifically covers the orientation
    // absent from the original right-split drag regression.
    const horizontalDivider = page.getByRole('separator', { name: 'Resize split' }).last();
    const horizontalDividerBox = await horizontalDivider.boundingBox();
    expect(horizontalDividerBox).not.toBeNull();
    const ratioBeforeHorizontalDrag = secondWindow.layout.ratio;
    await page.mouse.move(
      horizontalDividerBox!.x + Math.max(1, horizontalDividerBox!.width / 2),
      horizontalDividerBox!.y + Math.max(1, horizontalDividerBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      horizontalDividerBox!.x + Math.max(1, horizontalDividerBox!.width / 2),
      horizontalDividerBox!.y + Math.max(10, horizontalDividerBox!.height / 2 + 48),
    );
    await page.mouse.up();
    await expect
      .poll(async () => {
        const current = await activeTopologySession();
        return current.windows.find((window) => window.windowId === current.activeWindowId)?.layout
          .ratio;
      })
      .not.toBe(ratioBeforeHorizontalDrag);
    await page.keyboard.press('Meta+Alt+ArrowUp');
    await expect
      .poll(async () => {
        const current = await activeTopologySession();
        return current.windows.find((window) => window.windowId === current.activeWindowId)
          ?.activePaneId;
      })
      .not.toBe(lowerPaneId);
    await page.keyboard.press('Meta+Alt+ArrowDown');
    await expect
      .poll(async () => {
        const current = await activeTopologySession();
        return current.windows.find((window) => window.windowId === current.activeWindowId)
          ?.activePaneId;
      })
      .toBe(lowerPaneId);

    const wtermSessionId = firstWindow.panes[0]!.sessionId;
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect
      .poll(
        async () =>
          (await topology()).find((candidate) =>
            candidate.windows.some((window) =>
              window.panes.some((pane) => pane.sessionId === wtermSessionId),
            ),
          )?.windows.length,
      )
      .toBe(1);
    await page.keyboard.press(MUX_SHORTCUT.closeWindow);
    await expect
      .poll(async () =>
        (await topology()).some((candidate) =>
          candidate.windows.some((window) =>
            window.panes.some((pane) => pane.sessionId === wtermSessionId),
          ),
        ),
      )
      .toBe(false);
  });

  test('preserves other windows when a split shell exits', async () => {
    const retainedMarker = 'cockpit-mux-retained-window-marker';
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    const sessionId = (await activeTopologySession()).sessionId;
    const firstWindow = (await activeTopologySession()).windows[0]!;
    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    await activeWindowTerminals()
      .locator('textarea')
      .pressSequentially(`printf '${retainedMarker}\\n'`);
    await activeWindowTerminals().locator('textarea').press('Enter');
    await expect(activeWindowTerminals().filter({ hasText: retainedMarker })).toHaveCount(1);
    const secondWindow = (await activeTopologySession()).windows.find(
      (window) => window.windowId !== firstWindow.windowId,
    )!;
    await page.keyboard.press(MUX_SHORTCUT.splitBelow);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    const secondWindowWithSplit = (await activeTopologySession()).windows.find(
      (window) => window.windowId === secondWindow.windowId,
    )!;
    expect(secondWindowWithSplit.panes).toHaveLength(2);

    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(firstWindow.windowId);
    const exitingPane = firstWindow.panes[1]!;
    const exitingTerminal = activeWindowTerminal(exitingPane.key);
    // `exit` produces no durable terminal acknowledgement. First prove that
    // this exact, visible pane has received and executed an input command;
    // otherwise a later topology timeout cannot distinguish a missed focus/
    // input event from a real daemon lifecycle regression.
    const exitInputMarker = 'cockpit-mux-exiting-pane-input-marker';
    await exitingTerminal.locator('textarea').pressSequentially(`printf '${exitInputMarker}\\n'`);
    await exitingTerminal.locator('textarea').press('Enter');
    await expect(exitingTerminal).toContainText(exitInputMarker);
    await exitingTerminal.locator('textarea').pressSequentially('exit');
    await exitingTerminal.locator('textarea').press('Enter');

    await expect
      .poll(async () => {
        const session = (await topology()).find((candidate) => candidate.sessionId === sessionId);
        return session?.windows.map((window) => ({
          id: window.windowId,
          panes: window.panes.map((pane) => pane.paneId),
        }));
      })
      .toEqual([
        { id: firstWindow.windowId, panes: [firstWindow.panes[0]!.paneId] },
        {
          id: secondWindow.windowId,
          panes: secondWindowWithSplit.panes.map((pane) => pane.paneId),
        },
      ]);
    await page.keyboard.press('Meta+Shift+BracketRight');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(secondWindow.windowId);
    await expect(activeWindowTerminals().filter({ hasText: retainedMarker })).toHaveCount(1);

    // Exercise the other exit shape: terminating the last shell in a window
    // must retire only that window, not blank or remount its surviving peer.
    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await activeTopologySession()).activeWindowId)
      .toBe(firstWindow.windowId);
    const finalTerminal = activeWindowTerminal(firstWindow.panes[0]!.key);
    await finalTerminal.locator('textarea').pressSequentially('exit');
    await finalTerminal.locator('textarea').press('Enter');
    await expect
      .poll(async () => {
        const session = (await topology()).find((candidate) => candidate.sessionId === sessionId);
        return session?.windows.map((window) => window.windowId);
      })
      .toEqual([secondWindow.windowId]);
    await expect(activeWindowTerminals().filter({ hasText: retainedMarker })).toHaveCount(1);
  });

  test('keeps the selected window visible when an inactive shell exits', async () => {
    // Queue an ordinary shell exit in Window A, then move to Window B before
    // that process terminates. The provider's real poll/finalizeExited path
    // must remove only A's pane; it must not blank B while the renderer
    // reconciles the one-project/one-logical-session topology.
    const backgroundRootMarker = 'cockpit-mux-background-root-marker';
    const backgroundSplitMarker = 'cockpit-mux-background-split-marker';
    const selectedMarker = 'cockpit-mux-selected-window-marker';
    const backgroundSession = await activeTopologySession();
    const backgroundRoot = backgroundSession.windows[0]!.panes[0]!;
    const backgroundInput = activeWindowTerminal(backgroundRoot.key).locator('textarea');
    await backgroundInput.pressSequentially(`printf '${backgroundRootMarker}\\n'`);
    await backgroundInput.press('Enter');
    await expect(activeWindowTerminal(backgroundRoot.key)).toContainText(backgroundRootMarker);

    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    const backgroundWithSplit = await activeTopologySession();
    const backgroundSplit = backgroundWithSplit.windows[0]!.panes.find(
      (pane) => pane.paneId !== backgroundRoot.paneId,
    )!;
    const splitInput = activeWindowTerminal(backgroundSplit.key).locator('textarea');
    await splitInput.pressSequentially(`printf '${backgroundSplitMarker}\\n'; sleep 2; exit`);
    await splitInput.press('Enter');
    await expect(activeWindowTerminal(backgroundSplit.key)).toContainText(backgroundSplitMarker);

    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const selectedSession = await activeTopologySession();
    expect(selectedSession.sessionId).toBe(backgroundSession.sessionId);
    expect(selectedSession.activeWindowId).not.toBe(backgroundSession.activeWindowId);
    const selectedInput = activeWindowTerminals().locator('textarea');
    await selectedInput.pressSequentially(`printf '${selectedMarker}\\n'`);
    await selectedInput.press('Enter');
    await expect(activeWindowTerminals()).toContainText(selectedMarker);
    await expect
      .poll(async () => (await topologySnapshot()).activeSessionId)
      .toBe(selectedSession.sessionId);

    await expect
      .poll(async () => {
        const sessions = await topology();
        return sessions
          .find((session) => session.sessionId === backgroundSession.sessionId)
          ?.windows[0]?.panes.map((pane) => pane.paneId);
      })
      .toEqual([backgroundRoot.paneId]);
    await expect
      .poll(async () => (await topologySnapshot()).activeSessionId)
      .toBe(selectedSession.sessionId);
    await expect(activeTopologySession()).resolves.toMatchObject({
      sessionId: selectedSession.sessionId,
      activeWindowId: selectedSession.activeWindowId,
    });
    await expect(activeWindowTerminals()).toContainText(selectedMarker);
  });

  test('gives rapid split requests distinct terminal keys', async () => {
    const sessionId = (await activeTopologySession()).sessionId;
    await Promise.all([
      page.keyboard.press(MUX_SHORTCUT.splitRight),
      page.keyboard.press(MUX_SHORTCUT.splitRight),
    ]);
    await expect
      .poll(
        async () =>
          (await topology()).find((session) => session.sessionId === sessionId)?.windows[0]?.panes
            .length,
      )
      .toBe(3);
    const keys = await page.evaluate(async (activeSessionId) => {
      const sessions = (await window.api.muxSessions.topology()).sessions;
      const active = sessions.find((session) => session.sessionId === activeSessionId);
      return active?.windows[0]?.panes.map((pane) => pane.key) ?? [];
    }, sessionId);
    expect(new Set(keys).size).toBe(3);
  });

  test('converges on daemon topology when create, inspect, and close overlap', async () => {
    // Leave one known survivor before issuing the race. The split shortcut uses
    // the focused root as its source while a real shell exit retires that same source;
    // either daemon serialization order is legal, but the renderer may show
    // only the final authoritative snapshot—never a resurrected/duplicate tab.
    await page.keyboard.press(MUX_SHORTCUT.splitRight);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
    const initial = await activeTopologySession();
    const sessionId = initial.sessionId;
    const activeMuxWindow = initial.windows.find(
      (candidate) => candidate.windowId === initial.activeWindowId,
    )!;
    const source = activeMuxWindow.panes[0]!;
    await activeWindowTerminal(source.key).click();
    const sourceInput = activeWindowTerminal(source.key).locator('textarea');
    await expect(sourceInput).toBeFocused();
    const inspection = page.evaluate(async () => window.api.muxSessions.topology());
    await Promise.all([
      page.keyboard.press(MUX_SHORTCUT.splitRight),
      inspection,
      // Preserve the original input node before the split selects its new pane.
      // A real process exit and a create must overlap, but the test must not
      // accidentally exit the newly-created sibling merely because it won focus.
      sourceInput.pressSequentially('exit').then(() => sourceInput.press('Enter')),
    ]);
    await expect
      .poll(async () => {
        const session = (await topology()).find((candidate) => candidate.sessionId === sessionId);
        const panes = session?.windows.flatMap((candidate) => candidate.panes) ?? [];
        const paneIds = panes.map((pane) => pane.paneId);
        const keys = panes.map((pane) => pane.key);
        return (
          paneIds.length >= 1 &&
          new Set(paneIds).size === paneIds.length &&
          new Set(keys).size === keys.length &&
          panes.every((pane) => !pane.exited)
        );
      })
      .toBe(true);
    await expect
      .poll(async () => {
        const settled = (await topology()).find((candidate) => candidate.sessionId === sessionId);
        const settledWindow = settled?.windows.find(
          (candidate) => candidate.windowId === settled.activeWindowId,
        );
        const rendered = await activeWindowTerminals().evaluateAll((terminals) =>
          terminals.map((terminal) => terminal.parentElement?.dataset.terminalKey).filter(Boolean),
        );
        const daemon = settledWindow?.panes.map((pane) => pane.key) ?? [];
        // The layout tree owns visual order; the protocol's pane catalog owns
        // identity and can legitimately return the same leaves in a different
        // traversal order after a concurrent split/exit. Assert membership,
        // not a renderer-specific traversal order.
        return JSON.stringify([...rendered].sort()) === JSON.stringify([...daemon].sort());
      })
      .toBe(true);
  });

  test('keeps one logical session while adding a window', async () => {
    const initialSessions = (await topology()).length;
    expect(initialSessions).toBeGreaterThanOrEqual(1);
    const firstSession = await activeTopologySession();
    const firstMarker = 'cockpit-mux-first-logical-session';
    await activeWindowTerminals()
      .locator('textarea')
      .pressSequentially(`printf '${firstMarker}\\n'`);
    await activeWindowTerminals().locator('textarea').press('Enter');
    await expect(activeWindowTerminals()).toContainText(firstMarker);

    // Cockpit exposes a one-project/one-session model. New work belongs in a
    // window, never in an additional Session N tab.
    await page.keyboard.press(MUX_SHORTCUT.newWindow);
    await expect.poll(async () => (await topology()).length).toBe(initialSessions);
    await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
    const secondMarker = 'cockpit-mux-second-window';
    await activeWindowTerminals()
      .locator('textarea')
      .pressSequentially(`printf '${secondMarker}\\n'`);
    await activeWindowTerminals().locator('textarea').press('Enter');
    await expect(activeWindowTerminals()).toContainText(secondMarker);

    await page.keyboard.press('Meta+Shift+BracketLeft');
    await expect
      .poll(async () => (await activeTopologySession()).sessionId)
      .toBe(firstSession.sessionId);
    await expect(activeWindowTerminals()).toContainText(firstMarker);
  });

  test('keeps same-key lifecycle operations scoped to their project', async () => {
    const result = await page.evaluate(
      async ({ rootPath, firstProjectId }) => {
        const second = await window.api.projects.add({
          label: 'Mux isolation',
          connection: { kind: 'local', rootPath },
        });
        const opts = { key: 'same-key', kind: 'terminal' as const, cols: 80, rows: 24 };

        await window.api.projects.activate(firstProjectId);
        await window.api.terminal.open(opts, firstProjectId);
        await window.api.terminal.resize('same-key', 91, 29, firstProjectId);

        await window.api.projects.activate(second.id);
        await window.api.terminal.open(opts, second.id);
        return {
          secondProjectId: second.id,
          firstTopology: (await window.api.muxSessions.topology(firstProjectId)).sessions,
          secondTopology: (await window.api.muxSessions.topology(second.id)).sessions,
        };
      },
      { rootPath: projectRoot, firstProjectId: primaryProjectId },
    );
    const paneFor = (sessions: Topology, key: string) =>
      sessions
        .flatMap((session) => session.windows)
        .flatMap((window) => window.panes)
        .find((pane) => pane.key === key);
    const firstPane = paneFor(result.firstTopology, 'same-key');
    const secondPane = paneFor(result.secondTopology, 'same-key');
    expect(firstPane).toBeDefined();
    expect(secondPane).toBeDefined();
    expect(firstPane!.sessionId).not.toBe(secondPane!.sessionId);
    expect(firstPane!.paneId).not.toBe(secondPane!.paneId);

    // Close the background project's same-key pane while the second project is
    // active. A legacy active-provider lookup would close the second pane here.
    await page.evaluate(({ projectId, key }) => window.api.terminal.close(key, true, projectId), {
      projectId: primaryProjectId,
      key: 'same-key',
    });
    await expect
      .poll(async () => paneFor(await topology(), 'same-key')?.paneId)
      .toBe(secondPane!.paneId);
  });

  test('preserves visible pane markers and bidirectional focus independently per project', async () => {
    const typeMarker = async (paneKey: string, value: string): Promise<string> => {
      const terminal = activeWindowTerminal(paneKey);
      const pivot = Math.ceil(value.length / 2);
      const completion = `${value}:executed`;
      const input = terminal.locator('textarea');
      await input.focus();
      await expect(input).toBeFocused();
      await input.pressSequentially(
        `printf '%s%s\\n' '${value.slice(0, pivot)}' '${value.slice(pivot)}'; printf '%s\\n' '${completion}'`,
        { delay: 5 },
      );
      await input.press('Enter');
      // Matching the marker alone can be a false positive from shell input
      // echo; require output produced after the command executes.
      await expect(terminal).toContainText(completion);
      return completion;
    };
    const exerciseProject = async (label: string) => {
      await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
      await expect(activeWindowTerminals().locator('textarea')).toHaveCount(1);
      const session = await activeTopologySession();
      const window = session.windows.find(
        (candidate) => candidate.windowId === session.activeWindowId,
      )!;
      const root = window.panes.find((pane) => pane.paneId === window.activePaneId)!;
      const rootMarker = `mux-project:${label}:root`;
      const rootCompletion = await typeMarker(root.key, rootMarker);
      await page.keyboard.press(MUX_SHORTCUT.splitRight);
      await expect(activeWindowTerminals().locator('textarea')).toHaveCount(2);
      const afterSplit = await activeTopologySession();
      const splitWindow = afterSplit.windows.find(
        (candidate) => candidate.windowId === afterSplit.activeWindowId,
      )!;
      const selected = splitWindow.panes.find((pane) => pane.paneId === splitWindow.activePaneId)!;
      const selectedMarker = `mux-project:${label}:split`;
      const selectedCompletion = await typeMarker(selected.key, selectedMarker);
      await page.keyboard.press('Meta+Alt+ArrowLeft');
      await expect(activeWindowTerminal(root.key).locator('textarea')).toBeFocused();
      const leftMarker = `mux-project:${label}:left`;
      const leftCompletion = await typeMarker(root.key, leftMarker);
      await expect(activeWindowTerminal(selected.key)).not.toContainText(leftMarker);
      await page.keyboard.press('Meta+Alt+ArrowRight');
      await expect(activeWindowTerminal(selected.key).locator('textarea')).toBeFocused();
      const rightMarker = `mux-project:${label}:right`;
      const rightCompletion = await typeMarker(selected.key, rightMarker);
      await expect(activeWindowTerminal(root.key)).not.toContainText(rightMarker);
      return {
        rootMarker,
        selectedMarker,
        rootKey: root.key,
        selectedKey: selected.key,
        completions: [rootCompletion, selectedCompletion, leftCompletion, rightCompletion],
      };
    };

    const primary = await exerciseProject('primary');
    const secondaryId = await page.evaluate(async (rootPath) => {
      const project = await window.api.projects.add({
        label: 'Mux marker isolation',
        connection: { kind: 'local', rootPath },
      });
      await window.api.projects.activate(project.id);
      return project.id;
    }, projectRoot);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    const secondary = await exerciseProject('secondary');

    await page.evaluate((projectId) => window.api.projects.activate(projectId), primaryProjectId);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminal(primary.rootKey)).toContainText(primary.completions[0]!);
    await expect(activeWindowTerminal(primary.selectedKey)).toContainText(primary.completions[1]!);
    await activeWindowTerminal(primary.selectedKey).click();
    await page.keyboard.press('Meta+Alt+ArrowLeft');
    await expect(activeWindowTerminal(primary.rootKey).locator('textarea')).toBeFocused();

    await page.evaluate((projectId) => window.api.projects.activate(projectId), secondaryId);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.locator('.dv-tab', { hasText: 'Terminal' }).first().click();
    await expect(activeWindowTerminal(secondary.rootKey)).toContainText(secondary.completions[0]!);
    await expect(activeWindowTerminal(secondary.selectedKey)).toContainText(
      secondary.completions[1]!,
    );
    await activeWindowTerminal(secondary.selectedKey).click();
    await page.keyboard.press('Meta+Alt+ArrowLeft');
    await expect(activeWindowTerminal(secondary.rootKey).locator('textarea')).toBeFocused();
  });

  test.afterEach(async () => {
    try {
      if (appProcess && process.env['COCKPIT_E2E_PRESERVE_PROFILE'] !== '1') {
        await page.evaluate(async () => {
          const sessions = await window.api.muxSessions.list();
          await Promise.all(
            sessions.map(async (session) => {
              try {
                await window.api.muxSessions.destroy(session.projectId, session.sessionId);
              } catch {
                // Another pane or prior destroy may already have removed it.
              }
            }),
          );
        });
      }
      await closeApp();
      await stopProfileMuxDaemon();
    } finally {
      try {
        execFileSync('tmux', ['-L', TEST_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
      } catch {
        // An absent server is already clean.
      }
      rmSync(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      try {
        if (process.env['COCKPIT_E2E_PRESERVE_PROFILE'] !== '1')
          rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Electron's detached crash handler can briefly create its final marker
        // after the main process exits; the driver removes this exact profile.
      }
    }
  });
});
