import { describe, expect, it } from 'vitest';
import { jsonFoldModel } from './jsonFold';

describe('jsonFoldModel', () => {
  it('folds nested containers with exact source slices, outer-before-inner order, and correct itemCount/depth', () => {
    const text = [
      '{',
      '  "a": {',
      '    "b": [',
      '      1,',
      '      2',
      '    ]',
      '  },',
      '  "c": 3',
      '}',
    ].join('\n');

    const model = jsonFoldModel(text);

    expect(model.format).toBe('json');
    expect(model.errors).toEqual([]);
    expect(model.anchors).toEqual([]);
    expect(model.documents).toEqual([{ start: 0, end: text.length, index: 0 }]);
    expect(model.regions).toHaveLength(3);

    const [outer, aObj, bArr] = model.regions;

    expect(text.slice(outer.start, outer.end)).toBe(text);
    expect(outer.kind).toBe('object');
    expect(outer.itemCount).toBe(2); // "a", "c"
    expect(outer.depth).toBe(0);
    expect(outer.headerEnd).toBe(outer.start + 1);

    expect(text.slice(aObj.start, aObj.end)).toBe('{\n    "b": [\n      1,\n      2\n    ]\n  }');
    expect(aObj.kind).toBe('object');
    expect(aObj.itemCount).toBe(1); // "b"
    expect(aObj.depth).toBe(1);
    expect(aObj.headerEnd).toBe(aObj.start + 1);

    expect(text.slice(bArr.start, bArr.end)).toBe('[\n      1,\n      2\n    ]');
    expect(bArr.kind).toBe('array');
    expect(bArr.itemCount).toBe(2); // 1, 2
    expect(bArr.depth).toBe(2);
    expect(bArr.headerEnd).toBe(bArr.start + 1);

    // Outer-before-inner: ascending start, and each region's span fully
    // contains the next (start non-decreasing, end non-increasing).
    expect(outer.start).toBeLessThan(aObj.start);
    expect(aObj.start).toBeLessThan(bArr.start);
    expect(outer.end).toBeGreaterThanOrEqual(aObj.end);
    expect(aObj.end).toBeGreaterThanOrEqual(bArr.end);
  });

  it('excludes single-line containers from folding (whole file is one line)', () => {
    const text = '{"a": 1, "b": [1, 2, 3]}';
    const model = jsonFoldModel(text);
    expect(model.errors).toEqual([]);
    expect(model.regions).toEqual([]);
  });

  it('excludes single-line containers even when nested inside a multi-line one', () => {
    const text = '{\n  "a": [1, 2, 3],\n  "b": 4\n}';
    const model = jsonFoldModel(text);
    expect(model.errors).toEqual([]);
    expect(model.regions).toHaveLength(1);
    expect(model.regions[0].kind).toBe('object');
    expect(text.slice(model.regions[0].start, model.regions[0].end)).toBe(text);
  });

  it('tolerates JSONC comments and trailing commas with zero errors', () => {
    const text = [
      '{',
      '  // a line comment',
      '  "a": 1, /* block comment */',
      '  "b": [',
      '    1,',
      '    2,',
      '  ],',
      '}',
    ].join('\n');

    const model = jsonFoldModel(text);
    expect(model.errors).toEqual([]);
    expect(model.regions.some((r) => r.kind === 'object')).toBe(true);
    expect(model.regions.some((r) => r.kind === 'array')).toBe(true);
    // The comment text itself survives verbatim inside the containing
    // region's slice - it is never stripped or reserialized.
    const outer = model.regions.find((r) => r.depth === 0);
    expect(outer).toBeDefined();
    expect(text.slice(outer!.start, outer!.end)).toContain('// a line comment');
    expect(text.slice(outer!.start, outer!.end)).toContain('/* block comment */');
  });

  it('preserves number precision verbatim (never round-trips through a JS number)', () => {
    // Sanity check that this is a REAL precision hazard: parsing this
    // literal into a JS double and re-serializing it loses the trailing
    // digits. jsonFoldModel must never do that - it only ever slices text.
    expect(Number('1.0000000000000001')).toBe(1);

    const text = '{\n  "n": 1.0000000000000001,\n  "a": {\n    "b": 2\n  }\n}';
    const model = jsonFoldModel(text);
    expect(model.errors).toEqual([]);
    const outer = model.regions.find((r) => r.depth === 0);
    expect(outer).toBeDefined();
    expect(text.slice(outer!.start, outer!.end)).toContain('1.0000000000000001');
  });

  it('returns a partial model with populated errors and never throws on invalid JSON', () => {
    const text = '{"a": [1, 2, }';
    expect(() => jsonFoldModel(text)).not.toThrow();
    const model = jsonFoldModel(text);
    expect(model.format).toBe('json');
    expect(model.errors.length).toBeGreaterThan(0);
    expect(model.documents).toEqual([{ start: 0, end: text.length, index: 0 }]);
  });

  it('returns a partial model with populated errors and never throws on garbage input', () => {
    const text = '{not valid json at all!!!';
    expect(() => jsonFoldModel(text)).not.toThrow();
    const model = jsonFoldModel(text);
    expect(model.errors.length).toBeGreaterThan(0);
  });

  it('returns an empty, error-free model for an empty file', () => {
    const model = jsonFoldModel('');
    expect(model.format).toBe('json');
    expect(model.errors).toEqual([]);
    expect(model.regions).toEqual([]);
    expect(model.anchors).toEqual([]);
    expect(model.documents).toEqual([{ start: 0, end: 0, index: 0 }]);
  });

  it('round-trips every fixture through structuredClone (worker postMessage safety)', () => {
    const fixtures = [
      '{\n  "a": {\n    "b": [\n      1,\n      2\n    ]\n  },\n  "c": 3\n}',
      '{"a": 1, "b": [1, 2, 3]}',
      '{\n  // comment\n  "a": 1,\n}',
      '{"a": [1, 2, }',
      '{not valid json at all!!!',
      '',
    ];
    for (const text of fixtures) {
      const model = jsonFoldModel(text);
      expect(() => structuredClone(model)).not.toThrow();
      expect(structuredClone(model)).toEqual(model);
    }
  });
});
