/**
 * How the local `cockpit` CLI ships and is signed (scenario 14, packaging side).
 *
 * The CLI is the remote helper's Go binary for the host platform: no new artifact.
 * What can be checked without running electron-builder or notarization is checked
 * here — the config ships `remote-helper/dist` where the runtime resolver looks for
 * it, and the macOS signer treats the helper's darwin binary like the mux binaries
 * (selected from its manifest, signed by the real signer, hashes refreshed). A real
 * `package:dir` + notarization are NOT run by this suite.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

describe('electron-builder config', () => {
  const config = parse(readFileSync(join(REPO, 'electron-builder.yml'), 'utf8')) as {
    extraResources: Array<{ from: string; to: string; filter?: string[] }>;
    mac: { sign: string };
    afterPack: string;
  };

  it('ships the whole remote-helper dist (the CLI included) where the runtime resolver looks', () => {
    // helperDistDir() resolves <resourcesPath>/remote-helper/dist when packaged.
    const entry = config.extraResources.find((r) => r.from === 'remote-helper/dist');
    expect(entry).toBeDefined();
    expect(entry!.to).toBe('remote-helper/dist');
    expect(entry!.filter).toEqual(['**/*']);
  });

  it('seals macOS builds with the custom signer that covers the helper binary', () => {
    expect(config.mac.sign).toBe('scripts/sign-macos.mjs');
    expect(config.afterPack).toBe('scripts/sign-macos-after-pack.mjs');
  });
});

describe('macOS signer: the helper darwin binary is the local CLI', () => {
  let app: string;
  let dist: string;

  beforeEach(() => {
    app = mkdtempSync('/tmp/acsg-') + '/Cockpit.app';
    dist = join(app, 'Contents', 'Resources', 'remote-helper', 'dist');
    mkdirSync(dist, { recursive: true });
  });
  afterEach(() => rmSync(join(app, '..'), { recursive: true, force: true }));

  const writeManifest = (binaries: unknown): void =>
    writeFileSync(
      join(dist, 'manifest.json'),
      JSON.stringify({ version: '0.1.0', binaries }, null, 2),
    );

  it('selects only darwin entries from the helper manifest', async () => {
    const { helperDarwinBinaries } = await import('../../../scripts/sign-macos.mjs');
    writeManifest([
      { os: 'linux', arch: 'amd64', filename: 'helper-0.1.0-linux-amd64' },
      { os: 'darwin', arch: 'arm64', filename: 'helper-0.1.0-darwin-arm64' },
      { os: 'linux', arch: 'arm64', filename: 'helper-0.1.0-linux-arm64' },
    ]);
    expect(helperDarwinBinaries(app)).toEqual([join(dist, 'helper-0.1.0-darwin-arm64')]);
  });

  it('fails the build loudly when the helper manifest is missing or malformed', async () => {
    const { helperDarwinBinaries, refreshHelperManifest } =
      await import('../../../scripts/sign-macos.mjs');
    expect(() => helperDarwinBinaries(app)).toThrow(); // no manifest at all
    writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ binaries: 'nope' }));
    expect(() => helperDarwinBinaries(app)).toThrow(/Malformed remote-helper manifest/);
    writeManifest([]);
    expect(() => refreshHelperManifest(app)).toThrow(/Malformed remote-helper manifest/);
    writeManifest([{ os: 'darwin', arch: 'arm64' }]);
    expect(() => refreshHelperManifest(app)).toThrow(/Malformed binary entry/);
  });

  it("refreshes every entry's sha256 to the final bytes (signing changes them)", async () => {
    const { refreshHelperManifest } = await import('../../../scripts/sign-macos.mjs');
    const files = {
      'helper-0.1.0-linux-amd64': 'linux amd64 bytes',
      'helper-0.1.0-darwin-arm64': 'darwin arm64 bytes AFTER signing',
    };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dist, name), bytes);
    writeManifest([
      { os: 'linux', arch: 'amd64', filename: 'helper-0.1.0-linux-amd64', sha256: 'stale' },
      { os: 'darwin', arch: 'arm64', filename: 'helper-0.1.0-darwin-arm64', sha256: 'stale' },
    ]);
    refreshHelperManifest(app);
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8')) as {
      version: string;
      binaries: Array<{ filename: string; sha256: string }>;
    };
    expect(manifest.version).toBe('0.1.0'); // everything else is preserved
    for (const entry of manifest.binaries) {
      const expected = createHash('sha256')
        .update(files[entry.filename as keyof typeof files])
        .digest('hex');
      expect(entry.sha256).toBe(expected);
    }
  });
});
