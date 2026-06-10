/**
 * Builds a chokidar `ignored` predicate that honors a worktree's root
 * `.gitignore` (plus always-ignored `node_modules`). Without this, the recursive
 * worktree watchers walk gitignored data trees and open a per-file watch on every
 * entry — on a large project (e.g. an asset/`data` directory with tens of
 * thousands of files) that exhausts file descriptors and the main process loops
 * on `EMFILE: too many open files`.
 *
 * Only the root `.gitignore` is loaded (the common case for the heavy directories
 * that trigger EMFILE); nested `.gitignore` files are not yet honored. `.git`
 * handling is intentionally left to each watcher, which has its own rules for
 * which `.git` paths to keep watching.
 */
import { readFileSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** Always pruned regardless of `.gitignore` (cheap guard for the universal case
 *  where a repo's `.gitignore` somehow omits it). */
const ALWAYS = ['node_modules'];

/**
 * Returns a predicate suitable for chokidar's `ignored` option. `root` is the
 * worktree root the watcher was started on. The predicate accepts the path
 * chokidar passes (absolute, or relative to its `cwd`) and reports whether it is
 * gitignored. A missing/unreadable `.gitignore` degrades to {@link ALWAYS} only.
 */
export function createGitignoreFilter(root: string): (path: string, stats?: Stats) => boolean {
  const ig: Ignore = ignore().add(ALWAYS);
  try {
    ig.add(readFileSync(join(root, '.gitignore'), 'utf8'));
  } catch {
    /* no readable .gitignore — only ALWAYS applies */
  }
  return (path: string, stats?: Stats): boolean => {
    const abs = isAbsolute(path) ? path : join(root, path);
    let rel = relative(root, abs);
    // The root itself, or anything outside it, is never ignored here.
    if (rel === '' || rel.startsWith('..')) return false;
    // `ignore` expects POSIX-separated, root-relative paths.
    if (sep === '\\') rel = rel.split(sep).join('/');
    if (ig.ignores(rel)) return true;
    // A directory-only pattern (`data/`) matches `data/` but not bare `data`.
    // When chokidar tells us this entry is a directory, test the dir form too
    // so the whole subtree is pruned without descending into it.
    return stats?.isDirectory() === true && ig.ignores(`${rel}/`);
  };
}
