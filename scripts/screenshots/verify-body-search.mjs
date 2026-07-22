// End-to-end verification that the workgraph search matches on bead BODY, not
// just title/id. Boots the built app against the demo fixture in an isolated
// instance, types a body-only term into the workgraph Search box, and asserts
// the matching bead is visible while non-matching ones are hidden.
//
// Run: node scripts/screenshots/verify-body-search.mjs

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateFixture } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const TMUX_SOCKET = 'agent-cockpit-verify';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* none */
  }
}

async function main() {
  const fixture = generateFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-verify-'));
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');

  await win.evaluate(async ({ rootPath }) => {
    const p = await window.api.projects.add({
      label: 'Demo Notes',
      connection: { kind: 'local', rootPath },
    });
    await window.api.projects.activate(p.id);
  }, { rootPath: fixture });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await sleep(6000);
  console.log('app loaded; probing for Search box…');

  await win.screenshot({ path: join(tmpdir(), 'verify-before.png') });
  const search = win.locator('input[placeholder="Search…"]').first();
  const n = await search.count();
  console.log('Search inputs found:', n);
  if (n === 0) {
    // Workgraph panel may not be the visible tab — click its Dockview tab.
    const tab = win.locator('.dv-tab', { hasText: 'Workgraph' });
    console.log('Workgraph tab count:', await tab.count());
    if (await tab.count()) {
      await tab.first().click();
      await sleep(1500);
      console.log('after tab click, Search inputs:', await search.count());
    }
    await win.screenshot({ path: join(tmpdir(), 'verify-after-tab.png') });
  }

  const results = [];

  async function check(name, term, present, absent) {
    await search.fill('');
    await sleep(300);
    await search.fill(term);
    await sleep(600);
    const okPresent = await win.getByText(present, { exact: false }).count();
    const okAbsent = await win.getByText(absent, { exact: false }).count();
    const pass = okPresent > 0 && okAbsent === 0;
    results.push({ name, term, present, presentCount: okPresent, absent, absentCount: okAbsent, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: term="${term}" → "${present}"×${okPresent} (want>0), "${absent}"×${okAbsent} (want 0)`);
  }

  // "Serialize" appears ONLY in the "Persist notes to disk" bead body.
  await check('body-only word', 'Serialize', 'Persist notes to disk', 'Add full-text search');
  // "Umbrella" appears ONLY in the epic bead body.
  await check('body-only word (epic)', 'Umbrella', 'Build the demo notes app', 'Add tags to notes');
  // Control: a title term still works.
  await check('title term (control)', 'tags', 'Add tags to notes', 'Persist notes to disk');
  // Negative: a term in NO title/id/body hides everything (empty state).
  await search.fill('');
  await sleep(200);
  await search.fill('zzznomatch');
  await sleep(500);
  const emptyState = await win.getByText('No tasks match', { exact: false }).count();
  results.push({ name: 'no-match empty state', pass: emptyState > 0 });
  console.log(`${emptyState > 0 ? 'PASS' : 'FAIL'}  no-match empty state: "No tasks match"×${emptyState} (want>0)`);

  // app.close() can hang on tmux control-mode teardown; don't block on it.
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
