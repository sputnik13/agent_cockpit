/**
 * localReadFileBytes — the local byte source for the bounded binary-preview
 * read primitive (`WorkspaceProvider.readFileBytes`). Two byte sources,
 * selected by `opts.ref`:
 *
 *  - No `ref` (default): resolves `path` against the worktree root (or the
 *    project root) exactly like `localReadFile`/`localStat`, stats FIRST, and
 *    refuses (metadata only, no bytes) when the path is missing, a directory,
 *    or over `FILE_BYTES_CAP` — it never truncates a prefix.
 *  - `ref` set (local_repo_explorer-bn8a): reads the blob AT that git ref via
 *    `simpleGit.binaryCatFile` — the SAME plumbing `getFile`'s text-preview
 *    ref branch already uses (electron/main/git/files.ts) — so no new git
 *    shell-out is introduced. There is no filesystem inode to stat, so the
 *    cap is checked AFTER the read (mirrors `getFile`'s existing ref branch
 *    shape) but still refuses-never-truncates, matching this primitive's
 *    contract. Any `binaryCatFile` failure (bad ref, path absent at that ref,
 *    ...) is treated uniformly as "missing" — the same simplification
 *    `getFile`'s ref branch already makes.
 *
 * See the `WorkspaceProvider.readFileBytes` doc comment
 * (src/shared/providers/types.ts) for the full name/cap/no-range/`ref`
 * rationale.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import simpleGit from 'simple-git';
import { FILE_BYTES_CAP } from '@shared/providers/fileBytesCap';
import type { FileBytesResult } from '../types';
import { localStat } from './reads';

export async function localReadFileBytes(
  rootPath: string,
  path: string,
  opts?: { worktreePath?: string; ref?: string },
): Promise<FileBytesResult> {
  // Resolve against the worktree root when supplied; empty/absent = project
  // root (mirrors localReadFile/localExportFile's base resolution). Also the
  // git context (cwd) a `ref` read below resolves against, so a linked
  // worktree on another branch reads that branch's ref.
  const base = opts?.worktreePath || rootPath;

  if (opts?.ref) {
    // Git-object read: `path` is used verbatim in the pathspec (repo-relative,
    // POSIX), exactly like getFile's ref branch — callers (ImageCompare via
    // useImageBytes) always pass a repo-relative selection path, never an
    // absolute filesystem path.
    const git = simpleGit({ baseDir: base });
    const buf = await git.binaryCatFile(['blob', `${opts.ref}:${path}`]).catch(() => null);
    if (!buf) return { bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' };
    if (buf.length > FILE_BYTES_CAP) {
      return { bytesBase64: null, sizeBytes: buf.length, exists: true, reason: 'too-large' };
    }
    return { bytesBase64: buf.toString('base64'), sizeBytes: buf.length, exists: true, reason: null };
  }

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
