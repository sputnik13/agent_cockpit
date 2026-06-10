import { describe, expect, it } from 'vitest';
import {
  BEADS_SIGNALS,
  DIRECTORY_GRANULARITY,
  GIT_STATE_SIGNALS,
  NEVER_RECURSE,
  WATCH_DEBOUNCE_MS,
  classifyWatchPath,
  deriveWatchSpec,
  isHiddenFromChanges,
} from './policy';

describe('classifyWatchPath', () => {
  it('classifies ordinary files as working-tree', () => {
    expect(classifyWatchPath('src/index.ts')).toBe('working-tree');
    expect(classifyWatchPath('README.md')).toBe('working-tree');
    expect(classifyWatchPath('a/b/c.txt')).toBe('working-tree');
  });

  it('classifies git-state signals', () => {
    expect(classifyWatchPath('.git/HEAD')).toBe('git-state');
    expect(classifyWatchPath('.git/packed-refs')).toBe('git-state');
    expect(classifyWatchPath('.git/refs/heads/main')).toBe('git-state');
    expect(classifyWatchPath('.git/refs/tags/v1')).toBe('git-state');
    expect(classifyWatchPath('.git/refs/heads/feature/x')).toBe('git-state');
  });

  it('drops non-signal .git churn', () => {
    expect(classifyWatchPath('.git/index')).toBeNull();
    expect(classifyWatchPath('.git/COMMIT_EDITMSG')).toBeNull();
    expect(classifyWatchPath('.git/FETCH_HEAD')).toBeNull();
    expect(classifyWatchPath('.git/logs/HEAD')).toBeNull();
  });

  it('classifies beads committed-write signals', () => {
    expect(classifyWatchPath('.beads/beads.db')).toBe('beads');
    expect(classifyWatchPath('.beads/issues.jsonl')).toBe('beads');
  });

  it('drops beads WAL/shm/lock and non-signal beads churn (self-feed suppression)', () => {
    expect(classifyWatchPath('.beads/beads.db-wal')).toBeNull();
    expect(classifyWatchPath('.beads/beads.db-shm')).toBeNull();
    expect(classifyWatchPath('.beads/beads.db.lock')).toBeNull();
    expect(classifyWatchPath('.beads/config.yaml')).toBeNull();
    expect(classifyWatchPath('.beads/.br_history/x')).toBeNull();
  });

  it('drops never-recurse trees at any depth', () => {
    expect(classifyWatchPath('node_modules/foo/index.js')).toBeNull();
    expect(classifyWatchPath('packages/app/node_modules/dep/x.js')).toBeNull();
  });

  it('normalizes leading ./, leading /, and backslashes', () => {
    expect(classifyWatchPath('./src/a.ts')).toBe('working-tree');
    expect(classifyWatchPath('/.git/HEAD')).toBe('git-state');
    expect(classifyWatchPath('.git\\refs\\heads\\main')).toBe('git-state');
    expect(classifyWatchPath('')).toBeNull();
  });
});

describe('isHiddenFromChanges', () => {
  it('hides .git and .beads entries by default', () => {
    expect(isHiddenFromChanges('.beads/issues.jsonl', { showAll: false })).toBe(true);
    expect(isHiddenFromChanges('.git/HEAD', { showAll: false })).toBe(true);
  });

  it('does not hide ordinary working-tree files', () => {
    expect(isHiddenFromChanges('src/index.ts', { showAll: false })).toBe(false);
  });

  it('hides nothing when showAll is set', () => {
    expect(isHiddenFromChanges('.beads/issues.jsonl', { showAll: true })).toBe(false);
    expect(isHiddenFromChanges('.git/HEAD', { showAll: true })).toBe(false);
  });
});

describe('deriveWatchSpec', () => {
  it('projects the policy constants into a serializable spec', () => {
    const spec = deriveWatchSpec();
    expect(spec.neverRecurse).toEqual([...NEVER_RECURSE]);
    expect(spec.directoryGranularity).toEqual([...DIRECTORY_GRANULARITY]);
    expect(spec.gitStateSignals).toEqual([...GIT_STATE_SIGNALS]);
    expect(spec.beadsSignals).toEqual([...BEADS_SIGNALS]);
    expect(spec.debounceMs).toBe(WATCH_DEBOUNCE_MS);
  });

  it('returns fresh copies (callers cannot mutate policy constants)', () => {
    const spec = deriveWatchSpec();
    spec.neverRecurse.push('mutated');
    expect(deriveWatchSpec().neverRecurse).toEqual([...NEVER_RECURSE]);
  });
});
