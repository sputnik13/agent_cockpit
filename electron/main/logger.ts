/**
 * Central main-process logger. Provides structured log entries with a ring
 * buffer (capped at LOG_CAP entries) and a subscriber model so the IPC layer
 * can push entries to all renderer windows.
 *
 * Design constraints:
 * - log() ALSO calls console[level] so existing terminal stdout is unchanged.
 * - Never log raw pane %output bytes; callers must log structured messages only.
 * - Subscribers receive each new entry synchronously (no buffering delay).
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  context?: string;
  message: string;
}

type LogSubscriber = (entry: LogEntry) => void;

const LOG_CAP = 1000;

const buffer: LogEntry[] = [];
const subscribers = new Set<LogSubscriber>();

/** Subscribe to new log entries. Returns an unsubscribe function. */
export function subscribe(handler: LogSubscriber): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

/** Return a snapshot of the current ring buffer. */
export function getBuffer(): LogEntry[] {
  return buffer.slice();
}

function pushEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > LOG_CAP) {
    buffer.splice(0, buffer.length - LOG_CAP);
  }
  for (const s of subscribers) {
    try {
      s(entry);
    } catch {
      // never let a subscriber error break the log path
    }
  }
}

function log(level: LogLevel, message: string, context?: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, message, ...(context ? { context } : {}) };
  pushEntry(entry);
  // Mirror to console so existing terminal stdout is unchanged.
  const tag = context ? `[${context}] ` : '';
  if (level === 'error') {
    console.error(`${tag}${message}`);
  } else if (level === 'warn') {
    console.warn(`${tag}${message}`);
  } else {
    console.info(`${tag}${message}`);
  }
}

export const logger = {
  info: (message: string, context?: string): void => log('info', message, context),
  warn: (message: string, context?: string): void => log('warn', message, context),
  error: (message: string, context?: string): void => log('error', message, context),
};
