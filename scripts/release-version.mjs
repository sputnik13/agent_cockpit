// Prints the app version for electron-builder (`-c.extraMetadata.version`).
//
// Source of truth is the `vX.Y.Z` release tag (the one publish-to-github puts on
// each public/github release commit): the tag reachable from HEAD if there is
// one, else the highest `vX.Y.Z` tag in the repo. Tags are shared refs across
// git worktrees, so the tag created on the public commit is found even when
// packaging from `main` (where it is not an ancestor). Falls back to the
// package.json version when no release tag exists yet.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Strict semver release tag, e.g. v0.1.0 (no pre-release/build suffix). */
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;

function git(args) {
  try {
    // stderr ignored: `git describe` with no matching tag exits non-zero and
    // prints "fatal: No names found" — expected, handled by the empty return.
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function tagVersion() {
  // Prefer the release tag reachable from HEAD (accurate for the built commit).
  const reachable = TAG_RE.exec(
    git(['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--abbrev=0']),
  );
  if (reachable) return reachable[1];
  // Else the highest release tag anywhere in the repo (e.g. on the public commit).
  for (const t of git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname']).split('\n')) {
    const m = TAG_RE.exec(t.trim());
    if (m) return m[1];
  }
  return '';
}

function pkgVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
}

process.stdout.write(tagVersion() || pkgVersion());
