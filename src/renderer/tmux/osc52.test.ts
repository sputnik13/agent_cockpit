import { describe, expect, it } from 'vitest';
import { decodeOsc52Write } from './osc52';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('decodeOsc52Write', () => {
  it('decodes a base64 SET payload to UTF-8 text', () => {
    expect(decodeOsc52Write(`c;${b64('hello world')}`)).toBe('hello world');
  });

  it('decodes multibyte UTF-8 selections', () => {
    expect(decodeOsc52Write(`c;${b64('café — 日本語')}`)).toBe('café — 日本語');
  });

  it('accepts any selection target before the semicolon', () => {
    expect(decodeOsc52Write(`p;${b64('primary')}`)).toBe('primary');
    expect(decodeOsc52Write(`;${b64('default')}`)).toBe('default');
  });

  it('ignores read requests (?) so apps cannot exfiltrate the clipboard', () => {
    expect(decodeOsc52Write('c;?')).toBeNull();
  });

  it('ignores empty/clear payloads', () => {
    expect(decodeOsc52Write('c;')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(decodeOsc52Write('no-semicolon')).toBeNull();
    expect(decodeOsc52Write('c;!!!not base64!!!')).toBeNull();
  });
});
