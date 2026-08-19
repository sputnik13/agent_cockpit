import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import simpleGit from 'simple-git';

const DEFAULT_MAX_BYTES = 1024 * 256; // 256 KiB

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface FileFetchResult {
  content: string | null;
  truncated: boolean;
  isBinary: boolean;
  sizeBytes: number;
}

export async function getFile(
  worktreePath: string,
  filePath: string,
  opts?: { ref?: string; maxBytes?: number },
): Promise<FileFetchResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (opts?.ref) {
    const git = simpleGit({ baseDir: worktreePath });
    const buf = await git.binaryCatFile(['blob', `${opts.ref}:${filePath}`]).catch(() => null);
    if (!buf) return { content: null, truncated: false, isBinary: false, sizeBytes: 0 };
    const isBin = looksBinary(buf);
    const sizeBytes = buf.length;
    if (isBin || sizeBytes > maxBytes) {
      return { content: null, truncated: sizeBytes > maxBytes, isBinary: isBin, sizeBytes };
    }
    return { content: buf.toString('utf8'), truncated: false, isBinary: false, sizeBytes };
  }
  const full = isAbsolute(filePath) ? filePath : join(worktreePath, filePath);
  let st;
  try {
    st = statSync(full);
  } catch {
    return { content: null, truncated: false, isBinary: false, sizeBytes: 0 };
  }
  const sizeBytes = st.size;
  if (sizeBytes > maxBytes) {
    return { content: null, truncated: true, isBinary: false, sizeBytes };
  }
  const buf = readFileSync(full);
  const isBin = looksBinary(buf);
  return {
    content: isBin ? null : buf.toString('utf8'),
    truncated: false,
    isBinary: isBin,
    sizeBytes,
  };
}

export async function getPatch(
  worktreePath: string,
  baseline: string,
  filePath: string,
): Promise<string> {
  const git = simpleGit({ baseDir: worktreePath });
  // Diff vs working tree (no --staged so we cover both index and worktree).
  const patch = await git.diff([baseline, '--', filePath]);
  return patch;
}
