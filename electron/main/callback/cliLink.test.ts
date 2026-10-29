/**
 * The local `cockpit` CLI link (scenario 14, app side): `<userData>/callback/bin/
 * cockpit` points at the host's helper binary from the dist manifest, is created
 * under a verified 0700 directory, replaced atomically, idempotent, and never
 * fails startup.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import {
  createLocalCliLinker,
  ensureLocalCliLink,
  manifestPlatform,
  type LocalCliLinkOptions,
} from './cliLink';
import { localCliPath } from './localEnvironment';

let root: string;
let userData: string;
let dist: string;

beforeEach(() => {
  root = mkdtempSync('/tmp/accl-');
  userData = join(root, 'User Data'); // the default macOS profile path contains spaces
  dist = join(root, 'dist');
  mkdirSync(userData);
  mkdirSync(dist);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const BINARIES = [
  { os: 'linux', arch: 'amd64', filename: 'helper-0.1.0-linux-amd64' },
  { os: 'linux', arch: 'arm64', filename: 'helper-0.1.0-linux-arm64' },
  { os: 'darwin', arch: 'arm64', filename: 'helper-0.1.0-darwin-arm64' },
];

function writeDist(binaries = BINARIES): void {
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify({ version: '0.1.0', binaries }));
  for (const b of binaries) writeFileSync(join(dist, b.filename), `binary ${b.filename}`);
}

const options = (over: Partial<LocalCliLinkOptions> = {}): LocalCliLinkOptions => ({
  userDataDir: userData,
  distDir: dist,
  platform: 'darwin',
  arch: 'arm64',
  ...over,
});

describe('manifestPlatform', () => {
  it('maps Node platform/arch to the manifest tokens (x64 is amd64)', () => {
    expect(manifestPlatform('darwin', 'arm64')).toEqual({ os: 'darwin', arch: 'arm64' });
    expect(manifestPlatform('linux', 'x64')).toEqual({ os: 'linux', arch: 'amd64' });
    expect(manifestPlatform('linux', 'arm64')).toEqual({ os: 'linux', arch: 'arm64' });
    expect(manifestPlatform('win32', 'x64')).toBeNull();
    expect(manifestPlatform('linux', 'ia32')).toBeNull();
  });
});

describe('ensureLocalCliLink', () => {
  it('links <userData>/callback/bin/cockpit to the host build named by the manifest', () => {
    writeDist();
    const result = ensureLocalCliLink(options());
    expect(result).toEqual({
      ok: true,
      link: localCliPath(userData),
      target: join(dist, 'helper-0.1.0-darwin-arm64'),
      changed: true,
    });
    expect(readlinkSync(localCliPath(userData))).toBe(join(dist, 'helper-0.1.0-darwin-arm64'));
    // The injected COCKPIT_CLI is exactly this path (a program named `cockpit`).
    expect(localCliPath(userData)).toMatch(/\/User Data\/callback\/bin\/cockpit$/);
  });

  it('picks the entry for each supported host', () => {
    writeDist();
    for (const [platform, arch, want] of [
      ['linux', 'x64', 'helper-0.1.0-linux-amd64'],
      ['linux', 'arm64', 'helper-0.1.0-linux-arm64'],
      ['darwin', 'arm64', 'helper-0.1.0-darwin-arm64'],
    ] as const) {
      const result = ensureLocalCliLink(options({ platform, arch }));
      expect(result).toMatchObject({ ok: true, target: join(dist, want) });
    }
  });

  it('creates the directories owner-only and verified', () => {
    writeDist();
    ensureLocalCliLink(options());
    for (const dir of [join(userData, 'callback'), join(userData, 'callback', 'bin')]) {
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('is idempotent: an up-to-date link is left untouched', () => {
    writeDist();
    ensureLocalCliLink(options());
    const before = lstatSync(localCliPath(userData));
    const again = ensureLocalCliLink(options());
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(lstatSync(localCliPath(userData)).ino).toBe(before.ino);
  });

  it('re-points a stale link (the app moved or was updated) and leaves no temp link behind', () => {
    writeDist();
    ensureLocalCliLink(options());
    const moved = join(root, 'moved-dist');
    mkdirSync(moved);
    writeFileSync(join(moved, 'manifest.json'), JSON.stringify({ binaries: BINARIES }));
    writeFileSync(join(moved, 'helper-0.1.0-darwin-arm64'), 'new binary');
    const result = ensureLocalCliLink(options({ distDir: moved }));
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      target: join(moved, 'helper-0.1.0-darwin-arm64'),
    });
    expect(readlinkSync(localCliPath(userData))).toBe(join(moved, 'helper-0.1.0-darwin-arm64'));
    const entries = readdirSync(join(userData, 'callback', 'bin'));
    expect(entries).toEqual(['cockpit']);
  });

  it('replaces a link atomically: a concurrent reader never finds the path missing while it flips', async () => {
    writeDist();
    const other = join(root, 'dist-2');
    mkdirSync(other);
    writeFileSync(join(other, 'manifest.json'), JSON.stringify({ binaries: BINARIES }));
    writeFileSync(join(other, 'helper-0.1.0-darwin-arm64'), 'other');
    ensureLocalCliLink(options());

    // A pane running the CLI is another thread of control: read the link in a tight
    // loop on a worker while this thread keeps replacing it.
    const shared = new SharedArrayBuffer(4);
    const stop = new Int32Array(shared);
    const reader = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       const { readlinkSync } = require('node:fs');
       const stop = new Int32Array(workerData.shared);
       let missing = 0, reads = 0;
       while (Atomics.load(stop, 0) === 0) {
         reads += 1;
         try { readlinkSync(workerData.link); } catch { missing += 1; }
       }
       parentPort.postMessage({ missing, reads });`,
      { eval: true, workerData: { shared, link: localCliPath(userData) } },
    );
    const finished = new Promise<{ missing: number; reads: number }>((resolve, reject) => {
      reader.once('message', resolve);
      reader.once('error', reject);
    });
    for (let i = 0; i < 1500; i += 1) {
      ensureLocalCliLink(options({ distDir: i % 2 === 0 ? other : dist }));
    }
    Atomics.store(stop, 0, 1);
    const { missing, reads } = await finished;
    expect(reads).toBeGreaterThan(0);
    expect(missing).toBe(0);
  });

  it('fails clearly, creating nothing, when the dist cannot serve this host', () => {
    // No manifest at all.
    expect(ensureLocalCliLink(options())).toMatchObject({ ok: false, reason: 'no-manifest' });
    // A manifest without the host's entry (for example darwin/amd64, never built).
    writeDist();
    expect(ensureLocalCliLink(options({ platform: 'darwin', arch: 'x64' }))).toMatchObject({
      ok: false,
      reason: 'no-binary',
    });
    // The entry exists but its file does not.
    rmSync(join(dist, 'helper-0.1.0-darwin-arm64'));
    expect(ensureLocalCliLink(options())).toMatchObject({ ok: false, reason: 'no-binary' });
    // An unsupported platform.
    expect(ensureLocalCliLink(options({ platform: 'win32' }))).toMatchObject({
      ok: false,
      reason: 'unsupported-platform',
    });
    expect(() => lstatSync(join(userData, 'callback'))).toThrow();
  });

  it('fails closed on an unsafe directory instead of writing through it', () => {
    writeDist();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(join(userData, 'callback'), { mode: 0o700 });
    symlinkSync(elsewhere, join(userData, 'callback', 'bin')); // bin is a symlink
    expect(ensureLocalCliLink(options())).toMatchObject({ ok: false, reason: 'unsafe-dir' });
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(join(userData, 'callback', 'bin'));
    mkdirSync(join(userData, 'callback', 'bin'));
    chmodSync(join(userData, 'callback', 'bin'), 0o755);
    expect(ensureLocalCliLink(options())).toMatchObject({ ok: false, reason: 'unsafe-dir' });
  });
});

describe('createLocalCliLinker', () => {
  it('links once, logs a change once, and never throws', () => {
    // The linker uses the real platform of the test host; make that entry resolvable.
    const host = manifestPlatform(process.platform, process.arch);
    if (!host) return; // an unsupported test host has nothing to link
    writeDist([{ os: host.os, arch: host.arch, filename: 'helper-host' }]);
    const info = vi.spyOn(logger, 'info');
    const ensure = createLocalCliLinker(() => ({ userDataDir: userData, distDir: dist }));
    ensure();
    ensure();
    ensure();
    expect(readlinkSync(localCliPath(userData))).toBe(join(dist, 'helper-host'));
    const linked = info.mock.calls.filter(([m]) => String(m).startsWith('callback CLI linked'));
    expect(linked).toHaveLength(1);
  });

  it('logs a failure once per distinct reason and never throws, even from a throwing resolver', () => {
    const warn = vi.spyOn(logger, 'warn');
    const ensure = createLocalCliLinker(() => ({
      userDataDir: userData,
      distDir: join(root, 'nope'),
    }));
    expect(() => {
      ensure();
      ensure();
      ensure();
    }).not.toThrow();
    const unavailable = warn.mock.calls.filter(([m]) =>
      String(m).startsWith('callback CLI unavailable'),
    );
    expect(unavailable).toHaveLength(1);
    expect(String(unavailable[0]![0])).toContain('reason=no-manifest');

    const throwing = createLocalCliLinker(() => {
      throw new Error('app.getPath exploded');
    });
    expect(() => throwing()).not.toThrow();
  });
});
