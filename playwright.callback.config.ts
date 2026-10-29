import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Focused acceptance for the terminal callback socket against the BUILT app
 * (`npm run build`), through Playwright's structured runner: the renderer leg
 * (`cockpit open` -> a Content tab with the terminal keeping the keyboard,
 * `callback-open.spec.ts`) and the integrated acceptance on every local backend,
 * a restart and `deterministicSessionNames` (`callback-acceptance.spec.ts`). One
 * worker, serialized: each describe launches its own isolated app. Separate from
 * the broader proposed E2E-suite migration, like `playwright.mux.config.ts`.
 *
 * Run: `npm run test:e2e:callback`.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['callback-open.spec.ts', 'callback-acceptance.spec.ts'],
  // Not ./test-results (untracked and not ignored in this repo).
  outputDir:
    process.env['COCKPIT_E2E_RESULTS_DIR'] ?? join(tmpdir(), 'agent-cockpit-callback-e2e-results'),
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
