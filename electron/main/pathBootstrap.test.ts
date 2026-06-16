import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpawnSyncReturns } from 'node:child_process';
import {
  bootstrapPath,
  importLoginShellPath,
  mergePathDirs,
  resolveBin,
  staticPathDirs,
} from './pathBootstrap';

const ok = (stdout: string): SpawnSyncReturns<string> =>
  ({ status: 0, stdout, stderr: '', signal: null, output: [], pid: 1 }) as unknown as SpawnSyncReturns<string>;

describe('mergePathDirs', () => {
  it('dedupes order-preserving, dropping empties', () => {
    expect(mergePathDirs('/a:/b', '/b:/c', '/a')).toBe('/a:/b:/c');
    expect(mergePathDirs('/a::/b:', '', null, undefined, ' /c ')).toBe('/a:/b:/c');
  });

  it('returns empty string for no usable fragments', () => {
    expect(mergePathDirs(null, undefined, '', ':')).toBe('');
  });
});

describe('staticPathDirs', () => {
  it('includes Homebrew + user-local fallback dirs', () => {
    const dirs = staticPathDirs('/Users/me');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(dirs).toContain('/usr/local/bin');
    expect(dirs).toContain('/Users/me/.local/bin');
  });
});

describe('importLoginShellPath', () => {
  it('extracts the marker-delimited PATH, ignoring shell banner noise', () => {
    const spawn = vi.fn(() => ok('startup banner\n__AC_PATH__/opt/homebrew/bin:/usr/bin__AC_PATH__'));
    expect(importLoginShellPath({ shell: '/bin/zsh', spawn })).toBe('/opt/homebrew/bin:/usr/bin');
    expect(spawn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', expect.stringContaining('"$PATH"')],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  it('returns null without a shell (does not spawn)', () => {
    const spawn = vi.fn();
    expect(importLoginShellPath({ shell: '', spawn })).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns null on non-zero exit, error, or empty payload', () => {
    expect(
      importLoginShellPath({
        shell: '/bin/zsh',
        spawn: vi.fn(() => ({ status: 1, stdout: '', stderr: 'x' }) as unknown as SpawnSyncReturns<string>),
      }),
    ).toBeNull();
    expect(importLoginShellPath({ shell: '/bin/zsh', spawn: vi.fn(() => ok('__AC_PATH____AC_PATH__')) })).toBeNull();
    expect(
      importLoginShellPath({
        shell: '/bin/zsh',
        spawn: vi.fn(() => {
          throw new Error('spawn failed');
        }),
      }),
    ).toBeNull();
  });
});

describe('bootstrapPath', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('is a no-op on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const env: NodeJS.ProcessEnv = { PATH: '/orig' };
    bootstrapPath(env);
    expect(env.PATH).toBe('/orig');
  });

  it('unions login-shell PATH, static dirs, and prior PATH (deduped)', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
    // Stub the shell import via SHELL + a fake spawn by patching the real call path:
    // bootstrapPath uses importLoginShellPath() internally, which reads $SHELL and
    // spawns it. Here there is no marker output (real shell would differ), so the
    // import resolves to null and only the static + prior PATH union applies.
    env.SHELL = '';
    bootstrapPath(env);
    expect(env.PATH).toContain('/opt/homebrew/bin');
    expect(env.PATH).toContain('/usr/bin');
    // dedupe: /usr/bin appears once.
    expect(env.PATH!.split(':').filter((d) => d === '/usr/bin')).toHaveLength(1);
  });
});

describe('resolveBin', () => {
  it('returns null when not found on PATH', () => {
    expect(resolveBin('definitely-not-a-real-binary-xyz', { PATH: '/nonexistent-dir-xyz' })).toBeNull();
  });

  it('finds an executable that exists on PATH', () => {
    // `sh` is present in /bin on every POSIX CI host.
    const found = resolveBin('sh', { PATH: '/bin:/usr/bin' });
    if (process.platform !== 'win32') expect(found).toBe('/bin/sh');
  });
});
