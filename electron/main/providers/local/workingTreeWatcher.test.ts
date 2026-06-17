import { describe, expect, it, vi } from 'vitest';
import { createWorkingTreeWatcher, hasNativeRecursiveWatch } from './workingTreeWatcher';

describe('hasNativeRecursiveWatch', () => {
  it('is true only where the OS has a single-handle recursive watch', () => {
    expect(hasNativeRecursiveWatch('darwin')).toBe(true);
    expect(hasNativeRecursiveWatch('win32')).toBe(true);
    expect(hasNativeRecursiveWatch('linux')).toBe(false);
  });
});

/** A fake `node:fs` watch: captures the change callback so tests can drive it. */
function fakeFsWatch() {
  const calls: Array<{ path: string; opts: unknown }> = [];
  let cb: (event: string, filename: string | null) => void = () => {};
  const handle = { on: vi.fn(), close: vi.fn() };
  const fn = vi.fn((path: string, opts: unknown, listener: typeof cb) => {
    calls.push({ path, opts });
    cb = listener;
    return handle;
  });
  return { fn, handle, calls, fire: (f: string | null) => cb('change', f) };
}

/** A fake chokidar watch: captures the 'all' handler. */
function fakeChokidar() {
  const calls: Array<{ globs: unknown; opts: { ignored?: (p: string) => boolean } }> = [];
  let all: (event: string, p: string) => void = () => {};
  const handle = {
    on: vi.fn((evt: string, h: typeof all) => {
      if (evt === 'all') all = h;
      return handle;
    }),
    close: vi.fn(async () => {}),
  };
  const fn = vi.fn((globs: unknown, opts: { ignored?: (p: string) => boolean }) => {
    calls.push({ globs, opts });
    return handle;
  });
  return { fn, handle, calls, fire: (p: string) => all('add', p) };
}

describe('createWorkingTreeWatcher — native path (darwin/win32)', () => {
  it('opens ONE recursive fs.watch and feeds filtered, non-null paths', () => {
    const fs = fakeFsWatch();
    const onPath = vi.fn();
    createWorkingTreeWatcher({
      rootPath: '/repo',
      shouldIgnore: (p) => p.startsWith('node_modules/') || p.startsWith('.git/'),
      onPath,
      platform: 'darwin',
      fsWatchFn: fs.fn as never,
    });

    expect(fs.fn).toHaveBeenCalledTimes(1);
    expect(fs.calls[0]!.path).toBe('/repo');
    expect(fs.calls[0]!.opts).toMatchObject({ recursive: true, persistent: true });

    fs.fire('src/app.ts'); // allowed
    fs.fire('node_modules/x/index.js'); // ignored
    fs.fire('.git/HEAD'); // ignored (dedicated watcher owns it)
    fs.fire(null); // no filename — dropped

    expect(onPath.mock.calls.map((c) => c[0])).toEqual(['src/app.ts']);
  });

  it('does not use chokidar on the native path, and close() closes the handle', async () => {
    const fs = fakeFsWatch();
    const chok = fakeChokidar();
    const w = createWorkingTreeWatcher({
      rootPath: '/repo',
      shouldIgnore: () => false,
      onPath: vi.fn(),
      platform: 'win32',
      fsWatchFn: fs.fn as never,
      chokidarWatchFn: chok.fn as never,
    });
    expect(chok.fn).not.toHaveBeenCalled();
    await w.close();
    expect(fs.handle.close).toHaveBeenCalledTimes(1);
  });
});

describe('createWorkingTreeWatcher — Linux fallback', () => {
  it('uses chokidar.watch(["."]) with cwd/ignoreInitial/ignored and forwards events', async () => {
    const chok = fakeChokidar();
    const fs = fakeFsWatch();
    const onPath = vi.fn();
    const shouldIgnore = (p: string) => p === 'dist/out.js';
    const w = createWorkingTreeWatcher({
      rootPath: '/repo',
      shouldIgnore,
      onPath,
      platform: 'linux',
      fsWatchFn: fs.fn as never,
      chokidarWatchFn: chok.fn as never,
    });

    expect(fs.fn).not.toHaveBeenCalled();
    expect(chok.fn).toHaveBeenCalledTimes(1);
    expect(chok.calls[0]!.globs).toEqual(['.']);
    expect(chok.calls[0]!.opts).toMatchObject({ cwd: '/repo', ignoreInitial: true });
    // `ignored` delegates to shouldIgnore (chokidar prunes the descent with it).
    const ignored = chok.calls[0]!.opts.ignored!;
    expect(ignored('dist/out.js')).toBe(true);
    expect(ignored('src/app.ts')).toBe(false);

    chok.fire('src/app.ts');
    expect(onPath).toHaveBeenCalledWith('src/app.ts');

    await w.close();
    expect(chok.handle.close).toHaveBeenCalledTimes(1);
  });
});
