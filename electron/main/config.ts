/**
 * App configuration file. Persists AppSettings to `userData/config.json` as
 * human-readable JSON (the inspectable config file), with defaults + validation
 * on read. Writes are atomic (temp file + rename).
 */
import { app } from 'electron';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSettings, type AppSettings } from '@shared/settings';

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

function writeConfig(settings: AppSettings): void {
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

let cache: AppSettings | null = null;

type ConfigSource = 'fresh' | 'existing';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Resolve configuration at the one boundary that knows both the host platform
 * and whether a config file predates the Cockpit-mux default. Shared settings
 * normalization deliberately stays platform-neutral.
 */
export function normalizeConfigSettings(
  input: unknown,
  source: ConfigSource,
  platform: NodeJS.Platform = process.platform,
): AppSettings {
  const raw = asRecord(input);
  if (platform === 'win32') {
    // wterm/libghostty and cockpit-mux are not Windows targets. Preserve every
    // non-mux explicit selection, but never let a synced mux preference route
    // a Windows client into the unsupported launcher.
    return normalizeSettings(
      {
        ...raw,
        ...(raw.terminalBackend === 'cockpit-mux' ? { terminalBackend: 'control-mode' } : {}),
      },
      { defaultTerminalBackend: 'control-mode' },
    );
  }

  if (source === 'fresh') {
    // Preserve WTerm as the fresh-install default without coupling the two
    // independently selectable settings. An explicit fresh config value wins.
    return normalizeSettings(
      { terminalRenderer: 'wterm', ...raw },
      { defaultTerminalBackend: 'cockpit-mux' },
    );
  }

  // Existing installations stay on their resolved backend. Never ask them to
  // migrate: an explicit choice remains intact, and the legacy implicit
  // default remains control-mode.
  return normalizeSettings(raw, { defaultTerminalBackend: 'control-mode' });
}

export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = normalizeConfigSettings(JSON.parse(readFileSync(configPath(), 'utf8')), 'existing');
  } catch (error) {
    // Only an absent config is a fresh install. A corrupt/unreadable config is
    // conservatively treated as existing so it does not silently flip a user
    // from the former tmux default to a new backend.
    const missingConfig = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    // Older releases did not write config.json until the user changed a
    // preference. The app database is durable evidence that this is an
    // established profile, so missing settings there must keep the legacy
    // control-mode default instead of opting the user into Cockpit mux.
    const userDataPath = app?.getPath?.('userData');
    const hasExistingProfile = userDataPath
      ? existsSync(join(userDataPath, 'store.db'))
      : false;
    const source: ConfigSource = missingConfig && !hasExistingProfile ? 'fresh' : 'existing';
    cache = normalizeConfigSettings({}, source);
    // Record the resolved first-run defaults. Besides making them inspectable,
    // this keeps a newly initialized store.db from making the next launch look
    // like a legacy profile with no config.
    if (source === 'fresh') writeConfig(cache);
  }
  return cache;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeConfigSettings({ ...loadSettings(), ...patch }, 'existing');
  cache = next;
  writeConfig(next);
  return next;
}
