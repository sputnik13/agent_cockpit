import { describe, expect, it } from 'vitest';
import { FrameError, encodeFrame } from '../wire/frame';
import {
  CALLBACK_DEADLINE_MS,
  CALLBACK_ERROR_CODES,
  CALLBACK_MAX_CONNECTIONS,
  CALLBACK_MAX_FRAME_BYTES,
  CALLBACK_MAX_PATH_BYTES,
  CALLBACK_OPS,
  CALLBACK_PROTOCOL_VERSION,
  CALLBACK_RATE_LIMIT_PER_SECOND,
  createCallbackFrameDecoder,
  encodeCallbackFrame,
  errorReply,
  isCallbackOp,
  isInjectableEnvValue,
  okReply,
  paneFromEnv,
  parseCallbackEnvelope,
  parseOpenArgs,
  type CallbackPane,
  type CallbackRequest,
} from './protocol';
import frameFixtures from './fixtures/frames.json';
import identityFixtures from './fixtures/identity.json';
import messageFixtures from './fixtures/messages.json';

// ---- Scenario 3: wire codec ---------------------------------------------------

type FixtureChunk = string | { jsonStringFrame: number };
type FixturePayload = unknown | { jsonString: number };

function chunkBytes(chunk: FixtureChunk): Uint8Array {
  if (typeof chunk !== 'string') {
    return encodeFrame('a'.repeat(chunk.jsonStringFrame), frameFixtures.maxFrameBytes);
  }
  return Uint8Array.from(chunk.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function expandPayload(payload: FixturePayload): unknown {
  if (typeof payload === 'object' && payload !== null && 'jsonString' in payload) {
    return 'a'.repeat((payload as { jsonString: number }).jsonString);
  }
  return payload;
}

describe('callback wire codec (scenario 3)', () => {
  it('is bound to the documented 64 KiB cap', () => {
    expect(CALLBACK_MAX_FRAME_BYTES).toBe(64 * 1024);
    expect(frameFixtures.maxFrameBytes).toBe(CALLBACK_MAX_FRAME_BYTES);
  });

  describe.each(frameFixtures.cases)('fixture: $name', (fixture) => {
    it('decodes as the fixture expects', () => {
      const decoder = createCallbackFrameDecoder();
      const expected = fixture.expect as {
        payloads?: FixturePayload[];
        pendingBytes?: number;
        error?: string;
      };
      const decoded: unknown[] = [];
      let thrown: FrameError | null = null;
      try {
        for (const chunk of fixture.chunks as FixtureChunk[])
          decoded.push(...decoder.push(chunkBytes(chunk)));
      } catch (err) {
        thrown = err as FrameError;
      }
      if (expected.error) {
        expect(thrown).toBeInstanceOf(FrameError);
        expect(thrown?.code).toBe(expected.error);
        return;
      }
      expect(thrown).toBeNull();
      expect(decoded).toEqual((expected.payloads ?? []).map(expandPayload));
      expect(decoder.pendingBytes).toBe(expected.pendingBytes ?? 0);
    });
  });

  it('rejects a reply or request larger than the cap on encode', () => {
    const big = okReply(1, { blob: 'x'.repeat(CALLBACK_MAX_FRAME_BYTES) });
    expect(() => encodeCallbackFrame(big)).toThrow(/frame too large/);
  });
});

// ---- Scenario 2: identity & envelope --------------------------------------------

const validRequest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  id: 5,
  op: 'open',
  args: { path: '/a/b.md' },
  ...over,
});

describe('callback protocol constants', () => {
  it('pins the documented limits and the v1 allowlist', () => {
    expect(CALLBACK_PROTOCOL_VERSION).toBe(1);
    expect(CALLBACK_DEADLINE_MS).toBe(5_000);
    expect(CALLBACK_MAX_CONNECTIONS).toBe(32);
    expect(CALLBACK_RATE_LIMIT_PER_SECOND).toBe(10);
    expect([...CALLBACK_OPS]).toEqual(['open']);
    expect([...CALLBACK_ERROR_CODES]).toEqual([
      'unsupported-op',
      'bad-request',
      'rate-limited',
      'timeout',
      'not-connected',
      'internal',
    ]);
  });

  it('allowlists only open', () => {
    expect(isCallbackOp('open')).toBe(true);
    for (const op of [
      'Open',
      'review',
      'focus',
      'notify',
      'open ',
      '',
      '__proto__',
      'constructor',
    ]) {
      expect(isCallbackOp(op)).toBe(false);
    }
  });
});

describe('parseCallbackEnvelope (scenario 2)', () => {
  it('accepts a request with a tmux pane, a mux pane, and no pane', () => {
    expect(parseCallbackEnvelope(validRequest({ pane: { kind: 'tmux', id: '%12' } }))).toEqual({
      ok: true,
      id: 5,
      op: 'open',
      pane: { kind: 'tmux', id: '%12' },
      args: { path: '/a/b.md' },
    });
    expect(
      parseCallbackEnvelope(validRequest({ pane: { kind: 'mux', id: 'term-3' } })),
    ).toMatchObject({
      ok: true,
      pane: { kind: 'mux', id: 'term-3' },
    });
    const noPane = parseCallbackEnvelope(validRequest());
    expect(noPane).toEqual({ ok: true, id: 5, op: 'open', args: { path: '/a/b.md' } });
    expect(parseCallbackEnvelope(validRequest({ pane: null }))).toEqual(noPane);
  });

  it('never lets a request name a project: unknown fields are ignored', () => {
    const parsed = parseCallbackEnvelope(
      validRequest({
        projectId: 'other',
        project: 'other',
        args: { path: '/a', projectId: 'other' },
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      id: 5,
      op: 'open',
      args: { path: '/a', projectId: 'other' },
    });
    expect(parsed).not.toHaveProperty('projectId');
  });

  it('rejects an unknown protocol version, echoing a valid id', () => {
    expect(parseCallbackEnvelope(validRequest({ v: 2 }))).toMatchObject({ ok: false, id: 5 });
    expect(parseCallbackEnvelope(validRequest({ v: '1' }))).toMatchObject({ ok: false, id: 5 });
    expect(parseCallbackEnvelope({ id: 5, op: 'open' })).toMatchObject({ ok: false, id: 5 });
  });

  it('replies with id 0 when the request has no usable id', () => {
    for (const id of [undefined, 0, -1, 1.5, '5', null, Number.MAX_SAFE_INTEGER + 2]) {
      expect(parseCallbackEnvelope(validRequest({ id }))).toMatchObject({ ok: false, id: 0 });
    }
    for (const junk of [null, undefined, 'open', 7, [], [validRequest()]]) {
      expect(parseCallbackEnvelope(junk)).toEqual({
        ok: false,
        id: 0,
        message: 'request must be a JSON object',
      });
    }
  });

  it('rejects a missing, non-string, empty or oversize op', () => {
    for (const op of [undefined, null, 5, '', 'x'.repeat(33)]) {
      expect(parseCallbackEnvelope(validRequest({ op }))).toMatchObject({ ok: false, id: 5 });
    }
  });

  it('leaves the allowlist to the caller: an unknown op is a valid envelope', () => {
    expect(parseCallbackEnvelope(validRequest({ op: 'delete' }))).toMatchObject({
      ok: true,
      op: 'delete',
    });
  });

  it('rejects a malformed pane but accepts a missing one', () => {
    const bad: unknown[] = [
      'tmux',
      [],
      {},
      { kind: 'tmux' },
      { kind: 'screen', id: '%1' },
      { kind: 'tmux', id: '' },
      { kind: 'tmux', id: 7 },
      { kind: 'tmux', id: 'a\nb' },
      { kind: 'tmux', id: 'a\u0000b' },
      { kind: 'mux', id: 'k'.repeat(129) },
    ];
    for (const pane of bad) {
      expect(parseCallbackEnvelope(validRequest({ pane }))).toMatchObject({ ok: false, id: 5 });
    }
  });
});

describe('golden messages', () => {
  it.each(messageFixtures.requests)('accepts the request: $name', ({ request }) => {
    const envelope = parseCallbackEnvelope(request);
    expect(envelope).toMatchObject({ ok: true, op: 'open' });
    if (!envelope.ok) return;
    expect(isCallbackOp(envelope.op)).toBe(true);
    expect(parseOpenArgs(envelope.args).ok).toBe(true);
    // The fixture request survives the wire exactly.
    const decoded = createCallbackFrameDecoder().push(
      encodeCallbackFrame(request as CallbackRequest),
    );
    expect(decoded).toEqual([request]);
  });

  it.each(messageFixtures.replies)('round-trips the reply: $name', ({ reply }) => {
    const decoded = createCallbackFrameDecoder().push(encodeCallbackFrame(reply as never));
    expect(decoded).toEqual([reply]);
    const r = reply as { ok: boolean; error?: { code: string } };
    if (!r.ok) expect(CALLBACK_ERROR_CODES as readonly string[]).toContain(r.error?.code);
  });

  it('builds the reply shapes the fixtures document', () => {
    expect(okReply(1, { status: 'dispatched' })).toEqual(messageFixtures.replies[0]!.reply);
    expect(errorReply(8, 'not-connected', 'project is not connected')).toEqual(
      messageFixtures.replies.find((r) => r.name === 'not-connected')!.reply,
    );
  });
});

describe('parseOpenArgs', () => {
  it('accepts an absolute path, with or without a canonical form', () => {
    expect(parseOpenArgs({ path: '/a/b c.md' })).toEqual({ ok: true, args: { path: '/a/b c.md' } });
    expect(parseOpenArgs({ path: '/a/b.md', canonicalPath: '/private/a/b.md' })).toEqual({
      ok: true,
      args: { path: '/a/b.md', canonicalPath: '/private/a/b.md' },
    });
    expect(parseOpenArgs({ path: '/a/b.md', canonicalPath: null })).toEqual({
      ok: true,
      args: { path: '/a/b.md' },
    });
  });

  it('rejects empty, relative, non-string, missing and NUL-bearing paths', () => {
    for (const path of ['', 'README.md', './x', '../x', ' /x', 5, null, undefined, '/a\0b']) {
      expect(parseOpenArgs({ path }).ok).toBe(false);
    }
    expect(parseOpenArgs({}).ok).toBe(false);
    for (const args of [undefined, null, 'x', 7, ['/a']])
      expect(parseOpenArgs(args).ok).toBe(false);
  });

  it('applies the same rules to canonicalPath', () => {
    for (const canonicalPath of ['', 'rel/x', 5, '/a\0b']) {
      expect(parseOpenArgs({ path: '/a', canonicalPath }).ok).toBe(false);
    }
  });

  it('bounds a path by bytes, not characters', () => {
    expect(parseOpenArgs({ path: '/' + 'a'.repeat(CALLBACK_MAX_PATH_BYTES - 1) }).ok).toBe(true);
    expect(parseOpenArgs({ path: '/' + 'a'.repeat(CALLBACK_MAX_PATH_BYTES) }).ok).toBe(false);
    // 1366 three-byte characters are 4098 bytes: under the limit by length, over by bytes.
    expect(parseOpenArgs({ path: '/' + '日'.repeat(1366) }).ok).toBe(false);
  });

  it('allows a newline in a path (legal on POSIX); only NUL is refused', () => {
    expect(parseOpenArgs({ path: '/a/line\nbreak.md' }).ok).toBe(true);
  });
});

describe('pane identity from the environment (scenario 2)', () => {
  it.each(identityFixtures.cases)('$name', ({ env, pane }) => {
    expect(paneFromEnv(env)).toEqual(pane ?? undefined);
  });

  it('produces a pane the envelope accepts', () => {
    const pane = paneFromEnv({ TMUX_PANE: '%4' }) as CallbackPane;
    expect(parseCallbackEnvelope(validRequest({ pane }))).toMatchObject({ ok: true, pane });
  });
});

describe('injectable environment values (scenario 15)', () => {
  it('rejects NUL and line breaks, and nothing else', () => {
    for (const bad of ['a\0b', 'a\nb', 'a\rb', '\n', '\0'])
      expect(isInjectableEnvValue(bad)).toBe(false);
    const legal = [
      '',
      '/Users/me/Library/Application Support/Agent Cockpit/callback/abc.sock',
      "/tmp/it's here/$HOME;rm -rf ~ #x/a.sock",
      '"quoted" `tick` \\back\\slash',
      '日本語/ö',
    ];
    for (const ok of legal) expect(isInjectableEnvValue(ok)).toBe(true);
  });
});
