import simpleGit from 'simple-git';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Changeset, FileChange, FileChangeStatus } from '@shared/ipc/channels';
import { resolveBaseline } from './baseline';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.ico',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.so', '.dylib', '.dll', '.exe', '.o', '.a', '.bin',
]);

const GENERATED_PATTERNS = [
  /\bnode_modules\b/, /\bdist\b/, /\bbuild\b/, /\bout\b/, /\b\.next\b/, /\b\.vite\b/,
  /\bpackage-lock\.json$/, /\bpnpm-lock\.yaml$/, /\byarn\.lock$/,
];

function classifyBinary(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function classifyGenerated(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

function sizeBytes(worktreePath: string, file: string): number | null {
  try {
    return statSync(join(worktreePath, file)).size;
  } catch {
    return null;
  }
}

export async function computeChangeset(
  worktreePath: string,
  selector?: string,
): Promise<Changeset> {
  const baseline = await resolveBaseline(worktreePath, selector);
  const git = simpleGit({ baseDir: worktreePath });

  // Diff index+working tree vs baseline commit
  const diffSummary = await git.diffSummary([baseline.commit]);
  const files = new Map<string, FileChange>();

  for (const f of diffSummary.files) {
    const newPath = f.file;
    const isBinary = ('binary' in f && f.binary) || classifyBinary(newPath);
    const status: FileChangeStatus = inferStatusFromDiffFile(f.file, diffSummary);
    files.set(newPath, {
      status,
      oldPath: null,
      newPath,
      isBinary,
      isGenerated: classifyGenerated(newPath),
      sizeBytes: sizeBytes(worktreePath, newPath),
      staged: false,
    });
  }

  // Untracked + ignored from porcelain status
  const status = await git.status();
  for (const file of status.not_added) {
    if (!files.has(file)) {
      files.set(file, {
        status: 'untracked',
        oldPath: null,
        newPath: file,
        isBinary: classifyBinary(file),
        isGenerated: classifyGenerated(file),
        sizeBytes: sizeBytes(worktreePath, file),
        staged: false,
      });
    }
  }
  for (const file of status.conflicted) {
    files.set(file, {
      status: 'conflicted',
      oldPath: null,
      newPath: file,
      isBinary: classifyBinary(file),
      isGenerated: classifyGenerated(file),
      sizeBytes: sizeBytes(worktreePath, file),
      staged: false,
    });
  }
  for (const item of status.renamed) {
    const newPath = item.to;
    files.set(newPath, {
      status: 'renamed',
      oldPath: item.from,
      newPath,
      isBinary: classifyBinary(newPath),
      isGenerated: classifyGenerated(newPath),
      sizeBytes: sizeBytes(worktreePath, newPath),
      staged: false,
    });
  }
  for (const f of status.staged) {
    const existing = files.get(f);
    if (existing) existing.staged = true;
  }

  const out: Changeset = {
    worktree: worktreePath,
    baseline: baseline.commit,
    baselineKind: baseline.kind,
    files: Array.from(files.values()).sort((a, b) => a.newPath.localeCompare(b.newPath)),
    generatedAt: new Date().toISOString(),
  };
  return out;
}

function inferStatusFromDiffFile(
  _path: string,
  _summary: Awaited<ReturnType<ReturnType<typeof simpleGit>['diffSummary']>>,
): FileChangeStatus {
  // simple-git diff summary does not carry status flags reliably in one field;
  // git porcelain status is the authority for fine-grained classification.
  // Default to 'modified'; status pass will overwrite for untracked/renamed/etc.
  return 'modified';
}
