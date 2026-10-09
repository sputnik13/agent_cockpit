import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GhosttyCore } from '@wterm/ghostty';

const WASM_PATH = join(process.cwd(), 'node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm');
const WASM_URL = 'wterm-graphics-test.wasm';
const ESC = '\u001b';
const PNG_1X1_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function kitty(params: string, payload: string): Uint8Array {
  return new TextEncoder().encode(`${ESC}_G${params};${payload}${ESC}\\`);
}

describe('WTerm 0.5 Ghostty graphics core', () => {
  const originalFetch = globalThis.fetch;
  let core: GhosttyCore | null = null;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url) !== WASM_URL) throw new Error(`unexpected WASM request: ${String(url)}`);
        return new Response(await readFile(WASM_PATH), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    core?.dispose();
    core = null;
    vi.stubGlobal('fetch', originalFetch);
  });

  it('keeps direct RGB, RGBA, and PNG images in the public graphics API', async () => {
    core = await GhosttyCore.load({ wasmPath: WASM_URL, imageStorageLimit: 1024 });
    core.init(80, 24);

    core.writeRaw(kitty('a=T,f=24,s=1,v=1,i=101', '/wAA'));
    expect(core.getResponse()).toBe(`${ESC}_Gi=101;OK${ESC}\\`);
    let graphics = core.getGraphicsState();
    expect(graphics?.images).toEqual([{ imageId: 101, version: 1, width: 1, height: 1 }]);
    expect(core.getGraphicsImage(101, 1)?.rgba).toEqual(new Uint8Array([255, 0, 0, 255]));

    // Replacing an image advances its version without growing the image store.
    core.writeRaw(kitty('a=T,f=32,s=1,v=1,i=101', 'AP8A/w=='));
    expect(core.getResponse()).toBe(`${ESC}_Gi=101;OK${ESC}\\`);
    graphics = core.getGraphicsState();
    expect(graphics?.images).toEqual([{ imageId: 101, version: 2, width: 1, height: 1 }]);
    expect(core.getGraphicsImage(101, 2)?.rgba).toEqual(new Uint8Array([0, 255, 0, 255]));

    core.writeRaw(kitty('a=T,f=100,i=103', PNG_1X1_RED));
    expect(core.getResponse()).toBe(`${ESC}_Gi=103;OK${ESC}\\`);
    graphics = core.getGraphicsState();
    const png = graphics?.images.find((image) => image.imageId === 103);
    expect(png).toMatchObject({ imageId: 103, width: 1, height: 1 });
    expect(png).toBeDefined();
    expect(core.getGraphicsImage(103, png!.version)?.rgba).toEqual(
      new Uint8Array([255, 0, 0, 255]),
    );

    core.writeRaw(kitty('a=d,d=A', ''));
    expect(core.getGraphicsState()).toEqual({ generation: 4, images: [], placements: [] });
    expect(core.getResourceState().graphics).toMatchObject({
      capacity: 1024,
      used: 0,
      imageCount: 0,
      placementCount: 0,
      rejected: 0,
    });
  });

  it('accepts Cockpit quiet replay seeds without producing a terminal reply', async () => {
    core = await GhosttyCore.load({ wasmPath: WASM_URL, imageStorageLimit: 1024 });
    core.init(80, 24);

    // This is the daemon seed codec: transmit the retained raw RGBA image,
    // save the text-seed cursor, explicitly place the image, and restore the
    // cursor. q=2 makes every replay command quiet so it cannot enter the
    // user-input route during a renderer reload.
    core.writeRaw(
      new TextEncoder().encode(
        `${ESC}7${ESC}_Ga=t,f=32,s=1,v=1,i=201,q=2,m=0;/wAA/w==${ESC}\\` +
          `${ESC}[2;3H${ESC}_Ga=p,i=201,p=9,q=2,c=1,r=1;${ESC}\\${ESC}8`,
      ),
    );

    expect(core.getResponse()).toBeNull();
    expect(core.getGraphicsImage(201, 1)?.rgba).toEqual(new Uint8Array([255, 0, 0, 255]));
    expect(core.getGraphicsState()?.placements).toEqual([
      expect.objectContaining({ imageId: 201, row: 1, col: 2, columns: 1, rows: 1 }),
    ]);
  });
});
