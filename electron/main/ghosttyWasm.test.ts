import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  protocol: {
    registerSchemesAsPrivileged: electron.registerSchemesAsPrivileged,
    handle: electron.handle,
  },
}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import {
  GHOSTTY_WASM_SCHEME,
  GHOSTTY_WASM_URL,
  ghosttyWasmPath,
  registerGhosttyWasmHandler,
  registerGhosttyWasmScheme,
} from './ghosttyWasm';

afterEach(() => vi.clearAllMocks());

describe('Ghostty WASM asset protocol', () => {
  it('registers a fetch-capable private scheme before readiness', () => {
    registerGhosttyWasmScheme();

    expect(electron.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: GHOSTTY_WASM_SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      },
    ]);
  });

  it('serves only the bundled Ghostty WASM asset', async () => {
    vi.mocked(readFile).mockResolvedValueOnce(Buffer.from([0, 97, 115, 109]));
    registerGhosttyWasmHandler();
    const handler = electron.handle.mock.calls[0]?.[1];
    expect(handler).toBeTypeOf('function');

    const valid = await handler!({ url: GHOSTTY_WASM_URL } as Request);
    expect(valid.status).toBe(200);
    expect(valid.headers.get('Content-Type')).toBe('application/wasm');
    expect(new Uint8Array(await valid.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(vi.mocked(readFile)).toHaveBeenCalledWith(ghosttyWasmPath());

    const missing = await handler!({ url: `${GHOSTTY_WASM_SCHEME}://other/file.wasm` } as Request);
    expect(missing.status).toBe(404);
  });
});
