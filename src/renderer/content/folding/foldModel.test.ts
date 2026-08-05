import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineStartOffsets, offsetToLine } from './foldModel';

/** The naive, obviously-correct reference definition from the issue body's
 *  acceptance criteria: agree with this for every offset in a fixture. */
function naiveLine(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length - 1;
}

describe('lineStartOffsets', () => {
  it('always starts with 0', () => {
    expect(lineStartOffsets('')[0]).toBe(0);
    expect(lineStartOffsets('a\nb')[0]).toBe(0);
  });

  it('returns one entry per line, at the offset just past each newline', () => {
    const text = 'ab\ncd\nef';
    expect(lineStartOffsets(text)).toEqual([0, 3, 6]);
  });

  it('includes a trailing entry when the text ends with a newline', () => {
    const text = 'ab\ncd\n';
    expect(lineStartOffsets(text)).toEqual([0, 3, 6]);
  });

  it('returns a single entry for an empty file', () => {
    expect(lineStartOffsets('')).toEqual([0]);
  });

  it('returns a single entry for text with no newlines', () => {
    expect(lineStartOffsets('hello')).toEqual([0]);
  });

  it('handles consecutive blank lines', () => {
    expect(lineStartOffsets('a\n\n\nb')).toEqual([0, 2, 3, 4]);
  });
});

describe('offsetToLine', () => {
  const fixtures = [
    '',
    'hello',
    'ab\ncd\nef',
    'ab\ncd\n',
    'a\n\n\nb',
    '{\n  "a": {\n    "b": 1\n  }\n}',
    'line1\nline2\nline3\n\nline5',
  ];

  it.each(fixtures)('agrees with the naive definition for every offset in %j', (text) => {
    const starts = lineStartOffsets(text);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(offsetToLine(starts, offset)).toBe(naiveLine(text, offset));
    }
  });

  it('returns 0 for the only offset in an empty file', () => {
    expect(offsetToLine(lineStartOffsets(''), 0)).toBe(0);
  });
});

describe('guardrail: never materializes a re-serialized JS value', () => {
  // Grep-verifiable per the issue's guardrails: nothing in this module ever
  // CALLS a full-value parse/resolve API. This test makes that guardrail a
  // regression check instead of a one-time manual grep. It checks CODE only
  // - the doc comments in these files deliberately name these same APIs in
  // prose (to explain why they're avoided), so comments are stripped first;
  // otherwise the guardrail would trip on its own documentation.
  const dir = new URL('.', import.meta.url);
  const files = ['foldModel.ts', 'jsonFold.ts', 'yamlFold.ts'];
  const forbidden = ['.toJS(', 'JSON.parse(', 'yaml.parse(', 'getNodeValue(', '.resolve('];

  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  }

  it.each(files)('%s calls no full-value parse/resolve API', (file) => {
    const code = stripComments(readFileSync(new URL(file, dir), 'utf8'));
    for (const token of forbidden) {
      expect(code).not.toContain(token);
    }
  });
});
