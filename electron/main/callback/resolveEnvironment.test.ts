/**
 * The callback feature is best-effort: evaluating a project's environment source
 * must never fail a terminal creation, an attach or a session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCallbackEnvironment } from '@shared/callback/env';
import { subscribe, type LogEntry } from '../logger';
import { resolveCallbackEnvironment } from './resolveEnvironment';

const ENV = buildCallbackEnvironment({ sock: '/tmp/a.sock', cli: '/tmp/cockpit' })!;

let logs: LogEntry[];
let unsubscribe: () => void;
beforeEach(() => {
  logs = [];
  unsubscribe = subscribe((e) => logs.push(e));
  for (const level of ['info', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});
afterEach(() => {
  unsubscribe();
  vi.restoreAllMocks();
});

describe('resolveCallbackEnvironment', () => {
  it('is the source value, evaluated on each call', () => {
    const source = vi.fn(() => ENV);
    expect(resolveCallbackEnvironment(source, 'x')).toBe(ENV);
    expect(resolveCallbackEnvironment(source, 'x')).toBe(ENV);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('is undefined without a source (the feature is disabled for that object), silently', () => {
    expect(resolveCallbackEnvironment(undefined, 'x')).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('is undefined when the source says it has nothing', () => {
    expect(resolveCallbackEnvironment(() => undefined, 'x')).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it('survives a throwing source: logged with where, never propagated', () => {
    const value = resolveCallbackEnvironment(() => {
      throw new Error('handshake not ready');
    }, 'session=agent-cockpit-p1');
    expect(value).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', context: 'callback' });
    expect(logs[0]!.message).toBe(
      'callback env source threw session=agent-cockpit-p1: handshake not ready',
    );
  });
});
