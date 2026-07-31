/**
 * writeStreamToDest (D5: temp-then-rename) unit tests. Verifies the shared
 * Download-capability writer: success renames the temp file away leaving none
 * behind; a mid-stream source failure rejects, cleans up the temp file, and
 * leaves the destination untouched (absent, or with its prior content intact
 * if one already existed there); an unwritable destination directory rejects
 * with no partial file leaked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { writeStreamToDest } from './exportWrite';

/** A Readable that pushes one chunk, then on the NEXT read emits 'error'
 *  instead of ending — simulating a failure partway through a transfer
 *  (rather than an immediate/before-any-bytes failure). */
function flakyReadable(firstChunk: Buffer): Readable {
  let pushedFirst = false;
  return new Readable({
    read() {
      if (!pushedFirst) {
        pushedFirst = true;
        this.push(firstChunk);
        return;
      }
      queueMicrotask(() => this.emit('error', new Error('simulated mid-stream failure')));
    },
  });
}

describe('writeStreamToDest (D5: temp-then-rename)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-exportwrite-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the destination and leaves no temp file behind on success', async () => {
    const dest = join(dir, 'out.bin');
    await writeStreamToDest(Readable.from([Buffer.from('hello world')]), dest);
    expect(readFileSync(dest, 'utf8')).toBe('hello world');
    // Nothing else in the directory (no leftover *.part temp file).
    expect(readdirSync(dir)).toEqual(['out.bin']);
  });

  it('is byte-identical for binary content', async () => {
    const bin = Buffer.from([0x00, 0x89, 0xff, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const dest = join(dir, 'out.png');
    await writeStreamToDest(Readable.from([bin]), dest);
    expect(Buffer.compare(readFileSync(dest), bin)).toBe(0);
  });

  it('rejects and cleans up the temp file on a mid-stream source error', async () => {
    const dest = join(dir, 'out.bin');
    await expect(writeStreamToDest(flakyReadable(Buffer.from('partial-')), dest)).rejects.toThrow(
      /simulated mid-stream failure/,
    );
    expect(existsSync(dest)).toBe(false);
    expect(readdirSync(dir)).toEqual([]); // no leaked *.part file
  });

  it('leaves a pre-existing destination file untouched when the write fails', async () => {
    const dest = join(dir, 'out.bin');
    writeFileSync(dest, 'original-content');
    await expect(writeStreamToDest(flakyReadable(Buffer.from('partial-')), dest)).rejects.toThrow();
    expect(readFileSync(dest, 'utf8')).toBe('original-content');
    // Only the original destination file remains; the temp file was cleaned up.
    expect(readdirSync(dir)).toEqual(['out.bin']);
  });

  it('rejects and leaves no partial file when the destination directory does not exist', async () => {
    const dest = join(dir, 'missing-subdir', 'out.bin');
    await expect(writeStreamToDest(Readable.from([Buffer.from('hello')]), dest)).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    // The temp path lives alongside dest (inside the nonexistent subdir), so
    // nothing was created in `dir` itself either.
    expect(readdirSync(dir)).toEqual([]);
  });
});
