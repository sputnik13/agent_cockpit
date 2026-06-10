// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { remoteProjectLabel } from './ProjectTabs';

describe('remoteProjectLabel (8l84: remote project label defaults to basename)', () => {
  it('uses bare basename when no conflict', () => {
    expect(remoteProjectLabel('myrepo', 'alice', 'host.example', [])).toBe('myrepo');
  });

  it('uses bare basename when existing projects have different labels', () => {
    const existing = [{ label: 'other-repo' }, { label: 'something' }];
    expect(remoteProjectLabel('myrepo', 'alice', 'host.example', existing)).toBe('myrepo');
  });

  it('qualifies with user@host when basename conflicts with an existing project', () => {
    const existing = [{ label: 'myrepo' }];
    expect(remoteProjectLabel('myrepo', 'alice', 'host.example', existing)).toBe(
      'myrepo (alice@host.example)',
    );
  });

  it('qualifies with local project labels too (not just remote)', () => {
    // Local project named 'myrepo' counts as a conflict
    const existing = [{ label: 'myrepo' }];
    expect(remoteProjectLabel('myrepo', 'bob', 'other.host', existing)).toBe(
      'myrepo (bob@other.host)',
    );
  });

  it('appends a counter when qualified label also conflicts', () => {
    const existing = [{ label: 'myrepo' }, { label: 'myrepo (alice@host.example)' }];
    expect(remoteProjectLabel('myrepo', 'alice', 'host.example', existing)).toBe(
      'myrepo (alice@host.example) 2',
    );
  });

  it('keeps incrementing counter until unique', () => {
    const existing = [
      { label: 'repo' },
      { label: 'repo (alice@h)' },
      { label: 'repo (alice@h) 2' },
      { label: 'repo (alice@h) 3' },
    ];
    expect(remoteProjectLabel('repo', 'alice', 'h', existing)).toBe('repo (alice@h) 4');
  });
});
