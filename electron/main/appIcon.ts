import { join } from 'node:path';

/**
 * Resolve the development-only icon from the compiled main-process directory.
 * Packaged builds use electron-builder's platform-native icon configuration.
 */
export function developmentAppIcon(
  mainModuleDir: string,
  isDevelopment: boolean,
): string | undefined {
  return isDevelopment ? join(mainModuleDir, '../../build/icon.png') : undefined;
}
