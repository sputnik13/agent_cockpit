import { defineConfig } from '@playwright/test';

/**
 * Focused packaged-Electron acceptance for the Cockpit mux. This is separate
 * from the broader proposed E2E-suite migration: it proves the mux's release
 * gate through Playwright's structured runner with one serialized app launch.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'mux-topology.spec.ts',
  outputDir: process.env['COCKPIT_E2E_RESULTS_DIR'] ?? './test-results',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
