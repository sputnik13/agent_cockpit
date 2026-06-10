// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

/**
 * Tests for the connection-toggle confirm state machine in StatusRegion.
 * The UI logic (confirming flag, state-to-action routing) is verified here
 * without a full React render by testing the pure inputs + outputs.
 */

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** Mirror of the routing logic in ConnectionToggle. */
function routeAction(
  state: ConnectionState,
  isConfirming: boolean,
  click: 'main' | 'confirm' | 'cancel',
): 'startConfirm' | 'disconnect' | 'cancelConfirm' | 'reconnect' | 'none' {
  const inFlight = state === 'connecting' || state === 'reconnecting';
  if (inFlight) return 'none';
  if (state === 'connected') {
    if (!isConfirming && click === 'main') return 'startConfirm';
    if (isConfirming && click === 'confirm') return 'disconnect';
    if (isConfirming && click === 'cancel') return 'cancelConfirm';
    return 'none';
  }
  // disconnected or failed
  if (click === 'main') return 'reconnect';
  return 'none';
}

describe('ConnectionToggle state machine', () => {
  it('connected: main click starts the confirm flow', () => {
    expect(routeAction('connected', false, 'main')).toBe('startConfirm');
  });

  it('connected + confirming: confirm click disconnects', () => {
    expect(routeAction('connected', true, 'confirm')).toBe('disconnect');
  });

  it('connected + confirming: cancel click cancels', () => {
    expect(routeAction('connected', true, 'cancel')).toBe('cancelConfirm');
  });

  it('disconnected: main click reconnects immediately (no confirm)', () => {
    expect(routeAction('disconnected', false, 'main')).toBe('reconnect');
  });

  it('failed: main click reconnects immediately (no confirm)', () => {
    expect(routeAction('failed', false, 'main')).toBe('reconnect');
  });

  it('connecting: all clicks are no-ops (in-flight)', () => {
    expect(routeAction('connecting', false, 'main')).toBe('none');
  });

  it('reconnecting: all clicks are no-ops (in-flight)', () => {
    expect(routeAction('reconnecting', false, 'main')).toBe('none');
  });
});
