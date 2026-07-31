/**
 * localReadFileBytes — the local byte source for the bounded binary-preview
 * read primitive (`WorkspaceProvider.readFileBytes`). Resolves `path` against
 * the worktree root (or the project root) exactly like `localReadFile`/
 * `localStat`, stats FIRST, and refuses (metadata only, no bytes) when the
 * path is missing, a directory, or over `FILE_BYTES_CAP` — it never truncates
 * a prefix. See the `WorkspaceProvider.readFileBytes` doc comment
 * (src/shared/providers/types.ts) for the full name/cap/no-range/`ref`
 * rationale.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { FILE_BYTES_CAP } from '@shared/providers/fileBytesCap';
import type { FileBytesResult } from '../types';
import { localStat } from './reads';

export async function localReadFileBytes(
  rootPath: string,
  path: string,
  opts?: { worktreePath?: string },
): Promise<FileBytesResult> {
  // Resolve against the worktree root when supplied; empty/absent = project
  // root (mirrors localReadFile/localExportFile's base resolution).
  const base = opts?.worktreePath || rootPath;
  const abs = isAbsolute(path) ? path : join(base, path);
  // localStat (not LocalProvider.stat(), which is root-anchored only) so a
  // linked-worktree-only path resolves correctly.
  const st = localStat(abs);
  if (!st.exists) return { bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' };
  if (st.isDir) return { bytesBase64: null, sizeBytes: st.size, exists: true, reason: 'is-dir' };
  if (st.size > FILE_BYTES_CAP) {
    return { bytesBase64: null, sizeBytes: st.size, exists: true, reason: 'too-large' };
  }
  const buf = await readFile(abs);
  return { bytesBase64: buf.toString('base64'), sizeBytes: st.size, exists: true, reason: null };
}
