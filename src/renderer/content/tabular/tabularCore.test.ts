import { describe, it, expect } from 'vitest';
import { TabularEngine, parseDelimited } from './tabularCore';

describe('parseDelimited', () => {
  it('parses simple comma and tab records', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseDelimited('a\tb\n1\t2', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted fields: embedded delimiter, newline, and doubled quotes', () => {
    expect(parseDelimited('a,"b,c","line1\nline2","say ""hi"""\n', ',')).toEqual([
      ['a', 'b,c', 'line1\nline2', 'say "hi"'],
    ]);
  });

  it('handles CRLF, lone CR, a BOM, and no trailing newline', () => {
    expect(parseDelimited('﻿a,b\r\n1,2\r\n3,4', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parseDelimited('a\rb', ',')).toEqual([['a'], ['b']]);
  });

  it('keeps empty fields, including a trailing delimiter, and skips blank lines', () => {
    expect(parseDelimited('a,,c\n\n1,2,\n', ',')).toEqual([
      ['a', '', 'c'],
      ['1', '2', ''],
    ]);
  });

  it('is lenient: an unterminated quote consumes the rest; junk after a closing quote is kept', () => {
    expect(parseDelimited('a,"unterminated\nstill,here', ',')).toEqual([
      ['a', 'unterminated\nstill,here'],
    ]);
    expect(parseDelimited('"ab"cd,e', ',')).toEqual([['abcd', 'e']]);
  });

  it('returns no records for empty input', () => {
    expect(parseDelimited('', ',')).toEqual([]);
  });
});

const CSV = [
  'name,age,city',
  'bob,30,Austin',
  'alice,4,Boston',
  'carol,,austin',
  'dave,100,Denver',
].join('\n');

const names = (e: TabularEngine, n: number): string[] => e.rows(0, n).map((r) => r.cells[0]!);

describe('TabularEngine', () => {
  it('reports header, body row count and widest column count (ragged rows padded)', () => {
    const e = new TabularEngine('h1,h2\n1\n1,2,3\n', ',');
    expect(e.info()).toEqual({ header: ['h1', 'h2', ''], rowCount: 2, columns: 3 });
    expect(e.query({ sortCol: -1, sortDir: 'asc', filter: '' })).toBe(2);
    expect(e.rows(0, 2)[0]).toEqual({ n: 1, cells: ['1', '', ''] });
  });

  it('returns source order and a clamped window with no sort/filter', () => {
    const e = new TabularEngine(CSV, ',');
    expect(e.query({ sortCol: -1, sortDir: 'asc', filter: '' })).toBe(4);
    expect(names(e, 99)).toEqual(['bob', 'alice', 'carol', 'dave']);
    expect(e.rows(2, 3).map((r) => r.n)).toEqual([3]);
    expect(e.rows(10, 20)).toEqual([]);
  });

  it('sorts all-numeric columns numerically, with blanks last in both directions', () => {
    const e = new TabularEngine(CSV, ',');
    e.query({ sortCol: 1, sortDir: 'asc', filter: '' });
    expect(names(e, 4)).toEqual(['alice', 'bob', 'dave', 'carol']);
    e.query({ sortCol: 1, sortDir: 'desc', filter: '' });
    expect(names(e, 4)).toEqual(['dave', 'bob', 'alice', 'carol']);
  });

  it('sorts text columns case-insensitively in natural order', () => {
    const e = new TabularEngine('v\nitem10\nItem2\nitem1\n', ',');
    e.query({ sortCol: 0, sortDir: 'asc', filter: '' });
    expect(e.rows(0, 3).map((r) => r.cells[0])).toEqual(['item1', 'Item2', 'item10']);
  });

  it('keeps source order for ties (stable sort) and reports original row numbers', () => {
    const e = new TabularEngine('k,v\na,1\nb,1\nc,0\n', ',');
    e.query({ sortCol: 1, sortDir: 'asc', filter: '' });
    expect(e.rows(0, 3).map((r) => [r.cells[0], r.n])).toEqual([
      ['c', 3],
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('filters case-insensitively across every cell, then sorts the matches', () => {
    const e = new TabularEngine(CSV, ',');
    expect(e.query({ sortCol: -1, sortDir: 'asc', filter: 'AUSTIN' })).toBe(2);
    expect(names(e, 9)).toEqual(['bob', 'carol']);
    e.query({ sortCol: 0, sortDir: 'desc', filter: 'austin' });
    expect(names(e, 9)).toEqual(['carol', 'bob']);
    expect(e.query({ sortCol: -1, sortDir: 'asc', filter: 'zzz' })).toBe(0);
    expect(e.rows(0, 5)).toEqual([]);
  });

  it('clearing the filter and sort restores the full source-order view', () => {
    const e = new TabularEngine(CSV, ',');
    e.query({ sortCol: 0, sortDir: 'desc', filter: 'a' });
    expect(e.query({ sortCol: -1, sortDir: 'asc', filter: '' })).toBe(4);
    expect(names(e, 4)).toEqual(['bob', 'alice', 'carol', 'dave']);
  });

  it('ignores an out-of-range sort column', () => {
    const e = new TabularEngine(CSV, ',');
    e.query({ sortCol: 99, sortDir: 'asc', filter: '' });
    expect(names(e, 4)).toEqual(['bob', 'alice', 'carol', 'dave']);
  });

  it('handles a header-only and an empty file', () => {
    const h = new TabularEngine('a,b\n', ',');
    expect(h.info().rowCount).toBe(0);
    expect(h.query({ sortCol: 0, sortDir: 'asc', filter: 'x' })).toBe(0);
    const empty = new TabularEngine('', ',');
    expect(empty.info()).toEqual({ header: [], rowCount: 0, columns: 0 });
    expect(empty.query({ sortCol: -1, sortDir: 'asc', filter: '' })).toBe(0);
  });
});
