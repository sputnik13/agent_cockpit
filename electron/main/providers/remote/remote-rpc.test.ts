/**
 * Unit tests for the remote helper RPC framing codec, response-by-id
 * correlation, server-push watch dispatch (br h7a.7.3 client side), and the
 * gitStatus -> FileChangeStatus mapping / Changeset assembly.
 *
 * These exercise the protocol in isolation over an in-memory duplex stream;
 * upload/launch (helper.ts) and tmux terminal (tmux.ts) integration require a
 * live SSH host and a built helper binary and are deferred to the integration
 * phase.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  FrameDecoder,
  HelperRpcClient,
  encodeFrame,
  type RpcStream,
} from './rpcClient';
import { assembleChangeset, mapGitStatus } from './index';
import { deriveWatchSpec } from '@shared/watch/policy';

/**
 * A fake helper: client.stdin -> serverIn; serverOut -> client.stdout. A
 * provided responder turns each decoded client request into reply frames
 * written back to the client.
 */
function fakeHelper(
  respond: (req: { id: number; method: string; params: Record<string, unknown> }) => unknown,
): { stream: RpcStream; pushEvent: (event: string, data: unknown) => void } {
  const toClient = new PassThrough(); // client reads here (stdout)
  const toServer = new PassThrough(); // client writes here (stdin)
  const decoder = new FrameDecoder();

  toServer.on('data', (chunk: Buffer) => {
    for (const msg of decoder.push(chunk)) {
      const req = msg as { id: number; method: string; params: Record<string, unknown> };
      const result = respond(req);
      toClient.write(encodeFrame({ id: req.id, result, error: null }));
    }
  });

  return {
    stream: { stdin: toServer, stdout: toClient },
    pushEvent: (event, data) => toClient.write(encodeFrame({ event, data })),
  };
}

describe('frame codec', () => {
  it('round-trips a payload through encode -> FrameDecoder', () => {
    const payload = { id: 7, method: 'stat', params: { path: '/x' } };
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(payload));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(payload);
  });

  it('reassembles a frame split across multiple chunks', () => {
    const frame = encodeFrame({ id: 1, method: 'handshake', params: {} });
    const decoder = new FrameDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toHaveLength(0);
    expect(decoder.push(frame.subarray(2, 6))).toHaveLength(0);
    const out = decoder.push(frame.subarray(6));
    expect(out).toHaveLength(1);
  });

  it('decodes multiple frames delivered in one chunk', () => {
    const a = encodeFrame({ id: 1, result: 'a', error: null });
    const b = encodeFrame({ id: 2, result: 'b', error: null });
    const decoder = new FrameDecoder();
    const out = decoder.push(Buffer.concat([a, b]));
    expect(out).toHaveLength(2);
  });

  it('reassembles a large frame fed one byte at a time (single-concat path)', () => {
    // A large body arriving as many tiny chunks is the case the chunk-array
    // (concat-once-per-frame) decoder is designed for. It must still yield the
    // exact payload, and only on the final byte.
    const payload = { id: 9, result: { content: 'x'.repeat(50_000) }, error: null };
    const frame = encodeFrame(payload);
    const decoder = new FrameDecoder();
    let decoded: unknown[] = [];
    for (let i = 0; i < frame.length; i += 1) {
      const out = decoder.push(frame.subarray(i, i + 1));
      if (i < frame.length - 1) expect(out).toHaveLength(0);
      else decoded = out;
    }
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(payload);
  });
});

describe('HelperRpcClient correlation', () => {
  it('correlates responses to requests by id', async () => {
    const { stream } = fakeHelper((req) => {
      if (req.method === 'stat') return { exists: true, size: 42, isDir: false, mtime: 'now' };
      if (req.method === 'readFile') return { content: 'hello', truncated: false };
      return null;
    });
    const client = new HelperRpcClient(stream);
    // Issue concurrently; ids must keep the two replies distinct.
    const [stat, file] = await Promise.all([
      client.stat('/a'),
      client.readFile('/b'),
    ]);
    expect(stat).toEqual({ exists: true, size: 42, isDir: false, mtime: 'now' });
    expect(file).toEqual({ content: 'hello', truncated: false });
  });

  it('readFile forwards ref + cwd params for a git-ref read (and omits them otherwise)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'readFile') {
        seen.push(req.params);
        return { content: 'at-ref', truncated: false };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    await client.readFile('src/a.ts', { ref: 'HEAD', cwd: '/repo' });
    await client.readFile('/repo/src/a.ts');
    expect(seen[0]).toMatchObject({ path: 'src/a.ts', ref: 'HEAD', cwd: '/repo' });
    // Working-tree read: ref/cwd are undefined, so JSON framing drops them.
    expect(seen[1]!.ref).toBeUndefined();
    expect(seen[1]!.cwd).toBeUndefined();
    expect(seen[1]!.worktreePath).toBeUndefined();
  });

  it('readFile forwards worktreePath for a worktree-scoped working-tree read', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'readFile') {
        seen.push(req.params);
        return { content: 'wt', truncated: false };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    await client.readFile('/wt/src/a.ts', { worktreePath: '/wt' });
    expect(seen[0]).toMatchObject({ path: '/wt/src/a.ts', worktreePath: '/wt' });
    // No ref: the git-ref fields stay omitted.
    expect(seen[0]!.ref).toBeUndefined();
    expect(seen[0]!.cwd).toBeUndefined();
  });

  it('getDiffBundle issues ONE call carrying cwd/path/baseline and returns the bundle', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const { stream } = fakeHelper((req) => {
      calls.push({ method: req.method, params: req.params });
      if (req.method === 'getDiffBundle') {
        return {
          patch: '@@ -1 +1 @@',
          newContent: 'new',
          newReadable: true,
          newTruncated: false,
          oldContent: 'old',
          oldReadable: true,
          oldTruncated: false,
        };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    const bundle = await client.getDiffBundle('/repo', 'src/a.ts', 'HEAD');
    // The whole point of the bundle: a diff open is a SINGLE round trip.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'getDiffBundle',
      params: { cwd: '/repo', path: 'src/a.ts', baseline: 'HEAD' },
    });
    expect(bundle).toMatchObject({ patch: '@@ -1 +1 @@', newContent: 'new', oldContent: 'old' });
  });

  it('rejects with the helper-reported error string', async () => {
    const toClient = new PassThrough();
    const toServer = new PassThrough();
    const decoder = new FrameDecoder();
    toServer.on('data', (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const req = msg as { id: number };
        toClient.write(encodeFrame({ id: req.id, result: null, error: 'boom' }));
      }
    });
    const client = new HelperRpcClient({ stdin: toServer, stdout: toClient });
    await expect(client.stat('/x')).rejects.toThrow(/boom/);
  });

  it('dispatches a pushed watch event to the registered handler', async () => {
    const { stream, pushEvent } = fakeHelper(() => ({ token: 'tok-1' }));
    const client = new HelperRpcClient(stream);
    const received: Array<{ token: string; paths: string[] }> = [];
    await client.watchSubscribe('/repo', 'tok-1', deriveWatchSpec(), (data) => received.push(data));

    pushEvent('watch', { token: 'tok-1', paths: ['/repo/a.ts', '/repo/b.ts'] });
    // Allow the PassThrough 'data' microtask to flush.
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([{ token: 'tok-1', paths: ['/repo/a.ts', '/repo/b.ts'] }]);
  });

  it('ignores a watch event for an unknown token', async () => {
    const { stream, pushEvent } = fakeHelper(() => ({ token: 'tok-1' }));
    const client = new HelperRpcClient(stream);
    const received: unknown[] = [];
    await client.watchSubscribe('/repo', 'tok-1', deriveWatchSpec(), (d) => received.push(d));
    pushEvent('watch', { token: 'other', paths: ['/x'] });
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(0);
  });
});

describe('HelperRpcClient.listDir', () => {
  it('calls the listDir method and returns typed entries', async () => {
    const fakeEntries = [
      { name: 'subdir', path: 'subdir', isDir: true },
      { name: 'a.ts', path: 'a.ts', isDir: false },
    ];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'listDir') return fakeEntries;
      return null;
    });
    const client = new HelperRpcClient(stream);
    const entries = await client.listDir('/repo/src', '/repo');
    expect(entries).toEqual(fakeEntries);
  });

  it('forwards worktreePath when supplied and omits it otherwise', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'listDir') {
        seen.push(req.params);
        return [];
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    await client.listDir('/wt/src', '/wt', '/wt');
    await client.listDir('/repo/src', '/repo');
    expect(seen[0]).toMatchObject({ dir: '/wt/src', root: '/wt', worktreePath: '/wt' });
    // Absent worktreePath is dropped by JSON framing (no regression).
    expect(seen[1]!.worktreePath).toBeUndefined();
  });
});

describe('gitStatus -> FileChangeStatus mapping', () => {
  it('maps the common porcelain codes', () => {
    expect(mapGitStatus('??')).toBe('untracked');
    expect(mapGitStatus('!!')).toBe('ignored');
    expect(mapGitStatus(' M')).toBe('modified');
    expect(mapGitStatus('M ')).toBe('modified');
    expect(mapGitStatus('A ')).toBe('added');
    expect(mapGitStatus(' D')).toBe('deleted');
    expect(mapGitStatus('R ')).toBe('renamed');
    expect(mapGitStatus('UU')).toBe('conflicted');
    expect(mapGitStatus('AA')).toBe('conflicted');
  });
});

describe('Changeset assembly', () => {
  it('builds a HEAD-baseline changeset with v1-shape defaults', () => {
    const cs = assembleChangeset('/repo', 'HEAD', [
      { path: 'src/a.ts', status: ' M' },
      { path: 'new.txt', status: '??' },
    ]);
    expect(cs.worktree).toBe('/repo');
    expect(cs.baseline).toBe('HEAD');
    expect(cs.baselineKind).toBe('HEAD');
    expect(cs.files).toEqual([
      {
        status: 'modified',
        oldPath: null,
        newPath: 'src/a.ts',
        isBinary: false,
        isGenerated: false,
        sizeBytes: null,
        staged: false,
      },
      {
        status: 'untracked',
        oldPath: null,
        newPath: 'new.txt',
        isBinary: false,
        isGenerated: false,
        sizeBytes: null,
        staged: false,
      },
    ]);
    expect(typeof cs.generatedAt).toBe('string');
  });
});
