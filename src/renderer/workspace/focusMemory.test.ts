import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFocus, writeFocus } from './focusMemory';

// jsdom in this setup doesn't implement localStorage, so install a Map-backed
// fake. Methods are reassignable so individual tests can force throws.
interface FakeStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  clear(): void;
}

let store: Map<string, string>;

beforeEach(() => {
  store = new Map<string, string>();
  const fake: FakeStorage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = fake;
});

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: FakeStorage }).localStorage;
});

describe('focusMemory', () => {
  it('round-trips a value per (namespace, project)', () => {
    writeFocus('pane', 'projA', '%3');
    expect(readFocus('pane', 'projA')).toBe('%3');
  });

  it('isolates by namespace and by project', () => {
    writeFocus('pane', 'projA', '%3');
    writeFocus('panel', 'projA', 'changes');
    writeFocus('pane', 'projB', '%9');
    expect(readFocus('pane', 'projA')).toBe('%3');
    expect(readFocus('panel', 'projA')).toBe('changes');
    expect(readFocus('pane', 'projB')).toBe('%9');
    expect(readFocus('pane', 'projC')).toBeNull();
  });

  it('writing null clears the value', () => {
    writeFocus('pane', 'projA', '%3');
    writeFocus('pane', 'projA', null);
    expect(readFocus('pane', 'projA')).toBeNull();
  });

  it('treats a null projectId as a no-op / null', () => {
    writeFocus('pane', null, '%3'); // no-op
    expect(readFocus('pane', null)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('returns null when localStorage read throws (best-effort)', () => {
    globalThis.localStorage.getItem = () => {
      throw new Error('blocked');
    };
    expect(readFocus('pane', 'projA')).toBeNull();
  });

  it('does not throw when localStorage write throws (best-effort)', () => {
    globalThis.localStorage.setItem = () => {
      throw new Error('quota');
    };
    expect(() => writeFocus('pane', 'projA', '%3')).not.toThrow();
  });
});
