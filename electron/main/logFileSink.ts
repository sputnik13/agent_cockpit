/**
 * On-disk log file sink. Persists the main-process logger's entries to a
 * rotating JSON-lines file so the log survives a crash — the in-memory ring
 * buffer in logger.ts dies with the process, and on a Dock launch (launchd's
 * minimal PATH) console.* output goes to the unified log and is effectively
 * lost, so a persisted file is the only durable record of the run.
 *
 * Design constraints (mirror logger.ts discipline):
 * - Consumes the existing logger.subscribe() seam; does NOT rewrite logger core.
 * - Writes one JSON-encoded LogEntry per line, append mode.
 * - Every fs operation is wrapped so a write/rotate failure is SWALLOWED and
 *   never throws into the log path (a logger call must never fail because of us).
 * - Introduces no new log source: it writes whatever LogEntry.message already
 *   contains, so the "never log raw pane %output" rule is honored upstream.
 * - Pure / Electron-free: the caller resolves the log directory (app.getPath)
 *   and passes it in, so this module is unit-testable without Electron. All
 *   collaborators (fs, subscribe, getBuffer) are injectable for the same reason.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { subscribe as loggerSubscribe, getBuffer as loggerGetBuffer, type LogEntry } from './logger';

/** Minimal fs surface the sink needs; injectable so tests avoid touching disk. */
export interface SinkFs {
  mkdirSync(path: string, opts: { recursive: true }): void;
  appendFileSync(path: string, data: string): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  rmSync(path: string, opts: { force: true }): void;
}

export interface LogFileSinkOptions {
  /** Directory to write logs into (the caller resolves this via app.getPath). */
  dir: string;
  /** Active log file name. Default 'main.log'. */
  fileName?: string;
  /** Rotate when the active file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** How many rotated backups to keep (main.log.1 .. main.log.N). Default 3. */
  maxFiles?: number;
  /** Test seams — default to real fs / the shared logger. */
  fs?: SinkFs;
  subscribe?: (handler: (entry: LogEntry) => void) => () => void;
  getBuffer?: () => LogEntry[];
}

export interface LogFileSink {
  /** Stop receiving new entries (unsubscribe). Does not delete files. */
  stop(): void;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const DEFAULT_FILE_NAME = 'main.log';

const realFs: SinkFs = {
  mkdirSync: (p, o) => {
    mkdirSync(p, o);
  },
  appendFileSync: (p, d) => {
    appendFileSync(p, d);
  },
  statSync: (p) => statSync(p),
  renameSync: (a, b) => {
    renameSync(a, b);
  },
  rmSync: (p, o) => {
    rmSync(p, o);
  },
};

function serialize(entry: LogEntry): string {
  // JSON.stringify never throws for a well-formed LogEntry (all string fields),
  // but guard anyway so a pathological value can't break the log path.
  try {
    return JSON.stringify(entry) + '\n';
  } catch {
    return (
      JSON.stringify({ ts: entry.ts, level: entry.level, message: '<unserializable log entry>' }) + '\n'
    );
  }
}

/**
 * Start persisting logger entries to a rotating on-disk file. Flushes the
 * current in-memory buffer first (so pre-init entries are captured), then
 * subscribes for live entries. Best-effort throughout: any fs failure is
 * swallowed, never surfaced into a logger call.
 */
export function initLogFileSink(opts: LogFileSinkOptions): LogFileSink {
  const fs = opts.fs ?? realFs;
  const subscribe = opts.subscribe ?? loggerSubscribe;
  const getBuffer = opts.getBuffer ?? loggerGetBuffer;
  const fileName = opts.fileName ?? DEFAULT_FILE_NAME;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(0, opts.maxFiles ?? DEFAULT_MAX_FILES);
  const filePath = join(opts.dir, fileName);

  // Track the active file's byte size in memory so a rotation decision costs no
  // stat per write. Seeded from the existing file (append mode continues it).
  let bytes = 0;

  try {
    fs.mkdirSync(opts.dir, { recursive: true });
  } catch {
    /* swallow — a later write failure is likewise swallowed */
  }
  try {
    bytes = fs.statSync(filePath).size;
  } catch {
    bytes = 0; // file does not exist yet
  }

  const rotate = (): void => {
    // Shift backups outward, dropping the oldest: remove main.log.N, then
    // main.log.(N-1) -> .N, ..., main.log.1 -> .2, finally main.log -> .1.
    try {
      fs.rmSync(`${filePath}.${maxFiles}`, { force: true });
    } catch {
      /* swallow */
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`);
      } catch {
        /* backup i may not exist — swallow */
      }
    }
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      /* swallow */
    }
    bytes = 0;
  };

  const write = (entry: LogEntry): void => {
    const line = serialize(entry);
    const size = Buffer.byteLength(line);
    // Rotate BEFORE writing when appending this line would push a non-empty
    // active file over the bound, so no single file grows unbounded. An empty
    // file (bytes === 0) is never rotated even if one line exceeds maxBytes —
    // there is nothing to preserve and rotating would spin.
    if (maxBytes > 0 && bytes > 0 && bytes + size > maxBytes) {
      rotate();
    }
    try {
      fs.appendFileSync(filePath, line);
      bytes += size;
    } catch {
      /* swallow — never let a write failure break the log path */
    }
  };

  // Flush the pre-init snapshot first so entries logged before the sink was
  // wired are captured, THEN subscribe for live entries. If an entry is logged
  // in the narrow window between getBuffer() and subscribe() it may be missed;
  // for a diagnostic log, dropping at most one boundary entry is preferable to
  // the double-write that ordering subscribe-first would cause.
  for (const entry of getBuffer()) {
    write(entry);
  }
  const unsubscribe = subscribe(write);

  return {
    stop: () => {
      try {
        unsubscribe();
      } catch {
        /* swallow */
      }
    },
  };
}
