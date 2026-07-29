// End-to-end verification of Explorer root browsing + the shared worktree
// dropdown labels. Boots the built app against the demo fixture and asserts:
// the worktree dropdown labels the workspace as "<dir> - <branch>" and offers an
// Explorer-only "Root (/)" entry; selecting Root lists the filesystem root; and
// the Changes panel is NOT affected (root is Explorer-local).
//
// Run: node scripts/screenshots/verify-explorer-root.mjs

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateFixture, FIXTURE_DIR } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const TMUX_SOCKET = 'agent-cockpit-verify-explorer';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* none */
  }
}

async function main() {
  generateFixture();
  const workspaceLabel = `${basename(FIXTURE_DIR)} - main`;
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-verify-explorer-'));

  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate(async ({ rootPath }) => {
    const p = await window.api.projects.add({ label: 'Demo', connection: { kind: 'local', rootPath } });
    await window.api.projects.activate(p.id);
  }, { rootPath: FIXTURE_DIR });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(5000);

  const results = [];
  const record = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Activate the Explorer tab.
  await win.locator('.dv-tab', { hasText: 'Explorer' }).first().click();
  await sleep(800);

  // The worktree dropdown (aria-label="Worktree") — the Explorer instance.
  const explorerTrigger = win.getByLabel('Worktree').last();
  const triggerText = (await explorerTrigger.textContent())?.trim() ?? '';
  record('dropdown labels workspace as "<dir> - <branch>"', triggerText.includes(workspaceLabel), `trigger="${triggerText}"`);

  // Open it and check options: the workspace + an Explorer-only "Root (/)".
  await explorerTrigger.click();
  await sleep(400);
  const rootOptionCount = await win.getByRole('option', { name: 'Root (/)' }).count();
  record('offers an Explorer-only "Root (/)" option', rootOptionCount > 0);

  // Select Root.
  await win.getByRole('option', { name: 'Root (/)' }).first().click();
  await sleep(1500);

  // The tree now lists filesystem-root entries (e.g. "Users" on macOS), which the
  // project tree never contains.
  const usersCount = await win.getByText('Users', { exact: true }).count();
  record('selecting Root lists the filesystem root', usersCount > 0, `Users entries=${usersCount}`);

  // Changes isolation: the Changes panel still shows the project's changes, not root.
  await win.locator('.dv-tab', { hasText: 'Changes' }).first().click();
  await sleep(1000);
  const projectFile = await win.getByText('notes.ts', { exact: false }).count();
  const rootInChanges = await win.getByText('Users', { exact: true }).count();
  record('Changes panel unaffected by Explorer root selection', projectFile > 0 && rootInChanges === 0, `projectFile=${projectFile}, rootLeak=${rootInChanges}`);

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
