import simpleGit from 'simple-git';

export type BaselineKind = 'HEAD' | 'ref' | 'commit';

export interface ResolvedBaseline {
  selector: string;
  kind: BaselineKind;
  commit: string;
}

export async function resolveBaseline(
  worktreePath: string,
  selector: string | undefined,
): Promise<ResolvedBaseline> {
  const git = simpleGit({ baseDir: worktreePath });
  const sel = selector && selector.length > 0 ? selector : 'HEAD';
  let commit: string;
  try {
    commit = (await git.revparse([sel])).trim();
  } catch (err) {
    throw new Error(`baseline ${sel} could not be resolved: ${(err as Error).message}`);
  }
  const kind: BaselineKind = sel === 'HEAD' ? 'HEAD' : /^[0-9a-f]{4,40}$/.test(sel) ? 'commit' : 'ref';
  return { selector: sel, kind, commit };
}
