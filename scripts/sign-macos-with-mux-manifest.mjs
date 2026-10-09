/**
 * macOS after-sign hook for the separately versioned Cockpit-mux artifacts.
 *
 * electron-builder signs Mach-O files below extraResources before it seals the
 * enclosing .app. That changes the bytes of the two macOS mux binaries after
 * their release manifest is made. Sign first, refresh only the staged
 * manifest's SHA-256 values, then re-sign the enclosing app (not recursively)
 * so its resource seal covers the final manifest. This runs after
 * electron-builder's signing pass and before its notarization/archive steps.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MANIFEST_RE = /^manifest-.*\.json$/;

async function signedIdentity(appPath) {
  let details;
  try {
    ({ stderr: details } = await execFile('/usr/bin/codesign', ['-dvv', appPath]));
  } catch (error) {
    details = error.stderr ?? '';
  }
  const output = String(details);
  if (/Signature=adhoc/m.test(output)) return '-';
  const authority = /^Authority=(.+)$/m.exec(output)?.[1];
  if (authority) return authority;
  throw new Error(`Could not determine the signing identity for ${appPath}: ${output}`);
}

async function refreshManifest(appPath) {
  const dist = join(appPath, 'Contents', 'Resources', 'cockpit-mux', 'dist');
  const manifests = (await fs.readdir(dist))
    .filter((name) => MANIFEST_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const manifestPath = join(dist, manifests.at(-1) ?? '');
  if (manifests.length === 0) throw new Error(`Missing Cockpit-mux manifest in ${dist}`);

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 4) {
    throw new Error(`Malformed Cockpit-mux manifest at ${manifestPath}`);
  }
  for (const binary of manifest.binaries) {
    if (typeof binary?.filename !== 'string')
      throw new Error(`Malformed binary entry in ${manifestPath}`);
    binary.sha256 = createHash('sha256')
      .update(await fs.readFile(join(dist, binary.filename)))
      .digest('hex');
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
}

/** electron-builder's `afterSign` hook. */
export default async function signMacWithMuxManifest(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await refreshManifest(appPath);

  // Builder has already signed nested code. Re-signing only the outer app
  // refreshes its resource seal without rewriting the manifest-authenticated
  // mux binaries. Preserve the entitlements and requirements builder selected.
  const identity = await signedIdentity(appPath);
  const args = [
    '--force',
    '--sign',
    identity,
    '--preserve-metadata=identifier,requirements,entitlements,flags,runtime',
  ];
  if (identity !== '-') args.push('--timestamp');
  args.push(appPath);
  await execFile('/usr/bin/codesign', args);
  await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
}
