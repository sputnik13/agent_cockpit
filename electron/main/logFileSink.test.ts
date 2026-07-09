import { describe, expect, it } from 'vitest';
import { initLogFileSink, type SinkFs } from './logFileSink';
import type { LogEntry } from './logger';

// In-memory fs double: stores file contents in a Map so the sink can be tested
// without touching disk (mirrors the Electron-free style of logger.test.ts).
class FakeFs implements SinkFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  failAppend = false;

  mkdirSync(path: string): void {
    this.dirs.add(path);
  }
  appendFileSync(path: string, data: string): void {
    if (this.failAppend) throw new Error('disk full');
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  statSync(path: string): { size: number } {
    const f = this.files.get(path);
    if (f === undefined) throw new Error('ENOENT');
    return { size: Buffer.byteLength(f) };
  }
  renameSync(from: string, to: string): void {
    if (!this.files.has(from)) throw new Error('ENOENT');
    this.files.set(to, this.files.get(from)!);
    this.files.delete(from);
  }
  rmSync(path: string): void {
    this.files.delete(path);
  }
}

// Minimal logger seam: a buffer + subscriber set with an emit() to drive it.
function makeLoggerSeam() {
  const buffer: LogEntry[] = [];
  const subs = new Set<(e: LogEntry) => void>();
  return {
    buffer,
    getBuffer: (): LogEntry[] => buffer.slice(),
    subscribe: (h: (e: LogEntry) => void): (() => void) => {
      subs.add(h);
      return () => subs.delete(h);
    },
    emit: (e: LogEntry): void => {
      buffer.push(e);
      for (const s of subs) s(e);
    },
  };
}

function entry(message: string): LogEntry {
  return { ts: '2026-01-01T00:00:00.000Z', level: 'info', message };
}

function messagesIn(content: string | undefined): string[] {
  return (content ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as LogEntry).message);
}

describe('logFileSink', () => {
  it('flushes the existing buffer on init, then appends live entries', () => {
    const seam = makeLoggerSeam();
    seam.buffer.push(entry('pre-1'), entry('pre-2'));
    const fs = new FakeFs();

    initLogFileSink({
      dir: '/logs',
      fs,
      subscribe: seam.subscribe,
      getBuffer: seam.getBuffer,
      maxBytes: 1_000_000,
    });

    // Pre-init entries were flushed to the active file, in order.
    expect(messagesIn(fs.files.get('/logs/main.log'))).toEqual(['pre-1', 'pre-2']);

    // A live entry appends after the flushed ones.
    seam.emit(entry('live-1'));
    expect(messagesIn(fs.files.get('/logs/main.log'))).toEqual(['pre-1', 'pre-2', 'live-1']);

    // The log directory was created.
    expect(fs.dirs.has('/logs')).toBe(true);
  });

  it('writes one JSON-lines entry per log entry, preserving fields', () => {
    const seam = makeLoggerSeam();
    const fs = new FakeFs();
    initLogFileSink({ dir: '/logs', fs, subscribe: seam.subscribe, getBuffer: seam.getBuffer });

    seam.emit({ ts: '2026-01-01T00:00:00.000Z', level: 'error', message: 'boom', context: 'crash' });
    const lines = (fs.files.get('/logs/main.log') ?? '').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: '2026-01-01T00:00:00.000Z',
      level: 'error',
      message: 'boom',
      context: 'crash',
    });
  });

  it('rotates at the size bound and keeps only the last N backups', () => {
    const seam = makeLoggerSeam();
    const fs = new FakeFs();
    // Each serialized line is well over 40 bytes, so with maxBytes=40 every
    // write after the first rotates the active file.
    initLogFileSink({
      dir: '/logs',
      fs,
      subscribe: seam.subscribe,
      getBuffer: seam.getBuffer,
      maxBytes: 40,
      maxFiles: 3,
    });

    for (let i = 0; i < 6; i++) seam.emit(entry(`msg-${i}`));

    // Active + at most 3 backups; the oldest rotated file is dropped.
    expect(fs.files.has('/logs/main.log')).toBe(true);
    expect(fs.files.has('/logs/main.log.1')).toBe(true);
    expect(fs.files.has('/logs/main.log.3')).toBe(true);
    expect(fs.files.has('/logs/main.log.4')).toBe(false);
    expect(fs.files.size).toBeLessThanOrEqual(4);

    // The newest message is in the active file; older ones shifted to backups.
    expect(messagesIn(fs.files.get('/logs/main.log'))).toEqual(['msg-5']);
    expect(messagesIn(fs.files.get('/logs/main.log.1'))).toEqual(['msg-4']);
  });

  it('swallows write errors — a failing fs never throws into the log path', () => {
    const seam = makeLoggerSeam();
    seam.buffer.push(entry('pre-1'));
    const fs = new FakeFs();
    fs.failAppend = true;

    // Flush-on-init hits the failing append; must not throw.
    let sink!: ReturnType<typeof initLogFileSink>;
    expect(() => {
      sink = initLogFileSink({ dir: '/logs', fs, subscribe: seam.subscribe, getBuffer: seam.getBuffer });
    }).not.toThrow();

    // A live entry through the failing append must not throw either.
    expect(() => seam.emit(entry('live-1'))).not.toThrow();

    // stop() unsubscribes; later entries are not delivered to the sink.
    sink.stop();
    fs.failAppend = false;
    seam.emit(entry('after-stop'));
    expect(messagesIn(fs.files.get('/logs/main.log'))).not.toContain('after-stop');
  });
});
