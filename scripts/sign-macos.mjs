import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST_RE = /^manifest-.*\.json$/;

function runCodesign(args) {
  execFileSync('/usr/bin/codesign', args, { stdio: 'pipe' });
}

function refreshMuxManifest(appPath) {
  const dist = join(appPath, 'Contents', 'Resources', 'cockpit-mux', 'dist');
  const manifests = readdirSync(dist)
    .filter((name) => MANIFEST_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const manifestPath = join(dist, manifests.at(-1) ?? '');
  if (manifests.length === 0) throw new Error(`Missing Cockpit-mux manifest in ${dist}`);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 3) {
    throw new Error(`Malformed Cockpit-mux manifest at ${manifestPath}`);
  }
  for (const binary of manifest.binaries) {
    if (typeof binary?.filename !== 'string') {
      throw new Error(`Malformed binary entry in ${manifestPath}`);
    }
    binary.sha256 = createHash('sha256')
      .update(readFileSync(join(dist, binary.filename)))
      .digest('hex');
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

/**
 * The remote-helper binaries ship next to the mux ones (electron-builder's
 * extraResources carries all of `remote-helper/dist`). The host's darwin build is
 * ALSO the local `cockpit` CLI: the app links it at `<userData>/callback/bin/cockpit`
 * and a user's shell runs it, so it is signed with the app's identity like the mux
 * binaries, and its manifest hashes are refreshed after signing changes its bytes.
 */
function helperDist(appPath) {
  return join(appPath, 'Contents', 'Resources', 'remote-helper', 'dist');
}

export function helperDarwinBinaries(appPath) {
  const dist = helperDist(appPath);
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.binaries)) {
    throw new Error(`Malformed remote-helper manifest at ${join(dist, 'manifest.json')}`);
  }
  return manifest.binaries
    .filter((binary) => binary?.os === 'darwin' && typeof binary.filename === 'string')
    .map((binary) => join(dist, binary.filename));
}

export function refreshHelperManifest(appPath) {
  const dist = helperDist(appPath);
  const manifestPath = join(dist, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length === 0) {
    throw new Error(`Malformed remote-helper manifest at ${manifestPath}`);
  }
  for (const binary of manifest.binaries) {
    if (typeof binary?.filename !== 'string') {
      throw new Error(`Malformed binary entry in ${manifestPath}`);
    }
    binary.sha256 = createHash('sha256')
      .update(readFileSync(join(dist, binary.filename)))
      .digest('hex');
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

function muxDarwinBinaries(appPath) {
  const dist = join(appPath, 'Contents', 'Resources', 'cockpit-mux', 'dist');
  const manifestPath = join(
    dist,
    readdirSync(dist)
      .filter((name) => MANIFEST_RE.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1) ?? '',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.binaries
    .filter((binary) => binary?.os === 'darwin' && typeof binary.filename === 'string')
    .map((binary) => join(dist, binary.filename));
}

/**
 * Builder invokes custom sign hooks synchronously. Sign only the Mach-O
 * executables we ship as resources (the mux binaries and the remote-helper darwin
 * binary, which doubles as the local `cockpit` CLI), refresh their manifest
 * hashes, then seal the outer bundle. Do not recursively re-sign Electron's own
 * frameworks: their existing platform signatures must remain compatible with the
 * host executable at launch.
 */
export default function signMac(options) {
  const ownBinaries = () => [
    ...muxDarwinBinaries(options.app),
    ...helperDarwinBinaries(options.app),
  ];
  for (const binary of ownBinaries()) {
    runCodesign(['--force', '--sign', options.identity ?? '-', binary]);
  }
  refreshMuxManifest(options.app);
  refreshHelperManifest(options.app);
  runCodesign([
    '--force',
    '--sign',
    options.identity ?? '-',
    '--preserve-metadata=identifier,requirements,entitlements,flags,runtime',
    options.app,
  ]);
  // Electron's bundled frameworks retain their vendor signatures; recursively
  // re-verifying those under this ad-hoc app identity is neither necessary nor
  // launch-compatible. Verify the sealed bundle and the code artifacts we own
  // instead.
  runCodesign(['--verify', '--strict', options.app]);
  for (const binary of ownBinaries()) {
    runCodesign(['--verify', '--strict', binary]);
  }
}
