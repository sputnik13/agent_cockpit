/**
 * Import-for-effect: scrubs the inherited callback environment (see envScrub.ts
 * for what and why) the moment this module is evaluated.
 *
 * It must be the FIRST import of main's entry (electron/main/index.ts). Modules
 * evaluate in import order, so by the time any other module of the app is
 * evaluated, and not merely before the first spawn, `process.env` carries no
 * `COCKPIT_CALLBACK_*` / `COCKPIT_CLI` from an outer cockpit app.
 */
import { scrubCallbackEnv } from './envScrub';

/** The names removed at startup; main logs them once the log sink exists. Never values. */
export const scrubbedCallbackEnv: readonly string[] = scrubCallbackEnv();
