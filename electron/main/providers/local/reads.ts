/**
 * LocalProvider read operations — thin adapters over the retained v1 git/beads
 * services, re-homed behind the WorkspaceProvider read surface. All read-only.
 */
import { statSync, readdirSync } from 'node:fs';
import { join, isAbsolute, resolve as resolveNodePath, relative, sep } from 'node:path';
import type {
  BeadsIssue,
  BeadsTaskGraph,
  Changeset,
  WorktreeRecord,
} from '@shared/ipc/channels';
import type {
  DirEntry,
  FileReadOptions,
  FileReadResult,
  ResolvedPath,
  ResolvePathOptions,
  StatResult,
} from '../types';
import { listWorktrees as gitListWorktrees } from '@main/git/worktrees';
import { computeChangeset } from '@main/git/changeset';
import { getFile, getPatch } from '@main/git/files';
import { discoverBeadsSource } from '@main/beads/source';
import { loadGraph } from '@main/beads/normalize';

export function localListWorktrees(rootPath: string): Promise<WorktreeRecord[]> {
  return gitListWorktrees(rootPath);
}

export function localChangeset(worktreePath: string, baseline?: string): Promise<Changeset> {
  return computeChangeset(worktreePath, baseline);
}

export function localFileDiff(
  worktreePath: string,
  filePath: string,
  baseline = 'HEAD',
): Promise<string> {
  return getPatch(worktreePath, baseline, filePath);
}

export async function localReadFile(
  rootPath: string,
  path: string,
  opts?: FileReadOptions,
): Promise<FileReadResult> {
  const fetchOpts: { ref?: string; maxBytes?: number } = {};
  if (opts?.ref !== undefined) fetchOpts.ref = opts.ref;
  if (opts?.maxBytes !== undefined) fetchOpts.maxBytes = opts.maxBytes;
  // Resolve against the worktree root when supplied; empty/absent = project root.
  const base = opts?.worktreePath || rootPath;
  return getFile(base, path, fetchOpts);
}

export function localListDir(rootPath: string, dirPath: string, worktreePath?: string): DirEntry[] {
  const rel = dirPath === '.' ? '' : dirPath;
  // Resolve against the worktree root when supplied; empty/absent = project root.
  const base = worktreePath || rootPath;
  const abs = isAbsolute(rel) ? rel : join(base, rel);
  const entries = readdirSync(abs, { withFileTypes: true });
  return entries
    .map((e) => ({
      name: e.name,
      path: rel ? `${rel}/${e.name}` : e.name,
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export function localStat(absolutePath: string): StatResult {
  try {
    const s = statSync(absolutePath);
    return {
      exists: true,
      size: s.size,
      isDir: s.isDirectory(),
      mtime: s.mtime.toISOString(),
    };
  } catch {
    return { exists: false, size: 0, isDir: false, mtime: null };
  }
}

/** Strip a `file://` URI down to its filesystem path; pass anything else through. */
function stripFileUri(input: string): string {
  if (!/^file:\/\//i.test(input)) return input;
  try {
    return decodeURIComponent(new URL(input).pathname);
  } catch {
    return input;
  }
}

/** Resolve a clicked link target against the local project root, stat it, and
 *  classify it as inside/outside the project. Absolute and `file://` inputs are
 *  honored as-is; relative inputs resolve against `base` (a directory, absolute
 *  or relative to root) or the project root. */
export function localResolvePath(
  rootPath: string,
  input: string,
  opts?: ResolvePathOptions,
): ResolvedPath {
  const raw = stripFileUri(input.trim());
  const baseDir = opts?.base
    ? isAbsolute(opts.base)
      ? opts.base
      : join(rootPath, opts.base)
    : rootPath;
  const absPath = isAbsolute(raw) ? raw : resolveNodePath(baseDir, raw);
  const st = localStat(absPath);
  const rel = relative(rootPath, absPath);
  const insideProject = !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
  const relPath = insideProject ? (rel === '' ? '.' : rel.split(sep).join('/')) : null;
  return { exists: st.exists, isDir: st.isDir, insideProject, relPath, absPath };
}

export function localDetectBeads(rootPath: string): boolean {
  return discoverBeadsSource(rootPath) !== null;
}

export function localTaskGraph(rootPath: string): BeadsTaskGraph {
  const source = discoverBeadsSource(rootPath);
  if (!source) {
    return { source: { kind: 'jsonl', path: '' }, schemaCompatible: false, issues: [], deps: [] };
  }
  return loadGraph(source);
}

export function localGetTask(rootPath: string, issueId: string): BeadsIssue | null {
  const graph = localTaskGraph(rootPath);
  return graph.issues.find((i) => i.id === issueId) ?? null;
}
