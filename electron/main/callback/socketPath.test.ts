import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInjectableEnvValue } from '@shared/callback/protocol';
import {
  CallbackPathError,
  SOCKET_PATH_GUARD_BYTES,
  deriveSocketLocation,
  prepareSocketDir,
  projectHash,
  resolveSocketLocation,
} from './socketPath';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const uid = process.getuid?.() ?? 0;

let base: string;
beforeEach(() => {
  // A literal /tmp keeps the paths short; the unique directory keeps parallel files apart.
  base = mkdtempSync('/tmp/accb-sp-');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function pathError(fn: () => unknown): CallbackPathError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CallbackPathError);
    return err as CallbackPathError;
  }
  throw new Error('expected a CallbackPathError');
}

describe('projectHash (scenario 5)', () => {
  it('is the first 12 hex characters of SHA-256(projectId)', () => {
    // SHA-256("abc") = ba7816bf 8f01cfea 414140de ...
    expect(projectHash('abc')).toBe('ba7816bf8f01');
    const id = 'f3a9c1d2-0b7e-4c55-9a31-5b1e2c8d7e90';
    expect(projectHash(id)).toBe(sha256(id).slice(0, 12));
    expect(projectHash(id)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic and distinguishes projects', () => {
    expect(projectHash('p1')).toBe(projectHash('p1'));
    expect(projectHash('p1')).not.toBe(projectHash('p2'));
  });
});

describe('deriveSocketLocation (scenario 5)', () => {
  const SUFFIX = '/callback/'.length + 12 + '.sock'.length; // 27 bytes after userData

  it('uses <userData>/callback/<h>.sock, accepting spaces in the userData path', () => {
    const userDataDir = '/Users/jo/Library/Application Support/Agent Cockpit';
    const loc = deriveSocketLocation({ userDataDir, projectId: 'p1' });
    expect(loc).toEqual({
      socketPath: `${userDataDir}/callback/${projectHash('p1')}.sock`,
      dir: `${userDataDir}/callback`,
      fallback: false,
    });
  });

  it('resolves a relative userData path against the cwd', () => {
    const relative = deriveSocketLocation({ userDataDir: 'rel/userdata', projectId: 'p1' });
    const absolute = deriveSocketLocation({
      userDataDir: resolve('rel/userdata'),
      projectId: 'p1',
    });
    expect(relative).toEqual(absolute);
    expect(relative.socketPath.startsWith('/')).toBe(true);
  });

  it('keeps a path of exactly the 90-byte guard and falls back one byte over', () => {
    expect(SOCKET_PATH_GUARD_BYTES).toBe(90);
    const at = '/' + 'u'.repeat(SOCKET_PATH_GUARD_BYTES - SUFFIX - 1);
    const atLoc = deriveSocketLocation({ userDataDir: at, projectId: 'p1', tmpRoot: base });
    expect(Buffer.byteLength(atLoc.socketPath)).toBe(SOCKET_PATH_GUARD_BYTES);
    expect(atLoc.fallback).toBe(false);
    const over = deriveSocketLocation({ userDataDir: at + 'u', projectId: 'p1', tmpRoot: base });
    expect(over.fallback).toBe(true);
  });

  it('measures the guard in bytes, not characters', () => {
    // 30 three-byte characters are 90 bytes by themselves.
    const loc = deriveSocketLocation({
      userDataDir: '/' + '日'.repeat(30),
      projectId: 'p1',
      tmpRoot: base,
    });
    expect(loc.fallback).toBe(true);
  });

  it('falls back to /tmp/ac-cb-<uid>/<h>.sock where <h> hashes userData AND projectId', () => {
    const userDataDir =
      '/var/folders/zz/long/profile/path/that/overflows/the/socket/limit/for/sure/agent-cockpit';
    const loc = deriveSocketLocation({ userDataDir, projectId: 'p1', uid: 501 });
    const h = sha256(`${userDataDir}\0p1`).slice(0, 12);
    expect(loc).toEqual({
      socketPath: `/tmp/ac-cb-501/${h}.sock`,
      dir: '/tmp/ac-cb-501',
      fallback: true,
    });
    expect(Buffer.byteLength(loc.socketPath)).toBeLessThan(40);
  });

  it('defaults the fallback to the literal /tmp and the current uid', () => {
    const loc = deriveSocketLocation({ userDataDir: '/' + 'x'.repeat(100), projectId: 'p1' });
    expect(loc.dir).toBe(`/tmp/ac-cb-${uid}`);
  });

  it('never shares a fallback socket between profiles or projects', () => {
    const long = (name: string): string => `/${name}/` + 'x'.repeat(100);
    const a = deriveSocketLocation({
      userDataDir: long('profileA'),
      projectId: 'same',
      tmpRoot: base,
    });
    const b = deriveSocketLocation({
      userDataDir: long('profileB'),
      projectId: 'same',
      tmpRoot: base,
    });
    const c = deriveSocketLocation({
      userDataDir: long('profileA'),
      projectId: 'other',
      tmpRoot: base,
    });
    expect(new Set([a.socketPath, b.socketPath, c.socketPath]).size).toBe(3);
    // ...yet the same profile and project always agree.
    expect(
      deriveSocketLocation({ userDataDir: long('profileA'), projectId: 'same', tmpRoot: base }),
    ).toEqual(a);
  });

  it('disables callback when even the fallback is over the guard', () => {
    const err = pathError(() =>
      deriveSocketLocation({
        userDataDir: '/' + 'x'.repeat(100),
        projectId: 'p1',
        tmpRoot: '/' + 'r'.repeat(80),
      }),
    );
    expect(err.code).toBe('too-long');
  });

  it('falls back to /tmp when the primary path could not be injected (NUL, LF or CR in userData)', () => {
    for (const bad of ['\n', '\r', '\0']) {
      const userDataDir = `/tmp/a${bad}b`; // short: only the character class forces the fallback
      const loc = deriveSocketLocation({ userDataDir, projectId: 'p1', uid: 501, tmpRoot: base });
      expect(loc.fallback).toBe(true);
      expect(loc.dir).toBe(join(base, 'ac-cb-501'));
      expect(isInjectableEnvValue(loc.socketPath)).toBe(true);
      // The hash still takes in the real (hostile) userData path, so profiles stay apart.
      expect(loc.socketPath).toBe(
        join(base, 'ac-cb-501', `${sha256(`${userDataDir}\0p1`).slice(0, 12)}.sock`),
      );
    }
    const a = deriveSocketLocation({ userDataDir: '/tmp/a\nb', projectId: 'p1', tmpRoot: base });
    const b = deriveSocketLocation({ userDataDir: '/tmp/c\nd', projectId: 'p1', tmpRoot: base });
    expect(a.socketPath).not.toBe(b.socketPath);
  });

  it('disables callback only when the fallback cannot be injected either', () => {
    for (const bad of ['\n', '\r', '\0']) {
      const err = pathError(() =>
        deriveSocketLocation({
          userDataDir: `/tmp/a${bad}b`,
          projectId: 'p1',
          tmpRoot: `/tmp/r${bad}t`,
        }),
      );
      expect(err.code).toBe('invalid-value');
    }
  });
});

describe('prepareSocketDir (scenario 5)', () => {
  it('creates the directory 0700, including missing parents, and is idempotent', () => {
    const dir = join(base, 'profile', 'callback');
    prepareSocketDir(dir, uid);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    prepareSocketDir(dir, uid);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('accepts an existing 0700 directory it owns', () => {
    const dir = join(base, 'existing');
    mkdirSync(dir, { mode: 0o700 });
    expect(() => prepareSocketDir(dir, uid)).not.toThrow();
  });

  it('fails closed on a symlink, even one pointing at a safe directory', () => {
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    const err = pathError(() => prepareSocketDir(link, uid));
    expect(err.code).toBe('unsafe-dir');
    expect(err.message).toMatch(/is a symlink/);
  });

  it('fails closed on a non-directory', () => {
    const file = join(base, 'file');
    writeFileSync(file, '');
    expect(pathError(() => prepareSocketDir(file, uid)).code).toBe('dir-error');
  });

  it('fails closed on a directory owned by another user', () => {
    const dir = join(base, 'foreign');
    mkdirSync(dir, { mode: 0o700 });
    const err = pathError(() => prepareSocketDir(dir, uid + 1));
    expect(err.code).toBe('unsafe-dir');
    expect(err.message).toMatch(/owned by uid/);
  });

  it('fails closed on a directory open to group or other', () => {
    const dir = join(base, 'loose');
    mkdirSync(dir, { mode: 0o700 });
    for (const mode of [0o750, 0o705, 0o755, 0o777]) {
      chmodSync(dir, mode);
      const err = pathError(() => prepareSocketDir(dir, uid));
      expect(err.code).toBe('unsafe-dir');
      expect(err.message).toMatch(/must be 700/);
    }
  });
});

describe('resolveSocketLocation (scenario 5)', () => {
  it('derives the primary location and prepares its 0700 directory', () => {
    const loc = resolveSocketLocation({ userDataDir: join(base, 'ud'), projectId: 'p1' });
    expect(loc.fallback).toBe(false);
    expect(statSync(loc.dir).mode & 0o777).toBe(0o700);
  });

  it('prepares the injected fallback directory (never the shared /tmp one) 0700', () => {
    const tmpRoot = join(base, 'tmproot');
    mkdirSync(tmpRoot, { mode: 0o700 });
    const loc = resolveSocketLocation({
      userDataDir: join(base, 'x'.repeat(80)),
      projectId: 'p1',
      tmpRoot,
    });
    expect(loc.fallback).toBe(true);
    expect(loc.dir).toBe(join(tmpRoot, `ac-cb-${uid}`));
    expect(statSync(loc.dir).mode & 0o777).toBe(0o700);
  });

  it('fails closed when the userData callback directory is a symlink', () => {
    const ud = join(base, 'ud');
    mkdirSync(ud);
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(ud, 'callback'));
    expect(pathError(() => resolveSocketLocation({ userDataDir: ud, projectId: 'p1' })).code).toBe(
      'unsafe-dir',
    );
  });
});
