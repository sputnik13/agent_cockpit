import { describe, it, expect, vi } from 'vitest';
import { FakeProvider } from './fakeProvider';
import type { WorkspaceProvider } from './types';

describe('FakeProvider (WorkspaceProvider contract)', () => {
  it('satisfies the WorkspaceProvider interface', () => {
    const p: WorkspaceProvider = new FakeProvider('proj-1');
    expect(p.kind).toBe('local');
    expect(p.projectId).toBe('proj-1');
  });

  it('transitions connection status and notifies subscribers', async () => {
    const p = new FakeProvider('proj-1');
    const seen: string[] = [];
    const off = p.onStatusChange((s) => seen.push(s.state));
    expect(p.status().state).toBe('disconnected');
    await p.connect();
    expect(p.status().state).toBe('connected');
    await p.disconnect();
    off();
    await p.connect(); // not observed after unsubscribe
    expect(seen).toEqual(['connected', 'disconnected']);
  });

  it('echoes terminal writes to data subscribers and emits exit on close', async () => {
    const p = new FakeProvider('proj-1');
    const { id } = await p.openTerminal({ cols: 80, rows: 24 });
    const data = vi.fn();
    const exit = vi.fn();
    p.onTerminalData(id, data);
    p.onTerminalExit(id, exit);
    await p.writeTerminal(id, 'ls\n');
    expect(data).toHaveBeenCalledWith('ls\n');
    await p.closeTerminal(id);
    expect(exit).toHaveBeenCalledWith({ code: 0, signal: null });
  });

  it('delivers watch events until unsubscribe', async () => {
    const p = new FakeProvider('proj-1');
    const handler = vi.fn();
    const sub = await p.subscribeWatch(['**/*'], handler);

    p.emitWatch(['a.ts']);
    expect(handler).toHaveBeenCalledTimes(1);

    // Every live session is fully live now (no suspend/resume); events keep
    // flowing until the subscription is torn down.
    p.emitWatch(['c.ts']);
    expect(handler).toHaveBeenCalledTimes(2);

    await sub.unsubscribe();
    p.emitWatch(['d.ts']);
    expect(handler).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it('returns injected canned data for reads', async () => {
    const p = new FakeProvider('proj-1', 'remote', {
      hasBeads: true,
      fileDiffs: { 'x.ts': '@@ -1 +1 @@' },
      files: { 'x.ts': { content: 'hi', truncated: false, isBinary: false, sizeBytes: 2 } },
    });
    expect(p.kind).toBe('remote');
    expect(await p.detectBeads()).toBe(true);
    expect(await p.getFileDiff('wt', 'x.ts')).toBe('@@ -1 +1 @@');
    expect((await p.readFile('x.ts')).content).toBe('hi');
    expect((await p.stat('x.ts')).exists).toBe(true);
    expect((await p.stat('missing')).exists).toBe(false);
  });
});
