/**
 * localExportFile — the local byte source for the Download capability (D1).
 * Resolves `path` against the worktree root (or the project root) exactly
 * like `localReadFile`/`localStat`, then streams the raw file bytes to
 * `destAbsPath` via the shared D5 writer. Unlike `localReadFile` there is no
 * preview cap and no binary sniffing — every byte moves unconditionally,
 * which is the whole reason Download bypasses `readFile`/`getFile` (see the
 * issue's Contract for why that read path is not the byte source here).
 */
import { createReadStream } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { writeStreamToDest } from '../exportWrite';

export async function localExportFile(
  rootPath: string,
  path: string,
  destAbsPath: string,
  opts?: { worktreePath?: string },
): Promise<void> {
  // Resolve against the worktree root when supplied; empty/absent = project
  // root (mirrors localReadFile's base resolution).
  const base = opts?.worktreePath || rootPath;
  const abs = isAbsolute(path) ? path : join(base, path);
  await writeStreamToDest(createReadStream(abs), destAbsPath);
}
