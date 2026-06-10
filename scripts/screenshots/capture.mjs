// Boots the built Electron app against the demo fixture (see fixture.mjs) in an
// isolated user-data profile and captures README screenshots into docs/images/.
//
// Run via `npm run screenshots` (builds first) or directly with `node`.
// Isolation: a throwaway --user-data-dir means the app starts empty and only the
// demo project is ever shown — your real projects never appear in a screenshot.

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateFixture, FIXTURE_DIR } from './fixture.mjs';

/** Kill only the tmux sessions the demo opened (matched by working dir), never the user's. */
function killDemoSessions() {
  try {
    const out = execFileSync('tmux', ['-L', 'agent-cockpit', 'list-sessions', '-F', '#{session_name} #{session_path}'], {
      encoding: 'utf8',
    });
    for (const line of out.split('\n')) {
      const [name, ...rest] = line.split(' ');
      if (name && rest.join(' ') === FIXTURE_DIR) {
        execFileSync('tmux', ['-L', 'agent-cockpit', 'kill-session', '-t', name]);
      }
    }
  } catch {
    /* no socket / no sessions — nothing to clean */
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const OUT_DIR = join(ROOT, 'docs', 'images');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, name) {
  const path = join(OUT_DIR, `${name}.png`);
  await win.screenshot({ path });
  console.log('  •', `docs/images/${name}.png`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Generating demo fixture…');
  const fixture = generateFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-shots-'));

  console.log('Launching app…');
  const app = await electron.launch({ args: [MAIN, `--user-data-dir=${userDataDir}`] });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');

  // Deterministic window size for stable screenshots.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1480, 920);
  });
  await sleep(600);

  // Add + activate the demo project through the real IPC, then reload so the
  // renderer re-hydrates from the persisted store and the provider goes live.
  console.log('Adding demo project…');
  await win.evaluate(async (rootPath) => {
    const p = await window.api.projects.add({
      label: 'Demo Notes',
      connection: { kind: 'local', rootPath },
    });
    await window.api.projects.activate(p.id);
  }, fixture);
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

  await app.close();
  killDemoSessions();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
