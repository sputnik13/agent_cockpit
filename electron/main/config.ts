/**
 * App configuration file. Persists AppSettings to `userData/config.json` as
 * human-readable JSON (the inspectable config file), with defaults + validation
 * on read. Writes are atomic (temp file + rename).
 */
import { app } from 'electron';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSettings, type AppSettings } from '@shared/settings';

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

let cache: AppSettings | null = null;

export function loadSettings(): AppSettings {
  if (cache) return cache;
  try {
    cache = normalizeSettings(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    cache = normalizeSettings({}); // missing/corrupt file -> defaults
  }
  return cache;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = normalizeSettings({ ...loadSettings(), ...patch });
  cache = next;
  const path = configPath();
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return next;
}
