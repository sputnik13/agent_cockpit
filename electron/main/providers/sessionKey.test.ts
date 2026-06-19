import { describe, it, expect } from 'vitest';
import { sessionKey, sessionNameToken, sanitizeSessionName } from './sessionKey';

describe('sessionKey', () => {
  it('is deterministic and 16 lowercase hex chars', () => {
    const k = sessionKey('/srv/repo');
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionKey('/srv/repo')).toBe(k);
  });

  it('normalizes trailing slashes', () => {
    expect(sessionKey('/srv/repo/')).toBe(sessionKey('/srv/repo'));
    expect(sessionKey('/srv/repo///')).toBe(sessionKey('/srv/repo'));
  });

  it('differs for different roots', () => {
    expect(sessionKey('/srv/a')).not.toBe(sessionKey('/srv/b'));
  });
});

describe('sessionNameToken', () => {
  it('off: uses the (sanitized) project id — legacy behavior', () => {
    expect(sessionNameToken(false, 'proj-abc', '/srv/repo')).toBe('proj-abc');
    expect(sessionNameToken(false, 'proj.with:dots', '/srv/repo')).toBe('proj-with-dots');
  });

  it('on: uses sessionKey(root), independent of the project id', () => {
    const a = sessionNameToken(true, 'client-1-uuid', '/srv/repo');
    const b = sessionNameToken(true, 'client-2-uuid', '/srv/repo');
    expect(a).toBe(sessionKey('/srv/repo'));
    // Same root from two different client machines (different project ids) ->
    // the SAME token -> the same tmux session name -> shared session.
    expect(a).toBe(b);
  });
});

describe('sanitizeSessionName', () => {
  it('replaces . : and whitespace with -', () => {
    expect(sanitizeSessionName('a.b:c d')).toBe('a-b-c-d');
  });
});
