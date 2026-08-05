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
import { assembleChangeset, mapGitStatus, toFileBytesResult, toFileReadResult } from './index';
import type { ReadFileBytesResult, ReadFileResult } from './rpcClient';
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

  it('readFile forwards maxBytes when provided, and omits it otherwise (local_repo_explorer-ftbq)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'readFile') {
        seen.push(req.params);
        return { content: 'raised-cap read', truncated: false, isBinary: false, sizeBytes: 42 };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    await client.readFile('data.json', { worktreePath: '/wt', maxBytes: 2 * 1024 * 1024 });
    await client.readFile('data.json', { worktreePath: '/wt' });
    expect(seen[0]).toMatchObject({
      path: 'data.json',
      worktreePath: '/wt',
      maxBytes: 2 * 1024 * 1024,
    });
    // Omitted when not provided -- JSON framing drops the undefined field, so
    // the helper falls back to its own default cap.
    expect(seen[1]!.maxBytes).toBeUndefined();
  });

  it('readFile surfaces the helper isBinary verdict + sizeBytes for both binary and text content (br r3s6)', async () => {
    // Mirrors electron/main/git/files.ts's looksBinary semantics on the wire: a
    // NUL byte in the content -> isBinary true; plain text -> false. The Go
    // helper computes both isBinary and the true sizeBytes from bytes/stat it
    // already has in hand (see remote-helper/commands.go's
    // looksBinary/handleReadFile) and returns them on the SAME readFile
    // response (no second RPC). This proves the RPC client forwards both
    // fields through ReadFileResult with no loss, matching local's
    // classification for equivalent content.
    const { stream } = fakeHelper((req) => {
      if (req.method === 'readFile') {
        const params = req.params as { path: string };
        if (params.path === '/bin.dat') {
          return { content: 'PNG fake-binary', truncated: false, isBinary: true, sizeBytes: 4096 };
        }
        return {
          content: 'plain text content',
          truncated: false,
          isBinary: false,
          sizeBytes: 19,
        };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    const bin = await client.readFile('/bin.dat');
    const text = await client.readFile('/text.txt');
    expect(bin).toEqual({
      content: 'PNG fake-binary',
      truncated: false,
      isBinary: true,
      sizeBytes: 4096,
    });
    expect(text).toEqual({
      content: 'plain text content',
      truncated: false,
      isBinary: false,
      sizeBytes: 19,
    });
  });

  it('readFileBytes (git-ref binary-preview branch, br bn8a) forwards path/ref/cwd', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { stream } = fakeHelper((req) => {
      if (req.method === 'readFileBytes') {
        seen.push(req.params);
        return { bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: '' };
      }
      return null;
    });
    const client = new HelperRpcClient(stream);
    const res = await client.readFileBytes('assets/logo.png', 'HEAD', '/repo');
    expect(seen[0]).toEqual({ path: 'assets/logo.png', ref: 'HEAD', cwd: '/repo' });
    expect(res).toEqual({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: '' });
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

describe('toFileReadResult (br r3s6 REJECT fix: content-nulling + true sizeBytes)', () => {
  // RemoteProvider has no transport-injection seam (see readFileBytesOverTransport's
  // doc comment for the established precedent), so this pure adapter is exported
  // from index.ts specifically to make the class method's one-line-looking
  // transformation directly unit-testable without a live SSH host + built helper.

  it('passes text content through unchanged and reports the helper-provided size', () => {
    const res: ReadFileResult = {
      content: 'plain text content',
      truncated: false,
      isBinary: false,
      sizeBytes: 19,
    };
    expect(toFileReadResult(res)).toEqual({
      content: 'plain text content',
      truncated: false,
      isBinary: false,
      sizeBytes: 19,
    });
  });

  it('nulls content for binary and uses the TRUE sizeBytes, not Buffer.byteLength over the (possibly U+FFFD-mangled) content string', () => {
    // Simulates what Go's encoding/json actually produces for invalid UTF-8: a
    // single NUL byte substituted with U+FFFD, which is 3 bytes in UTF-8 -- so
    // Buffer.byteLength(content, 'utf8') (the old, buggy computation) would
    // report 3, not the true original 1-byte size the helper reports via
    // sizeBytes. This is the exact regression the REJECT identified.
    const res: ReadFileResult = {
      content: '�',
      truncated: false,
      isBinary: true,
      sizeBytes: 1,
    };
    const mangledByteLength = Buffer.byteLength(res.content, 'utf8');
    expect(mangledByteLength).toBe(3); // sanity: confirms the mangling inflates size
    const result = toFileReadResult(res);
    expect(result.content).toBeNull();
    expect(result.isBinary).toBe(true);
    expect(result.sizeBytes).toBe(1); // true size, NOT mangledByteLength (3)
  });

  it('routes a binary+truncated response to the "too-large" branch contract: content null, truncated true', () => {
    // Consumers (RawFile.tsx) check `truncated` BEFORE `isBinary`, so a file
    // that is both binary and over the cap must still null its content (this
    // just proves toFileReadResult does not special-case that combination).
    const res: ReadFileResult = {
      content: 'aaaa...(capped)',
      truncated: true,
      isBinary: true,
      sizeBytes: 5_000_000,
    };
    const result = toFileReadResult(res);
    expect(result.content).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(5_000_000);
  });

  it('nulls content when truncated is true even though isBinary is false (local_repo_explorer-ftbq refuse-never-truncate fix)', () => {
    // The Go helper's readFile now REFUSES (never truncates) a file over its
    // effective cap (remote-helper/commands.go's handleReadFile), but
    // `content` stays a plain, always-present `string` field on the wire (""
    // when refused, never absent/null). Before this fix, only `isBinary`
    // gated the null -- a refused TEXT (non-binary) file kept its (empty but
    // non-null) content and would win the `content !== null` branch every
    // consumer (RawFile.tsx, FoldingView.tsx) checks first, misrendering an
    // empty file instead of the too-large placeholder.
    const res: ReadFileResult = {
      content: '',
      truncated: true,
      isBinary: false,
      sizeBytes: 12_582_912, // 12 MiB -- over the effective cap
    };
    const result = toFileReadResult(res);
    expect(result.content).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.isBinary).toBe(false);
    expect(result.sizeBytes).toBe(12_582_912);
  });

  it('a successful (non-truncated, non-binary) read is never nulled — sanity companion to the refuse-never-truncate fix above', () => {
    const res: ReadFileResult = {
      content: 'well under the cap',
      truncated: false,
      isBinary: false,
      sizeBytes: 19,
    };
    expect(toFileReadResult(res).content).toBe('well under the cap');
  });

  it('degrades isBinary to false against a stale helper build missing the field (never trusts the static type at runtime)', () => {
    // A pre-br-r3s6 helper's response has no isBinary/sizeBytes fields at all;
    // cast past the static type to model that wire shape precisely.
    const stale = { content: 'text from an old helper', truncated: false } as unknown as ReadFileResult;
    const result = toFileReadResult(stale);
    expect(result.isBinary).toBe(false);
    expect(result.content).toBe('text from an old helper'); // not nulled
  });

  it('degrades sizeBytes to a content-derived length against a stale helper build missing the field', () => {
    const stale = {
      content: 'hello',
      truncated: false,
      isBinary: false,
    } as unknown as ReadFileResult;
    const result = toFileReadResult(stale);
    expect(result.sizeBytes).toBe(Buffer.byteLength('hello', 'utf8'));
  });

  it('rejects a truthy-but-not-true isBinary (defensive equality, not truthiness)', () => {
    // A malformed/unexpected wire value (e.g. a stringly-typed "true") must
    // NOT be treated as binary -- only the literal boolean true does.
    const malformed = {
      content: 'text',
      truncated: false,
      isBinary: 'true',
      sizeBytes: 4,
    } as unknown as ReadFileResult;
    const result = toFileReadResult(malformed);
    expect(result.isBinary).toBe(false);
    expect(result.content).toBe('text');
  });
});

describe('toFileBytesResult (git-ref binary-preview branch, br bn8a)', () => {
  // RemoteProvider has no transport-injection seam (same precedent as
  // toFileReadResult above), so this pure adapter is exported specifically to
  // make the readFileBytes RPC response's translation directly unit-testable.

  it('passes present bytes through, mapping the RPC\'s "" reason sentinel to reason: null', () => {
    const res: ReadFileBytesResult = { bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: '' };
    expect(toFileBytesResult(res)).toEqual({ bytesBase64: 'Zm9v', sizeBytes: 3, exists: true, reason: null });
  });

  it('a 0-byte blob is present (bytesBase64: ""), not absent — reason drives the branch, never bytesBase64 truthiness', () => {
    const res: ReadFileBytesResult = { bytesBase64: '', sizeBytes: 0, exists: true, reason: '' };
    expect(toFileBytesResult(res)).toEqual({ bytesBase64: '', sizeBytes: 0, exists: true, reason: null });
  });

  it('maps reason "missing" (path absent at ref) to a null-bytes result, exists false', () => {
    const res: ReadFileBytesResult = { sizeBytes: 0, exists: false, reason: 'missing' };
    expect(toFileBytesResult(res)).toEqual({ bytesBase64: null, sizeBytes: 0, exists: false, reason: 'missing' });
  });

  it('maps reason "too-large" to a null-bytes refusal carrying the true blob size, exists true', () => {
    const res: ReadFileBytesResult = { sizeBytes: 12_582_912, exists: true, reason: 'too-large' };
    expect(toFileBytesResult(res)).toEqual({
      bytesBase64: null,
      sizeBytes: 12_582_912,
      exists: true,
      reason: 'too-large',
    });
  });

  it('degrades an unrecognized/malformed reason to "missing" (refuse) rather than passing it through — `exists` still reflects the wire value independently', () => {
    const malformed = { sizeBytes: 0, exists: true, reason: 'weird-future-value' } as unknown as ReadFileBytesResult;
    expect(toFileBytesResult(malformed)).toEqual({
      bytesBase64: null,
      sizeBytes: 0,
      exists: true,
      reason: 'missing',
    });
  });

  it('degrades sizeBytes to 0 against a response missing the field (never trusts the static type at runtime)', () => {
    const stale = { bytesBase64: 'Zm9v', exists: true, reason: '' } as unknown as ReadFileBytesResult;
    expect(toFileBytesResult(stale).sizeBytes).toBe(0);
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
