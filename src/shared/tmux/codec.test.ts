import { describe, expect, it } from 'vitest';
import { decodeOutput, toHex } from './codec';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe('decodeOutput (tmux %output octal decode)', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(decodeOutput('hello')).toEqual(bytes(104, 101, 108, 108, 111));
  });

  it('decodes a three-digit octal escape', () => {
    // \015 == 0o15 == 13 (CR)
    expect(decodeOutput('\\015')).toEqual(bytes(13));
    // \033 == 0o33 == 27 (ESC)
    expect(decodeOutput('\\033')).toEqual(bytes(27));
  });

  it('decodes an escaped backslash as a single backslash byte', () => {
    expect(decodeOutput('\\\\')).toEqual(bytes(0x5c));
  });

  it('decodes a mixed prompt-like sequence (ESC [ 0 m)', () => {
    // tmux: "\033[0m$ " -> ESC '[' '0' 'm' '$' ' '
    expect(decodeOutput('\\033[0m$ ')).toEqual(bytes(27, 0x5b, 0x30, 0x6d, 0x24, 0x20));
  });

  it('decodes the full octal byte range (\\000 and \\377)', () => {
    expect(decodeOutput('\\000')).toEqual(bytes(0));
    expect(decodeOutput('\\377')).toEqual(bytes(255));
  });

  it('accepts 1-2 digit octal escapes defensively', () => {
    // "\7" -> 7 ; the trailing 'x' is literal.
    expect(decodeOutput('\\7x')).toEqual(bytes(7, 0x78));
  });

  it('stops octal parsing at a non-octal digit', () => {
    // \0 then '8' (not octal) then '9' -> byte 0, '8', '9'
    expect(decodeOutput('\\089')).toEqual(bytes(0, 0x38, 0x39));
  });

  it('preserves a lone trailing backslash (truncated input)', () => {
    expect(decodeOutput('ab\\')).toEqual(bytes(0x61, 0x62, 0x5c));
  });

  it('handles an empty payload', () => {
    expect(decodeOutput('')).toEqual(bytes());
  });
});

describe('toHex (send-keys -H encoder, space-separated pairs)', () => {
  it('encodes ASCII as space-separated lowercase hex pairs', () => {
    expect(toHex('A')).toBe('41');
    expect(toHex('abc')).toBe('61 62 63');
  });

  it('encodes control bytes (CR, ESC)', () => {
    expect(toHex('\r')).toBe('0d');
    expect(toHex('\u001b')).toBe('1b');
  });

  it('encodes a Uint8Array directly', () => {
    expect(toHex(bytes(0, 255, 16))).toBe('00 ff 10');
  });

  it('encodes multibyte UTF-8 (é -> c3 a9)', () => {
    expect(toHex('é')).toBe('c3 a9');
  });

  it('encodes a control sequence as spaced pairs', () => {
    const input = bytes(27, 0x5b, 0x41); // ESC [ A (cursor up)
    expect(toHex(input)).toBe('1b 5b 41');
  });
});
