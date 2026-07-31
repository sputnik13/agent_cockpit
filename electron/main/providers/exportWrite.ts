/**
 * writeStreamToDest — the single shared writer behind the Download capability
 * (D1: seam placement). Both `LocalProvider.exportFile` and
 * `RemoteProvider.exportFile` pipe their respective byte source (a local
 * `fs.createReadStream`, or `RemoteTransport.createReadStream` over SFTP)
 * through this one function so the partial-write safety policy (D5) lives in
 * exactly one place regardless of transport.
 *
 * D5 — partial-write safety: write-to-temp-then-rename. The destination path
 * is written only via the final rename, which is atomic on the same
 * filesystem (the temp file lives alongside it, same directory). On ANY
 * failure — a source read error, a destination write error, or a failed
 * rename — the temp file is best-effort unlinked and the error is rethrown;
 * `destPath` is left with no partial/truncated content (and, if it already
 * existed, its prior content is untouched).
 *
 * Never buffers the whole file in memory: `pipeline` streams source -> dest.
 */
import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

/**
 * Stream `source` to `destPath` via a same-directory temp file, renamed into
 * place only on success. Rethrows on any failure after best-effort cleaning up
 * the temp file; `destPath` itself is never touched except by that final
 * rename.
 */
export async function writeStreamToDest(source: Readable, destPath: string): Promise<void> {
  const tmpPath = `${destPath}.${randomBytes(8).toString('hex')}.part`;
  try {
    await pipeline(source, createWriteStream(tmpPath));
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
