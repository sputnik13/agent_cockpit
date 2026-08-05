// Give the dev Electron.app (node_modules/electron) a stable, nameable code
// identity instead of its stock ad-hoc signature.
//
// Why: macOS Full Disk Access (and similar TCC grants) can only persist a grant
// against a durable code identity. Ad-hoc signing (Electron's stock signature)
// derives its "identity" from a hash of the binary's current bytes, which
// changes on every `npm install`/Electron version bump — so macOS can't keep a
// grant attached to it and falls back to attributing file-access requests (e.g.
// git spawned from the main process) to the nearest stable ancestor, typically
// the Homebrew `node` binary running electron-vite. Re-signing with a real
// (self-signed is fine — no CA chain is needed for a locally-built, never-
// quarantined binary) code-signing certificate gives the bundle a signing
// subject that survives rebuilds as long as this script re-applies it, so the
// bundle can hold its own Full Disk Access grant under its own name.
//
// Setup (one-time, per machine): create a self-signed certificate in Keychain
// Access (Certificate Assistant > Create a Certificate > Identity Type: Self
// Signed Root > Certificate Type: Code Signing), matching SIGNING_IDENTITY
// below, then trust it for the codesigning policy:
//   security add-trusted-cert -d -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db <exported-cert.pem>
// Confirm with `security find-identity -v -p codesigning`.
//
// Best-effort/idempotent: a no-op (with a log line) on non-macOS, when
// node_modules/electron isn't installed yet, or when the signing identity
// isn't present on this machine — must never fail `npm install` for a
// contributor who hasn't done the one-time cert setup.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIGNING_IDENTITY = 'Agent Cockpit Dev Signing';
const BUNDLE_ID = 'com.agentcockpit.electron.dev';
const BUNDLE_NAME = 'Agent Cockpit Dev';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appPath = join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plistPath = join(appPath, 'Contents', 'Info.plist');

if (!existsSync(plistPath)) {
  console.log('[sign-dev-electron] node_modules/electron not installed yet; skipping.');
  process.exit(0);
}

function hasSigningIdentity(name) {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    return out.includes(name);
  } catch {
    return false;
  }
}

if (!hasSigningIdentity(SIGNING_IDENTITY)) {
  console.log(
    `[sign-dev-electron] signing identity "${SIGNING_IDENTITY}" not found in keychain; ` +
      'skipping dev Electron re-sign (see this script\'s header comment for one-time setup).',
  );
  process.exit(0);
}

try {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${BUNDLE_ID}`, plistPath]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleName ${BUNDLE_NAME}`, plistPath]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleDisplayName ${BUNDLE_NAME}`, plistPath]);

  execFileSync('codesign', ['--force', '--deep', '--sign', SIGNING_IDENTITY, appPath], {
    stdio: 'inherit',
  });

  console.log(`[sign-dev-electron] signed ${appPath} as "${SIGNING_IDENTITY}" (${BUNDLE_ID}).`);
} catch (err) {
  console.warn(`[sign-dev-electron] failed to re-sign dev Electron.app: ${err.message}`);
}
