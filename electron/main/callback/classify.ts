/**
 * Path classification for an `open` request (requirement 14): turn the absolute
 * path a terminal sent into the content selection the renderer opens.
 *
 * The CLI runs on the provider's host and sends the logical absolute path plus
 * its canonical form (symlink-resolved PARENT directory joined with the base
 * name, so a symlinked file inside a worktree is not misclassified as
 * external). Main matches the canonical path against the canonical worktree
 * roots from `listWorktrees` (plus the project root) and builds the selection
 * from the worktree path plus the relative path: the same inputs the Explorer
 * uses, so the tab id (the fully-qualified path) equals the Explorer's for the
 * same file. A path outside every worktree becomes an `external-file` with the
 * LOGICAL path. A selection never carries a `baseline`: a plain file open must
 * not force a git-ref read, which falsely reports an untracked file as missing.
 *
 * When the CLI could not canonicalize (it then sends only the logical path) and
 * the LOCAL project root is itself a symlink, a logical path under the configured
 * root is rewritten to that root's realpath, which main already computes, and the
 * worktree match is retried: git reports worktree roots in canonical form, and the
 * Explorer reads from that path, so without the retry the same file would get a
 * second tab.
 *
 * No remote realpath and no `resolvePath`/`stat`: a symlinked remote
 * `remotePath` cannot be canonicalized without a realpath RPC, so such a path is
 * classified as external on remote (a documented limitation).
 */
import { posix } from 'node:path';
import type { CallbackOpenSelection, OpenArgs } from '@shared/callback/protocol';
import type { WorkspaceProvider } from '../providers/types';

export interface ClassifyInput {
  /** Logical absolute path, as the CLI sent it. */
  path: string;
  /** Canonical absolute path, when the CLI could compute one. */
  canonicalPath?: string;
  /** Worktree roots exactly as the provider reported them (git reports canonical roots). */
  worktrees: readonly string[];
  /** Project root candidates: the configured root, plus its canonical form where main can compute one. */
  projectRoots: readonly string[];
  /** Local only, and only when the configured root is a symlink: the configured root and its
   *  realpath. Lets a logical path be rewritten to canonical form when the CLI sent none. */
  rootAlias?: { configured: string; canonical: string };
}

function clean(path: string): string {
  const normalized = posix.normalize(path);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/** `subject` relative to `root` when it is strictly inside it, else null. */
function relativeInside(root: string, subject: string): string | null {
  const base = clean(root);
  const prefix = base === '/' ? '/' : `${base}/`;
  return subject.length > prefix.length && subject.startsWith(prefix)
    ? subject.slice(prefix.length)
    : null;
}

/** The deepest worktree containing `subject` (a linked worktree can live inside the primary one). */
function deepestWorktree(
  worktrees: readonly string[],
  subject: string,
): { worktree: string; rel: string } | null {
  let best: { worktree: string; rel: string } | null = null;
  for (const worktree of worktrees) {
    const rel = relativeInside(worktree, subject);
    if (rel !== null && (best === null || clean(worktree).length > clean(best.worktree).length)) {
      best = { worktree, rel };
    }
  }
  return best;
}

/** `logical` with the configured-root prefix rewritten to the root's realpath, if it is under it. */
function viaRootAlias(logical: string, alias: ClassifyInput['rootAlias']): string[] {
  if (!alias) return [];
  const rel = relativeInside(alias.configured, logical);
  return rel === null ? [] : [clean(posix.join(alias.canonical, rel))];
}

export function classifyOpenTarget(input: ClassifyInput): CallbackOpenSelection {
  const logical = clean(input.path);
  // What to match against the worktree roots, best first: the canonical form when the
  // CLI sent one; otherwise the logical path, then (the retry) its rewrite through the
  // configured root's realpath.
  const subjects =
    input.canonicalPath !== undefined
      ? [clean(input.canonicalPath)]
      : [logical, ...viaRootAlias(logical, input.rootAlias)];

  for (const subject of subjects) {
    const hit = deepestWorktree(input.worktrees, subject);
    if (hit) return { kind: 'file', path: hit.rel, worktreePath: hit.worktree };
  }

  // No worktree matched (a non-git folder): relative to the project root, with
  // worktreePath '' exactly as the Explorer builds it.
  for (const root of input.projectRoots) {
    const rel = relativeInside(root, subjects[0]!);
    if (rel !== null) return { kind: 'file', path: rel, worktreePath: '' };
  }

  return { kind: 'external-file', path: logical, worktreePath: '' };
}

export interface OpenTargetDeps {
  provider: Pick<WorkspaceProvider, 'kind' | 'listWorktrees'>;
  /** The project root as configured (local `rootPath`, remote `remotePath`). */
  projectRoot: string;
  /** Canonicalize a path on this host. Called for LOCAL projects only. */
  realpath: (path: string) => Promise<string>;
}

/** Gather the provider's worktree roots and classify `args`. */
export async function resolveOpenSelection(
  deps: OpenTargetDeps,
  args: OpenArgs,
): Promise<CallbackOpenSelection> {
  let worktrees: string[] = [];
  try {
    worktrees = (await deps.provider.listWorktrees()).map((w) => w.path);
  } catch {
    // Not a git repository: classify against the project root alone, exactly as
    // the renderer's worktree store treats a failed listing (an empty list).
  }
  const projectRoots = [deps.projectRoot];
  let rootAlias: ClassifyInput['rootAlias'];
  if (deps.provider.kind === 'local') {
    try {
      const real = await deps.realpath(deps.projectRoot);
      if (real !== deps.projectRoot) {
        projectRoots.push(real);
        rootAlias = { configured: deps.projectRoot, canonical: real };
      }
    } catch {
      // An unresolvable root still matches in its configured form.
    }
  }
  return classifyOpenTarget({
    path: args.path,
    ...(args.canonicalPath !== undefined ? { canonicalPath: args.canonicalPath } : {}),
    worktrees,
    projectRoots,
    ...(rootAlias ? { rootAlias } : {}),
  });
}
