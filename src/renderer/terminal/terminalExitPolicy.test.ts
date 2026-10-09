import { describe, expect, it } from 'vitest';
import { shouldRetainTerminalAfterExit } from './terminalExitPolicy';

describe('shouldRetainTerminalAfterExit', () => {
  it('retains a recovered daemon-crash screen', () => {
    expect(shouldRetainTerminalAfterExit('daemon-crash')).toBe(true);
  });

  it('disposes ordinary exited terminals', () => {
    expect(shouldRetainTerminalAfterExit(null)).toBe(false);
    expect(shouldRetainTerminalAfterExit('SIGTERM')).toBe(false);
  });
});
