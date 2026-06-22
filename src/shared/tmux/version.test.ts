import { describe, expect, it } from 'vitest';
import { parseTmuxVersion, tmuxAtLeast } from './version';

describe('parseTmuxVersion', () => {
  it('parses MAJOR.MINOR', () => {
    expect(parseTmuxVersion('3.2')).toBe(30200);
    expect(parseTmuxVersion('3.0')).toBe(30000);
  });

  it('orders lettered releases just above their base', () => {
    const base = parseTmuxVersion('3.0')!;
    const a = parseTmuxVersion('3.0a')!;
    const b = parseTmuxVersion('3.0b')!;
    const next = parseTmuxVersion('3.1')!;
    expect(base).toBeLessThan(a);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(next);
  });

  it('orders two-digit minors above single-digit (3.10 > 3.2)', () => {
    expect(parseTmuxVersion('3.10')!).toBeGreaterThan(parseTmuxVersion('3.2')!);
  });

  it('tolerates surrounding text/prefixes', () => {
    expect(parseTmuxVersion('tmux 3.2')).toBe(30200);
    expect(parseTmuxVersion('next-3.4')).toBe(30400);
    expect(parseTmuxVersion('tmux 3.6a')).toBe(30601);
    expect(parseTmuxVersion('openbsd-7.5')).toBe(70500);
  });

  it('returns null when no version core is present', () => {
    expect(parseTmuxVersion('garbage')).toBeNull();
    expect(parseTmuxVersion('')).toBeNull();
  });
});

describe('tmuxAtLeast', () => {
  it('compares string versions', () => {
    expect(tmuxAtLeast('3.2', '3.2')).toBe(true);
    expect(tmuxAtLeast('3.3', '3.2')).toBe(true);
    expect(tmuxAtLeast('3.1', '3.2')).toBe(false);
    expect(tmuxAtLeast('3.0a', '3.0')).toBe(true);
    expect(tmuxAtLeast('3.0', '3.0a')).toBe(false);
  });

  it('accepts a pre-parsed integer', () => {
    expect(tmuxAtLeast(parseTmuxVersion('3.5'), '3.2')).toBe(true);
  });

  it('treats unknown/unparseable version as below target (feature stays off)', () => {
    expect(tmuxAtLeast(null, '3.2')).toBe(false);
    expect(tmuxAtLeast('garbage', '3.2')).toBe(false);
    expect(tmuxAtLeast('3.5', 'garbage')).toBe(false);
  });
});
