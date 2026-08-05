import { describe, it, expect, afterEach, vi } from 'vitest';
import { computeFoldModel, __resetFoldClientForTest, __setWorkerFactoryForTest } from './foldClient';
import * as foldCore from './foldCore';
import type { FoldFormat, FoldModel } from './foldModel';

// Every test in this file either (a) leaves `workerFactoryOverride` unset, in
// which case `ensureWorker` returns null on its very first line
// (`workerDisabled` is latched true at module load under vitest's
// `import.meta.env.MODE === 'test'`) before ever reaching the dynamic
// `import('./foldWorker?worker')`, or (b) calls `__setWorkerFactoryForTest`,
// which makes `ensureWorker` take the injected-factory branch of its ternary
// instead. Either way, the `?worker` virtual module is structurally never
// evaluated by this suite.
afterEach(() => {
  __resetFoldClientForTest();
  __setWorkerFactoryForTest(null);
});

type FoldReply = { id: number; model?: FoldModel; error?: string };

/** A minimal Worker-shaped fake: only `onmessage`/`onerror`/`postMessage` are
 *  ever touched by foldClient.ts. `postMessage` is assigned separately so it
 *  can close over `w` itself (to call back into `w.onmessage`/`w.onerror`,
 *  exactly as a real worker would via the message/error event loop — except
 *  synchronously, which keeps these tests simple and un-flaky). */
function fakeWorker(): { onmessage: ((e: MessageEvent<FoldReply>) => void) | null; onerror: (() => void) | null; postMessage: (msg: { id: number; text: string; format: FoldFormat }) => void } {
  return { onmessage: null, onerror: null, postMessage: () => {} };
}

describe('computeFoldModel', () => {
  it('worker-disabled path (default under vitest): equals computeFoldModelSync for JSON', async () => {
    const text = '{\n  "a": 1\n}';
    const result = await computeFoldModel(text, 'json');
    expect(result).toEqual(foldCore.computeFoldModelSync(text, 'json'));
  });

  it('worker-disabled path (default under vitest): equals computeFoldModelSync for YAML', async () => {
    const text = 'a:\n  - 1\n  - 2\n';
    const result = await computeFoldModel(text, 'yaml');
    expect(result).toEqual(foldCore.computeFoldModelSync(text, 'yaml'));
  });

  it('worker path: a successful worker reply equals computeFoldModelSync for the same input', async () => {
    const text = '{\n  "a": 1\n}';
    const w = fakeWorker();
    w.postMessage = (msg) => {
      w.onmessage?.({ data: { id: msg.id, model: foldCore.computeFoldModelSync(msg.text, msg.format) } } as MessageEvent<FoldReply>);
    };
    __setWorkerFactoryForTest(() => w as unknown as Worker);

    const result = await computeFoldModel(text, 'json');
    expect(result).toEqual(foldCore.computeFoldModelSync(text, 'json'));
  });

  it('content-addressed cache: identical (text, format) is served from cache with no second compute', async () => {
    const spy = vi.spyOn(foldCore, 'computeFoldModelSync');
    const text = '{\n  "a": 1\n}';

    const first = await computeFoldModel(text, 'json');
    const second = await computeFoldModel(text, 'json');

    expect(second).toBe(first); // same object identity ⇒ served from cache
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('the same text under a different format is a cache miss (key includes format)', async () => {
    const spy = vi.spyOn(foldCore, 'computeFoldModelSync');
    const text = 'hello';

    await computeFoldModel(text, 'json');
    await computeFoldModel(text, 'yaml');

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('exceeding the cache cap evicts the oldest entry first and stays bounded', async () => {
    const spy = vi.spyOn(foldCore, 'computeFoldModelSync');
    // 9 distinct inputs against a cap of 8 (MAX_FOLD_CACHE_ENTRIES).
    const texts = Array.from({ length: 9 }, (_, i) => `{"n": ${i}}`);
    for (const t of texts) await computeFoldModel(t, 'json');
    expect(spy).toHaveBeenCalledTimes(9);

    // The oldest entry was evicted: re-requesting it recomputes.
    spy.mockClear();
    await computeFoldModel(texts[0]!, 'json');
    expect(spy).toHaveBeenCalledTimes(1);

    // The most recent entry survived: no recompute.
    spy.mockClear();
    await computeFoldModel(texts[8]!, 'json');
    expect(spy).toHaveBeenCalledTimes(0);

    spy.mockRestore();
  });

  describe('worker failure fallback (every path resolves inline, never rejects, never hangs)', () => {
    it('a worker construction failure falls back to inline and permanently disables further worker attempts', async () => {
      const factory = vi.fn(() => {
        throw new Error('construct fail');
      });
      __setWorkerFactoryForTest(factory);

      const textA = '{\n  "a": 1\n}';
      const resultA = await computeFoldModel(textA, 'json');
      expect(resultA).toEqual(foldCore.computeFoldModelSync(textA, 'json'));

      // workerDisabled is now permanently latched (per the guardrail: only
      // onerror and a construction throw latch it) — a second, distinct call
      // never re-invokes the factory.
      const textB = '{\n  "b": 2\n}';
      const resultB = await computeFoldModel(textB, 'json');
      expect(resultB).toEqual(foldCore.computeFoldModelSync(textB, 'json'));
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it('a worker onerror falls back to inline and permanently disables further worker attempts', async () => {
      const factory = vi.fn(() => {
        const w = fakeWorker();
        w.postMessage = () => {
          w.onerror?.();
        };
        return w as unknown as Worker;
      });
      __setWorkerFactoryForTest(factory);

      const textA = '{\n  "a": 1\n}';
      const resultA = await computeFoldModel(textA, 'json');
      expect(resultA).toEqual(foldCore.computeFoldModelSync(textA, 'json'));

      const textB = '{\n  "b": 2\n}';
      const resultB = await computeFoldModel(textB, 'json');
      expect(resultB).toEqual(foldCore.computeFoldModelSync(textB, 'json'));
      expect(factory).toHaveBeenCalledTimes(1); // never reconstructed
    });

    it('a postMessage throw falls back to inline for that call only (worker is reused, not disabled)', async () => {
      let postCount = 0;
      const factory = vi.fn(() => {
        const w = fakeWorker();
        w.postMessage = () => {
          postCount += 1;
          throw new Error('boom');
        };
        return w as unknown as Worker;
      });
      __setWorkerFactoryForTest(factory);

      const textA = '{\n  "a": 1\n}';
      const resultA = await computeFoldModel(textA, 'json');
      expect(resultA).toEqual(foldCore.computeFoldModelSync(textA, 'json'));

      const textB = '{\n  "b": 2\n}';
      const resultB = await computeFoldModel(textB, 'json');
      expect(resultB).toEqual(foldCore.computeFoldModelSync(textB, 'json'));

      expect(factory).toHaveBeenCalledTimes(1); // same worker reused across calls
      expect(postCount).toBe(2); // each call still tried postMessage and fell back
    });

    it('a worker error reply falls back to inline for that call only (worker is reused, not disabled)', async () => {
      const w = fakeWorker();
      w.postMessage = (msg) => {
        w.onmessage?.({ data: { id: msg.id, error: 'parse exploded' } } as MessageEvent<FoldReply>);
      };
      const factory = vi.fn(() => w as unknown as Worker);
      __setWorkerFactoryForTest(factory);

      const textA = '{\n  "a": 1\n}';
      const resultA = await computeFoldModel(textA, 'json');
      expect(resultA).toEqual(foldCore.computeFoldModelSync(textA, 'json'));

      const textB = '{\n  "b": 2\n}';
      const resultB = await computeFoldModel(textB, 'json');
      expect(resultB).toEqual(foldCore.computeFoldModelSync(textB, 'json'));

      expect(factory).toHaveBeenCalledTimes(1); // same worker reused across calls
    });
  });
});
