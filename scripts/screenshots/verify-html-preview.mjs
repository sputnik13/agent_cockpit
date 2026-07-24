// End-to-end verification of the sandboxed HTML preview (content panel).
// Boots the built app against the demo fixture (plus a self-contained mockup.html
// carrying inline CSS, an external-image egress probe, and a script effect) and
// asserts the static v1 preview: preview is the default mode; CSS applies; the
// external resource is blocked (no successful network load — CSP); scripts do NOT
// run (static-only v1); Raw mode stays available.
//
// Run: node scripts/screenshots/verify-html-preview.mjs

import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateFixture, FIXTURE_DIR } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const MAIN = join(ROOT, 'out', 'main', 'index.js');
const TMUX_SOCKET = 'agent-cockpit-verify-html';
const PROBE_HOST = 'blocked-probe.invalid';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOCKUP = `<!doctype html>
<html>
  <head><style>#styled { color: rgb(0, 128, 0); }</style></head>
  <body>
    <div id="styled">STYLED</div>
    <div id="out">JS-DID-NOT-RUN</div>
    <img id="probe" src="https://${PROBE_HOST}/probe.png" alt="probe" />
    <script>document.getElementById('out').textContent = 'JS-RAN';</script>
  </body>
</html>
`;

function killSessions() {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-server']);
  } catch {
    /* none */
  }
}

async function main() {
  generateFixture();
  writeFileSync(join(FIXTURE_DIR, 'mockup.html'), MOCKUP);
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-cockpit-verify-html-'));

  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`, `--tmux-socket=${TMUX_SOCKET}`],
  });
  const win = await app.firstWindow();
  win.setDefaultTimeout(15000);
  await win.waitForLoadState('domcontentloaded');

  // A CSP-blocked request STILL fires Playwright's `request` event (Chromium
  // reports requestWillBeSent before the CSP check), so counting requests is not
  // proof of egress. The real signals are: a successful `response`/`requestfinished`
  // to the probe (= leaked) vs a `requestfailed` (= blocked). We assert no success.
  const succeeded = [];
  const failed = [];
  const wire = () => {
    win.on('response', (r) => {
      if (r.url().includes(PROBE_HOST)) succeeded.push(r.url());
    });
    win.on('requestfinished', (r) => {
      if (r.url().includes(PROBE_HOST)) succeeded.push(r.url());
    });
    win.on('requestfailed', (r) => {
      if (r.url().includes(PROBE_HOST)) failed.push(r.failure()?.errorText ?? 'failed');
    });
  };
  wire();

  await win.evaluate(async ({ rootPath }) => {
    const p = await window.api.projects.add({ label: 'Demo', connection: { kind: 'local', rootPath } });
    await window.api.projects.activate(p.id);
  }, { rootPath: FIXTURE_DIR });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  wire(); // re-attach after reload
  await sleep(5000);

  const results = [];
  const record = (name, pass, detail = '') => {
    results.push({ name, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // Open mockup.html from the Changes panel (untracked file in the fixture).
  await win.getByText('mockup.html', { exact: false }).first().click();
  await sleep(1500);

  // Preview is the default mode.
  const previewTab = win.locator('[role="tab"]', { hasText: 'Preview' });
  record('preview tab is default/selected', (await previewTab.getAttribute('aria-selected')) === 'true');

  const frame = win.frameLocator('iframe[title="HTML preview"]');

  // CSS applies inside the sandboxed frame.
  const color = await frame.locator('#styled').evaluate((el) => getComputedStyle(el).color);
  record('inline CSS applies', color === 'rgb(0, 128, 0)', `color=${color}`);

  // Scripts do NOT run (static-only v1) — no "Run scripts" control exists.
  const outStatic = await frame.locator('#out').textContent();
  record('scripts do not run (static v1)', outStatic?.trim() === 'JS-DID-NOT-RUN', `out=${outStatic?.trim()}`);
  record(
    'no Run scripts control (deferred to v2)',
    (await win.getByRole('button', { name: 'Run scripts' }).count()) === 0,
  );

  // External image blocked — no SUCCESSFUL load reached the probe host.
  const probeW = await frame.locator('#probe').evaluate((img) => img.naturalWidth);
  record('probe image did not load (naturalWidth 0)', probeW === 0, `naturalWidth=${probeW}`);
  record(
    'no network egress (external image did not load)',
    succeeded.length === 0,
    `succeeded=${succeeded.length}, failed=[${failed.join(', ')}]`,
  );

  // Raw mode still available.
  record('Raw mode available', (await win.locator('[role="tab"]', { hasText: 'Raw' }).count()) > 0);

  await Promise.race([app.close().catch(() => {}), sleep(3000)]);
  killSessions();

  const allPass = results.every((r) => r.pass);
  console.log(`\n${allPass ? '✅ ALL PASS' : '❌ FAILURES'}`);
  console.log('(remote parity: file read uses the shared readFile provider path; remote host not exercised here.)');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  killSessions();
  process.exit(1);
});
