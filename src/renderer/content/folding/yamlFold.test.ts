import { describe, expect, it } from 'vitest';
import { yamlFoldModel } from './yamlFold';

describe('yamlFoldModel', () => {
  it('folds nested block maps with correct itemCount/depth; a block map has headerEnd === start', () => {
    const text = 'a:\n  b: 1\n  c: 2\n';
    const model = yamlFoldModel(text);

    expect(model.format).toBe('yaml');
    expect(model.errors).toEqual([]);
    expect(model.documents).toEqual([{ start: 0, end: text.length, index: 0 }]);
    expect(model.regions).toHaveLength(2);

    const [outer, inner] = model.regions;
    expect(text.slice(outer.start, outer.end)).toBe(text);
    expect(outer.kind).toBe('map');
    expect(outer.itemCount).toBe(1); // "a"
    expect(outer.depth).toBe(0);
    // A block map has no delimiter character of its own at `start` (its
    // "mapping key" line belongs to the parent Pair, already outside this
    // region) - nothing needs to stay visible from within the region.
    expect(outer.headerEnd).toBe(outer.start);

    expect(text.slice(inner.start, inner.end)).toBe('b: 1\n  c: 2\n');
    expect(inner.kind).toBe('map');
    expect(inner.itemCount).toBe(2); // "b", "c"
    expect(inner.depth).toBe(1);
    expect(inner.headerEnd).toBe(inner.start);
  });

  it('folds multi-line block scalars, keeping the |/> indicator line as the header', () => {
    const text = 'lit: |\n  line one\n  line two\nfold: >\n  line one\n  line two\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    const scalars = model.regions.filter((r) => r.kind === 'block-scalar');
    expect(scalars).toHaveLength(2);

    const [lit, fold] = scalars;
    expect(text.slice(lit.start, lit.end)).toBe('|\n  line one\n  line two\n');
    expect(text.slice(lit.start, lit.headerEnd)).toBe('|\n');
    expect(lit.itemCount).toBe(0);
    expect(lit.depth).toBe(1);

    expect(text.slice(fold.start, fold.end)).toBe('>\n  line one\n  line two\n');
    expect(text.slice(fold.start, fold.headerEnd)).toBe('>\n');
    expect(fold.itemCount).toBe(0);
    expect(fold.depth).toBe(1);
  });

  it('folds multi-line flow collections (header keeps the opening bracket) but excludes single-line ones', () => {
    const text = 'seqMulti: [\n  1,\n  2\n]\nseqSingle: [1, 2, 3]\nmapMulti: {\n  a: 1,\n  b: 2\n}\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    // Only the root map + the two multi-line flow collections; the
    // single-line `seqSingle` flow array is excluded.
    expect(model.regions).toHaveLength(3);
    expect(model.regions.some((r) => text.slice(r.start, r.end) === '[1, 2, 3]')).toBe(false);

    const seq = model.regions.find((r) => r.kind === 'seq');
    expect(seq).toBeDefined();
    expect(text.slice(seq!.start, seq!.end)).toBe('[\n  1,\n  2\n]');
    expect(text.slice(seq!.start, seq!.headerEnd)).toBe('[');
    expect(seq!.itemCount).toBe(2);

    const map = model.regions.find((r) => r.kind === 'map' && r.depth === 1);
    expect(map).toBeDefined();
    expect(text.slice(map!.start, map!.end)).toBe('{\n  a: 1,\n  b: 2\n}');
    expect(text.slice(map!.start, map!.headerEnd)).toBe('{');
    expect(map!.itemCount).toBe(2);
  });

  it('renders ALL documents of a multi-document stream, with correct offsets and region attribution', () => {
    const text = 'a: 1\n---\nb:\n  c: 2\n  d: 3\n---\ne: |\n  x\n  y\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    expect(model.documents).toHaveLength(3);
    expect(model.documents.map((d) => d.index)).toEqual([0, 1, 2]);
    // Documents partition the file contiguously with no gaps or overlaps.
    expect(model.documents[0].start).toBe(0);
    for (let i = 1; i < model.documents.length; i++) {
      expect(model.documents[i].start).toBe(model.documents[i - 1].end);
    }
    expect(model.documents[model.documents.length - 1].end).toBe(text.length);

    // Every region's start offset falls within the [start, end) of exactly
    // the document whose index matches its textual position.
    for (const region of model.regions) {
      const owner = model.documents.find((d) => region.start >= d.start && region.start < d.end);
      expect(owner).toBeDefined();
    }

    // Document 1 (the second document) has a nested block map.
    const doc1Regions = model.regions.filter(
      (r) => r.start >= model.documents[1].start && r.start < model.documents[1].end,
    );
    expect(doc1Regions.some((r) => r.kind === 'map' && r.itemCount === 2)).toBe(true);

    // Document 2 (the third document) has a block scalar.
    const doc2Regions = model.regions.filter(
      (r) => r.start >= model.documents[2].start && r.start < model.documents[2].end,
    );
    expect(doc2Regions.some((r) => r.kind === 'block-scalar')).toBe(true);
  });

  it('links an &anchor definition to every *alias referencing it, with exact source slices', () => {
    const text = 'a: &x hello\nb: *x\nc: *x\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    expect(model.anchors).toHaveLength(1);
    const [link] = model.anchors;
    expect(link.name).toBe('x');
    expect(text.slice(link.definition.start, link.definition.end)).toBe('&x');
    expect(link.aliases).toHaveLength(2);
    for (const alias of link.aliases) {
      expect(text.slice(alias.start, alias.end)).toBe('*x');
    }
  });

  it('bounded backward-scan for the anchor definition tolerates a trailing line comment', () => {
    // The Document layer's node range for the anchored value starts AFTER
    // "&x # trailing comment\n  " (at "k"), so locating "&x" requires the
    // backward scan to skip over both the comment and the whitespace/
    // newline/indentation - this is the scan's dedicated unit test.
    const text = 'top: &x # trailing comment\n  k: v\n  k2: v2\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    expect(model.anchors).toHaveLength(1);
    expect(model.anchors[0].name).toBe('x');
    const { definition } = model.anchors[0];
    expect(text.slice(definition.start, definition.end)).toBe('&x');
    // An anchor with no aliases is still reported (definition-only).
    expect(model.anchors[0].aliases).toEqual([]);
  });

  it('links an alias to its anchor even when the alias appears before the anchor, in a later document', () => {
    const text = 'x: 1\n---\nb: *y\na: &y hello\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    expect(model.documents).toHaveLength(2);
    expect(model.anchors).toHaveLength(1);
    const [link] = model.anchors;
    expect(link.name).toBe('y');
    expect(text.slice(link.definition.start, link.definition.end)).toBe('&y');
    expect(link.aliases).toHaveLength(1);
    expect(text.slice(link.aliases[0].start, link.aliases[0].end)).toBe('*y');
    // The alias's textual position precedes the definition's - confirming
    // this really does exercise the forward-reference (order-independent
    // grouping-by-name) case, not just a same-document lookup.
    expect(link.aliases[0].start).toBeLessThan(link.definition.start);
  });

  it('scopes anchors per document: the same name reused in two documents yields two independent links', () => {
    const text = 'a: &x hello\nb: *x\n---\nc: &x world\nd: *x\n';
    const model = yamlFoldModel(text);

    expect(model.errors).toEqual([]);
    expect(model.documents).toHaveLength(2);
    expect(model.anchors).toHaveLength(2);
    expect(model.anchors.every((a) => a.name === 'x')).toBe(true);
    // Each link's own definition/alias slices are self-consistent and
    // distinct (not merged across the document boundary).
    const [first, second] = model.anchors;
    expect(text.slice(first.definition.start, first.definition.end)).toBe('&x');
    expect(text.slice(second.definition.start, second.definition.end)).toBe('&x');
    expect(first.definition.start).not.toBe(second.definition.start);
    expect(first.aliases).toHaveLength(1);
    expect(second.aliases).toHaveLength(1);
  });

  it('returns a partial model with populated errors and never throws on invalid YAML (tab indentation)', () => {
    const text = 'a: 1\n\tb: 2\n';
    expect(() => yamlFoldModel(text)).not.toThrow();
    const model = yamlFoldModel(text);
    expect(model.format).toBe('yaml');
    expect(model.errors.length).toBeGreaterThan(0);
    for (const err of model.errors) {
      expect(typeof err.offset).toBe('number');
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('returns a partial model with populated errors and never throws on more severely broken YAML', () => {
    const text = 'a: [1, "unterminated\nb: {c: 1\n';
    expect(() => yamlFoldModel(text)).not.toThrow();
    const model = yamlFoldModel(text);
    expect(model.errors.length).toBeGreaterThan(0);
  });

  it('returns an empty, error-free model for an empty file', () => {
    const model = yamlFoldModel('');
    expect(model.format).toBe('yaml');
    expect(model.documents).toEqual([]);
    expect(model.regions).toEqual([]);
    expect(model.anchors).toEqual([]);
    expect(model.errors).toEqual([]);
  });

  it('round-trips every fixture through structuredClone (worker postMessage safety)', () => {
    const fixtures = [
      'a:\n  b: 1\n  c: 2\n',
      'lit: |\n  line one\n  line two\n',
      'seqMulti: [\n  1,\n  2\n]\nmapMulti: {\n  a: 1,\n  b: 2\n}\n',
      'a: 1\n---\nb:\n  c: 2\n---\ne: |\n  x\n  y\n',
      'a: &x hello\nb: *x\nc: *x\n',
      'x: 1\n---\nb: *y\na: &y hello\n',
      'a: &x hello\nb: *x\n---\nc: &x world\nd: *x\n',
      'a: 1\n\tb: 2\n',
      'a: [1, "unterminated\nb: {c: 1\n',
      '',
    ];
    for (const text of fixtures) {
      const model = yamlFoldModel(text);
      expect(() => structuredClone(model)).not.toThrow();
      expect(structuredClone(model)).toEqual(model);
    }
  });
});
