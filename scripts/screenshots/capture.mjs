// Boots the built Electron app against the demo fixture (see fixture.mjs) in a
// fully isolated instance and captures README screenshots into docs/images/.
//
// Run via `npm run screenshots` (builds first) or directly with `node`.
// Isolation (see docs/BUILD.md "Running an isolated instance"):
//   --user-data-dir  → empty profile, so only the demo project is ever shown.
//   --tmux-socket    → a separate tmux server, so the running app is untouched.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateFixture } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const OUT_DIR = join(ROOT, 'docs', 'images');

// Dedicated, throwaway tmux socket — never the app's default 'agent-cockpit'.
const TMUX_SOCKET = 'agent-cockpit-shots';
// A Nerd Font so powerline/git glyphs in the demo prompt render correctly.
const FONT_FAMILY = 'RobotoMono Nerd Font Mono';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  await win.screenshot({ path: join(OUT_DIR, `${name}.png`) });
  console.log('  •', `docs/images/${name}.png`);
}

/** Tear down the isolated tmux server (exclusively this run's). */
function killShotSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* no server / already gone */
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Generating demo fixture…');
  const fixture = generateFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-shots-'));

  console.log('Launching isolated app…');
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Deterministic window size for stable screenshots.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1480, 920);
  });
  await sleep(600);

  // Set the Nerd Font, then add + activate the demo project through the real IPC.
  // Reloading re-hydrates the renderer from the persisted store and the provider
  // goes live with the chosen font.
  console.log('Configuring + adding demo project…');
  await win.evaluate(
    async ({ rootPath, fontFamily }) => {
      await window.api.settings.set({ fontFamily });
      const p = await window.api.projects.add({
        label: 'Demo Notes',
        connection: { kind: 'local', rootPath },
      });
      await window.api.projects.activate(p.id);
    },
    { rootPath: fixture, fontFamily: FONT_FAMILY },
  );
  await win.reload();
  await win.waitForLoadState('domcontentloaded');

  // Let the local provider connect and the panels load (changes, workgraph).
  await sleep(5000);

  console.log('Capturing…');
  await shot(win, 'workspace');

  // Open a changed file so the diff/content viewer is populated, then capture.
  try {
    await win.getByText('src/notes.ts', { exact: false }).first().click({ timeout: 5000 });
    await sleep(1200);
    await shot(win, 'content-diff');
  } catch (e) {
    console.warn('  (skipped content-diff shot:', e.message, ')');
  }

  // Select the in-progress task so Task Detail is populated, then capture.
  try {
    await win.getByText('Add full-text search', { exact: false }).first().click({ timeout: 5000 });
    await sleep(1000);
    await shot(win, 'workgraph-task-detail');
  } catch (e) {
    console.warn('  (skipped task-detail shot:', e.message, ')');
  }

  // app.close() can hang on tmux control-mode teardown; don't block on it.
  await Promise.race([app.close().catch(() => {}), sleep(3000)]);
  killShotSessions();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
