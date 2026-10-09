import { join } from 'node:path';

import signMac from './sign-macos.mjs';

/**
 * electron-builder skips macOS signing when a directory package has no
 * discoverable certificate. Seal that testable output with the same signer the
 * distributable path uses; a later certificate-backed signing pass may re-seal
 * it for release.
 */
export default function signMacAfterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const identity = context.packager.platformSpecificBuildOptions.identity ?? '-';
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  signMac({ app, identity });
}
