import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ userDataPath: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electronState.userDataPath } }));

import { normalizeConfigSettings } from './config';

let profilePath: string | null = null;

afterEach(() => {
  if (profilePath) rmSync(profilePath, { recursive: true, force: true });
  profilePath = null;
  electronState.userDataPath = '';
  vi.resetModules();
});

describe('normalizeConfigSettings — Cockpit-mux default promotion', () => {
  it('selects cockpit-mux only for fresh macOS/Linux configurations', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const settings = normalizeConfigSettings({}, 'fresh', platform);
      expect(settings.terminalBackend).toBe('cockpit-mux');
      expect(settings.terminalRenderer).toBe('wterm');
    }
  });

  it('keeps an explicit fresh renderer choice while defaulting an omitted one to wterm', () => {
    const settings = normalizeConfigSettings({ terminalRenderer: 'dom' }, 'fresh', 'darwin');
    expect(settings.terminalBackend).toBe('cockpit-mux');
    expect(settings.terminalRenderer).toBe('dom');
  });

  it('silently preserves an existing backend despite a legacy pending migration flag', () => {
    const settings = normalizeConfigSettings(
      { terminalBackend: 'session-per-tab', terminalBackendMigration: 'pending' },
      'existing',
      'darwin',
    );
    expect(settings.terminalBackend).toBe('session-per-tab');
    expect(settings).not.toHaveProperty('terminalBackendMigration');
  });

  it('keeps an existing implicit legacy default on control-mode without prompting', () => {
    const settings = normalizeConfigSettings(
      { terminalBackendMigration: 'pending' },
      'existing',
      'linux',
    );
    expect(settings.terminalBackend).toBe('control-mode');
    expect(settings).not.toHaveProperty('terminalBackendMigration');
  });

  it('keeps an established profile on control-mode when its legacy config file is absent', async () => {
    profilePath = mkdtempSync(join(tmpdir(), 'cockpit-existing-profile-'));
    writeFileSync(join(profilePath, 'store.db'), 'legacy profile marker');
    electronState.userDataPath = profilePath;
    vi.resetModules();

    const { loadSettings } = await import('./config');
    expect(loadSettings().terminalBackend).toBe('control-mode');
  });

  it('preserves stored settings in a populated profile when a later build loads it', async () => {
    profilePath = mkdtempSync(join(tmpdir(), 'cockpit-populated-profile-'));
    const config = {
      terminalBackend: 'control-mode',
      terminalRenderer: 'dom',
      fontSize: 17,
    };
    const configContents = `${JSON.stringify(config, null, 2)}\n`;
    writeFileSync(join(profilePath, 'config.json'), configContents);
    writeFileSync(join(profilePath, 'store.db'), 'populated profile fixture');
    electronState.userDataPath = profilePath;
    vi.resetModules();

    const { loadSettings } = await import('./config');
    const settings = loadSettings();

    expect(settings.terminalBackend).toBe('control-mode');
    expect(settings.terminalRenderer).toBe('dom');
    expect(settings.fontSize).toBe(17);
    expect(readFileSync(join(profilePath, 'config.json'), 'utf8')).toBe(configContents);
    expect(readFileSync(join(profilePath, 'store.db'), 'utf8')).toBe('populated profile fixture');
  });

  it('persists fresh defaults so a second launch keeps Cockpit mux after store.db exists', async () => {
    profilePath = mkdtempSync(join(tmpdir(), 'cockpit-fresh-profile-'));
    electronState.userDataPath = profilePath;
    vi.resetModules();

    const { loadSettings } = await import('./config');
    expect(loadSettings().terminalBackend).toBe('cockpit-mux');
    expect(existsSync(join(profilePath, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(profilePath, 'config.json'), 'utf8')).terminalBackend).toBe(
      'cockpit-mux',
    );

    // The database is created after first-run settings resolution. On the next
    // launch, the persisted selection remains authoritative.
    writeFileSync(join(profilePath, 'store.db'), 'initialized after first-run settings');
    vi.resetModules();
    const secondLaunch = await import('./config');
    expect(secondLaunch.loadSettings().terminalBackend).toBe('cockpit-mux');
  });

  it('never selects cockpit-mux on Windows', () => {
    expect(normalizeConfigSettings({}, 'fresh', 'win32').terminalBackend).toBe('control-mode');
    expect(
      normalizeConfigSettings({ terminalBackend: 'cockpit-mux' }, 'existing', 'win32')
        .terminalBackend,
    ).toBe('control-mode');
    expect(
      normalizeConfigSettings({ terminalBackend: 'session-per-tab' }, 'existing', 'win32')
        .terminalBackend,
    ).toBe('session-per-tab');
  });
});
