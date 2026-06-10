import { describe, it, expect } from 'vitest';
import {
  beadsArgs,
  beadsErrorMessage,
  parseComments,
  parseCreatedId,
} from './runner';

describe('beadsArgs (argv builders — argv only, no shell)', () => {
  it('close with and without a reason', () => {
    expect(beadsArgs.close('x-1')).toEqual(['close', 'x-1']);
    expect(beadsArgs.close('x-1', 'done here')).toEqual(['close', 'x-1', '--reason', 'done here']);
    // Empty reason collapses to no flag.
    expect(beadsArgs.close('x-1', '')).toEqual(['close', 'x-1']);
  });

  it('reopen / comment / listComments', () => {
    expect(beadsArgs.reopen('x-1')).toEqual(['reopen', 'x-1']);
    expect(beadsArgs.comment('x-1', 'hi')).toEqual(['comments', 'add', 'x-1', '--message', 'hi']);
    expect(beadsArgs.listComments('x-1')).toEqual(['comments', 'list', 'x-1']);
  });

  it('create includes only the provided optional fields', () => {
    expect(beadsArgs.create({ title: 'T' })).toEqual(['create', 'T']);
    expect(
      beadsArgs.create({ title: 'T', parent: 'p1', priority: 0, description: 'd' }),
    ).toEqual(['create', 'T', '--parent', 'p1', '-p', '0', '-d', 'd']);
    // priority 0 must NOT be dropped (it is a valid P0).
    expect(beadsArgs.create({ title: 'T', priority: 0 })).toEqual(['create', 'T', '-p', '0']);
  });

  it('treats a shell-looking title as an inert literal arg (injection-safe)', () => {
    const evil = '"; rm -rf ~';
    expect(beadsArgs.create({ title: evil })).toEqual(['create', evil]);
  });
});

describe('parseComments', () => {
  it('maps br comment JSON ({issue_id, created_at}) to BeadsComment', () => {
    const out = JSON.stringify([
      { id: 51, issue_id: 'x-1', author: 'me', text: 'hi', created_at: '2026-06-09T04:22:43Z' },
    ]);
    expect(parseComments(out)).toEqual([
      { id: 51, issueId: 'x-1', author: 'me', text: 'hi', createdAt: '2026-06-09T04:22:43Z' },
    ]);
  });

  it('returns [] for empty output', () => {
    expect(parseComments('')).toEqual([]);
    expect(parseComments('  \n')).toEqual([]);
  });
});

describe('parseCreatedId', () => {
  it('extracts a string id from create --json', () => {
    expect(parseCreatedId(JSON.stringify({ id: 'proj-abc', title: 'T' }))).toBe('proj-abc');
  });
  it('returns null when absent/non-string/unparseable', () => {
    expect(parseCreatedId(JSON.stringify({ title: 'T' }))).toBeNull();
    expect(parseCreatedId(JSON.stringify({ id: 7 }))).toBeNull();
    expect(parseCreatedId('not json')).toBeNull();
    expect(parseCreatedId('')).toBeNull();
  });
});

describe('beadsErrorMessage', () => {
  it('prefers a JSON error envelope on stdout', () => {
    expect(beadsErrorMessage(JSON.stringify({ error: 'no such issue' }), 'noise')).toBe('no such issue');
    expect(beadsErrorMessage(JSON.stringify({ message: 'boom' }), null)).toBe('boom');
  });
  it('falls back to stderr, then to raw stdout', () => {
    expect(beadsErrorMessage('', 'stderr text')).toBe('stderr text');
    expect(beadsErrorMessage('plain stdout', '')).toBe('plain stdout');
    expect(beadsErrorMessage('', '')).toBeNull();
  });
});
