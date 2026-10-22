// End-to-end check of Content panel tabs in the REAL built app (isolated
// profile + tmux socket): opening files from Changes adds tabs, re-opening a
// file reuses its tab, tabs are labelled with the filename and carry the full
// path as their title, closing works, and the tabs are restored after a full
// app restart on the same profile.
//
// Run (build first):  npm run build && node scripts/screenshots/verify-content-tabs.mjs
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixture, FIXTURE_DIR } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, '..', '..', 'out', 'main', 'index.js');
const TMUX_SOCKET = 'agent-cockpit-verify-content-tabs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* none */
  }
}

// When this runs from a terminal inside a dev-launched cockpit, the shell
// inherits the dev launcher's variables. Left in place they would point the test
// app at the live dev server (ELECTRON_RENDERER_URL) and at the dev launcher's
// exit marker (AC_DEV_APP_EXIT_FILE), so scrub them: the test app must load the
// built bundle and touch nothing owned by another instance.
function isolatedEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_|AC_|COCKPIT_|NODE_ENV_ELECTRON_VITE$|TMUX$)/.test(key)) delete env[key];
  }
  return env;
}

async function launch(userDataDir) {
  const app = await electron.launch({
    args: [MAIN, '--headless', `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
    env: isolatedEnv(),
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

const tabs = (win) => win.getByRole('tablist', { name: 'Open files' }).getByRole('tab');

async function main() {
  generateFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-verify-content-tabs-'));
  const results = [];
  const record = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  let { app, win } = await launch(userDataDir);
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  await win.evaluate(
    async ({ rootPath }) => {
      const p = await window.api.projects.add({
        label: 'Demo',
        connection: { kind: 'local', rootPath },
      });
      await window.api.projects.activate(p.id);
    },
    { rootPath: FIXTURE_DIR },
  );
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(5000);

  await win.locator('.dv-tab', { hasText: 'Changes' }).first().click();
  await sleep(800);
  for (const name of ['notes.ts', 'search.ts', 'README.md']) {
    await win.getByText(name, { exact: false }).first().click();
    await sleep(600);
  }
  record(
    'three opened files give three tabs',
    (await tabs(win).count()) === 3,
    `count=${await tabs(win).count()}`,
  );

  await win.getByText('notes.ts', { exact: false }).first().click();
  await sleep(500);
  record('re-opening an open file reuses its tab', (await tabs(win).count()) === 3);
  const active = await win
    .locator('[role="tablist"][aria-label="Open files"] [aria-selected="true"]')
    .first()
    .textContent();
  record(
    'the re-opened file is the active tab',
    active?.trim() === 'notes.ts',
    `active="${active?.trim()}"`,
  );
  const title = await tabs(win).first().getAttribute('title');
  // macOS resolves the temp fixture dir to /private/var/..., so match the stable tail.
  record(
    'tab title is the fully-qualified path',
    typeof title === 'string' &&
      title.startsWith('/') &&
      title.endsWith('/agent-cockpit-demo/src/notes.ts'),
    `title="${title}"`,
  );

  await win.getByRole('button', { name: 'Close search.ts' }).click();
  await sleep(300);
  record('closing a tab removes it', (await tabs(win).count()) === 2);

  // Restart on the same profile: tabs are restored.
  await Promise.race([app.close().catch(() => {}), sleep(3000)]);
  killSessions();
  ({ app, win } = await launch(userDataDir));
  await win.waitForLoadState('domcontentloaded');
  await sleep(5000);
  const restored = await tabs(win).allTextContents();
  record(
    'tabs are restored after an app restart',
    restored.join(',') === 'notes.ts,README.md',
    `restored=${restored.join(',')}`,
  );
  record('no uncaught renderer errors', errors.length === 0, errors.join(' | '));

  await Promise.race([app.close().catch(() => {}), sleep(3000)]);
  killSessions();

  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? '✅ ALL PASS' : '❌ FAILURES'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  killSessions();
  process.exit(1);
});
