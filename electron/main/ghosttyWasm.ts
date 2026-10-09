import { readFile } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';
import { app, protocol } from 'electron';

export const GHOSTTY_WASM_SCHEME = 'cockpit-wasm';
export const GHOSTTY_WASM_URL = `${GHOSTTY_WASM_SCHEME}://ghostty-vt/ghostty-vt.wasm`;

/** Must run before app readiness so Chromium permits fetch() for this private scheme. */
export function registerGhosttyWasmScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: GHOSTTY_WASM_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/** Serves exactly the packaged libghostty binary; it is not a general file protocol. */
export function registerGhosttyWasmHandler(): void {
  protocol.handle(GHOSTTY_WASM_SCHEME, async (request) => {
    if (request.url !== GHOSTTY_WASM_URL) return new Response('Not found', { status: 404 });
    const bytes = await readFile(ghosttyWasmPath());
    return new Response(bytes, {
      headers: {
        'Content-Type': 'application/wasm',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });
}

export function ghosttyWasmPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'ghostty-wasm', 'ghostty-vt.wasm')
    : pathResolve(
        __dirname,
        '..',
        '..',
        'node_modules',
        '@wterm',
        'ghostty',
        'wasm',
        'ghostty-vt.wasm',
      );
}
