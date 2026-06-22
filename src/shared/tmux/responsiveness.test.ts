import { describe, expect, it } from 'vitest';
import {
  classifyResponsiveness,
  RESPONSIVENESS_POLL_MS,
  UNRESPONSIVE_FAIL_MS,
  UNRESPONSIVE_WARN_MS,
} from './responsiveness';

describe('classifyResponsiveness', () => {
  it('is none with no pending command', () => {
    expect(classifyResponsiveness(null)).toBe('none');
  });

  it('is none below the warn threshold', () => {
    expect(classifyResponsiveness(0)).toBe('none');
    expect(classifyResponsiveness(UNRESPONSIVE_WARN_MS - 1)).toBe('none');
  });

  it('warns from the warn threshold up to the fail threshold', () => {
    expect(classifyResponsiveness(UNRESPONSIVE_WARN_MS)).toBe('warn');
    expect(classifyResponsiveness(UNRESPONSIVE_FAIL_MS - 1)).toBe('warn');
  });

  it('fails at or beyond the fail threshold', () => {
    expect(classifyResponsiveness(UNRESPONSIVE_FAIL_MS)).toBe('fail');
    expect(classifyResponsiveness(UNRESPONSIVE_FAIL_MS * 10)).toBe('fail');
  });

  it('thresholds are ordered and the poll is finer than the warn window', () => {
    expect(UNRESPONSIVE_WARN_MS).toBeLessThan(UNRESPONSIVE_FAIL_MS);
    expect(RESPONSIVENESS_POLL_MS).toBeLessThan(UNRESPONSIVE_WARN_MS);
  });
});
